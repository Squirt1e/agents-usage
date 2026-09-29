//! macOS menubar host.
//!
//! Owns the tray icon, the panel window lifecycle and the restricted bridge to
//! the Rust usage service (tasks 5.1–5.6). The host never talks to a provider
//! itself: every `panel_*` command proxies to the loopback service it started or
//! reused, using the private discovery origin and session token.

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// Environment variable read at startup; kept tiny because Finder launches have
/// no interactive shell environment.
pub const LOG_FILTER_ENV: &str = "AGENTS_USAGE_DESKTOP_LOG";

/// Host -> panel event announcing the intended visibility, so the panel can play
/// its enter/leave transition before the window is really shown or hidden.
pub const PANEL_VISIBILITY_EVENT: &str = "panel://visibility";

/// Host -> panel event announcing the intended header visibility. The header
/// settles away when the pointer leaves the window and comes back when it
/// returns. The host owns this: a non-key window's webview receives no pointer
/// events, so the DOM cannot see the pointer cross the window edge, but the
/// window server still delivers cursor enter/leave to the host regardless of
/// focus.
pub const PANEL_HEADER_EVENT: &str = "panel://header";

/// Tray identifiers. The item ids are what the menu event handler matches on; the
/// tray id is how a visibility change finds the item again, because Tauri has a
/// setter for a tray's menu but no getter, so the item handle is kept in the state.
const TRAY_ID: &str = "tray";
const TRAY_TOGGLE_ID: &str = "toggle";

/// What the tray's toggle item says.
///
/// A menu item is one action, so its label has to name the action *this* click
/// performs. Naming both actions in a single label, separated by a slash, reads
/// like a switch — out of place beside three items that are all verbs. The panel's
/// own state decides which of the two labels is showing.
const TRAY_SHOW_LABEL: &str = "显示面板";
const TRAY_HIDE_LABEL: &str = "隐藏面板";

/// The tray's panel-shape radio group.
///
/// A group rather than one "switch to the other one" item: the label of a single item
/// can only name the mode a click would switch *to*, which leaves the menu unable to say
/// which mode the panel is in. Two checked items answer both questions at once, and each
/// click is still one action ("switch to this mode").
const TRAY_MODE_FULL_ID: &str = "mode-full";
const TRAY_MODE_MINIMAL_ID: &str = "mode-minimal";
const TRAY_MINIMAL_LABEL: &str = "极简模式";
const TRAY_FULL_LABEL: &str = "标准模式";

/// The tray's theme radio group.
///
/// The theme is a setting like the panel's shape, and the tray is where a reader reaches
/// for it without opening a window. The labels are the settings window's own wording —
/// `AppSettings.tsx`'s `THEME_OPTIONS` — and the guard reads that file to keep the two
/// surfaces from describing one setting two ways.
const TRAY_THEME_LIGHT_ID: &str = "theme-light";
const TRAY_THEME_DARK_ID: &str = "theme-dark";
const TRAY_THEME_SYSTEM_ID: &str = "theme-system";
const TRAY_THEME_LIGHT_LABEL: &str = "浅色";
const TRAY_THEME_DARK_LABEL: &str = "深色";
const TRAY_THEME_SYSTEM_LABEL: &str = "跟随系统";

/// The theme the radio group starts on, before the settings read says otherwise.
///
/// It is the settings contract's own default (`desktop-contract.ts` reads a missing theme
/// as `dark`), so the first frames of a fresh launch show the theme the panel is drawing.
const TRAY_DEFAULT_THEME: &str = "dark";

/// TEMPORARY (panel-flicker diagnosis): append a timestamped line every time the
/// host changes, or considers changing, the panel's visibility.
///
/// A flicker reported during a drag has two very different possible causes: the
/// enter/leave fade being replayed, or the transparent window being
/// re-composited. This log decides which, because the fade cannot happen without
/// a line here. Remove once the flicker is settled.
fn diag_log(event: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("agents-usage-panel-events.log");
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let _ = writeln!(file, "{millis} {event}");
}

use usage_core::storage::data_dir::{DataDirectory, ServiceDiscovery, PROTOCOL_VERSION};

/// Read the shared discovery file, returning `None` when it does not exist yet.
fn read_discovery() -> Result<Option<ServiceDiscovery>, String> {
    let directory =
        DataDirectory::open(DataDirectory::default_root()).map_err(|error| error.to_string())?;
    directory
        .read_discovery()
        .map_err(|error| error.to_string())
}

/// A connection to the service: origin plus the session token for mutations.
#[derive(Debug)]
struct ServiceConnection {
    origin: String,
    session_token: String,
    owned_by_desktop: bool,
    child: Option<Arc<Mutex<std::process::Child>>>,
}

impl ServiceConnection {
    /// The network-relevant snapshot of the connection.
    fn endpoint(&self) -> ServiceEndpoint {
        ServiceEndpoint {
            origin: self.origin.clone(),
            session_token: self.session_token.clone(),
        }
    }
}

/// What an HTTP request needs to reach the service. Taken as a snapshot so no
/// request holds the connection lock across an await.
#[derive(Clone)]
struct ServiceEndpoint {
    origin: String,
    session_token: String,
}

/// Shared panel state.
struct PanelState {
    pinned: Mutex<bool>,
    minimal_mode: Mutex<bool>,
    minimal_detail: Mutex<MinimalDetailState>,
    /// Guarded so a command that finds the service gone can replace the
    /// connection instead of failing until the app is relaunched.
    service: Mutex<ServiceConnection>,

    /// Intended visibility, used to toggle correctly while the hide animation
    /// is still running.
    visibility: Mutex<VisibilityState>,
    /// Generation of the panel's header visibility. Every cursor-enter/leave or
    /// visibility change that must invalidate a pending header hide bumps it;
    /// the delayed hide task only fires when the generation it captured is
    /// still the current one. Same model as [`VisibilityState`].
    header_generation: Mutex<u64>,
    /// Which settings section the window should be showing.
    ///
    /// The host keeps it rather than relying only on the event it emits, because the
    /// webview can miss that event: a fresh window has not registered its listener
    /// during its first frames, and a request that arrives then would be lost with
    /// the window left on the wrong section. The event is still the fast path, and
    /// this is what the window reads when it comes up — see `panel_settings_section`.
    settings_section: Mutex<&'static str>,
    /// The tray item that shows or hides the panel, so its label can follow the
    /// panel's visibility. See [`sync_tray_toggle`].
    tray_toggle: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// The tray's panel-shape radio group: the value each item writes, and the item.
    ///
    /// Kept as a group because the menu shows a *state* here, not just an action: exactly
    /// one of the two is checked, and the pair is corrected as a whole whenever the mode
    /// can change. See [`sync_tray_mode`].
    tray_mode: Mutex<Vec<(&'static str, CheckMenuItem<tauri::Wry>)>>,
    /// The tray's theme radio group, same shape and same reason. See [`sync_tray_theme`].
    tray_theme: Mutex<Vec<(&'static str, CheckMenuItem<tauri::Wry>)>>,
}

#[derive(Default)]
struct MinimalDetailState {
    selection: Option<String>,
    index: u32,
    height: f64,
    generation: u64,
}

impl PanelState {
    fn service_endpoint(&self) -> ServiceEndpoint {
        self.service
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .endpoint()
    }

    /// Re-discover the service (or start a fresh one) after the recorded
    /// connection went stale, and store the new connection. This mirrors the
    /// startup discovery so a service that dies under a live host heals on the
    /// next command instead of failing every command until relaunch.
    async fn reconnect_service(&self) -> Result<(), String> {
        let fresh = tauri::async_runtime::spawn_blocking(connect_to_service)
            .await
            .map_err(|error| format!("service recovery failed: {error}"))??;
        *self
            .service
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = fresh;
        Ok(())
    }
}

/// Discover the running service, or start one and wait for its discovery file.
///
/// A discovery entry is only reused when its recorded process is still alive and
/// the protocol version matches; a stale file from a crashed run is ignored and
/// replaced by a fresh service (task 4.3 "过期信息").
fn connect_to_service() -> Result<ServiceConnection, String> {
    if let Some(discovery) = read_discovery()? {
        if discovery.protocol_version == PROTOCOL_VERSION && discovery.process_is_alive() {
            return Ok(ServiceConnection {
                origin: discovery.origin(),
                session_token: discovery.session_token,
                owned_by_desktop: discovery.owned_by_desktop,
                child: None,
            });
        }
    }

    let binary = locate_service_binary();
    let mut child = Command::new(&binary)
        .env("AGENTS_USAGE_DESKTOP_OWNED", "1")
        .spawn()
        .map_err(|error| format!("cannot start the usage service: {error}"))?;

    for _ in 0..100 {
        std::thread::sleep(Duration::from_millis(50));
        if let Some(discovery) = read_discovery()? {
            if discovery.protocol_version == PROTOCOL_VERSION && discovery.process_is_alive() {
                return Ok(ServiceConnection {
                    origin: discovery.origin(),
                    session_token: discovery.session_token,
                    owned_by_desktop: true,
                    child: Some(Arc::new(Mutex::new(child))),
                });
            }
        }
    }
    let _ = child.kill();
    Err("the usage service did not publish its discovery file".to_string())
}

fn locate_service_binary() -> PathBuf {
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            let sibling = dir.join("usage-service");
            if sibling.exists() {
                return sibling;
            }
        }
    }
    PathBuf::from("usage-service")
}

/// Open a URL in the default browser.
fn open_url(url: &str) -> Result<(), String> {
    let status = Command::new("open")
        .arg(url)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open exited with {status}"))
    }
}

/// Whether a request failure means the recorded connection is stale: the
/// service process is gone (`service request failed: …`), or the service was
/// restarted under a live host and issues a fresh session token now (HTTP 403).
fn connection_is_stale(error: &str) -> bool {
    error.starts_with("service request failed:") || error.contains("service returned HTTP 403")
}

/// HTTP GET from the service, healing a stale connection once.
async fn service_get(state: &PanelState, path: &str) -> Result<Value, String> {
    let origin = state.service_endpoint().origin;
    match service_get_once(&origin, path).await {
        Ok(value) => Ok(value),
        Err(error) if connection_is_stale(&error) => {
            state.reconnect_service().await?;
            let origin = state.service_endpoint().origin;
            service_get_once(&origin, path).await
        }
        Err(error) => Err(error),
    }
}

/// One HTTP GET attempt against an origin snapshot.
async fn service_get_once(origin: &str, path: &str) -> Result<Value, String> {
    let url = format!("{origin}{path}");
    let response = reqwest::get(&url)
        .await
        .map_err(|error| format!("service request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("service returned HTTP {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|error| format!("service returned invalid JSON: {error}"))
}

/// HTTP mutation to the service (with the session token), healing a stale
/// connection once.
async fn service_mutation(
    state: &PanelState,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let endpoint = state.service_endpoint();
    match service_mutation_once(&endpoint, method, path, body.clone()).await {
        Ok(value) => Ok(value),
        Err(error) if connection_is_stale(&error) => {
            state.reconnect_service().await?;
            let endpoint = state.service_endpoint();
            service_mutation_once(&endpoint, method, path, body).await
        }
        Err(error) => Err(error),
    }
}

/// One HTTP mutation attempt against an endpoint snapshot.
async fn service_mutation_once(
    endpoint: &ServiceEndpoint,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{}{}", endpoint.origin, path);
    let client = reqwest::Client::new();
    let mut request = match method {
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "POST" => client.post(&url),
        other => return Err(format!("unsupported mutation method {other}")),
    }
    .header("x-session-token", &endpoint.session_token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("service request failed: {error}"))?;
    if response.status().is_success() {
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        return response
            .json()
            .await
            .map_err(|error| format!("service returned invalid JSON: {error}"));
    }
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    Err(format!("service returned HTTP {status}: {text}"))
}

// ---------------------------------------------------------------------------
// Restricted bridge commands (task 5.1)
// ---------------------------------------------------------------------------

/// How long a re-collection is allowed to take before its snapshot is read back.
///
/// The service acknowledges a manual refresh before it has an answer (the panel
/// reads the snapshot afterwards for the same reason), so the emit waits a beat
/// rather than sending a snapshot taken before the request landed. Short enough that
/// the card answers while the user is still looking at the setting they changed.
const RECOLLECT_SETTLE_MS: u64 = 1_200;

/// The platforms a settings write makes stale, so they are collected again.
///
/// Everything else a settings write can change is presentation — theme, quota value
/// mode, reset formats, platform visibility and order, peak schedules — and needs no
/// collection. These are the writes that change *what* would be collected: which
/// region's endpoint answers, which CLI collects Codex, and which experimental
/// connections are on at all. Credentials are handled by their own commands, which
/// always re-collect the platform they belong to.
///
/// This judgement lives in the host rather than in the window that made the write,
/// because the collected cards are in the *other* window: the settings window writes
/// `glmRegion`, and the platform card that has to answer for it is in the panel.
/// Keeping it here also means every entry point — the panel's own toggles today, the
/// settings window, and whatever comes next — is correct without repeating the rule.
///
/// Mirrored from the wording of the panel's own rule ("a setting that changes what
/// would be collected is collected again right away, so the card shows the answer to
/// the setting the user just made instead of the previous one"): without it, a
/// region switch kept showing the previous region's quota until the next scheduled
/// pass, which reads as "the setting did nothing".
fn providers_to_recollect(patch: &Value) -> Vec<&'static str> {
    let Some(fields) = patch.as_object() else {
        return Vec::new();
    };
    let mut providers: Vec<&'static str> = Vec::new();
    let mut push = |provider: &'static str| {
        if !providers.contains(&provider) {
            providers.push(provider);
        }
    };
    // Presence, not truth: switching the wallet off is *also* a change to what would
    // be collected, exactly as the TS rule reads (`!== undefined`).
    if fields.contains_key("glmRegion") {
        push("glm");
    }
    // The experimental connections only collect when they are switched *on*, which is
    // what `=== true` says on the panel side: switching one off needs no collection,
    // and re-collecting there would spend a request to learn nothing.
    if fields.get("glmWalletEnabled") == Some(&Value::Bool(true)) {
        push("glm");
    }
    if fields.get("deepseekWebEnabled") == Some(&Value::Bool(true)) {
        push("deepseek");
    }
    if fields.contains_key("codexCliPath") {
        push("codex");
    }
    providers
}

/// Which platform a credential belongs to.
///
/// Both experimental connections sit on the platform whose card shows them, so
/// saving either one collects that platform: the wallet credential is GLM's and the
/// web credential is DeepSeek's.
fn provider_of_credential(target: &str) -> Option<&'static str> {
    match target {
        "glm" | "glm-wallet" => Some("glm"),
        "deepseek" | "deepseek-web" => Some("deepseek"),
        "codex" => Some("codex"),
        _ => None,
    }
}

/// Collect the named platforms once, right away.
///
/// The service answers a manual refresh with "received and running", so the verdict
/// is not in the answer: the snapshot is read again after the requests land, and only
/// then emitted. That keeps the two windows' cards consistent and avoids a second
/// emit from the periodic forwarder in the same second.
fn recollect_now(app: AppHandle, providers: Vec<&'static str>) {
    if providers.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        for provider in providers {
            let result = {
                let state = app.state::<PanelState>();
                service_mutation(&state, "POST", &format!("/api/refresh/{provider}"), None).await
            };
            if let Err(error) = result {
                // A refused refresh (a cooldown, a service that went away) is not
                // worth a message: the card already shows the reading that made the
                // request, and the periodic pass will try again.
                diag_log(&format!("recollect {provider} refused: {error}"));
            }
        }
        // Let the collection land before reading it back: the service acknowledges
        // the request before it has an answer, which is why the panel reads the
        // snapshot instead of trusting the reply.
        tokio::time::sleep(Duration::from_millis(RECOLLECT_SETTLE_MS)).await;
        let snapshot = {
            let state = app.state::<PanelState>();
            service_get(&state, "/api/snapshots").await
        };
        match snapshot {
            Ok(value) => {
                let _ = app.emit("panel://snapshot", value);
            }
            Err(error) => diag_log(&format!("recollect snapshot failed: {error}")),
        }
    });
}

#[tauri::command]
async fn panel_snapshot(state: tauri::State<'_, PanelState>) -> Result<Value, String> {
    service_get(&state, "/api/snapshots").await
}

#[tauri::command]
async fn panel_settings(
    app: AppHandle,
    state: tauri::State<'_, PanelState>,
) -> Result<Value, String> {
    let settings = service_get(&state, "/api/settings").await?;
    *state
        .minimal_mode
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        settings["panelDisplayMode"] == "minimal";
    // This read is the first thing that tells the host which shape and which theme are
    // persisted — the tray menu is built long before the webview asks — so it is also
    // where the tray's radio groups stop guessing.
    sync_tray_mode(&app);
    sync_tray_theme(
        &app,
        settings["theme"].as_str().unwrap_or(TRAY_DEFAULT_THEME),
    );
    Ok(settings)
}

/// Write settings, then tell **every** window what they became.
///
/// The broadcast is what makes a change made in one window visible in the other
/// without a re-open, and it is deliberately the host's job: the two windows are
/// separate webviews with separate JavaScript, so a write in the settings window
/// reaches the panel only if the process that owns both says so. `app.emit` goes to
/// all webviews, so this one call serves both.
///
/// The window that made the write adopts the returned value immediately (see
/// `settings-store.ts`), so the echo that follows is recognised as the same value
/// rather than a second change.
///
/// This is the host's only settings write, and the tray's mode and theme groups go
/// through it too: a second path for the same write is how the panel bookkeeping, the
/// re-frame, the broadcast and the menu's own check marks drift apart from one of their
/// callers.
async fn write_settings(app: &AppHandle, patch: Value) -> Result<Value, String> {
    let state = app.state::<PanelState>();
    let next = service_mutation(&state, "PUT", "/api/settings", Some(patch.clone())).await?;
    if patch.get("panelDisplayMode").is_some() {
        let minimal = next["panelDisplayMode"] == "minimal";
        let mut mode = state
            .minimal_mode
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let left_minimal = *mode && !minimal;
        *mode = minimal;
        // Dropped before the re-frame: `set_full_layout` reads nothing from the
        // state, but a lock held across window work is a lock held across however
        // long the window server takes.
        drop(mode);
        // A switch back to the full panel is not a show: the window is already up,
        // and the panel's height path only ever reports a height, so without this
        // the window would stay rail-wide at the rail's anchor, showing a 350-point
        // panel's content squeezed into 58 points.
        if left_minimal {
            set_full_layout(app);
        }
        // The mode the write carried is also what the tray's group now shows.
        sync_tray_mode(app);
    }
    if patch.get("theme").is_some() {
        // Same guard, same reason: a write that did not carry the theme leaves the
        // group alone, because its answer still holds the theme from before. The tray
        // lives outside both windows, so this is the only side that can correct it.
        sync_tray_theme(app, next["theme"].as_str().unwrap_or(TRAY_DEFAULT_THEME));
    }
    let _ = app.emit("panel://settings", next.clone());
    recollect_now(app.clone(), providers_to_recollect(&patch));
    Ok(next)
}

#[tauri::command]
async fn panel_update_settings(app: AppHandle, patch: Value) -> Result<Value, String> {
    write_settings(&app, patch).await
}

#[tauri::command]
async fn panel_refresh(
    state: tauri::State<'_, PanelState>,
    provider: String,
) -> Result<Value, String> {
    service_mutation(&state, "POST", &format!("/api/refresh/{provider}"), None).await
}

#[tauri::command]
async fn panel_validate_credential(
    app: AppHandle,
    state: tauri::State<'_, PanelState>,
    target: String,
    secret: String,
) -> Result<Value, String> {
    let status = service_mutation(
        &state,
        "PUT",
        &format!("/api/credentials/{target}"),
        Some(json!({ "secret": secret })),
    )
    .await?;
    // A credential that just validated is a connection that just became usable, so
    // collect it right away — the same reasoning as a collection-affecting setting.
    // Without it the card went on showing nothing (or the previous reading) until the
    // next scheduled pass, and coming back from a fresh, working key to an empty card
    // reads as "the key was wrong".
    recollect_now(app, provider_of_credential(&target).into_iter().collect());
    Ok(status)
}

#[tauri::command]
async fn panel_delete_credential(
    app: AppHandle,
    state: tauri::State<'_, PanelState>,
    target: String,
) -> Result<Value, String> {
    let result = service_mutation(
        &state,
        "DELETE",
        &format!("/api/credentials/{target}"),
        None,
    )
    .await?;
    // Deleting is the other half of the same rule: the connection is now unusable, so
    // collect again and let the service say so. The card itself is already back to
    // its template (a credential is part of its display gate), but the connection's
    // own status line would otherwise go on claiming 数据正常 from a reading whose key
    // no longer exists.
    recollect_now(app, provider_of_credential(&target).into_iter().collect());
    Ok(result)
}

#[tauri::command]
fn panel_pinned_state(state: tauri::State<'_, PanelState>) -> bool {
    *state
        .pinned
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
fn panel_set_pinned(app: AppHandle, state: tauri::State<'_, PanelState>, pinned: bool) -> bool {
    set_pinned(&app, pinned);
    if let Ok(mut guard) = state.pinned.lock() {
        *guard = pinned;
    }
    pinned
}

#[tauri::command]
fn panel_hide(app: AppHandle) {
    // Escape (or the panel's own close affordance) hides with the same
    // transition as a tray toggle.
    diag_log("panel_hide command");
    hide_panel(&app);
}

/// A window's top-left corner in the points of the display it is on.
///
/// tao turns a *physical* position into window coordinates with the scale factor
/// of the display the window is on right now, so reading and writing a position
/// both have to go through that factor — the same reason `position_near_tray`
/// builds a logical target.
fn window_origin_points(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    window
        .outer_position()
        .ok()
        .map(|position| (f64::from(position.x) / scale, f64::from(position.y) / scale))
}

/// A window's height in points, or `fallback` when the frame cannot be read.
///
/// The width is deliberately not read the same way: a window hidden in the rail's
/// shape still reports the rail's 58 points until a queued resize lands, so any frame
/// that has to be anchored at the full width takes that width from `PANEL_WIDTH`
/// instead — see `show_full_panel`.
fn window_height_points(window: &WebviewWindow, fallback: f64) -> f64 {
    let scale = window.scale_factor().unwrap_or(1.0);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    window
        .outer_size()
        .ok()
        .map(|size| size.height as f64 / scale)
        .unwrap_or(fallback)
}

/// Return the smallest translation that puts a dropped panel back on-screen.
///
/// A panel that is already covered by the union of all displays stays exactly
/// where the user dropped it, including when it straddles a shared edge. Once
/// any part leaves that union, each display offers its nearest fully-contained
/// position and the shortest translation wins.
fn boundary_clamp_target(
    screens: &[DisplayBounds],
    origin: (f64, f64),
    size: (f64, f64),
    mouse_down: bool,
) -> Option<(f64, f64)> {
    if mouse_down
        || !origin.0.is_finite()
        || !origin.1.is_finite()
        || size.0 <= 0.0
        || size.1 <= 0.0
    {
        return None;
    }
    let area = |screen: &DisplayBounds| {
        let left = origin.0.max(screen.left());
        let right = (origin.0 + size.0).min(screen.right());
        let top = origin.1.max(screen.top());
        let bottom = (origin.1 + size.1).min(screen.bottom());
        (right - left).max(0.0) * (bottom - top).max(0.0)
    };
    let panel_area = size.0 * size.1;
    if screens.iter().map(area).sum::<f64>() >= panel_area - 0.5 {
        return None;
    }

    screens
        .iter()
        .map(|screen| {
            let target = (
                origin
                    .0
                    .clamp(screen.left(), (screen.right() - size.0).max(screen.left())),
                origin
                    .1
                    .clamp(screen.top(), (screen.bottom() - size.1).max(screen.top())),
            );
            let dx = target.0 - origin.0;
            let dy = target.1 - origin.1;
            (target, dx * dx + dy * dy, area(screen))
        })
        .min_by(|left, right| {
            left.1
                .total_cmp(&right.1)
                .then_with(|| right.2.total_cmp(&left.2))
        })
        .map(|(target, _, _)| target)
}

fn resized_native_origin_y(current_y: f64, current_height: f64, next_height: f64) -> f64 {
    current_y + current_height - next_height
}

fn resized_native_origin_x_keep_right(current_x: f64, current_width: f64, next_width: f64) -> f64 {
    current_x + current_width - next_width
}

/// Resize one native frame atomically while retaining its current top-left.
/// Reading the frame inside the queued main-thread operation is load-bearing:
/// a drag may move the window before this height frame reaches AppKit.
#[cfg(target_os = "macos")]
fn set_panel_size(app: &AppHandle, window: &WebviewWindow, width: f64, height: f64) {
    let Ok(pointer) = window.ns_window() else {
        return;
    };
    let pointer = pointer as usize;
    let _ = app.run_on_main_thread(move || unsafe {
        let window = &*(pointer as *mut objc2_app_kit::NSWindow);
        let mut frame = window.frame();
        frame.origin.y = resized_native_origin_y(frame.origin.y, frame.size.height, height);
        frame.size.width = width;
        frame.size.height = height;
        window.setFrame_display(frame, true);
    });
}

/// Move and resize the panel in one native frame update.
///
/// With no `target` the right edge stays fixed, which is what lets the rail's detail
/// grow to the left without moving the rail. With a `target` the window is placed
/// there — the one atomic move a mode switch needs, since a separate position and
/// size would be two frames of a window visibly jumping between them.
#[cfg(target_os = "macos")]
fn apply_panel_frame(
    app: &AppHandle,
    window: &WebviewWindow,
    width: f64,
    height: f64,
    target: Option<(f64, f64)>,
) {
    let Ok(pointer) = window.ns_window() else {
        return;
    };
    let current = window_origin_points(window);
    let pointer = pointer as usize;
    let _ = app.run_on_main_thread(move || unsafe {
        let window = &*(pointer as *mut objc2_app_kit::NSWindow);
        let mut frame = window.frame();
        if let (Some((target_x, target_y)), Some((current_x, current_y))) = (target, current) {
            frame.origin.x += target_x - current_x;
            frame.origin.y += current_y - target_y;
        } else {
            frame.origin.x =
                resized_native_origin_x_keep_right(frame.origin.x, frame.size.width, width);
            frame.origin.y += frame.size.height - height;
        }
        frame.size.width = width;
        frame.size.height = height;
        window.setFrame_display(frame, true);
    });
}

#[cfg(not(target_os = "macos"))]
fn apply_panel_frame(
    _app: &AppHandle,
    window: &WebviewWindow,
    width: f64,
    height: f64,
    target: Option<(f64, f64)>,
) {
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if let Some((x, y)) = target {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
}

#[cfg(not(target_os = "macos"))]
fn set_panel_size(_app: &AppHandle, window: &WebviewWindow, width: f64, height: f64) {
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
}

/// Put the full panel's frame on its tray anchor in one native update.
///
/// The width is stated rather than read: a window that was hidden in the rail's shape
/// is still 58 points wide while the panel's own height report is on its way, and
/// anchoring it as if it were the full width leaves the 350-point panel hanging off the
/// screen edge — the correction only arrives from the boundary tracker, as a jump.
/// `apply_panel_frame` therefore gets a size the caller already knows, and moves and
/// resizes together so there is no frame at neither size.
fn show_full_panel(
    app: &AppHandle,
    window: &WebviewWindow,
    anchor: Option<tauri::Rect>,
    height: f64,
) {
    let width = PANEL_WIDTH;
    let target = full_panel_target(app, window, anchor, width, height);
    match target {
        Some(target) => apply_panel_frame(app, window, width, height, Some((target.x, target.y))),
        None => apply_panel_frame(app, window, width, height, None),
    }
}

#[cfg(target_os = "macos")]
async fn primary_mouse_pressed(app: &AppHandle) -> Option<bool> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // Native window dragging owns the main thread until mouse-up. Sampling
    // AppKit there also keeps a queued check from correcting a mid-drag frame.
    app.run_on_main_thread(move || {
        let buttons = objc2_app_kit::NSEvent::pressedMouseButtons();
        let _ = sender.send(buttons & 1 != 0);
    })
    .ok()?;
    receiver.await.ok()
}

#[cfg(not(target_os = "macos"))]
async fn primary_mouse_pressed(_app: &AppHandle) -> Option<bool> {
    Some(false)
}

fn start_boundary_tracking(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(CURSOR_POLL_MS)).await;
            if app_handle.get_webview_window(MINIMAL_DETAIL_LABEL)
                .and_then(|window| window.is_visible().ok()) == Some(true) {
                let _ = place_minimal_detail(&app_handle);
            }
            let Some(window) = app_handle.get_webview_window("panel") else {
                continue;
            };
            if window.is_visible().ok() != Some(true) {
                continue;
            }
            let Some(mouse_down) = primary_mouse_pressed(&app_handle).await else {
                continue;
            };
            if mouse_down {
                continue;
            }
            let Some(origin) = window_origin_points(&window) else {
                continue;
            };
            let Ok(size) = window.outer_size() else {
                continue;
            };
            let scale = window.scale_factor().unwrap_or(1.0);
            let scale = if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            };
            let size = (
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            );
            let Ok(monitors) = app_handle.available_monitors() else {
                continue;
            };
            let screens: Vec<_> = monitors
                .iter()
                .map(|monitor| DisplayBounds::from_monitor(monitor, display_scale(monitor)))
                .collect();
            if let Some(target) = boundary_clamp_target(&screens, origin, size, false) {
                let _ = window.set_position(LogicalPosition::new(target.0, target.1));
            }
        }
    });
}

/// Size the window to the height the panel asked for.
///
/// The panel measures its own content (it is the only side that can) and asks;
/// this clamps the request to the display and changes the native frame atomically
/// around its live top-left, so a queued height frame cannot replay an old drag
/// position after mouse-up.
#[tauri::command]
fn panel_set_height(app: AppHandle, height: f64) -> f64 {
    let Some(window) = app.get_webview_window("panel") else {
        return PANEL_MIN_WINDOW_HEIGHT;
    };
    // A height report belongs to the window's present display. The last tray
    // anchor can be on another display after a manual drag; reusing it here
    // pulled the panel back across screens every time the header collapsed.
    let monitor = window.current_monitor().ok().flatten();
    let work_area = monitor.as_ref().map(work_area_points);
    let requested = height;
    // The height stays the panel's measurement, clamped only by the display: the
    // window is not the panel's to resize *down* either. It is the window's
    // position that moves when the two disagree.
    let height = clamp_panel_height(requested, work_area.as_ref().map(|area| area.height));
    diag_log(&format!(
        "panel_set_height requested={requested:.0} applied={height:.0}"
    ));
    set_panel_size(&app, &window, PANEL_WIDTH, height);
    // The resize lands on the next runloop turn, so confirm what the window
    // actually became rather than what was requested.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(window) = app_handle.get_webview_window("panel") {
            if let Ok(size) = window.outer_size() {
                diag_log(&format!("panel size now {}x{}", size.width, size.height));
            }
        }
    });
    height
}

/// How far the rail's right edge sits from its display's right edge.
///
/// Flush: the rail hangs off the menu bar's right end, where a status item's own menu
/// would be, and the work-area clamp below is what keeps it out of a Dock that reserves
/// that strip.
const MINIMAL_RAIL_RIGHT_INSET: f64 = 0.0;

/// How far the rail's top edge sits below its display's top edge: clear of the menu bar,
/// level with the tray icon.
const MINIMAL_RAIL_TOP_INSET: f64 = 40.0;

/// A display-relative point rectangle for the rail and its optional left detail.
fn minimal_panel_frame(
    display: DisplayBounds,
    work: DisplayBounds,
    requested_width: f64,
    requested_height: f64,
) -> (f64, f64, f64, f64) {
    let rail_right =
        (display.right() - MINIMAL_RAIL_RIGHT_INSET).clamp(work.left(), work.right());
    let width = requested_width
        .max(58.0)
        .min((rail_right - work.left()).max(1.0));
    let x = rail_right - width;
    let y = (display.top() + MINIMAL_RAIL_TOP_INSET).clamp(work.top(), work.bottom());
    let height = requested_height.max(1.0).min((work.bottom() - y).max(1.0));
    (x, y, width, height)
}

/// Position the independent card from the rail's current top-left, never by
/// changing the rail frame. The centre of each 64-point slot advances by 68.
///
/// The card never rises above the rail's own top edge: the rail is the shape the
/// reader is pointing at, and a card whose head sat above it read as a second panel
/// that had escaped the first. A card too tall for the room below the rail's top is
/// therefore pushed *down*, and the caret follows the ring it belongs to rather than
/// the card's own centre.
fn minimal_detail_frame(
    rail: (f64, f64),
    index: u32,
    requested_height: f64,
    work: DisplayBounds,
) -> (f64, f64, f64, f64, f64) {
    // Reserve the seven-point rail gap inside the transparent child so the
    // card's outward caret is painted inside its native frame. 332 is the card
    // (330) plus the detail's own border on both sides; the same number is
    // `MINIMAL_DETAIL_WIDTH` in `src/desktop/panel/minimal-layout.ts`.
    let width = 339.0_f64.min((rail.0 - work.left()).max(1.0));
    let height = requested_height.max(1.0).min(work.height);
    let x = (rail.0 - width).max(work.left());
    let anchor_y = rail.1 + 37.0 + f64::from(index) * 68.0;
    let top = rail.1.max(work.top());
    let y = (anchor_y - height / 2.0).clamp(top, (work.bottom() - height).max(top));
    let caret = (anchor_y - y).clamp(14.0, (height - 14.0).max(14.0));
    (x, y, width, height, caret)
}

#[tauri::command]
fn panel_set_minimal_layout(app: AppHandle, _width: f64, height: f64, anchor: bool) -> (f64, f64) {
    // Width changes caused the rail's transparent native surface to blink.
    let width = 58.0;
    let Some(window) = app.get_webview_window("panel") else {
        return (width, height);
    };
    let current_width = window
        .outer_size()
        .ok()
        .map(|size| size.width as f64 / window.scale_factor().unwrap_or(1.0))
        .unwrap_or(58.0);
    let current_origin = window_origin_points(&window).unwrap_or((0.0, 0.0));
    let monitor = if anchor {
        window.current_monitor().ok().flatten()
    } else {
        app.available_monitors()
            .ok()
            .and_then(|monitors| {
                monitors.into_iter().find(|monitor| {
                    let bounds = DisplayBounds::from_monitor(monitor, display_scale(monitor));
                    bounds.spans_x(current_origin.0 + current_width)
                })
            })
            .or_else(|| window.current_monitor().ok().flatten())
    };
    let Some(monitor) = monitor else {
        return (width, height);
    };
    let display = DisplayBounds::from_monitor(&monitor, display_scale(&monitor));
    let work = work_area_points(&monitor);
    let (x, y, anchored_width, anchored_height) = minimal_panel_frame(display, work, width, height);
    // Pure content changes honour a rail the user dragged elsewhere on this display.
    let (applied_width, applied_height) = if anchor {
        (anchored_width, anchored_height)
    } else {
        (
            width
                .max(58.0)
                .min((current_origin.0 + current_width - work.left()).max(1.0)),
            height
                .max(1.0)
                .min((work.bottom() - current_origin.1).max(1.0)),
        )
    };
    let target = if anchor { Some((x, y)) } else { None };
    apply_panel_frame(&app, &window, applied_width, applied_height, target);
    // The same diagnostic the full panel's height path writes, for the same reason:
    // when the rail's frame looks wrong, the question is always whether the front end
    // asked for the wrong size or the host applied a different one.
    diag_log(&format!(
        "minimal layout requested={width:.0}x{height:.0} anchor={anchor} applied={applied_width:.0}x{applied_height:.0}"
    ));
    (applied_width, applied_height)
}

#[tauri::command]
fn panel_open_web_version(state: tauri::State<'_, PanelState>) -> Result<(), String> {
    open_url(&state.service_endpoint().origin)
}

const MINIMAL_DETAIL_LABEL: &str = "minimal-detail";
const MINIMAL_DETAIL_DISMISS_EVENT: &str = "panel://minimal-detail-dismiss";

/// The child webview reads host state even when hidden, so an early hover cannot
/// be lost while its document is still loading.
#[tauri::command]
fn panel_detail_current(app: AppHandle) -> Value {
    let detail = app.state::<PanelState>();
    let detail = detail.minimal_detail.lock().unwrap_or_else(|p| p.into_inner());
    json!({ "selection": detail.selection, "index": detail.index, "generation": detail.generation })
}

#[tauri::command]
fn panel_set_minimal_detail(app: AppHandle, selection: Option<String>, index: u32) {
    let selection = selection.filter(|value| {
        matches!(value.as_str(), "codex" | "glm" | "deepseek" | "connection")
    });
    let generation = {
        let state = app.state::<PanelState>();
        let mut detail = state.minimal_detail.lock().unwrap_or_else(|p| p.into_inner());
        if detail.selection == selection && detail.index == index {
            return;
        }
        detail.selection = selection.clone();
        detail.index = index;
        detail.generation = detail.generation.wrapping_add(1);
        detail.generation
    };
    diag_log(&format!("detail select={selection:?} index={index}"));
    if let Some(window) = app.get_webview_window(MINIMAL_DETAIL_LABEL) {
        let payload = json!({ "selection": selection, "index": index, "generation": generation });
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('panel:minimal-detail-selection', {{ detail: {payload} }}))"
        ));
    }
    if selection.is_none() {
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(170)).await;
            let state = app_handle.state::<PanelState>();
            let detail = state.minimal_detail.lock().unwrap_or_else(|p| p.into_inner());
            if detail.generation == generation && detail.selection.is_none() {
                if let Some(window) = app_handle.get_webview_window(MINIMAL_DETAIL_LABEL) {
                    let _ = window.eval(
                        "window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: null }))",
                    );
                    let _ = window.hide();
                }
            }
        });
    }
}

fn dismiss_minimal_detail(app: &AppHandle, focus: bool) {
    let active = app.state::<PanelState>()
        .minimal_detail.lock().unwrap_or_else(|p| p.into_inner())
        .selection.is_some();
    if !active { return; }
    panel_set_minimal_detail(app.clone(), None, 0);
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('panel:minimal-detail-dismiss', {{ detail: {{ focus: {focus} }} }}))"
        ));
    }
    let _ = app.emit(MINIMAL_DETAIL_DISMISS_EVENT, json!({ "focus": focus }));
}

#[tauri::command]
fn panel_detail_dismiss(app: AppHandle, focus: bool) {
    dismiss_minimal_detail(&app, focus);
}

/// Only the child frame moves or changes height. The rail stays 58 points wide.
fn place_minimal_detail(app: &AppHandle) -> Option<(f64, f64)> {
    let rail = app.get_webview_window("panel")?;
    let detail = app.get_webview_window(MINIMAL_DETAIL_LABEL)?;
    let origin = window_origin_points(&rail)?;
    let monitor = rail.current_monitor().ok().flatten()?;
    let work = work_area_points(&monitor);
    let state = app.state::<PanelState>();
    let state = state.minimal_detail.lock().unwrap_or_else(|p| p.into_inner());
    state.selection.as_ref()?;
    if state.height <= 0.0 { return None; }
    let (x, y, width, height, caret) = minimal_detail_frame(origin, state.index, state.height, work);
    drop(state);
    let scale = detail.scale_factor().unwrap_or(1.0);
    let current_size = detail.outer_size().ok();
    if current_size.is_none_or(|size| {
        (f64::from(size.width) / scale - width).abs() > 0.5
            || (f64::from(size.height) / scale - height).abs() > 0.5
    }) {
        let _ = detail.set_size(LogicalSize::new(width, height));
    }
    if window_origin_points(&detail).is_none_or(|(current_x, current_y)| {
        (current_x - x).abs() > 0.5 || (current_y - y).abs() > 0.5
    }) {
        let _ = detail.set_position(LogicalPosition::new(x, y));
    }
    Some((caret, height))
}

#[tauri::command]
fn panel_detail_layout(app: AppHandle, height: f64) -> Option<Value> {
    if !height.is_finite() || height <= 0.0 { return None; }
    {
        let state = app.state::<PanelState>();
        let mut detail = state.minimal_detail.lock().unwrap_or_else(|p| p.into_inner());
        detail.selection.as_ref()?;
        detail.height = height;
    }
    let (caret, applied_height) = place_minimal_detail(&app)?;
    diag_log(&format!("detail layout requested={height:.0} applied={applied_height:.0}"));
    if let Some(window) = app.get_webview_window(MINIMAL_DETAIL_LABEL) {
        let _ = window.show();
    }
    Some(json!({ "caret": caret, "height": applied_height }))
}

// The settings-window commands are declared *after* `panel_open_web_version` on
// purpose: `a_native_resize_keeps_the_current_top_edge` reads the source between
// `panel_set_height` and this command to prove the height path never enqueues a
// stale drag position, so anything inserted before it would be read as part of that
// check.

/// Open the settings window, or move the existing one to the requested section.
///
/// `section` is optional because only two of the four entry points name one (a
/// card's gear names its platform; the empty state's button names 平台管理), and an
/// unknown or absent name has to land somewhere sensible rather than failing.
#[tauri::command]
fn panel_open_settings(app: AppHandle, section: Option<String>) -> Result<(), String> {
    open_settings(&app, section.as_deref())
}

/// Settings window -> host: the first render is on screen; show the window.
#[tauri::command]
fn panel_settings_ready(app: AppHandle) {
    reveal_settings_window(&app);
}

/// Settings window -> host: which section should be showing.
///
/// The durable half of the section handoff. `panel://settings-section` is the fast path
/// while the window is up and listening, but a webview that has only just been created
/// has no listener yet: a request that arrives in those first frames would be lost, and
/// the window would open on whatever the window was built with. The host records the
/// request instead and the window asks for it once it is mounted, so the section is
/// right whichever way the timing falls.
#[tauri::command]
fn panel_settings_section(app: AppHandle) -> String {
    let state = app.state::<PanelState>();
    let current = state
        .settings_section
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    (*current).to_string()
}

// ---------------------------------------------------------------------------
// Window behaviour (tasks 5.2–5.6)
// ---------------------------------------------------------------------------

/// Logical inset between the panel and the status bar / screen edge.
const PANEL_MARGIN: f64 = 10.0;

/// Panel width in logical pixels: the content is designed for it and never resizes.
const PANEL_WIDTH: f64 = 350.0;
/// Ceiling for the self-sized panel, whatever the content asks for.
///
/// A display usually binds first (`work_area_height - 2 * PANEL_MARGIN`); this is the
/// number for the case where it does not — a monitor lookup that failed, or a display
/// taller than the panel should ever be.
const PANEL_MAX_HEIGHT: f64 = 900.0;

/// The smallest height the host will apply, whatever it is asked for.
///
/// This is not a design decision about the panel's content — that is the panel's to
/// make, and the old 320-point floor belonged to a rule (three whole cards, else a
/// minimum) that no longer exists. It is the host's own sanity bound, low enough that
/// no real request can reach it: a shorter window has no title bar to grab, and a
/// display whose work area is tiny would otherwise be able to invert the clamp.
const PANEL_MIN_WINDOW_HEIGHT: f64 = 40.0;

/// Clamp a requested panel height to something a display can actually show.
///
/// Split out from the command so the bounds are testable without a window: the panel
/// asks for the height its content needs, and this decides how much of that request
/// the screen allows. It only ever cuts a request *down*; a short request is honoured
/// as it stands, because a short overview is a short panel.
fn clamp_panel_height(requested: f64, work_area_height: Option<f64>) -> f64 {
    let upper = match work_area_height.map(|height| height - 2.0 * PANEL_MARGIN) {
        Some(limit) if limit.is_finite() => limit.clamp(PANEL_MIN_WINDOW_HEIGHT, PANEL_MAX_HEIGHT),
        _ => PANEL_MAX_HEIGHT,
    };
    if requested.is_nan() {
        // Nothing comparable in the request at all. The `upper` bound is the honest
        // answer: it is the largest height the window may take, and the panel will
        // correct it on its next measurement.
        return upper;
    }
    // `clamp` with the bound below the ceiling: `upper` is raised to the sanity bound
    // above, so the two never cross — and `clamp` panics when they do, which is exactly
    // what a display shorter than the bound would do to a hand-written comparison.
    requested.clamp(PANEL_MIN_WINDOW_HEIGHT.min(upper), upper)
}
/// How long the panel's exit animation is allowed to run before the window is
/// hidden.
///
/// Kept in sync with the 260ms CSS transition in `src/desktop/panel.css`, plus
/// room for the event to reach the webview and the first frame of the transition
/// to start: shortening this below the CSS duration cuts the fade off mid-flight,
/// which is exactly the "something vanished too early" artefact.
const PANEL_HIDE_ANIMATION_MS: u64 = 300;

/// How long the pointer may stay off the panel before its header is invited to
/// settle away.
const PANEL_HEADER_HIDE_DELAY_MS: u64 = 5_000;

/// How long the rail waits before collapsing its actions: not at all.
///
/// The rail's three actions are a hover affordance that only has room while the
/// pointer is on the rail, so the moment the pointer leaves is the moment they go;
/// waiting reads as the actions being left behind on a shape that has already moved
/// on. The full panel keeps `PANEL_HEADER_HIDE_DELAY_MS`, so a pointer that dips out
/// of the panel for a moment does not make its header flicker.
const MINIMAL_HEADER_HIDE_DELAY_MS: u64 = 0;

/// Intended visibility plus a counter that invalidates a pending animated hide.
#[derive(Debug, Default)]
struct VisibilityState {
    generation: u64,
    showing: bool,
}

fn build_panel_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("index.html".into()))
        .title("用量面板")
        .inner_size(350.0, 560.0)
        .min_inner_size(58.0, 1.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Transparent so the panel's own rounded corners are what the user sees.
        .transparent(true)
        // No native window shadow: the window server draws it from the window's
        // shape and leaves it behind while the webview fades out, so the panel
        // blinks out of a dark rounded outline. The panel's own border and
        // background give it its edge instead.
        .shadow(false)
        // Let the webview handle HTML5 drag and drop itself (platform reordering
        // on the settings page); the panel never accepts OS file drops.
        .disable_drag_drop_handler()
        .visible(false)
        .build()?;

    // Temporary popup collapses when it loses focus; a pinned panel stays open
    // (task 5.4). The header's collapse follows the pointer, but Tauri filters the
    // window server's cursor enter/leave out of `WindowEvent`, and a non-key
    // window's webview receives no pointer events — so the host polls the cursor
    // against the window bounds instead (see `start_cursor_tracking`). Record the
    // focus-hide time so a tray click that lands right after is not mistaken for a
    // fresh "show".
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(focused) = event {
            let pinned = panel_pinned(&app_handle);
            let visible = app_handle
                .get_webview_window("panel")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            diag_log(&format!(
                "focus({focused}) pinned={pinned} window_visible={visible}"
            ));
            if !*focused && !pinned && visible
                && !(panel_is_minimal(&app_handle) && cursor_over_detail(&app_handle) == Some(true)) {
                hide_panel(&app_handle);
            }
        }
    });

    Ok(window)
}

/// How often the host re-checks whether the pointer is over the panel.
const CURSOR_POLL_MS: u64 = 150;

/// How long the pointer poll waits for the window server's answer about what is under the
/// pointer before it moves on without a probe for this round.
const FRONT_WINDOW_SAMPLE_MS: Duration = Duration::from_millis(50);

/// One pointer position, expressed against a window's top-left in the window's own
/// logical points.
///
/// tao reports cursor coordinates at the primary display's scale and window
/// coordinates at the window's own scale, even though both share a point-space
/// origin. Comparing the raw physical values breaks on mixed-DPI displays.
fn point_in_window(
    cursor: (f64, f64),
    cursor_scale: f64,
    origin: (f64, f64),
    window_scale: f64,
) -> (f64, f64) {
    (
        cursor.0 / cursor_scale - origin.0 / window_scale,
        cursor.1 / cursor_scale - origin.1 / window_scale,
    )
}

/// Whether such a point lies inside a box of `size` that starts at the origin.
fn point_in_box(point: (f64, f64), size: (f64, f64)) -> bool {
    point.0 >= 0.0 && point.0 < size.0 && point.1 >= 0.0 && point.1 < size.1
}

/// `AppHandle::cursor_position` uses the primary display's scale, whereas the
/// window frame uses its own backing scale. Compare them only after converting
/// both to the shared macOS point coordinate space.
fn cursor_over_panel(app: &AppHandle) -> Option<bool> {
    cursor_over_window(app, "panel")
}

fn cursor_over_detail(app: &AppHandle) -> Option<bool> {
    cursor_over_window(app, MINIMAL_DETAIL_LABEL)
}

fn cursor_over_window(app: &AppHandle, label: &str) -> Option<bool> {
    let window = app.get_webview_window(label)?;
    if window.is_visible().ok() != Some(true) {
        return Some(false);
    }
    Some(cursor_point_in_window(app, &window).is_some())
}

/// A window's backing scale, with the zero and NaN a window can report while it is
/// still being created read as 1.
fn window_scale(window: &WebviewWindow) -> f64 {
    let scale = window.scale_factor().unwrap_or(1.0);
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// The scale `AppHandle::cursor_position` reports at: the primary display's.
fn cursor_scale(app: &AppHandle) -> f64 {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| display_scale(&monitor))
        .unwrap_or(1.0)
}

/// Where the pointer is inside a window, in that window's own logical points.
///
/// `None` when it is outside the window or cannot be placed at all (no cursor reading,
/// no display to scale against). Both mean "not over this window" to every caller, and
/// the rail — the one caller that needs the coordinates rather than a yes or no — reads
/// them the same way.
fn cursor_point_in_window(app: &AppHandle, window: &WebviewWindow) -> Option<(f64, f64)> {
    let cursor = app.cursor_position().ok()?;
    let origin = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window_scale(window);
    let point = point_in_window(
        (cursor.x, cursor.y),
        cursor_scale(app),
        (f64::from(origin.x), f64::from(origin.y)),
        scale,
    );
    let size = (f64::from(size.width) / scale, f64::from(size.height) / scale);
    point_in_box(point, size).then_some(point)
}

/// Whether the window a click at the pointer would go to is the one the rail draws in.
///
/// A window number of zero means the window server found nothing there, and a number we
/// could not read means we do not know: both keep the probe alive, because its whole
/// purpose is a rail that still answers the pointer. Only a *different* window — which is
/// what a slid-out Dock or an open menu is — suppresses it.
fn frontmost_is_ours(topmost: isize, ours: isize) -> bool {
    topmost == 0 || ours == 0 || topmost == ours
}

/// Poll the pointer against the panel bounds and drive the header from the
/// enter/leave transitions, since Tauri exposes neither cursor events nor a
/// way to let a non-key webview see the pointer.
fn header_tracking_transition(
    inside: &mut Option<bool>,
    visible: bool,
    pointer_inside: Option<bool>,
) -> Option<bool> {
    if !visible {
        *inside = None;
        return None;
    }
    let Some(now_inside) = pointer_inside else {
        *inside = None;
        return None;
    };
    if *inside == Some(now_inside) {
        return None;
    }
    *inside = Some(now_inside);
    Some(now_inside)
}

/// Poll the pointer against the panel's bounds and drive its header.
///
/// Scoped to the `panel` window on purpose, and the settings window is the reason
/// to say so out loud: the header belongs to the panel, so the pointer leaving the
/// *settings* window says nothing about it, and a poll that considered both windows
/// would keep the panel's header up while the user reads a form in the other one.
/// The settings window has no header to collapse: it wears system chrome.
fn start_cursor_tracking(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut inside = None;
        let mut outside_detail_since: Option<Instant> = None;
        // Which document the probe last painted in, so leaving it sends one clear.
        let mut probe_target: Option<&'static str> = None;
        loop {
            tokio::time::sleep(Duration::from_millis(CURSOR_POLL_MS)).await;
            let Some(panel) = app_handle.get_webview_window("panel") else {
                continue;
            };
            let visible = panel.is_visible().ok().unwrap_or(false);
            let action = header_tracking_transition(
                &mut inside,
                visible,
                visible.then(|| cursor_over_panel(&app_handle)).flatten(),
            );
            let detail_open = panel_is_minimal(&app_handle)
                && app_handle.state::<PanelState>()
                    .minimal_detail.lock().unwrap_or_else(|p| p.into_inner())
                    .selection.is_some()
                && app_handle.get_webview_window(MINIMAL_DETAIL_LABEL)
                    .and_then(|window| window.is_visible().ok()) == Some(true);
            if detail_open
                && cursor_over_panel(&app_handle) == Some(false)
                && cursor_over_detail(&app_handle) == Some(false)
            {
                if outside_detail_since.get_or_insert_with(Instant::now).elapsed() >= Duration::from_millis(180) {
                    dismiss_minimal_detail(&app_handle, false);
                    outside_detail_since = None;
                }
            } else {
                outside_detail_since = None;
            }
            // Hover, for a webview that cannot see the pointer.
            //
            // A webview only receives pointer events while its window is key, and neither
            // of the panel's windows can count on that: the panel's is unfocused whenever
            // the reader is working in another application, and the card's can never be
            // key at all. Pointing at a ring or at an action then did nothing — no card, no
            // switching, no hover — while the panel sat there always-on-top to be pointed
            // at. The host samples the pointer for the header anyway, so it hands each
            // document the one fact it cannot get for itself. The document answers with the
            // question a real `pointerenter` would ask, so a ring's selection keeps its
            // single owner; and the rail ignores the probe while its own pointer events are
            // arriving, which is what keeps a deliberate `Escape` closed.
            let mut painted: Option<&'static str> = None;
            if let Some(point) = cursor_point_in_window(&app_handle, &panel) {
                forward_pointer_probe(&app_handle, &panel, Some(point)).await;
                painted = Some("panel");
            }
            if let Some(detail) = app_handle.get_webview_window(MINIMAL_DETAIL_LABEL) {
                if detail.is_visible().ok() == Some(true) {
                    if let Some(point) = cursor_point_in_window(&app_handle, &detail) {
                        forward_pointer_probe(&app_handle, &detail, Some(point)).await;
                        painted = Some(MINIMAL_DETAIL_LABEL);
                    }
                }
            }
            // One clear per crossing, not one per poll: the window the pointer just left is
            // the only one that can still be holding a paint. (A window that goes away
            // while painted is cleared by its own hide path.)
            if painted != probe_target {
                if let Some(label) = probe_target {
                    if let Some(window) = app_handle.get_webview_window(label) {
                        forward_pointer_probe(&app_handle, &window, None).await;
                    }
                }
                probe_target = painted;
            }
            let Some(now_inside) = action else {
                continue;
            };
            if now_inside {
                restore_panel_header(&app_handle);
            } else {
                schedule_header_hide(&app_handle);
            }
        }
    });
}

/// Forward the pointer into one child document, or tell it the pointer has gone.
///
/// Two documents need this and for the same reason: a webview only sees pointer events
/// while its window is key, and neither the panel's window (unfocused whenever the reader
/// is working elsewhere) nor the detail window (never focusable — see
/// `build_minimal_detail_window`) can count on that. The document answers with the same
/// question a real `pointerenter` would — what is under this point — and paints the hover
/// its own stylesheet would have painted (see `probe-hover.ts`).
///
/// `point` is in the target window's own points, or `None` for "the pointer left": a
/// webview that is not key never hears that either, so the paint has to be taken back
/// explicitly or it stays on the last control the pointer crossed.
///
/// The window server is asked first. The Dock slides out over these windows without
/// moving them or shrinking the work area, and an open menu is drawn above an
/// always-on-top window: all of it is a pointer that is *not* on our control.
async fn forward_pointer_probe(app: &AppHandle, window: &WebviewWindow, point: Option<(f64, f64)>) {
    let script = match point {
        Some((x, y)) => format!(
            "window.dispatchEvent(new CustomEvent('panel:hover-probe', \
             {{ detail: {{ x: {x:.1}, y: {y:.1} }} }}))"
        ),
        None => "window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: null }))".into(),
    };
    if point.is_none() {
        // Clearing needs no hit test: the document takes the paint off whatever holds it.
        let _ = window.eval(script);
        return;
    }
    if window_is_frontmost(app, window).await {
        let _ = window.eval(script);
    }
}

/// Whether a window is the one the pointer would actually reach.
///
/// The candidate window list AppKit keeps includes windows from *other* applications
/// (`+windowNumberAtPoint:belowWindowWithWindowNumber:` says so), which is the one thing
/// geometry cannot answer: an auto-hidden Dock slides out over the rail without moving it
/// or shrinking the work area, so a reader pointing at a Dock icon is — by every rectangle
/// this host knows — pointing at the rail. That is the false hover the probe must not
/// invent. Both numbers are read on the main thread, where AppKit wants them: the query is
/// a window-server round trip, and the panel's own number lives on its `NSWindow`.
///
/// Anything that cannot be read counts as ours (see `frontmost_is_rail`).
#[cfg(target_os = "macos")]
async fn window_is_frontmost(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Ok(pointer) = window.ns_window() else {
        return true;
    };
    let pointer = pointer as usize;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let queued = app.run_on_main_thread(move || {
        let window = unsafe { &*(pointer as *mut objc2_app_kit::NSWindow) };
        // Safe because `run_on_main_thread` runs this closure on the main thread, which
        // is the only thing the marker asserts.
        let marker = unsafe { objc2_foundation::MainThreadMarker::new_unchecked() };
        // AppKit's own pointer reading, so its hit test needs no conversion: tao's cursor
        // position is a top-left origin measured against the primary display's *pixels*,
        // which is the same point space only on a 1x display. The question here is about
        // AppKit's space, so it is asked in AppKit's space.
        let point = objc2_app_kit::NSEvent::mouseLocation();
        let topmost = objc2_app_kit::NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(
            point, 0, marker,
        );
        let _ = sender.send((topmost, window.windowNumber()));
    });
    if queued.is_err() {
        return true;
    }
    // Bounded, because this runs inside the pointer poll: a main thread busy with a native
    // window drag answers late, and the poll's other duties — the header, the dismissal
    // that follows the pointer out — must not wait behind a hover question. A sample that
    // does not arrive in time simply means no probe this round.
    let Ok(Ok((topmost, own))) = tokio::time::timeout(FRONT_WINDOW_SAMPLE_MS, receiver).await else {
        return false;
    };
    frontmost_is_ours(topmost, own)
}

#[cfg(not(target_os = "macos"))]
async fn window_is_frontmost(_app: &AppHandle, _window: &WebviewWindow) -> bool {
    true
}

/// Take back the hover both documents may be painting.
///
/// The pointer leaving is what the probe would normally say, but a hidden window is not
/// probed: a control painted just before the panel (or its card) went away would come
/// back painted the next time it is shown. Sent while the windows are still on screen —
/// the hide waits out the panel's exit animation — so the documents can hear it.
fn clear_probe_hover(app: &AppHandle) {
    for label in ["panel", MINIMAL_DETAIL_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.eval(
                "window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: null }))",
            );
        }
    }
}

/// Whether the panel is in its rail shape.
///
/// One reader of the flag the settings commands record, so a rule that differs
/// between the shapes asks the same question in the same place.
fn panel_is_minimal(app: &AppHandle) -> bool {
    *app.state::<PanelState>()
        .minimal_mode
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Schedule the panel's header hide for after the pointer-leave delay.
///
/// Generation-guarded like the animated hide: whatever happens in the next few
/// seconds — the pointer coming back, the panel being hidden, a tray toggle —
/// bumps the generation, and the task wakes up only to find its invite obsolete.
///
/// The rail has no delay. Its three actions are a hover affordance that the rail
/// only has room for while the pointer is on it, and waiting reads as the actions
/// being left behind on a shape that has already moved on; the full panel keeps the
/// delay so a pointer that dips out for a moment does not make its header flicker.
fn schedule_header_hide(app: &AppHandle) {
    let generation = bump_header_generation(app);
    let delay = if panel_is_minimal(app) {
        MINIMAL_HEADER_HIDE_DELAY_MS
    } else {
        PANEL_HEADER_HIDE_DELAY_MS
    };
    diag_log(&format!("header hide scheduled delay={delay}"));
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        // Re-check what the schedule was predicated on rather than trusting the
        // cursor event: the pointer may have come back, or the window gone away.
        let visible = app_handle
            .get_webview_window("panel")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        if !visible || cursor_over_panel(&app_handle) != Some(false) {
            diag_log("header hide cancelled");
            return;
        }
        // Hold the generation lock through emission. Otherwise a pointer return
        // can emit `true` after this check but before our stale `false` event.
        let state = app_handle.state::<PanelState>();
        let guard = state
            .header_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *guard != generation {
            diag_log("header hide cancelled");
            return;
        }
        diag_log("header hide due");
        let _ = app_handle.emit(PANEL_HEADER_EVENT, json!({ "visible": false }));
    });
}

/// Restore the panel's header and cancel any hide still pending.
///
/// The bump comes first: the panel dedupes repeated "visible" events, so the
/// generation is what actually retires a scheduled hide when the header is
/// already visible.
fn restore_panel_header(app: &AppHandle) {
    let state = app.state::<PanelState>();
    let mut guard = state
        .header_generation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = guard.wrapping_add(1);
    diag_log("header restored");
    let _ = app.emit(PANEL_HEADER_EVENT, json!({ "visible": true }));
}

fn bump_header_generation(app: &AppHandle) -> u64 {
    let state = app.state::<PanelState>();
    let mut guard = state
        .header_generation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = guard.wrapping_add(1);
    *guard
}

/// Whether the panel is pinned to the screen.
fn panel_pinned(app: &AppHandle) -> bool {
    let state = app.state::<PanelState>();
    let guard = state
        .pinned
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard
}

/// Put the window into the shape a pin state asks for.
///
/// Split from [`set_pinned`] so startup can apply the state the panel was
/// created with (the dev default) without emitting a pin event to a webview that
/// has not loaded its listeners yet.
fn apply_pinned(app: &AppHandle, pinned: bool) {
    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    // The panel stays floating in both states; pinning only decides whether
    // it survives a focus-out (task 5.4). Unpinning must not hide it.
    let _ = window.set_always_on_top(true);
    // A pinned panel belongs to the user rather than to one desktop: joining
    // every Space is what keeps it on screen when they switch desktops.
    // Clearing the behaviour on unpin is what keeps the transient popup off
    // desktops the user never opened it on.
    let _ = window.set_visible_on_all_workspaces(pinned);
}

fn set_pinned(app: &AppHandle, pinned: bool) {
    apply_pinned(app, pinned);
    // Keep the panel's pin indicator in sync when the state changes.
    let _ = app.emit("panel://pinned", pinned);
}

/// A display's bounds in the points macOS arranges displays in, top edge first.
///
/// Not physical pixels: those are not a shared space once scale factors differ.
/// A 2x display is twice as wide in physical pixels as it is in points, so its
/// physical bounds reach into its neighbour's, and the same point can land on
/// two displays at once. In points, display bounds never overlap.
#[derive(Debug, Clone, Copy, PartialEq)]
struct DisplayBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl DisplayBounds {
    /// A physical rectangle — a monitor's bounds, or its work area — in that
    /// display's points.
    fn from_physical(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Self {
        Self {
            x: x / scale,
            y: y / scale,
            width: width / scale,
            height: height / scale,
        }
    }

    /// A monitor's own bounds: where it is and how big it is.
    fn from_monitor(monitor: &tauri::Monitor, scale: f64) -> Self {
        let position = monitor.position();
        let size = monitor.size();
        Self::from_physical(
            f64::from(position.x),
            f64::from(position.y),
            f64::from(size.width),
            f64::from(size.height),
            scale,
        )
    }

    fn left(&self) -> f64 {
        self.x
    }

    fn top(&self) -> f64 {
        self.y
    }

    fn right(&self) -> f64 {
        self.x + self.width
    }

    fn bottom(&self) -> f64 {
        self.y + self.height
    }

    /// Whether the display's horizontal span covers `x`, its edges included.
    fn spans_x(&self, x: f64) -> bool {
        x >= self.left() && x <= self.right()
    }
}

/// A display's scale factor, guarded against a value the window server would
/// never report but that a division must not turn into NaN.
fn display_scale(monitor: &tauri::Monitor) -> f64 {
    let reported = monitor.scale_factor();
    if reported.is_finite() && reported > 0.0 {
        reported
    } else {
        1.0
    }
}

/// A display's top-left corner, in the points that display is arranged in.
fn display_origin_points(monitor: &tauri::Monitor) -> (f64, f64) {
    let position = monitor.position();
    let scale = display_scale(monitor);
    (f64::from(position.x) / scale, f64::from(position.y) / scale)
}

/// A display's work area, in the points that display is arranged in.
///
/// This is the rectangle the panel is clamped into: its top edge is the status
/// bar's bottom edge, and its sides and bottom keep the panel on the display.
fn work_area_points(monitor: &tauri::Monitor) -> DisplayBounds {
    let area = monitor.work_area();
    DisplayBounds::from_physical(
        f64::from(area.position.x),
        f64::from(area.position.y),
        f64::from(area.size.width),
        f64::from(area.size.height),
        display_scale(monitor),
    )
}

/// A display as the anchor lookup needs it: where it is, and the scale factor
/// the anchor rect has to be read in.
#[derive(Debug, Clone, Copy)]
struct AnchorDisplay {
    bounds: DisplayBounds,
    scale: f64,
}

impl AnchorDisplay {
    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let scale = display_scale(monitor);
        Self {
            bounds: DisplayBounds::from_monitor(monitor, scale),
            scale,
        }
    }
}

/// A tray rect's anchor point, in the points `scale` is measured in.
///
/// macOS reports the rect in physical pixels — points multiplied by the scale
/// factor of the display whose menu bar was clicked — so it is divided by the
/// candidate display's scale factor here. A logical rect is points already.
fn anchor_point(rect: tauri::Rect, scale: f64) -> (f64, f64) {
    match rect.position {
        tauri::Position::Physical(position) => {
            (f64::from(position.x) / scale, f64::from(position.y) / scale)
        }
        tauri::Position::Logical(position) => (position.x, position.y),
    }
}

/// Which display the tray anchor sits on, if any.
///
/// The anchor is the status item's own frame, whose origin lies on the top edge
/// of the display that drew the menu bar, so the anchor's x has to fall in that
/// display's horizontal span and its y has to be nearest that display's top.
/// Nearest rather than contained on purpose: the reported y can land a point or
/// two above the display it belongs to, and a window-server rounding error must
/// not send the panel back to the other screen.
///
/// The answer has to come from the anchor and not from the panel window: when
/// the icon on a second screen is clicked, the hidden window is still parked on
/// the first one, and asking *it* which display it is on is what used to open
/// the panel on the wrong screen.
fn display_for_anchor(displays: &[AnchorDisplay], anchor: tauri::Rect) -> Option<usize> {
    displays
        .iter()
        .enumerate()
        .filter_map(|(index, display)| {
            let (x, y) = anchor_point(anchor, display.scale);
            display
                .bounds
                .spans_x(x)
                .then_some((index, (y - display.bounds.y).abs()))
        })
        .min_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(index, _)| index)
}

/// The display the panel belongs on.
///
/// The menu bar icon's display decides, so a click on a second monitor opens the
/// panel on that monitor. Without an anchor (the menu item, a second launch) or
/// for an anchor outside every display, the window's own display stays the best
/// remaining guess.
fn target_monitor(
    app: &AppHandle,
    window: &WebviewWindow,
    anchor: Option<tauri::Rect>,
) -> Option<tauri::Monitor> {
    if let Some(anchor) = anchor {
        if let Ok(monitors) = app.available_monitors() {
            let displays: Vec<AnchorDisplay> =
                monitors.iter().map(AnchorDisplay::from_monitor).collect();
            if let Some(index) = display_for_anchor(&displays, anchor) {
                return monitors.into_iter().nth(index);
            }
        }
    }
    window.current_monitor().ok().flatten()
}

/// The menu bar's height in points, measured on the main display.
///
/// The main display is the one whose work area macOS is guaranteed to start
/// below its menu bar, which makes the gap between the display's top and its
/// work area the menu bar's height. Zero when nothing is reserved (an auto-hiding
/// menu bar, or no main display to measure).
fn menu_bar_height(app: &AppHandle) -> f64 {
    let Ok(Some(primary)) = app.primary_monitor() else {
        return 0.0;
    };
    let reserved = f64::from(primary.work_area().position.y) - f64::from(primary.position().y);
    let scale = primary.scale_factor();
    if reserved > 0.0 && scale.is_finite() && scale > 0.0 {
        reserved / scale
    } else {
        0.0
    }
}

/// The panel's top edge, in points.
///
/// A work area that starts below the menu bar is the honest answer: that edge is
/// the status bar's bottom edge. Secondary displays often report a work area
/// starting at their very top instead, because macOS draws a menu bar there
/// without reserving it, and a panel hung from that edge would sit on top of the
/// status bar. So the menu bar's height is a floor.
fn panel_top(work_top: f64, display_top: f64, menu_bar: f64) -> f64 {
    work_top.max(display_top + menu_bar)
}

/// The full panel's frame on the display the tray belongs on: left-aligned with the
/// tray icon, 10 logical pixels below the status bar, never past the screen edge.
///
/// Every number here is in points, and the result is a *logical* position, because
/// points are the only space two displays with different scale factors agree on.
/// tao's macOS backend turns a **physical** position into window coordinates with
/// the scale factor of the display the window is on *right now*, so a physical
/// target computed for the other display lands somewhere else entirely: with a 2x
/// built-in and a 1x external side by side, clicking the icon on the external put
/// the panel at half the intended distance from its left edge — right next to the
/// built-in instead of under the icon — and clicking back on the built-in could not
/// bring the panel over, because the panel stayed inside the external display. A
/// logical position is handed to `setFrameOrigin` as it is.
///
/// Split from the move itself so a mode switch can re-frame a window that is already
/// on screen: that caller knows the size it is about to apply, while the show path
/// reads the window's own. Both go through this arithmetic, so a switch back lands
/// exactly where a fresh open would.
fn full_panel_target(
    app: &AppHandle,
    window: &WebviewWindow,
    anchor: Option<tauri::Rect>,
    width: f64,
    height: f64,
) -> Option<LogicalPosition<f64>> {
    let Some(monitor) = target_monitor(app, window, anchor) else {
        // A temporary monitor lookup failure is not permission to discard a
        // position the user chose by moving the window to screen centre.
        return None;
    };
    let scale = display_scale(&monitor);
    // The work area normally excludes the menu bar and the Dock, so its top edge
    // is the status bar's bottom edge; `panel_top` covers the displays where it
    // does not.
    let work = work_area_points(&monitor);
    let (_, display_top) = display_origin_points(&monitor);
    let margin = PANEL_MARGIN;
    let top = panel_top(work.y, display_top, menu_bar_height(app));

    // Left-align with the tray icon, then clamp: right-align to the screen when
    // the icon sits too close to the edge for a full-width panel. The anchor and
    // the panel are both measured in the clicked display's points.
    let mut x = anchor.map_or(work.right() - margin - width, |rect| {
        anchor_point(rect, scale).0
    });
    let mut y = top + margin;
    if x + width > work.right() - margin {
        x = work.right() - margin - width;
    }
    if x < work.left() + margin {
        x = work.left() + margin;
    }
    if y + height > work.bottom() - margin {
        y = work.bottom() - margin - height;
    }
    diag_log(&format!(
        "full panel target work=({},{}) {}x{} scale={scale} top={top} target=({},{}) size={width}x{height}",
        work.x, work.y, work.width, work.height, x.max(work.left()), y.max(work.top())
    ));
    Some(LogicalPosition::new(x.max(work.left()), y.max(work.top())))
}

/// Move an already-sized panel to its tray anchor.
fn position_near_tray(app: &AppHandle, anchor: Option<tauri::Rect>) {
    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    // The window reports its own size in the units of the display it is on.
    let window_scale = window.scale_factor().unwrap_or(1.0);
    let window_scale = if window_scale.is_finite() && window_scale > 0.0 {
        window_scale
    } else {
        1.0
    };
    let width = size.width as f64 / window_scale;
    let height = size.height as f64 / window_scale;
    let Some(target) = full_panel_target(app, &window, anchor, width, height) else {
        return;
    };
    // Showing may follow a recent tray click on the same display, so avoid a
    // window-server round trip if it is already at the target.
    if let Ok(current) = window.outer_position() {
        let current_x = f64::from(current.x) / window_scale;
        let current_y = f64::from(current.y) / window_scale;
        if (current_x - target.x).abs() < 0.5 && (current_y - target.y).abs() < 0.5 {
            return;
        }
    }
    let _ = window.set_position(target);
}

/// Put a panel that is already on screen back into its full shape.
///
/// Switching the display mode is not a show: the window stays up, and the panel's
/// height path only ever reports a height, so nothing else would widen the window
/// back from the rail or move it off the rail's anchor. This re-frames it with the
/// same arithmetic the show path uses, so a switch back lands where a fresh open
/// would; the panel's own height report then settles the height. A hidden panel is
/// left alone — `show_panel` solves its frame on the way in.
fn set_full_layout(app: &AppHandle) {
    dismiss_minimal_detail(app, false);
    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    if window.is_visible().ok() != Some(true) {
        return;
    }
    // The rail's height is the honest starting point: the panel measures the full
    // overview and reports it the moment it has rendered the full shape, so an extra
    // frame at the old height is invisible and a guess would be one jump more.
    let height = window_height_points(&window, PANEL_MAX_HEIGHT);
    diag_log(&format!("set_full_layout {}x{height:.0}", PANEL_WIDTH));
    show_full_panel(app, &window, None, height);
}

/// Keep the tray's toggle item saying what a click would do next.
///
/// Called wherever the panel's intended visibility changes. The label is read when
/// the user opens the menu, so a stale one from a focus-out hide would offer the
/// wrong action: "隐藏面板" on a panel that is already gone.
fn sync_tray_toggle(app: &AppHandle) {
    let state = app.state::<PanelState>();
    let visible = state
        .visibility
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .showing;
    let item = state
        .tray_toggle
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(item) = item.as_ref() {
        let _ = item.set_text(if visible {
            TRAY_HIDE_LABEL
        } else {
            TRAY_SHOW_LABEL
        });
    }
}

/// Keep exactly the current value checked in one tray radio group.
///
/// The menu is the only surface that shows a setting without being able to read it, so
/// every group is corrected through here: one rule for both groups, and no way for one of
/// them to end up with two checks or none.
fn sync_tray_radio(group: &Mutex<Vec<(&'static str, CheckMenuItem<tauri::Wry>)>>, current: &str) {
    for (value, item) in group
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
    {
        let _ = item.set_checked(*value == current);
    }
}

/// Keep the tray's panel-shape group showing the mode the panel is in.
///
/// Called wherever the panel's display mode can change: the settings read that first
/// tells the host which mode is persisted, and the one settings write both windows
/// and the tray go through. The check marks are read when the menu opens, so a stale
/// group would point at the mode the panel is not showing.
fn sync_tray_mode(app: &AppHandle) {
    let state = app.state::<PanelState>();
    let minimal = *state
        .minimal_mode
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sync_tray_radio(&state.tray_mode, if minimal { "minimal" } else { "full" });
}

/// Keep the tray's theme group showing the theme the settings hold.
///
/// Same two call sites as the mode group, and for the same reason: the read that first
/// tells the host what is persisted, and the one write everything goes through. The
/// settings window is the other place a theme is chosen, so a group corrected only in the
/// tray would disagree with a theme switched there.
fn sync_tray_theme(app: &AppHandle, theme: &str) {
    sync_tray_radio(&app.state::<PanelState>().tray_theme, theme);
}

/// Switch the panel to one of its two shapes, from the tray's mode group.
///
/// The switch is a settings write, not a window action: the panel itself is what draws
/// the other shape, and both windows have to hear the new mode. So it goes through
/// [`write_settings`] — the same path a window's write takes — which persists it,
/// re-frames a window that is leaving the rail, broadcasts it, and corrects this group's
/// check mark. The write is a service round trip, so it runs off the menu's thread; a
/// failed write leaves the mode where it was and the group still showing it.
fn set_panel_mode(app: &AppHandle, mode: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = write_settings(&app, json!({ "panelDisplayMode": mode })).await;
    });
}

/// Switch the theme, from the tray's theme group.
///
/// A settings write like the mode, and for the same reasons: both windows draw the theme,
/// the service persists it, and the write is what the group's check mark follows.
fn set_theme(app: &AppHandle, theme: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = write_settings(&app, json!({ "theme": theme })).await;
    });
}

/// Show the panel, cancelling any hide animation still in flight.
fn show_panel(app: &AppHandle, anchor: Option<tauri::Rect>) {
    diag_log(&format!("show_panel anchor={}", anchor.is_some()));
    let Some(window) = app.get_webview_window("panel") else {
        return;
    };
    {
        let state = app.state::<PanelState>();
        let mut visibility = state
            .visibility
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        visibility.generation = visibility.generation.wrapping_add(1);
        visibility.showing = true;
    }
    sync_tray_toggle(app);
    // "Show" on a panel that is already on screen is a bring-to-front, not a
    // transition. Everything below this point is a transition: re-anchoring would
    // teleport a panel the reader is looking at, and the visibility event restarts
    // the panel's enter animation — which the panel can only read as "I was hidden
    // and now I am back", because it never saw a hide. In dev the host shows the
    // panel before the webview subscribes, so the panel starts out believing it is
    // hidden; a redundant announce there was a visible fade-out and fade-in.
    let was_visible = window.is_visible().unwrap_or(false);
    if was_visible {
        let _ = window.set_focus();
        restore_panel_header(app);
        return;
    }
    let height = window_height_points(&window, 560.0);
    if panel_is_minimal(app) {
        let _ = panel_set_minimal_layout(app.clone(), 58.0, height, true);
    } else {
        // The window may have been hidden in the rail's shape, so the full frame is
        // solved and applied here rather than left to `position_near_tray`: that reads
        // the size the window has *now*, which is the rail's 58 points until a queued
        // resize lands.
        show_full_panel(app, &window, anchor, height);
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit(PANEL_VISIBILITY_EVENT, json!({ "visible": true }));
    // A reopened panel always comes back with its header up, whatever state the
    // webview kept from before the window was hidden.
    restore_panel_header(app);
    // A hide/show pair can finish between two cursor polls. In that case the
    // polling loop still remembers "outside" and sees no edge to schedule from.
    if cursor_over_panel(app) == Some(false) {
        schedule_header_hide(app);
    }
}

/// Ask the panel to play its exit animation, then hide the window.
///
/// The hide is delayed and generation-guarded: a show that starts during the
/// animation wins, so a quick double-click of the tray icon cannot leave the
/// window hidden while the panel believes it is visible.
fn hide_panel(app: &AppHandle) {
    diag_log("hide_panel");
    dismiss_minimal_detail(app, false);
    // Retire any header hide still pending: the panel is going away whole, and
    // `show_panel` restores the header on the way back in.
    bump_header_generation(app);
    let generation = {
        let state = app.state::<PanelState>();
        let mut visibility = state
            .visibility
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        visibility.showing = false;
        visibility.generation = visibility.generation.wrapping_add(1);
        visibility.generation
    };
    sync_tray_toggle(app);
    // Sent while the windows are still on screen: a control the probe painted must not
    // come back painted the next time the panel is shown.
    clear_probe_hover(app);
    let _ = app.emit(PANEL_VISIBILITY_EVENT, json!({ "visible": false }));

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PANEL_HIDE_ANIMATION_MS)).await;
        let current = {
            let state = app_handle.state::<PanelState>();
            let visibility = state
                .visibility
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            visibility.generation
        };
        if current != generation {
            diag_log("hide cancelled by a newer visibility change");
            return;
        }
        if let Some(window) = app_handle.get_webview_window("panel") {
            diag_log("window.hide()");
            let _ = window.hide();
        }
    });
}

/// Show or hide the panel — the tray menu's first entry, and its only caller.
///
/// The entry names the action this click performs (see [`sync_tray_toggle`]), so the
/// current visibility decides which of the two it is.
///
/// There used to be a second caller: a left click on the icon toggled the panel
/// directly, and a focus-out hide from the click that closed it had to be discounted for
/// 400 ms so the click did not immediately re-open what it had just closed. The icon now
/// opens the menu instead (see the tray builder), which leaves this function as the one
/// deliberate show/hide — and leaves nothing for that discount to protect against, while
/// it would still swallow a reader's "显示面板" clicked within the same moment.
fn toggle_panel(app: &AppHandle, anchor: Option<tauri::Rect>) {
    let showing = {
        let state = app.state::<PanelState>();
        let visibility = state
            .visibility
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        visibility.showing
    };
    if showing {
        hide_panel(app);
        return;
    }
    show_panel(app, anchor);
}

/// Where the tray icon is, so the panel can open beside it.
///
/// Asked of the icon rather than taken from a click: the menu is opened by the status
/// item itself, so no click reaches this process with a rect in hand — and the icon's own
/// rect answers the same question, because a status item's menu only ever opens on the
/// display that item is on. A missing icon or a failed lookup leaves `None`, which the
/// target arithmetic reads as "the display the window is already on".
fn tray_anchor(app: &AppHandle) -> Option<tauri::Rect> {
    app.tray_by_id(TRAY_ID)?.rect().ok().flatten()
}

/// Host -> settings window event naming the section to show.
///
/// The window is built once and then only shown, so this is how an entry point
/// that names a section is served after the first time: the panel's gear, a card's
/// gear, the empty state's "管理平台" and the tray item's "打开设置" all end up in the
/// same window, and it moves to the section they asked for.
pub const SETTINGS_SECTION_EVENT: &str = "panel://settings-section";

/// The label of the settings window, and the section every entry point falls back
/// to when it does not name one.
const SETTINGS_WINDOW_LABEL: &str = "settings";
const SETTINGS_DEFAULT_SECTION: &str = "platforms";

/// The sections a request may name. Anything else is treated as "no section named"
/// so a typo cannot leave the window on a section that does not exist.
const SETTINGS_SECTIONS: [&str; 5] = ["platforms", "appearance", "codex", "glm", "deepseek"];

/// The settings window's fixed size, in logical pixels.
///
/// Fixed on purpose: the window is a settings *sheet* for a 350px-wide panel, and a
/// size the user could change would make every layout inside it a responsive
/// problem for no benefit. The content area scrolls instead.
const SETTINGS_WINDOW_WIDTH: f64 = 600.0;
const SETTINGS_WINDOW_HEIGHT: f64 = 400.0;

/// How far above the display's vertical centre the settings window sits.
///
/// Centred vertically it reads as slightly low, because the window has a title bar
/// the eye does not count as part of the content. Lifting it puts the content area —
/// the part that matters — on the centre line.
const SETTINGS_WINDOW_RISE: f64 = 50.0;

/// Normalise a requested section. `None` (or an unknown name) means "the default".
fn settings_section(requested: Option<&str>) -> &'static str {
    match requested {
        Some(name) => SETTINGS_SECTIONS
            .iter()
            .find(|known| **known == name)
            .copied()
            .unwrap_or(SETTINGS_DEFAULT_SECTION),
        None => SETTINGS_DEFAULT_SECTION,
    }
}

/// Where the settings window goes, given the display's work area, all in points.
///
/// Centred horizontally on the display, and `SETTINGS_WINDOW_RISE` above its vertical
/// centre. Not beside the panel: the panel is anchored under the menu-bar icon, which
/// can be anywhere along the top edge, so "next to the panel" put the settings window
/// wherever the icon happened to be — a placement the reader has to hunt for and that
/// changes with the icon's position. The centre of the display is the one place that is
/// predictable, and it is what a settings sheet normally does.
///
/// Split out from the move itself so the placement is testable without a window
/// server, which is the same reason `boundary_clamp_target` is.
fn settings_window_origin(work: (f64, f64, f64, f64)) -> (f64, f64) {
    let (work_x, work_y, work_width, work_height) = work;

    /// Where to put a `size`-long axis inside a `start`..`start + span` work area:
    /// centred, then kept `gap` clear of each edge — or pinned to the start when the
    /// span is too tight to allow both margins.
    ///
    /// The two branches are not interchangeable: centring and then clamping with
    /// `clamp(lo, hi)` panics when `hi < lo`, which is exactly what a display barely
    /// taller than the window produces.
    fn axis(start: f64, span: f64, size: f64, gap: f64) -> f64 {
        if size + gap * 2.0 >= span {
            return start;
        }
        let lo = start + gap;
        let hi = start + span - size - gap;
        if hi <= lo {
            return start;
        }
        (start + (span - size) / 2.0).clamp(lo, hi)
    }

    let x = axis(work_x, work_width, SETTINGS_WINDOW_WIDTH, PANEL_MARGIN);
    let y = axis(work_y, work_height, SETTINGS_WINDOW_HEIGHT, PANEL_MARGIN);
    // The vertical placement is deliberately lifted off the centre: the title bar makes a
    // pure centre read low. Only applied when there is room for it, so a short display
    // does not push the window up against the menu bar.
    let lifted = y - SETTINGS_WINDOW_RISE;
    let y = if lifted >= work_y + PANEL_MARGIN {
        lifted
    } else {
        y
    };
    (x, y)
}

/// Move the settings window beside the panel on the panel's own display.
fn position_settings_window(app: &AppHandle) {
    let Some(settings) = app.get_webview_window(SETTINGS_WINDOW_LABEL) else {
        return;
    };
    // The display the *settings window* is on, falling back to the panel's. The panel's
    // monitor would be the tempting choice (it is the window the user just clicked), but
    // the panel is anchored under the menu-bar icon and can be on a different display
    // from the one the reader is looking at; the settings window's own monitor is where
    // it will actually be drawn.
    let monitor = settings.current_monitor().ok().flatten().or_else(|| {
        app.get_webview_window("panel")
            .and_then(|window| window.current_monitor().ok().flatten())
    });
    let Some(monitor) = monitor else {
        // No display to reason about is not permission to move the window: leaving it
        // where the window server put it beats moving it somewhere arbitrary.
        return;
    };
    let work = work_area_points(&monitor);
    let (x, y) = settings_window_origin((work.x, work.y, work.width, work.height));
    diag_log(&format!("position_settings_window target=({x},{y})"));
    let _ = settings.set_position(LogicalPosition::new(x, y));
}

/// Build the settings window. Hidden until its first render says it is ready.
fn build_settings_window(app: &AppHandle, section: Option<&str>) -> tauri::Result<WebviewWindow> {
    let section = settings_section(section);
    // The section the window was opened on is part of its identity, not a later
    // request: a window opened from a card's gear has to render that platform on its
    // first frame, because the host does not show it until then. It rides the same
    // injected-config mechanism the service origin does, so the webview needs no
    // extra bridge call to learn it.
    let injected = json!({
        "origin": app.state::<PanelState>().service_endpoint().origin,
        "sessionToken": app.state::<PanelState>().service_endpoint().session_token,
        "webUrl": app.state::<PanelState>().service_endpoint().origin,
        "capabilities": { "pin": false, "hide": false, "openWebVersion": false },
        "settingsSection": section,
    });

    let window = WebviewWindowBuilder::new(app, SETTINGS_WINDOW_LABEL, settings_window_url())
        .title("设置")
        .inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
        // Not resizable: the content is laid out for exactly this size, and the content
        // area scrolls. Min and max are set to the same pair so macOS cannot pick a
        // size of its own when restoring the window.
        .min_inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
        .max_inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
        .resizable(false)
        // Standard chrome, unlike the panel's: a fixed-size form wants a title bar with
        // a close button, and the panel's borderless look is what it is because it hangs
        // off the menu bar.
        .decorations(true)
        .skip_taskbar(false)
        .always_on_top(false)
        .visible(false)
        .build()?;

    let _ = window.eval(format!("window.__AGENTS_USAGE__ = {injected};"));
    // Deliberately no focus handler: the settings window keeps its place when the
    // user clicks back into the panel, which is what makes "change it here, watch it
    // there" possible. The panel's own focus-hide rule lives on the panel window
    // (see `build_panel_window`) and does not reach this one.
    Ok(window)
}

/// Which document the settings window loads.
///
/// Packaged, it is the second entry point Vite emits next to `index.html`. In dev
/// the panel is served from the Vite dev server, whose root is the `src/desktop`
/// directory, so the settings document is its sibling there.
fn settings_window_url() -> WebviewUrl {
    if tauri::is_dev() {
        WebviewUrl::External(
            "http://127.0.0.1:5174/src/desktop/settings.html"
                .parse()
                .expect("the dev settings URL is a literal"),
        )
    } else {
        WebviewUrl::App("settings.html".into())
    }
}

fn minimal_detail_window_url() -> WebviewUrl {
    if tauri::is_dev() {
        WebviewUrl::External(
            "http://127.0.0.1:5174/src/desktop/minimal-detail.html"
                .parse()
                .expect("the dev detail URL is a literal"),
        )
    } else {
        WebviewUrl::App("minimal-detail.html".into())
    }
}

fn build_minimal_detail_window(app: &AppHandle, panel: &WebviewWindow) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, MINIMAL_DETAIL_LABEL, minimal_detail_window_url())
        .title("用量详情")
        // The card (330) plus its border and the seven-point strip the caret is painted
        // in: `MINIMAL_DETAIL_WIDTH` + `MINIMAL_DETAIL_GAP` in `minimal-layout.ts`.
        .inner_size(339.0, 200.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(true)
        .shadow(false)
        .focused(false)
        .visible(false)
        .parent(panel)?
        .build()?;
    // The card must not be able to become the key window.
    //
    // Showing a window goes through `makeKeyAndOrderFront`, and the rail's webview
    // only sees pointer events while *its* window is key — which is why this host
    // polls the cursor for the panel's header at all. A detail that took key
    // therefore froze the rail: the first hovered card came up, and every later hover
    // was invisible to the webview, so the detail could no longer be switched by
    // pointing at another platform. The card is buttons and readings; it needs no
    // keyboard focus (Escape is handled by the rail, which also takes focus back), so
    // it is shown as a plain floating surface instead. Clicks still reach it: a
    // non-key window is still the window under the pointer.
    let _ = window.set_focusable(false);
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            if !panel_pinned(&app_handle)
                && cursor_over_panel(&app_handle) != Some(true)
                && cursor_over_detail(&app_handle) != Some(true)
            {
                hide_panel(&app_handle);
            }
        }
    });
    Ok(window)
}

/// Open the settings window, or bring the existing one forward on `section`.
///
/// One window serves every entry point: opening it again would give the user two
/// copies of the same form writing to the same settings, and no way to tell which
/// one is current.
fn open_settings(app: &AppHandle, section: Option<&str>) -> Result<(), String> {
    let section = settings_section(section);
    diag_log(&format!("open_settings section={section}"));
    // Recorded before anything is shown, so a window that is still booting (or whose
    // listener has not been registered yet) can read it back rather than miss the
    // event — see `panel_settings_section`.
    {
        let state = app.state::<PanelState>();
        let mut current = state
            .settings_section
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = section;
    }
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        position_settings_window(app);
        let _ = window.show();
        let _ = window.set_focus();
        // The window is already mounted, so the section it should move to is a
        // request rather than part of its identity.
        let _ = app.emit_to(
            SETTINGS_WINDOW_LABEL,
            SETTINGS_SECTION_EVENT,
            json!({ "section": section }),
        );
        return Ok(());
    }
    build_settings_window(app, Some(section))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Show the settings window once its first render is on screen.
///
/// The host builds it hidden, so a blank window is never what the user sees while
/// the webview boots: this is the moment the document says it has painted.
fn reveal_settings_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) else {
        return;
    };
    diag_log("reveal_settings_window");
    position_settings_window(app);
    let _ = window.show();
    let _ = window.set_focus();
}

// ---------------------------------------------------------------------------
// Application assembly
// ---------------------------------------------------------------------------

/// Poll the service's loopback API and forward snapshots to the panel as host
/// events, so the panel updates live without a second scheduler. Errors are
/// ignored: the panel falls back to its cached data until the next poll.
fn spawn_event_forwarder(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let origin = app.state::<PanelState>().service_endpoint().origin;
            if let Ok(response) = reqwest::get(format!("{origin}/api/snapshots")).await {
                if response.status().is_success() {
                    if let Ok(value) = response.json::<Value>().await {
                        let _ = app.emit("panel://snapshot", value);
                    }
                }
            }
        }
    });
}

pub fn build(context: tauri::Context) -> tauri::App {
    tauri::Builder::new()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch reveals the existing panel instead of opening one.
            show_panel(app, None);
        }))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let service = connect_to_service()?;
            let injected = json!({
                "origin": service.origin,
                "sessionToken": service.session_token,
                "webUrl": service.origin,
                "capabilities": { "pin": true, "hide": true, "openWebVersion": true }
            });
            let panel = build_panel_window(app.handle())?;

            // The panel reads `window.__AGENTS_USAGE__` and falls back to the
            // service's loopback HTTP API (which validates Host/Origin/session),
            // so the discovery token never has to ride the global Tauri bridge.
            if let Some(window) = app.get_webview_window("panel") {
                let script = format!("window.__AGENTS_USAGE__ = {};", injected);
                let _ = window.eval(&script);
            }

            // Dev builds start pinned so the panel survives focus loss while
            // styles are edited; packaged builds keep the popup behaviour.
            let pinned = tauri::is_dev();
            app.manage(PanelState {
                pinned: Mutex::new(pinned),
                minimal_mode: Mutex::new(false),
                minimal_detail: Mutex::new(MinimalDetailState::default()),
                service: Mutex::new(service),
                visibility: Mutex::new(VisibilityState::default()),
                header_generation: Mutex::new(0),
                settings_section: Mutex::new(SETTINGS_DEFAULT_SECTION),
                tray_toggle: Mutex::new(None),
                tray_mode: Mutex::new(Vec::new()),
                tray_theme: Mutex::new(Vec::new()),
            });
            build_minimal_detail_window(app.handle(), &panel)?;

            // The window has to agree with that first state instead of waiting
            // for the first button press: a panel that reads as pinned but is
            // still tied to one desktop would only start following the user's
            // desktops after they unpinned and pinned it again.
            apply_pinned(app.handle(), pinned);

            // Drive the header from the pointer: poll the cursor against the
            // window bounds (the header state machine needs `PanelState` managed
            // above, so this runs after `manage`).
            start_cursor_tracking(app.handle());
            start_boundary_tracking(app.handle());

            // Dev loop convenience: `tauri dev` serves the panel from the Vite
            // dev server (hot reload), so put the window on screen right away
            // instead of waiting for a tray click. Must run after `manage` so a
            // focus event cannot reach the not-yet-managed state.
            if tauri::is_dev() {
                if let Some(window) = app.get_webview_window("panel") {
                    // A host hot-reload recreates this window. Centering every
                    // new dev window makes a panel placed at the upper right
                    // appear to jump to the middle after the reload.
                    position_near_tray(app.handle(), None);
                    let _ = window.show();
                    let _ = window.set_focus();
                    // This show did not go through `show_panel`, so record it:
                    // otherwise the first tray click would "show" an
                    // already-visible panel, replaying its enter fade and
                    // jumping it to the tray.
                    let state = app.state::<PanelState>();
                    let mut visibility = state
                        .visibility
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    visibility.showing = true;
                    visibility.generation = visibility.generation.wrapping_add(1);
                }
            }

            // Forward the service's loopback API into host events so the panel
            // updates live without polling.
            spawn_event_forwarder(app.handle().clone());

            // The toggle item's label is decided at runtime (see
            // `sync_tray_toggle`), so it is built here and kept in the state.
            let toggle_item =
                MenuItem::with_id(app, TRAY_TOGGLE_ID, TRAY_SHOW_LABEL, true, None::<&str>)?;
            // The two radio groups are built here and kept in the state, because a menu
            // item's check mark is the host's to correct (see `sync_tray_mode` /
            // `sync_tray_theme`). They start on the settings contract's own defaults —
            // full cards and the dark theme — and the settings read corrects both as soon
            // as the host knows what is persisted.
            let check_item = |id: &'static str, label: &'static str, checked: bool| {
                CheckMenuItem::with_id(app, id, label, true, checked, None::<&str>)
            };
            let full_item = check_item(TRAY_MODE_FULL_ID, TRAY_FULL_LABEL, true)?;
            let minimal_item = check_item(TRAY_MODE_MINIMAL_ID, TRAY_MINIMAL_LABEL, false)?;
            let light_item = check_item(TRAY_THEME_LIGHT_ID, TRAY_THEME_LIGHT_LABEL, false)?;
            let dark_item = check_item(
                TRAY_THEME_DARK_ID,
                TRAY_THEME_DARK_LABEL,
                TRAY_DEFAULT_THEME == "dark",
            )?;
            let system_item = check_item(TRAY_THEME_SYSTEM_ID, TRAY_THEME_SYSTEM_LABEL, false)?;

            // Four blocks, one question each: is the panel on screen, what shape is it,
            // what theme does it wear, and the window/process actions. The separators are
            // what make the two radio groups read as groups instead of as five more verbs
            // in one list — and they are the reason the mode switch could become a pair of
            // checked items at all, since a check mark needs a block to mean anything in.
            let menu = Menu::with_items(
                app,
                &[
                    &toggle_item,
                    &PredefinedMenuItem::separator(app)?,
                    &full_item,
                    &minimal_item,
                    &PredefinedMenuItem::separator(app)?,
                    &light_item,
                    &dark_item,
                    &system_item,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "settings", "打开设置", true, None::<&str>)?,
                    &MenuItem::with_id(app, "restart", "重启应用", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
                ],
            )?;

            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/tray-template.png"
                ))?)
                .icon_as_template(true)
                .tooltip("用量面板")
                .menu(&menu)
                // Both buttons open the menu. A status item with a menu is expected to
                // show it on click, and the panel's own visibility is the menu's first
                // entry — the icon used to toggle the panel directly on a left click,
                // which made the menu (its shape and theme groups included) something a
                // reader had to know to right-click for.
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_panel(app, tray_anchor(app)),
                    TRAY_MODE_FULL_ID => set_panel_mode(app, "full"),
                    TRAY_MODE_MINIMAL_ID => set_panel_mode(app, "minimal"),
                    TRAY_THEME_LIGHT_ID => set_theme(app, "light"),
                    TRAY_THEME_DARK_ID => set_theme(app, "dark"),
                    TRAY_THEME_SYSTEM_ID => set_theme(app, "system"),
                    // The tray is the one entry point that does not come from the
                    // panel, so it names no section: 平台管理 is the first thing the
                    // window shows and the setting users reach for most.
                    "settings" => {
                        let _ = open_settings(app, None);
                    }
                    // Restarting is quitting and coming back, and it is the one
                    // operation that has to release the service itself: the restart
                    // never reaches the `ExitRequested` handler below.
                    "restart" => {
                        release_owned_service(app);
                        app.restart();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            let _ = tray;

            // The items were created on their opening state: the toggle on the
            // hidden-panel label (a dev build has already put the panel on screen by
            // now), and the two groups on the settings contract's defaults, which are
            // also what the host assumes until the webview's settings read says
            // otherwise.
            {
                let state = app.state::<PanelState>();
                state
                    .tray_toggle
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .replace(toggle_item);
                state
                    .tray_mode
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend([
                        ("full", full_item),
                        ("minimal", minimal_item),
                    ]);
                state
                    .tray_theme
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend([
                        ("light", light_item),
                        ("dark", dark_item),
                        ("system", system_item),
                    ]);
            }
            sync_tray_toggle(app.handle());
            sync_tray_mode(app.handle());
            sync_tray_theme(app.handle(), TRAY_DEFAULT_THEME);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            panel_snapshot,
            panel_settings,
            panel_update_settings,
            panel_refresh,
            panel_validate_credential,
            panel_delete_credential,
            panel_pinned_state,
            panel_set_pinned,
            panel_hide,
            panel_set_height,
            panel_set_minimal_layout,
            panel_set_minimal_detail,
            panel_detail_current,
            panel_detail_layout,
            panel_detail_dismiss,
            panel_open_web_version,
            panel_open_settings,
            panel_settings_ready,
            panel_settings_section
        ])
        .build(context)
        .expect("failed to build the agents-usage desktop host")
}

pub fn run() {
    build(tauri::generate_context!()).run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            release_owned_service(app);
        }
    });
}

/// Kill the service this host started itself, if it started one.
///
/// Shared by quitting and by restarting, because they differ in exactly one way
/// that matters here: `AppHandle::restart` re-execs the process and never emits
/// `ExitRequested`, so the run-loop handler cannot do this for the restart path.
///
/// Doing it *before* the restart is also what keeps the new host off a dying
/// service: the old one exits within two seconds of losing its parent (its own
/// watchdog), and a host that starts inside that window reads a discovery file
/// whose process is still alive and attaches to it. A service the user started
/// independently is left running, as quitting leaves it.
fn release_owned_service(app: &AppHandle) {
    let state = app.state::<PanelState>();
    let connection = state
        .service
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !connection.owned_by_desktop {
        return;
    }
    if let Some(child) = &connection.child {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
    }
}

/// Marker used by `cargo test` to prove the host crate links without a window
/// server; the tray and window behaviour is verified on a real desktop session.
pub fn runtime_kind() -> &'static str {
    std::any::type_name::<tauri::Wry>()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host's one settings write, as source.
    ///
    /// The webview command is a one-line delegate to it, and the tray's mode switch
    /// calls the same function, so the write's rules (record the mode it carried,
    /// re-frame a window leaving the rail, broadcast, recollect) are all asserted
    /// against this helper rather than against whichever caller happens to be first.
    fn settings_write_source(source: &'static str) -> &'static str {
        source
            .split("async fn write_settings")
            .nth(1)
            .expect("the shared settings write")
            .split("#[tauri::command]")
            .next()
            .expect("end of the shared settings write")
    }

    #[test]
    fn the_settings_window_is_centred_and_lifted() {
        // Independent acceptance values keep the test from passing just because the
        // constants and implementation drift together.
        let work = (0.0, 25.0, 1440.0, 875.0);
        let (x, y) = settings_window_origin(work);
        assert_eq!(x, 420.0);
        assert_eq!(y, 212.5);
        // Lifted, not dropped: the content area lands closer to the centre line than a
        // pure centre would put it.
        let pure_centre = 25.0 + (875.0 - SETTINGS_WINDOW_HEIGHT) / 2.0;
        assert!(y < pure_centre);

        // A display offset to the right of another one: the centring is relative to that
        // display's own work area, not to the global origin.
        let right_display = (1792.0, 0.0, 2560.0, 1400.0);
        let (x, _) = settings_window_origin(right_display);
        assert_eq!(x, 2772.0);
    }

    #[test]
    fn the_settings_window_stays_inside_a_work_area_it_does_not_fit() {
        // A display smaller than the sheet: it is anchored at the work area's origin
        // rather than centred off the top-left corner into negative coordinates.
        let tiny = (0.0, 0.0, 400.0, 300.0);
        assert_eq!(settings_window_origin(tiny), (0.0, 0.0));

        // Taller than the window but without room for both margins (420 against a
        // 400pt window): it is anchored at the work area's top edge instead of being
        // clamped into an inverted range, which would panic.
        let tight = (0.0, 0.0, 1440.0, 420.0);
        let (x, y) = settings_window_origin(tight);
        assert_eq!(y, 0.0);
        assert!(x >= PANEL_MARGIN && x + SETTINGS_WINDOW_WIDTH <= 1440.0 - PANEL_MARGIN);

        // A display with room to spare *and* room for the margins: the window is centred
        // and the rise is applied without leaving the work area.
        let roomy = (0.0, 0.0, 1440.0, 875.0);
        let (x, y) = settings_window_origin(roomy);
        assert!(x >= PANEL_MARGIN && x + SETTINGS_WINDOW_WIDTH <= 1440.0 - PANEL_MARGIN);
        assert!(y >= PANEL_MARGIN && y + SETTINGS_WINDOW_HEIGHT <= 875.0 - PANEL_MARGIN);
    }

    #[test]
    fn a_section_request_survives_a_window_that_is_not_listening_yet() {
        // The event is the fast path; this is the durable half. The host records the
        // request, and the window reads it back — otherwise a request that lands while
        // the webview is still booting is lost and the window opens on the wrong section.
        let source = include_str!("lib.rs");
        let record = source
            .split("fn open_settings")
            .nth(1)
            .expect("open_settings")
            .split("fn reveal_settings_window")
            .next()
            .expect("end of open_settings");
        assert!(
            record.contains("settings_section"),
            "open_settings must record the requested section, not only emit it"
        );
        assert!(
            record.contains("SETTINGS_SECTION_EVENT"),
            "the event stays: it is what moves a window that is already listening"
        );
        // And the command really reads a non-empty section name.
        assert!(source.contains("fn panel_settings_section"));
        assert!(SETTINGS_SECTIONS.contains(&SETTINGS_DEFAULT_SECTION));
    }

    #[test]
    fn settings_sheet_matches_the_host_window_size() {
        // The browser fallback renders the same settings surface as a sheet over the panel
        // document, so it must be the same shape as the host's window. The two live in
        // different languages and cannot share a constant, so the pair is checked here.
        let css = include_str!("../../src/desktop/settings.css");
        let sheet = css
            .split(".settings-sheet {")
            .nth(1)
            .expect("the fallback sheet rule")
            .split('}')
            .next()
            .expect("end of the sheet rule");
        assert!(
            sheet.contains(&format!("width: {SETTINGS_WINDOW_WIDTH:.0}px")),
            "the fallback sheet must be as wide as the settings window"
        );
        assert!(
            sheet.contains(&format!("height: {SETTINGS_WINDOW_HEIGHT:.0}px")),
            "the fallback sheet must be as tall as the settings window"
        );
    }

    #[test]
    fn only_writes_that_change_what_is_collected_re_collect() {
        // Presentation writes: the card does not need to ask the provider anything
        // again, and re-collecting would spend a request to learn nothing.
        for patch in [
            json!({ "theme": "light" }),
            json!({ "panelDisplayMode": "minimal" }),
            json!({ "quotaValueMode": "used" }),
            json!({ "quotaWarningThreshold": 15 }),
            json!({ "balanceWarningThreshold": 12.5 }),
            json!({ "platformVisibility": { "glm": false } }),
            json!({ "platformOrder": ["glm", "codex"] }),
            json!({ "codexResetFormat": "absolute" }),
            json!({ "glmQuotaDisplay": "bar" }),
            // Switching an experimental connection *off* collects nothing: the card
            // stops showing that module from the settings alone.
            json!({ "glmWalletEnabled": false }),
            json!({ "deepseekWebEnabled": false }),
        ] {
            assert!(
                providers_to_recollect(&patch).is_empty(),
                "presentation write re-collected: {patch}"
            );
        }

        // Collection-affecting writes: the answer on the card is now the answer to
        // the setting the user just made, or the setting reads as doing nothing.
        assert_eq!(
            providers_to_recollect(&json!({ "glmRegion": "global" })),
            vec!["glm"]
        );
        assert_eq!(
            providers_to_recollect(&json!({ "codexCliPath": "/opt/homebrew/bin/codex" })),
            vec!["codex"]
        );
        assert_eq!(
            providers_to_recollect(&json!({ "glmWalletEnabled": true })),
            vec!["glm"]
        );
        assert_eq!(
            providers_to_recollect(&json!({ "deepseekWebEnabled": true })),
            vec!["deepseek"]
        );

        // One platform is collected once, however many of its fields changed: two
        // overlapping requests for the same provider are two requests for one answer.
        let both = json!({ "glmRegion": "global", "glmWalletEnabled": true });
        assert_eq!(providers_to_recollect(&both), vec!["glm"]);

        // A patch that is not an object at all is not a reason to collect anything.
        assert!(providers_to_recollect(&json!("nope")).is_empty());
        assert!(providers_to_recollect(&Value::Null).is_empty());
    }

    #[test]
    fn a_credential_collects_the_platform_whose_card_shows_it() {
        // Both experimental connections sit on the platform whose card shows them.
        assert_eq!(provider_of_credential("glm-wallet"), Some("glm"));
        assert_eq!(provider_of_credential("glm"), Some("glm"));
        assert_eq!(provider_of_credential("deepseek-web"), Some("deepseek"));
        assert_eq!(provider_of_credential("codex"), Some("codex"));
        assert_eq!(provider_of_credential("unknown"), None);
    }

    #[test]
    fn minimal_frame_anchors_the_rail_in_display_points_and_clamps_detail() {
        let display = DisplayBounds {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };
        let work = DisplayBounds {
            x: 0.0,
            y: 24.0,
            width: 1440.0,
            height: 836.0,
        };
        // Flush with the display's right edge, 40 points down: the rail hangs off the end
        // of the menu bar rather than floating ten points clear of it.
        assert_eq!(
            minimal_panel_frame(display, work, 58.0, 420.0),
            (
                display.right() - MINIMAL_RAIL_RIGHT_INSET - 58.0,
                MINIMAL_RAIL_TOP_INSET,
                58.0,
                420.0
            )
        );
        assert_eq!(
            minimal_panel_frame(display, work, 330.0, 420.0),
            (
                display.right() - MINIMAL_RAIL_RIGHT_INSET - 330.0,
                MINIMAL_RAIL_TOP_INSET,
                330.0,
                420.0
            )
        );
        let narrow = DisplayBounds {
            x: 1440.0,
            y: 0.0,
            width: 300.0,
            height: 600.0,
        };
        let narrow_work = DisplayBounds {
            x: 1440.0,
            y: 25.0,
            width: 300.0,
            height: 535.0,
        };
        // A display narrower than the requested width clamps it to what is left of the
        // work area — all 300 points of this one, now that the rail is flush with the
        // right edge rather than stopping 60 points short of it.
        assert_eq!(
            minimal_panel_frame(narrow, narrow_work, 330.0, 600.0),
            (1440.0, MINIMAL_RAIL_TOP_INSET, 300.0, 520.0)
        );
    }

    #[test]
    fn minimal_detail_resizes_to_the_left_without_moving_the_rail() {
        let rail_x = 1322.0;
        let rail_width = 58.0;
        let detail_x = resized_native_origin_x_keep_right(rail_x, rail_width, 330.0);
        assert_eq!(detail_x, 1050.0);
        assert_eq!(detail_x + 330.0, rail_x + rail_width);
        assert_eq!(
            resized_native_origin_x_keep_right(detail_x, 330.0, 58.0),
            rail_x
        );
    }

    #[test]
    fn independent_detail_sits_beside_a_fixed_rail_and_clamps_to_work_area() {
        let work = DisplayBounds { x: 0.0, y: 24.0, width: 1440.0, height: 836.0 };
        let (x, y, width, height, caret) = minimal_detail_frame((1322.0, 40.0), 1, 300.0, work);
        assert_eq!((x, width, height), (983.0, 339.0, 300.0));
        assert_eq!(x + width, 1322.0);
        assert!(y >= work.top());
        assert!((y + caret - (40.0 + 37.0 + 68.0)).abs() < 0.01);
        let narrow = DisplayBounds { x: 1100.0, y: 24.0, width: 300.0, height: 500.0 };
        let (_, _, clipped_width, _, _) = minimal_detail_frame((1322.0, 40.0), 0, 300.0, narrow);
        assert_eq!(clipped_width, 222.0);
    }

    #[test]
    fn the_detail_never_rises_above_the_rail_it_belongs_to() {
        // A tall card on the top platform wants to be centred on the first ring, which
        // is 37 points below the rail's top edge — half of a 420-point card would put
        // its head 173 points above the rail. The card is pushed down instead, and its
        // caret keeps pointing at the ring it describes.
        let work = DisplayBounds { x: 0.0, y: 24.0, width: 1440.0, height: 836.0 };
        let rail = (1322.0, 40.0);
        let (_, y, _, height, caret) = minimal_detail_frame(rail, 0, 420.0, work);
        assert_eq!((y, height), (rail.1, 420.0));
        assert!((y + caret - (rail.1 + 37.0)).abs() < 0.01);
        // A short card still centres on its ring, which is above the rail's top only
        // when the ring itself is: the clamp is a floor, not a re-centring.
        let (_, centred, _, _, _) = minimal_detail_frame(rail, 2, 90.0, work);
        assert!((centred - (rail.1 + 37.0 + 136.0 - 45.0)).abs() < 0.01);
        // And a display whose work area starts below the rail's top cannot invite the
        // card back above the rail: the tighter of the two is the bound.
        let lower = DisplayBounds { x: 0.0, y: 200.0, width: 1440.0, height: 400.0 };
        let (_, y, _, height, _) = minimal_detail_frame(rail, 0, 120.0, lower);
        assert_eq!((y, height), (200.0, 120.0));
    }

    #[test]
    fn minimal_insets_are_logical_points_on_retina_displays() {
        let display = DisplayBounds::from_physical(0.0, 0.0, 2880.0, 1800.0, 2.0);
        let work = DisplayBounds::from_physical(0.0, 48.0, 2880.0, 1672.0, 2.0);
        let frame = minimal_panel_frame(display, work, 58.0, 420.0);
        assert_eq!(
            frame,
            (
                display.right() - MINIMAL_RAIL_RIGHT_INSET - 58.0,
                MINIMAL_RAIL_TOP_INSET,
                58.0,
                420.0
            )
        );
    }

    #[test]
    fn minimal_frame_solves_against_the_display_the_rail_is_on() {
        // A second display hangs to the right of the built-in one and is shorter than
        // it. The 60/40 insets are measured from *that* display's edges: solving them
        // against the primary is what puts the rail back on the built-in screen when
        // the user switched modes while looking at the external one.
        let external = DisplayBounds {
            x: 1440.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let external_work = DisplayBounds {
            x: 1440.0,
            y: 25.0,
            width: 1920.0,
            height: 1005.0,
        };
        assert_eq!(
            minimal_panel_frame(external, external_work, 58.0, 420.0),
            (
                external.right() - MINIMAL_RAIL_RIGHT_INSET - 58.0,
                MINIMAL_RAIL_TOP_INSET,
                58.0,
                420.0
            )
        );

        // The same display reported in physical pixels at 2x: mixed scaling must not
        // halve or double the insets. `from_physical` divides by the scale, so the
        // point-space answer is identical to the 1x display above.
        let scaled = DisplayBounds::from_physical(2880.0, 0.0, 3840.0, 2160.0, 2.0);
        let scaled_work = DisplayBounds::from_physical(2880.0, 50.0, 3840.0, 2010.0, 2.0);
        assert_eq!(
            minimal_panel_frame(scaled, scaled_work, 58.0, 420.0),
            (
                scaled.right() - MINIMAL_RAIL_RIGHT_INSET - 58.0,
                MINIMAL_RAIL_TOP_INSET,
                58.0,
                420.0
            )
        );
    }

    #[test]
    fn minimal_frame_lands_inside_the_display_that_is_left() {
        // The rail was on a display that has since been unplugged, and the request
        // that arrives now is for a wide, tall detail. Whatever the numbers were, the
        // answer has to be a frame the user can actually reach on what remains.
        let remaining = DisplayBounds {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };
        let remaining_work = DisplayBounds {
            x: 0.0,
            y: 24.0,
            width: 1440.0,
            height: 876.0,
        };
        let (x, y, width, height) = minimal_panel_frame(remaining, remaining_work, 330.0, 2000.0);
        assert!(
            x >= remaining_work.x,
            "the detail may not start off the left edge"
        );
        assert!(
            x + width <= remaining_work.right(),
            "the rail's right edge has to stay on the remaining display"
        );
        assert!(y >= remaining_work.y);
        assert!(
            y + height <= remaining_work.bottom(),
            "a panel taller than the work area is clamped, not pushed off the bottom"
        );
        // The rail keeps its anchor even when the detail had to be narrowed: its right
        // edge is still the display's right edge minus the rail's own inset.
        assert_eq!(x + width, remaining.right() - MINIMAL_RAIL_RIGHT_INSET);
    }

    #[test]
    fn the_host_learns_the_panel_mode_before_the_window_appears() {
        let source = include_str!("lib.rs");

        // Cold start: the panel webview asks for settings while it is still hidden,
        // and that answer is the only thing telling the host which shape to build.
        let settings = source
            .split("async fn panel_settings")
            .nth(1)
            .expect("settings read command")
            .split("#[tauri::command]")
            .next()
            .expect("end of settings read command");
        assert!(
            settings.contains("minimal_mode"),
            "reading the settings has to record the persisted panel mode"
        );

        // A settings write only moves the host's copy when it actually carried the
        // mode. Recording the answer unconditionally would make a concurrent theme or
        // threshold write, whose response still holds the old mode, silently switch
        // the window back to the full panel.
        let write = settings_write_source(source);
        let guard = write
            .find("panelDisplayMode")
            .expect("the write has to look at the mode field");
        let record = write
            .find("minimal_mode")
            .expect("the write has to record the mode it carried");
        assert!(
            guard < record,
            "an unrelated write must not overwrite the recorded mode"
        );
    }

    #[test]
    fn showing_the_panel_solves_the_rail_frame_before_the_window_is_shown() {
        let source = include_str!("lib.rs");
        let show = source
            .split("fn show_panel")
            .nth(1)
            .expect("show_panel")
            .split("fn hide_panel")
            .next()
            .expect("end of show_panel");
        let layout = show
            .find("panel_set_minimal_layout")
            .expect("showing a minimal panel has to solve the rail's frame");
        let tray = show
            .find("show_full_panel")
            .expect("the full panel keeps its tray anchor");
        let visible = show
            .find("window.show()")
            .expect("show_panel shows the window");
        assert!(
            show.contains("panel_is_minimal"),
            "show_panel has to ask which mode the panel is in"
        );
        assert!(
            layout < visible && tray < visible,
            "the frame has to be solved before the window is shown, or the rail is \
             drawn 350 points wide for a frame before it moves"
        );
    }

    #[test]
    fn showing_an_already_visible_panel_is_not_a_transition() {
        let source = include_str!("lib.rs");
        let show = source
            .split("fn show_panel")
            .nth(1)
            .expect("show_panel")
            .split("fn hide_panel")
            .next()
            .expect("end of show_panel");
        // The panel's enter animation is driven by this event, and the panel has no
        // way to tell a redundant announce from a real re-show: in dev the host shows
        // the panel before the webview subscribes, so the panel believes it is hidden
        // and would fade out and back in. Re-anchoring has the same problem — it moves
        // a window the reader is looking at — so both sit behind the same guard.
        let guard = show
            .find("let was_visible = window.is_visible()")
            .expect("show_panel must know whether the panel was already on screen");
        let anchor = show
            .find("show_full_panel(app, &window, anchor")
            .expect("the full panel keeps its tray anchor");
        let emit = show
            .find("PANEL_VISIBILITY_EVENT")
            .expect("show_panel announces its visibility");
        assert!(
            guard < anchor && guard < emit,
            "the redundant-show guard has to come before both the anchor and the announce"
        );
        assert!(
            show[guard..anchor].contains("return"),
            "an already-visible panel has to return before it is re-anchored"
        );
    }

    #[test]
    fn a_content_update_never_re_anchors_the_rail() {
        let source = include_str!("lib.rs");
        let command = source
            .split("fn panel_set_minimal_layout")
            .nth(1)
            .expect("minimal layout command")
            .split("#[tauri::command]")
            .next()
            .expect("end of minimal layout command");
        assert!(
            command.contains("if anchor"),
            "the command has to branch on whether it may move the window"
        );
        // A data update carries no target origin, so the native resize keeps the
        // current top-left (and, horizontally, the rail's right edge) in place. That
        // is what stops a pure height change from snapping a dragged rail back.
        let target = command
            .find("let target = if anchor")
            .expect("the target origin must be gated on anchoring");
        assert!(
            command[target..].contains("None"),
            "a data update must not carry a target origin"
        );
    }

    #[test]
    fn the_rail_collapses_its_header_without_the_pointer_delay() {
        // Nothing under `cargo test` can wait out a pointer-leave delay, so this guards
        // the wiring instead: the rail's own delay constant exists, is zero, and is the
        // branch the schedule actually sleeps for.
        let source = include_str!("lib.rs");
        // Spelled in two pieces: written whole, the needle would match this test's own
        // text and the assertion could never fail.
        let rail_delay = format!("MINIMAL_HEADER_{}", "HIDE_DELAY_MS");
        assert!(
            source.contains(&format!("const {rail_delay}: u64 = 0")),
            "the rail has to collapse its actions at once, with no delay"
        );
        let schedule = source
            .split("fn schedule_header_hide")
            .nth(1)
            .expect("header hide schedule")
            .split("fn restore_panel_header")
            .next()
            .expect("end of the schedule");
        let branch = schedule
            .split("panel_is_minimal")
            .nth(1)
            .expect("the wait has to depend on which shape the panel is in")
            .split(';')
            .next()
            .expect("end of the delay expression");
        assert!(
            branch.contains(&rail_delay),
            "the minimal branch has to take the rail's own delay"
        );
        assert!(
            branch.contains(&format!("PANEL_HEADER_{}", "HIDE_DELAY_MS")),
            "the full panel has to keep the shared pointer-leave delay"
        );
        assert!(
            schedule.contains("Duration::from_millis(delay)"),
            "the task must sleep for the branch's delay, not the full panel's"
        );
    }

    #[test]
    fn switching_back_to_the_full_panel_re_frames_the_window() {
        let source = include_str!("lib.rs");
        let write = settings_write_source(source);
        // Only a write that actually carried the mode may move the host's copy, and only
        // a switch *out* of the rail may re-frame: recording the answer unconditionally
        // would make a concurrent theme write, whose response still holds the old mode,
        // re-frame the window under the reader.
        assert!(
            write.contains("let left_minimal = *mode && !minimal"),
            "the re-frame has to fire on the minimal -> full transition alone"
        );
        assert!(
            write.contains(&format!("set_full_{}", "layout")),
            "leaving minimal mode has to re-frame a window that is already on screen"
        );
        // The frame it applies is the full panel's, placed by the same arithmetic the
        // show path uses, and a hidden panel is left to `show_panel`.
        let helper = source
            .split("fn set_full_layout")
            .nth(1)
            .expect("the full-layout helper")
            .split("\n}")
            .next()
            .expect("end of the helper");
        assert!(
            helper.contains("show_full_panel"),
            "the full frame is applied by the same path a show uses, or the two drift"
        );
        assert!(
            helper.contains("is_visible"),
            "a hidden panel is left to show_panel, which solves its frame on the way in"
        );
        // That shared path is the one that knows the full width and the tray anchor.
        let frame = source
            .split("fn show_full_panel")
            .nth(1)
            .expect("the shared full-frame helper")
            .split("\n}")
            .next()
            .expect("end of the helper");
        assert!(
            frame.contains("full_panel_target"),
            "the full frame has to reuse the show path's arithmetic"
        );
        assert!(
            frame.contains(&format!("PANEL_{}", "WIDTH")),
            "the full panel is 350 points wide, and only this puts that width back"
        );
    }

    #[test]
    fn minimal_mode_does_not_add_a_second_set_of_window_rules() {
        let source = include_str!("lib.rs");
        let focus = source
            .split("window.on_window_event")
            .nth(1)
            .expect("focus handler")
            .split("Ok(window)")
            .next()
            .expect("end of the panel window builder");
        // Pinning, focus-hide and desktop behaviour are shared by both modes. A mode
        // branch inside this handler would give the rail its own copy of those rules,
        // and the two would drift.
        assert!(
            !focus.contains("minimal_mode"),
            "pin and focus rules belong to the panel, not to one of its shapes"
        );
    }

    #[test]
    fn the_settings_write_is_broadcast_to_every_window() {
        let source = include_str!("lib.rs");
        let command = settings_write_source(source);
        // Every caller has to go through that one write, or one of them — the tray's
        // mode switch today — keeps its own copy that skips the broadcast.
        assert!(
            source.contains("write_settings(&app, patch).await"),
            "the webview command has to delegate to the shared write"
        );
        // The write is announced to all webviews, not answered only to its caller:
        // that is the whole mechanism by which the panel learns what the settings
        // window just changed.
        assert!(
            command.contains(r#"app.emit("panel://settings""#),
            "the written settings must be broadcast, or the other window goes stale"
        );
        assert!(
            command.contains("recollect_now"),
            "a collection-affecting write must be collected again right away"
        );
        // Credentials follow the same rule.
        let credentials = source
            .split("async fn panel_validate_credential")
            .nth(1)
            .expect("credential command")
            .split("fn panel_delete_credential")
            .next()
            .expect("end of credential command");
        assert!(credentials.contains("recollect_now"));
    }

    #[test]
    fn settings_dev_url_matches_the_vite_server() {
        // In dev the panel is served from the Vite dev server whose root is the
        // `src/desktop` directory, so the settings document is its sibling there — close
        // enough to `devUrl` in tauri.conf.json that the two are easy to let drift. The
        // front-end test `serves the settings window document at the URL its builder
        // produces` fetches the path this builds, so a mismatch here would surface as a
        // blank window at runtime rather than as a failing test.
        let dev_url = include_str!("../tauri.conf.json");
        let dev_url = dev_url
            .split("\"devUrl\"")
            .nth(1)
            .and_then(|rest| rest.split('"').nth(1))
            .expect("devUrl in tauri.conf.json");
        // The literal in `settings_window_url()` has to be `devUrl` + `settings.html`.
        let source = include_str!("lib.rs");
        let expected = format!("{dev_url}settings.html");
        assert!(
            source.contains(&expected),
            "settings_window_url() must point at {expected} in dev"
        );
        // The packaged branch loads the document Vite emits next to `index.html`, which
        // is what `rollupOptions.input.settings` and the flattening plugin produce.
        assert!(
            source.contains("WebviewUrl::App(\"settings.html\".into())"),
            "the packaged settings window must load settings.html"
        );
    }

    #[test]
    fn a_section_request_lands_on_a_real_section() {
        for known in SETTINGS_SECTIONS {
            assert_eq!(settings_section(Some(known)), known);
        }
        // Every entry point that names nothing, and every typo, lands on 平台管理:
        // a window left on a section that does not exist would render an empty pane.
        assert_eq!(settings_section(None), SETTINGS_DEFAULT_SECTION);
        assert_eq!(settings_section(Some("")), SETTINGS_DEFAULT_SECTION);
        assert_eq!(
            settings_section(Some("Platforms")),
            SETTINGS_DEFAULT_SECTION
        );
        assert_eq!(settings_section(Some("nope")), SETTINGS_DEFAULT_SECTION);
    }

    #[test]
    fn the_detail_window_never_takes_the_key_window_from_the_rail() {
        // The rail's webview sees pointer events only while its own window is key, and
        // `show()` goes through `makeKeyAndOrderFront`. A detail that could become key
        // therefore ended hover switching: the first card opened and every later hover
        // was invisible to the rail. The guard reads the builder because the failure is
        // invisible in code review — `focused(false)` looks like it already says this,
        // and it only decides the order of the *first* frame.
        let source = include_str!("lib.rs");
        let builder = source
            .split("fn build_minimal_detail_window")
            .nth(1)
            .expect("detail window builder")
            .split("fn open_settings")
            .next()
            .expect("end of detail window builder");
        assert!(
            builder.contains("set_focusable(false)"),
            "the detail window must not be able to become the key window"
        );
        assert!(
            builder.contains("inner_size(339.0"),
            "the detail window is the card (330) plus its border and the caret's strip"
        );
    }

    #[test]
    fn the_settings_window_is_fixed_and_decorated() {
        let source = include_str!("lib.rs");
        let builder = source
            .split("fn build_settings_window")
            .nth(1)
            .expect("settings window builder")
            .split("fn settings_window_url")
            .next()
            .expect("end of settings window builder");
        for required in [
            ".inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)",
            ".min_inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)",
            ".max_inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)",
            ".resizable(false)",
            ".decorations(true)",
            ".visible(false)",
        ] {
            assert!(
                builder.contains(required),
                "the settings window must set {required}"
            );
        }
        // The panel's look is the panel's: a transparent, borderless settings window
        // would make "standard title bar" a lie.
        assert!(
            !builder.contains(".transparent(true)"),
            "the settings window is opaque"
        );
        assert!(
            !builder.contains(".shadow(false)"),
            "it keeps the system window shadow"
        );
        // Standard chrome does not float, and it does belong in the window list.
        assert!(
            !builder.contains(".always_on_top(true)"),
            "the settings window does not float"
        );
        assert!(
            !builder.contains(".skip_taskbar(true)"),
            "it is a normal window"
        );
        // No focus handler: the window keeps its place when the panel takes focus.
        assert!(
            !builder.contains("WindowEvent::Focused"),
            "the settings window must not hide on focus loss"
        );
    }

    #[test]
    fn a_native_resize_keeps_the_current_top_edge() {
        assert_eq!(resized_native_origin_y(200.0, 400.0, 500.0), 100.0);
        assert_eq!(resized_native_origin_y(200.0, 400.0, 300.0), 300.0);
        let command = include_str!("lib.rs")
            .split("fn panel_set_height")
            .nth(1)
            .expect("height command")
            .split("fn panel_open_web_version")
            .next()
            .expect("end of height command");
        assert!(
            !command.contains("set_position"),
            "height frames must not enqueue stale drag positions"
        );
    }

    #[test]
    fn a_drag_preserves_any_position_fully_covered_by_the_desktop() {
        let screens = [
            DisplayBounds {
                x: 0.0,
                y: 0.0,
                width: 1792.0,
                height: 1120.0,
            },
            DisplayBounds {
                x: 1792.0,
                y: -320.0,
                width: 2560.0,
                height: 1440.0,
            },
        ];
        let size = (PANEL_WIDTH, 500.0);
        assert_eq!(
            boundary_clamp_target(&screens, (1700.0, -320.0), size, true),
            None
        );
        assert_eq!(
            boundary_clamp_target(&screens, (1700.0, -320.0), size, false),
            Some((1792.0, -320.0))
        );
        assert_eq!(
            boundary_clamp_target(&screens, (1600.0, 60.0), size, false),
            None
        );
        assert_eq!(
            boundary_clamp_target(&screens, (4200.0, -320.0), size, false),
            Some((4352.0 - PANEL_WIDTH, -320.0))
        );
        assert_eq!(
            boundary_clamp_target(&screens, (4000.0, -320.0), size, false),
            None
        );
        assert_eq!(
            boundary_clamp_target(&screens, (-500.0, 20.0), size, false),
            Some((0.0, 20.0))
        );
    }

    #[test]
    fn a_drop_keeps_its_exact_position_when_the_desktop_contains_the_panel() {
        let screens = [
            DisplayBounds {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 800.0,
            },
            DisplayBounds {
                x: 1000.0,
                y: 0.0,
                width: 1000.0,
                height: 800.0,
            },
        ];
        assert_eq!(
            boundary_clamp_target(&screens, (900.0, 100.0), (350.0, 400.0), false),
            None
        );
    }

    #[test]
    fn a_drop_outside_the_top_moves_only_to_the_top_edge() {
        let screens = [DisplayBounds {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
        }];
        assert_eq!(
            boundary_clamp_target(&screens, (400.0, -40.0), (350.0, 400.0), false),
            Some((400.0, 0.0))
        );
    }

    #[test]
    fn a_drop_past_the_right_and_bottom_moves_to_the_nearest_edges() {
        let screens = [DisplayBounds {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 800.0,
        }];
        assert_eq!(
            boundary_clamp_target(&screens, (900.0, 500.0), (350.0, 400.0), false),
            Some((650.0, 400.0))
        );
    }

    #[test]
    fn a_drop_between_displays_chooses_the_smallest_position_change() {
        let screens = [
            DisplayBounds {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 800.0,
            },
            DisplayBounds {
                x: 1000.0,
                y: -400.0,
                width: 1000.0,
                height: 800.0,
            },
        ];
        assert_eq!(
            boundary_clamp_target(&screens, (700.0, -300.0), (350.0, 400.0), false),
            Some((1000.0, -300.0))
        );
    }

    #[test]
    fn cursor_hit_testing_normalizes_mixed_display_scales() {
        // App cursor coordinates use the primary 2x scale; the external window
        // reports its frame at 1x. The window's corner is 3990/-210 and its box is
        // 350x420 points, so the first sample lands 10/10 inside it, the second 240
        // points to its left, and the third 350 points past its right edge.
        let box_size = (350.0, 420.0);
        assert_eq!(
            point_in_window((8000.0, -400.0), 2.0, (3990.0, -210.0), 1.0),
            (10.0, 10.0)
        );
        assert!(point_in_box(
            point_in_window((8000.0, -400.0), 2.0, (3990.0, -210.0), 1.0),
            box_size
        ));
        assert!(!point_in_box(
            point_in_window((7500.0, -400.0), 2.0, (3990.0, -210.0), 1.0),
            box_size
        ));
        assert!(!point_in_box(
            point_in_window((8680.0, -400.0), 2.0, (3990.0, -210.0), 1.0),
            box_size
        ));
        // The same box on a 2x display: the cursor is at 200/100 points and the window
        // starts at 180/90, so the point is 20/10 inside it.
        assert_eq!(
            point_in_window((200.0, 100.0), 1.0, (360.0, 180.0), 2.0),
            (20.0, 10.0)
        );
        assert!(point_in_box(
            point_in_window((200.0, 100.0), 1.0, (360.0, 180.0), 2.0),
            box_size
        ));
    }

    #[test]
    fn the_cursor_poll_hands_the_rail_the_pointer_it_cannot_see() {
        // The rail opens a platform's card on hover, and hover needs pointer events — which
        // a webview only receives while its window is key. The host's poll is therefore what
        // keeps a pinned, always-on-top rail usable while the reader works in another app or
        // while the settings window holds key. The guard reads the loop because the failure
        // is silent: everything still runs, the rail simply stops answering the pointer.
        let source = include_str!("lib.rs");
        let poll = source
            .split("fn start_cursor_tracking")
            .nth(1)
            .expect("the pointer poll")
            .split("fn panel_is_minimal")
            .next()
            .expect("end of the pointer poll");
        assert!(
            poll.contains(&format!("cursor_point_{}", "in_window")),
            "the poll has to place the pointer inside the panel window"
        );
        assert!(
            poll.contains(&format!("{}-probe", "hover")),
            "and hand it to the rail, which decides what is under it"
        );
        assert!(
            poll.contains(&format!("panel_is_{}", "minimal")),
            "the probe belongs to the rail: the full panel has a normal pointer"
        );
        // And only when the window server agrees the rail is what is under the pointer.
        // The Dock slides out over an always-on-top window without moving it, so every
        // rectangle this host knows still says "the rail": pointing at a Dock icon would
        // open a card, which is the false hover this check exists to stop.
        assert!(
            poll.contains(&format!("forward_pointer_{}", "probe")),
            "the poll has to forward the pointer to the rail's document"
        );
        // The card's document is a window of its own, and it can never be key — so it
        // needs the probe just as much as the rail does.
        assert!(
            poll.contains(&format!("MINIMAL_DETAIL_{}", "LABEL")),
            "the card's document has to be probed too"
        );
        // A probe is only half the story: a webview that is not key never hears the
        // pointer leave either, so the hover it painted has to be taken back — both when
        // the pointer moves off a document and when a document goes away still painted.
        let clear = source
            .split(&format!("fn clear_probe_{}", "hover"))
            .nth(1)
            .expect("the probe's clear helper")
            .split("\n}")
            .next()
            .expect("end of the clear helper");
        assert!(
            clear.contains(&format!("MINIMAL_DETAIL_{}", "LABEL")),
            "clearing has to reach both documents"
        );
        for function in ["fn hide_panel", "fn panel_set_minimal_detail"] {
            let body = source
                .split(function)
                .nth(1)
                .unwrap_or_else(|| panic!("{function} must exist"))
                .split("\n}")
                .next()
                .expect("end of the function");
            assert!(
                body.contains("detail: null") || body.contains(&format!("clear_probe_{}", "hover")),
                "{function} has to take the painted hover back before the window goes away"
            );
        }
    }

    #[test]
    fn only_a_different_window_suppresses_the_hover_probe() {
        let rail = 4242;
        assert!(frontmost_is_ours(rail, rail));
        // Nothing at the point, or nothing readable: the probe stays alive. Failing the
        // other way would take hover away from a pinned rail, which is what it is for.
        assert!(frontmost_is_ours(0, rail));
        assert!(frontmost_is_ours(rail, 0));
        // The Dock, a menu, another window: not a hover on the rail.
        assert!(!frontmost_is_ours(99, rail));
    }

    #[test]
    fn header_tracking_schedules_on_first_visible_outside_sample() {
        let mut inside = None;
        assert_eq!(header_tracking_transition(&mut inside, false, None), None);
        assert_eq!(
            header_tracking_transition(&mut inside, true, Some(false)),
            Some(false)
        );
        assert_eq!(
            header_tracking_transition(&mut inside, true, Some(false)),
            None
        );
        assert_eq!(
            header_tracking_transition(&mut inside, true, Some(true)),
            Some(true)
        );
        assert_eq!(header_tracking_transition(&mut inside, false, None), None);
        assert_eq!(
            header_tracking_transition(&mut inside, true, Some(false)),
            Some(false)
        );
        // A transient window-server read failure must not permanently consume
        // the outside edge if a pending hide is cancelled at its due time.
        assert_eq!(header_tracking_transition(&mut inside, true, None), None);
        assert_eq!(
            header_tracking_transition(&mut inside, true, Some(false)),
            Some(false)
        );
    }

    #[test]
    fn panel_height_is_clamped_to_the_display() {
        // A tall ask stops at the display less the panel's own margins, which on a
        // 900pt work area is tighter than the hard ceiling.
        assert_eq!(
            clamp_panel_height(1400.0, Some(900.0)),
            900.0 - 2.0 * PANEL_MARGIN
        );
        // On a display with room to spare, the hard ceiling is what binds.
        assert_eq!(clamp_panel_height(1400.0, Some(1400.0)), PANEL_MAX_HEIGHT);
        // A short ask is honoured as-is. There is no floor belonging to the content:
        // a short overview is a short panel, and lifting the request would report a
        // height the content does not occupy.
        assert_eq!(clamp_panel_height(420.0, Some(900.0)), 420.0);
        assert_eq!(clamp_panel_height(40.0, Some(900.0)), 40.0);
        // Below the host's own sanity bound the window is still drawable, which is what
        // that bound is for — not for the panel's layout.
        assert_eq!(
            clamp_panel_height(-5.0, Some(900.0)),
            PANEL_MIN_WINDOW_HEIGHT
        );
        // A work area with room for the window is used as it stands, margins and all.
        assert_eq!(
            clamp_panel_height(500.0, Some(200.0)),
            200.0 - 2.0 * PANEL_MARGIN
        );
        // A work area too small for even the sanity bound cannot invert the clamp: the
        // ceiling is raised to the bound rather than pushed below the ask.
        assert_eq!(
            clamp_panel_height(500.0, Some(1.0)),
            PANEL_MIN_WINDOW_HEIGHT
        );
        // No monitor (or a nonsense value) still yields something drawable.
        assert_eq!(clamp_panel_height(500.0, None), 500.0);
        // An infinite ask is a real request and is cut down like any other; only `NaN`
        // has nothing in it to honour.
        assert_eq!(
            clamp_panel_height(f64::INFINITY, Some(900.0)),
            900.0 - 2.0 * PANEL_MARGIN
        );
        assert_eq!(
            clamp_panel_height(f64::NAN, Some(900.0)),
            900.0 - 2.0 * PANEL_MARGIN
        );
    }

    /// A display as the anchor lookup sees it: point bounds plus its scale.
    fn display(x: f64, y: f64, width: f64, height: f64, scale: f64) -> AnchorDisplay {
        AnchorDisplay {
            bounds: DisplayBounds {
                x,
                y,
                width,
                height,
            },
            scale,
        }
    }

    /// A tray rect the way macOS hands it over: physical pixels, its origin on
    /// the top edge of the display whose menu bar was clicked.
    fn tray_rect(x: f64, y: f64, scale: f64) -> tauri::Rect {
        tauri::Rect {
            position: tauri::Position::Physical(tauri::PhysicalPosition::new(
                (x * scale) as i32,
                (y * scale) as i32,
            )),
            size: tauri::Size::Physical(tauri::PhysicalSize::new(24, 24)),
        }
    }

    #[test]
    fn the_clicked_menu_bar_picks_its_own_display() {
        // Two 1920x1080 screens side by side, the second one starting at x=1920.
        let displays = [
            display(0.0, 0.0, 1920.0, 1080.0, 1.0),
            display(1920.0, 0.0, 1920.0, 1080.0, 1.0),
        ];
        // The icon in the first screen's status bar.
        assert_eq!(
            display_for_anchor(&displays, tray_rect(1200.0, 0.0, 1.0)),
            Some(0)
        );
        // The same icon mirrored into the second screen's status bar: this is the
        // click that used to open the panel back on the first screen.
        assert_eq!(
            display_for_anchor(&displays, tray_rect(2500.0, 0.0, 1.0)),
            Some(1)
        );
        // A status bar below the first screen (a display arranged underneath).
        let stacked = [
            display(0.0, 0.0, 1920.0, 1080.0, 1.0),
            display(0.0, -1080.0, 1920.0, 1080.0, 1.0),
        ];
        assert_eq!(
            display_for_anchor(&stacked, tray_rect(900.0, -1080.0, 1.0)),
            Some(1)
        );
    }

    #[test]
    fn a_retina_screen_does_not_swallow_its_neighbour() {
        // This machine's setup: a 2x built-in display 1792x1120 points wide, and
        // a 1x external 2560x1440 whose top sits 320 points higher. In physical
        // pixels the built-in spans 0..3584 while the external starts at 1792,
        // so the two overlap and a physical-pixel test would confuse them.
        let displays = [
            display(0.0, 0.0, 1792.0, 1120.0, 2.0),
            display(1792.0, -320.0, 2560.0, 1440.0, 1.0),
        ];
        // An icon 1200 points into the external screen's menu bar.
        assert_eq!(
            display_for_anchor(&displays, tray_rect(2992.0, -320.0, 1.0)),
            Some(1)
        );
        // An icon 1600 points into the built-in screen's menu bar.
        assert_eq!(
            display_for_anchor(&displays, tray_rect(1600.0, 0.0, 2.0)),
            Some(0)
        );
    }

    #[test]
    fn an_anchor_a_point_off_the_display_still_finds_it() {
        let displays = [
            display(0.0, 0.0, 1792.0, 1120.0, 2.0),
            display(1792.0, -320.0, 2560.0, 1440.0, 1.0),
        ];
        // The status item's frame can be reported a point or two above the top
        // edge it sits on; that must not fall through to the other display.
        assert_eq!(
            display_for_anchor(&displays, tray_rect(2992.0, -322.0, 1.0)),
            Some(1)
        );
        // An anchor outside every display has no answer, so the caller falls back
        // to the window's own display instead of guessing.
        let single = [display(0.0, 0.0, 1920.0, 1080.0, 1.0)];
        assert_eq!(
            display_for_anchor(&single, tray_rect(4000.0, 0.0, 1.0)),
            None
        );
    }

    #[test]
    fn a_work_area_without_a_reserved_menu_bar_does_not_hide_it() {
        // The built-in display: work area already starts below the menu bar, so
        // the reservation stands as reported and nothing moves.
        assert_eq!(panel_top(60.0, 0.0, 60.0), 60.0);
        // The external display: its work area starts at its very top although a
        // menu bar is drawn there, so the panel hangs below the menu bar instead.
        assert_eq!(panel_top(-320.0, -320.0, 30.0), -290.0);
        // A shorter reservation than the menu bar (a display with its own idea
        // of the strip) still clears the menu bar.
        assert_eq!(panel_top(24.0, 0.0, 30.0), 30.0);
        // An auto-hiding menu bar reserves nothing and nothing is added.
        assert_eq!(panel_top(0.0, 0.0, 0.0), 0.0);
    }

    #[test]
    fn a_display_reads_in_points_not_in_its_own_pixels() {
        // This machine, measured against NSScreen: a 2x built-in with a 2240
        // physical-pixel-tall screen and a 2180-tall work area, and a 1x external
        // that reports points to begin with.
        let built_in = DisplayBounds::from_physical(0.0, 0.0, 3584.0, 2240.0, 2.0);
        assert_eq!(
            built_in,
            DisplayBounds {
                x: 0.0,
                y: 0.0,
                width: 1792.0,
                height: 1120.0,
            }
        );
        // The work area keeps the menu bar out, which is what `panel_top` hangs
        // the panel from: 60 physical pixels above its top is a 30-point strip,
        // exactly the visibleFrame macOS reports for this display.
        let work = DisplayBounds::from_physical(0.0, 60.0, 3584.0, 2180.0, 2.0);
        assert_eq!(work.top(), 30.0);
        assert_eq!(work.bottom(), 1120.0);
        assert_eq!(work.right(), 1792.0);
        assert_eq!(
            DisplayBounds::from_physical(1792.0, -320.0, 2560.0, 1440.0, 1.0),
            DisplayBounds {
                x: 1792.0,
                y: -320.0,
                width: 2560.0,
                height: 1440.0,
            }
        );
    }

    #[test]
    fn the_header_hide_follows_the_pointer_not_focus() {
        // Nothing under `cargo test` can observe the window server, so this
        // guards the wiring instead. Tauri filters the cursor enter/leave out of
        // its window events and a non-key webview sees no pointer events, so the
        // host must poll the cursor against the window bounds and drive the header
        // from those transitions — never from focus.
        let source = include_str!("lib.rs");
        // Each needle is spelled in two pieces on purpose: written whole, the
        // needle would match this test's own text and the assertion could never
        // fail.
        assert!(
            source.contains(&format!("cursor_over_{}", "panel")),
            "the host must check the cursor against the panel bounds"
        );
        assert!(
            source.contains(&format!("start_cursor_{}", "tracking")),
            "the host must run the cursor polling loop"
        );
        assert!(
            source.contains(&format!("PANEL_HEADER_{}", "HIDE_DELAY")),
            "the host must keep the shared hide-delay constant"
        );
        assert!(
            source.contains(&format!("restore_panel_{}", "header")),
            "the host must keep the restore strand for the pointer returning"
        );
    }

    #[test]
    fn pinning_is_what_ties_the_panel_to_every_desktop() {
        // Nothing under `cargo test` can observe the window server, so this
        // guards the wiring instead: joining every Space follows the pin flag.
        // Passing a constant `true` would drag the transient popup onto desktops
        // the user never opened it on — a panel appearing over unrelated work —
        // and dropping the call hides a pinned panel on the next desktop switch.
        let source = include_str!("lib.rs");
        // Spelled in two pieces on purpose: written whole, the needle would match
        // this test's own text and the assertion could never fail.
        let pinned_call = format!("set_visible_on_all_workspaces({})", "pinned");
        assert!(
            source.contains(&pinned_call),
            "the panel must join every desktop exactly while it is pinned"
        );
    }

    #[test]
    fn the_panel_is_placed_in_points() {
        // The failure this pins, seen on a 2x built-in beside a 1x external:
        // tao's macOS backend reads a **physical** position in the scale factor of
        // the display the window is on *right now*. A physical target meant for
        // the other display therefore landed at half the distance from its left
        // edge — the panel appeared right next to the neighbour it was supposed to
        // leave — and a click back on the first display could not bring it over.
        // A logical position is handed to `setFrameOrigin` unchanged, so the
        // placement has to stay logical.
        let source = include_str!("lib.rs");
        assert!(
            source.contains("set_position(target)") && source.contains("LogicalPosition::new"),
            "the panel must be moved with a logical position"
        );
        // Spelled in two pieces on purpose: written whole, the needle would match
        // this test's own text and the assertion could never pass.
        let physical_call = format!("set_position({}::new", "PhysicalPosition");
        assert!(
            !source.contains(&physical_call),
            "a physical position is read in the wrong display's scale factor"
        );
    }

    #[test]
    fn the_tray_item_says_what_a_click_would_do() {
        let source = include_str!("lib.rs");
        // One item, two actions: the label has to be whichever action this click is.
        // The pair used to be spelled into a single label, which reads like a switch
        // standing next to three verbs.
        assert!(
            source.contains("const TRAY_SHOW_LABEL: &str = \"显示面板\"")
                && source.contains("const TRAY_HIDE_LABEL: &str = \"隐藏面板\""),
            "the tray item needs a label for each state"
        );
        // The mode item follows the same rule: it names the mode this click switches
        // *to*, so which of its two labels is right depends on the panel's current one.
        assert!(
            source.contains("const TRAY_MINIMAL_LABEL: &str = \"极简模式\"")
                && source.contains("const TRAY_FULL_LABEL: &str = \"标准模式\""),
            "the mode item needs a label for each mode it can switch to"
        );
        // Spelled in two pieces on purpose: written whole, the needle would match
        // this test's own text (and the comment that explains why it is gone).
        let slash_label = format!("显示{}隐藏面板", "/");
        assert!(
            !source.contains(&slash_label),
            "a menu item is one action, not a slash-separated pair"
        );

        // The label is only right if it follows *every* visibility change, including
        // the focus-out hide the user never asked for through the menu.
        for function in ["fn show_panel", "fn hide_panel"] {
            let body = source
                .split(function)
                .nth(1)
                .unwrap_or_else(|| panic!("{function} must exist"))
                .split("\n}")
                .next()
                .expect("end of the function");
            assert!(
                body.contains("sync_tray_toggle"),
                "{function} must keep the tray label in step with the panel"
            );
        }

        // The mode has two ways to change behind the menu's back: the settings read
        // that first tells the host what is persisted, and the one write both windows
        // (and the tray itself) go through. Both have to correct the item.
        for function in ["async fn panel_settings", "async fn write_settings"] {
            let body = source
                .split(function)
                .nth(1)
                .unwrap_or_else(|| panic!("{function} must exist"))
                .split("\n}")
                .next()
                .expect("end of the function");
            assert!(
                body.contains("sync_tray_mode"),
                "{function} must keep the tray's mode item in step with the panel"
            );
        }
    }

    #[test]
    fn the_tray_icon_opens_its_menu_instead_of_toggling_the_panel() {
        let source = include_str!("lib.rs");
        // A status item with a menu is expected to open it on click, and the menu is now
        // where the panel's visibility, shape and theme all live. The left click used to
        // toggle the panel instead, which meant the menu was something a reader had to
        // know to right-click for.
        let builder = source
            .split("TrayIconBuilder::with_id")
            .nth(1)
            .expect("tray icon builder")
            .split(".build(app)?")
            .next()
            .expect("end of the tray icon builder");
        assert!(
            builder.contains("show_menu_on_left_click(true)"),
            "the icon has to open its menu on a left click"
        );
        // No click handler is left to do anything else with the click: the whole reason
        // the panel used to move under a click is that this handler existed.
        assert!(
            !builder.contains("on_tray_icon_event"),
            "the icon click must not reach the panel any more"
        );
        // Spelled in two pieces: written whole, the needle would match this test's own
        // text (and the comment above explaining what went away).
        let focus_hide_stamp = format!("last_focus_{}", "hide");
        assert!(
            !source.contains(&focus_hide_stamp),
            "the guard that discounted a click's own focus-out hide has nothing left to protect"
        );

        // Showing from the menu still has to land beside the icon that was clicked, and
        // the click no longer carries a rect: the icon is asked for its own.
        let handler = source
            .split("on_menu_event")
            .nth(1)
            .expect("tray menu handler")
            .split(".build(app)?")
            .next()
            .expect("end of the tray menu handler");
        assert!(
            handler.contains("toggle_panel(app, tray_anchor(app))"),
            "the menu's show/hide has to anchor on the tray icon"
        );
        let anchor = source
            .split("fn tray_anchor")
            .nth(1)
            .expect("the tray anchor helper")
            .split("\n}")
            .next()
            .expect("end of the tray anchor helper");
        assert!(
            anchor.contains("tray_by_id(TRAY_ID)") && anchor.contains("rect()"),
            "the anchor is the icon's own rectangle, which is on the display its menu opens on"
        );
    }

    #[test]
    fn the_tray_offers_both_panel_modes_as_a_checked_group() {
        let source = include_str!("lib.rs");
        // Both items are kept in the state for the same reason the visibility toggle is:
        // their check marks are corrected after the menu that holds them has been built.
        // A group rather than one item, because the menu has to be able to show which mode
        // the panel is *in*, not only which one a click would switch to.
        assert!(
            source.contains("tray_mode: Mutex<Vec<(&'static str, CheckMenuItem<tauri::Wry>)>>"),
            "the mode group has to stay reachable for its check marks to follow the mode"
        );
        // The menu branches are what a click reaches, and each one names its own mode:
        // one entry per mode, so the clicked item *is* the value to write.
        let handler = source
            .split("on_menu_event")
            .nth(1)
            .expect("tray menu handler")
            .split(".build(app)?")
            .next()
            .expect("end of the tray menu handler");
        for (id, mode) in [
            ("TRAY_MODE_FULL_ID", "full"),
            ("TRAY_MODE_MINIMAL_ID", "minimal"),
        ] {
            assert!(
                handler.contains(&format!("{id} => set_panel_mode(app, \"{mode}\")")),
                "the {id} entry has to switch the panel to {mode}"
            );
        }
        // And that switch is the shared settings write, not a second way to move the
        // panel: `write_settings` is what persists the mode, re-frames a window leaving
        // the rail, broadcasts to both windows and corrects the group.
        let switch = source
            .split("fn set_panel_mode")
            .nth(1)
            .expect("the tray mode switch")
            .split("\n}")
            .next()
            .expect("end of the tray mode switch");
        assert!(
            switch.contains("write_settings"),
            "the tray switch has to go through the one settings write"
        );
        assert!(
            switch.contains("\"panelDisplayMode\""),
            "the switch has to carry the field the panel reads its shape from"
        );
        // The click carries the value, so the item no longer has to be toggled from the
        // host's copy — and nothing else may write the mode behind this path's back.
        assert!(
            !switch.contains("minimal_mode"),
            "the mode switch must not read the current mode to work out the next one"
        );
    }

    #[test]
    fn the_tray_offers_the_theme_the_settings_window_does() {
        let source = include_str!("lib.rs");
        assert!(
            source.contains("tray_theme: Mutex<Vec<(&'static str, CheckMenuItem<tauri::Wry>)>>"),
            "the theme group has to stay reachable for its check marks to follow the theme"
        );
        // One entry per theme, and the labels are the settings window's own words: two
        // surfaces naming one setting differently is a reader's problem, not a style one.
        let settings_window = include_str!("../../src/desktop/settings/AppSettings.tsx");
        for (id, value, label) in [
            ("TRAY_THEME_LIGHT_ID", "light", "浅色"),
            ("TRAY_THEME_DARK_ID", "dark", "深色"),
            ("TRAY_THEME_SYSTEM_ID", "system", "跟随系统"),
        ] {
            assert!(
                source.contains(&format!("const {id}: &str = \"theme-{value}\"")),
                "the tray needs an item id for the {value} theme"
            );
            assert!(
                settings_window.contains(&format!("value: '{value}', label: '{label}'")),
                "the tray's {label} has to be the settings window's own wording"
            );
        }
        let handler = source
            .split("on_menu_event")
            .nth(1)
            .expect("tray menu handler")
            .split(".build(app)?")
            .next()
            .expect("end of the tray menu handler");
        for (id, value) in [
            ("TRAY_THEME_LIGHT_ID", "light"),
            ("TRAY_THEME_DARK_ID", "dark"),
            ("TRAY_THEME_SYSTEM_ID", "system"),
        ] {
            assert!(
                handler.contains(&format!("{id} => set_theme(app, \"{value}\")")),
                "the {id} entry has to write the {value} theme"
            );
        }
        let switch = source
            .split("fn set_theme")
            .nth(1)
            .expect("the tray theme switch")
            .split("\n}")
            .next()
            .expect("end of the tray theme switch");
        assert!(
            switch.contains("write_settings") && switch.contains("\"theme\""),
            "the theme has to go through the one settings write, carrying its field"
        );

        // The group is only honest if it follows *every* way the theme can change: the
        // settings read that first tells the host what is persisted, and the one write
        // both windows (and the tray itself) go through.
        for function in ["async fn panel_settings", "async fn write_settings"] {
            let body = source
                .split(function)
                .nth(1)
                .unwrap_or_else(|| panic!("{function} must exist"))
                .split("\n}")
                .next()
                .expect("end of the function");
            assert!(
                body.contains("sync_tray_theme"),
                "{function} must keep the tray's theme group in step with the settings"
            );
        }
        // Both groups are corrected by the same rule, so neither can end up with two
        // checks or none.
        assert!(
            source.contains("fn sync_tray_radio") && source.contains("sync_tray_radio(&state.tray_mode"),
            "the two radio groups have to be corrected by one helper"
        );
    }

    #[test]
    fn the_menu_offers_a_restart_that_releases_its_own_service_first() {
        let source = include_str!("lib.rs");
        // The tray is built from one list, so the order in that list is the order the
        // user reads. Restarting sits before quitting: both are final for the
        // current process, and neither belongs in the middle of the read-only ones.
        let menu = source
            .split("Menu::with_items")
            .nth(1)
            .expect("tray menu")
            .split(".build(app)?")
            .next()
            .expect("end of the tray setup");
        // The needles are the list entries themselves: the toggle's own id lives on
        // a const now, so the literal only appears in the event handler below. The mode
        // switch sits with the other panel-state action, ahead of the window and
        // process ones.
        let positions: Vec<usize> = [
            "&toggle_item",
            "&full_item",
            "&minimal_item",
            "&light_item",
            "&dark_item",
            "&system_item",
            "\"settings\"",
            "\"restart\"",
            "\"quit\"",
        ]
        .iter()
                .map(|needle| {
                    menu.find(needle)
                        .unwrap_or_else(|| panic!("the tray menu has no {needle} entry"))
                })
                .collect();
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "tray menu entries are out of order: {positions:?}"
        );
        assert!(
            menu.contains("\"重启应用\""),
            "the restart entry has to be labelled"
        );
        assert!(
            source.contains("TRAY_MODE_MINIMAL_ID,") && source.contains("TRAY_MINIMAL_LABEL,"),
            "the mode entries have to be labelled"
        );
        // Four blocks, three separators: without them the two checked groups read as
        // five more verbs in one list, which is the shape this menu was reorganised out
        // of. The order is the read order, so the separators are counted in place.
        assert_eq!(
            menu.matches("PredefinedMenuItem::separator").count(),
            3,
            "the tray menu needs one separator between each pair of blocks"
        );
        // Every entry names an action. "打开设置" rather than a bare "设置…": a noun
        // alone in a context menu reads as a submenu, and the ellipsis that used to
        // mark it as a dialog reads as a promise the menu does not keep here.
        assert!(
            menu.contains("\"打开设置\"") && !menu.contains("设置…"),
            "the settings entry has to name its action, without an ellipsis"
        );

        // The restart never reaches the run-loop exit handler (it re-execs the
        // process instead of requesting an exit), so this branch is the only place
        // that releases the service the host owns — and it has to release it
        // *before* restarting, or the new host attaches to a service on its way out.
        let restart = source
            .split("\"restart\" =>")
            .nth(1)
            .expect("restart menu branch")
            .split("\"quit\" =>")
            .next()
            .expect("end of the restart branch");
        let release = restart
            .find("release_owned_service")
            .expect("the restart must release the service it owns");
        let relaunch = restart
            .find("app.restart()")
            .expect("the restart entry must restart the app");
        assert!(
            release < relaunch,
            "releasing the service after the restart would never run"
        );

        // Quitting goes through the same function, so the two cannot drift apart.
        let exit = source
            .split("RunEvent::ExitRequested")
            .nth(1)
            .expect("exit handler")
            .split("});")
            .next()
            .expect("end of the exit handler");
        assert!(
            exit.contains("release_owned_service"),
            "quitting and restarting have to release the service the same way"
        );
    }
}

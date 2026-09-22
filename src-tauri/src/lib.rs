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
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
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
    /// Guarded so a command that finds the service gone can replace the
    /// connection instead of failing until the app is relaunched.
    service: Mutex<ServiceConnection>,
    /// When a focus-out auto-hid the panel (temporary popup only), so a tray
    /// click that arrives right after is treated as "close" rather than re-open.
    last_focus_hide: Mutex<Instant>,
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
async fn panel_settings(state: tauri::State<'_, PanelState>) -> Result<Value, String> {
    service_get(&state, "/api/settings").await
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
#[tauri::command]
async fn panel_update_settings(
    app: AppHandle,
    state: tauri::State<'_, PanelState>,
    patch: Value,
) -> Result<Value, String> {
    let next = service_mutation(&state, "PUT", "/api/settings", Some(patch.clone())).await?;
    let _ = app.emit("panel://settings", next.clone());
    recollect_now(app, providers_to_recollect(&patch));
    Ok(next)
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

#[cfg(not(target_os = "macos"))]
fn set_panel_size(_app: &AppHandle, window: &WebviewWindow, width: f64, height: f64) {
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
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

#[tauri::command]
fn panel_open_web_version(state: tauri::State<'_, PanelState>) -> Result<(), String> {
    open_url(&state.service_endpoint().origin)
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
        .min_inner_size(350.0, 300.0)
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
            if !*focused && !pinned && visible {
                hide_panel(&app_handle);
                mark_focus_hide(&app_handle);
            }
        }
    });

    Ok(window)
}

/// How often the host re-checks whether the pointer is over the panel.
const CURSOR_POLL_MS: u64 = 150;

/// Whether the pointer currently sits inside the panel window's bounds.
///
/// tao reports cursor coordinates at the primary display's scale and window
/// coordinates at the window's own scale, even though both share a point-space
/// origin. Comparing the raw physical values breaks on mixed-DPI displays.
fn point_inside_panel(
    cursor: (f64, f64),
    cursor_scale: f64,
    origin: (f64, f64),
    size: (f64, f64),
    window_scale: f64,
) -> bool {
    let (x, y) = (cursor.0 / cursor_scale, cursor.1 / cursor_scale);
    let (left, top) = (origin.0 / window_scale, origin.1 / window_scale);
    x >= left && x < left + size.0 / window_scale && y >= top && y < top + size.1 / window_scale
}

/// `AppHandle::cursor_position` uses the primary display's scale, whereas the
/// window frame uses its own backing scale. Compare them only after converting
/// both to the shared macOS point coordinate space.
fn cursor_over_panel(app: &AppHandle) -> Option<bool> {
    let window = app.get_webview_window("panel")?;
    let Ok(cursor) = app.cursor_position() else {
        return None;
    };
    let Ok(origin) = window.outer_position() else {
        return None;
    };
    let Ok(size) = window.outer_size() else {
        return None;
    };
    let cursor_scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| display_scale(&monitor))
        .unwrap_or(1.0);
    let window_scale = window.scale_factor().unwrap_or(1.0);
    let window_scale = if window_scale.is_finite() && window_scale > 0.0 {
        window_scale
    } else {
        1.0
    };
    Some(point_inside_panel(
        (cursor.x, cursor.y),
        cursor_scale,
        (f64::from(origin.x), f64::from(origin.y)),
        (f64::from(size.width), f64::from(size.height)),
        window_scale,
    ))
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
        loop {
            tokio::time::sleep(Duration::from_millis(CURSOR_POLL_MS)).await;
            let visible = app_handle
                .get_webview_window("panel")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            let action = header_tracking_transition(
                &mut inside,
                visible,
                visible.then(|| cursor_over_panel(&app_handle)).flatten(),
            );
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

/// Schedule the panel's header hide for after the pointer-leave delay.
///
/// Generation-guarded like the animated hide: whatever happens in the next few
/// seconds — the pointer coming back, the panel being hidden, a tray toggle —
/// bumps the generation, and the task wakes up only to find its invite obsolete.
fn schedule_header_hide(app: &AppHandle) {
    let generation = bump_header_generation(app);
    diag_log("header hide scheduled");
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PANEL_HEADER_HIDE_DELAY_MS)).await;
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

/// Record that a focus-out just hid the panel.
fn mark_focus_hide(app: &AppHandle) {
    let state = app.state::<PanelState>();
    let mut guard = state
        .last_focus_hide
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Instant::now();
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

/// Position the panel left-aligned with the tray icon, 10 logical pixels below
/// the status bar and never past the screen edge (task 5.3).
///
/// Every number here is in points, and the window is moved with a *logical*
/// position, because points are the only space two displays with different scale
/// factors agree on. tao's macOS backend turns a **physical** position into window
/// coordinates with the scale factor of the display the window is on *right now*,
/// so a physical target computed for the other display lands somewhere else
/// entirely: with a 2x built-in and a 1x external side by side, clicking the icon
/// on the external put the panel at half the intended distance from its left edge
/// — right next to the built-in instead of under the icon — and clicking back on
/// the built-in could not bring it over, because the panel stayed inside the
/// external display. A logical position is handed to `setFrameOrigin` as it is.
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

    let Some(monitor) = target_monitor(app, &window, anchor) else {
        // A temporary monitor lookup failure is not permission to discard a
        // position the user chose by moving the window to screen centre.
        return;
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
    let target = LogicalPosition::new(x.max(work.left()), y.max(work.top()));
    // Showing may follow a recent tray click on the same display, so avoid a
    // window-server round trip if it is already at the target.
    if let Ok(current) = window.outer_position() {
        let current_x = f64::from(current.x) / window_scale;
        let current_y = f64::from(current.y) / window_scale;
        if (current_x - target.x).abs() < 0.5 && (current_y - target.y).abs() < 0.5 {
            return;
        }
    }
    diag_log(&format!(
        "position_near_tray work=({},{}) {}x{} scale={scale} top={top} target=({},{})",
        work.x, work.y, work.width, work.height, target.x, target.y
    ));
    let _ = window.set_position(target);
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
    position_near_tray(app, anchor);
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

    // If a focus-out auto-hide just ran, the tray click was the "close" that
    // triggered it — do not immediately re-open.
    {
        let state = app.state::<PanelState>();
        let recent_hide = state
            .last_focus_hide
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .elapsed()
            < Duration::from_millis(400);
        if recent_hide {
            return;
        }
    }

    show_panel(app, anchor);
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
    let y = if lifted >= work_y + PANEL_MARGIN { lifted } else { y };
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
    let monitor = settings
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| {
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

    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        settings_window_url(),
    )
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
            let _ = build_panel_window(app.handle())?;

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
                service: Mutex::new(service),
                last_focus_hide: Mutex::new(Instant::now()),
                visibility: Mutex::new(VisibilityState::default()),
                header_generation: Mutex::new(0),
                settings_section: Mutex::new(SETTINGS_DEFAULT_SECTION),
                tray_toggle: Mutex::new(None),
            });

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

            let menu = Menu::with_items(
                app,
                &[
                    &toggle_item,
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
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_panel(app, None),
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
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        diag_log("tray left click");
                        toggle_panel(tray.app_handle(), Some(rect));
                    }
                })
                .build(app)?;
            let _ = tray;

            // The item was created with the hidden-panel label, and a dev build has
            // already put the panel on screen by now.
            app.state::<PanelState>()
                .tray_toggle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .replace(toggle_item);
            sync_tray_toggle(app.handle());

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
        assert_eq!(providers_to_recollect(&json!({ "glmRegion": "global" })), vec!["glm"]);
        assert_eq!(providers_to_recollect(&json!({ "codexCliPath": "/opt/homebrew/bin/codex" })), vec!["codex"]);
        assert_eq!(providers_to_recollect(&json!({ "glmWalletEnabled": true })), vec!["glm"]);
        assert_eq!(providers_to_recollect(&json!({ "deepseekWebEnabled": true })), vec!["deepseek"]);

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
    fn the_settings_write_is_broadcast_to_every_window() {
        let source = include_str!("lib.rs");
        let command = source
            .split("async fn panel_update_settings")
            .nth(1)
            .expect("settings write command")
            .split("#[tauri::command]")
            .next()
            .expect("end of settings write command");
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
        assert_eq!(settings_section(Some("Platforms")), SETTINGS_DEFAULT_SECTION);
        assert_eq!(settings_section(Some("nope")), SETTINGS_DEFAULT_SECTION);
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
            assert!(builder.contains(required), "the settings window must set {required}");
        }
        // The panel's look is the panel's: a transparent, borderless settings window
        // would make "standard title bar" a lie.
        assert!(!builder.contains(".transparent(true)"), "the settings window is opaque");
        assert!(!builder.contains(".shadow(false)"), "it keeps the system window shadow");
        // Standard chrome does not float, and it does belong in the window list.
        assert!(!builder.contains(".always_on_top(true)"), "the settings window does not float");
        assert!(!builder.contains(".skip_taskbar(true)"), "it is a normal window");
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
        // reports its frame at 1x. Both points describe x=4000, y=-200.
        assert!(point_inside_panel(
            (8000.0, -400.0),
            2.0,
            (3990.0, -210.0),
            (350.0, 420.0),
            1.0
        ));
        assert!(!point_inside_panel(
            (7500.0, -400.0),
            2.0,
            (3990.0, -210.0),
            (350.0, 420.0),
            1.0
        ));
        assert!(!point_inside_panel(
            (8680.0, -400.0),
            2.0,
            (3990.0, -210.0),
            (350.0, 420.0),
            1.0
        ));
        assert!(point_inside_panel(
            (200.0, 100.0),
            1.0,
            (360.0, 180.0),
            (700.0, 840.0),
            2.0
        ));
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
        assert_eq!(clamp_panel_height(-5.0, Some(900.0)), PANEL_MIN_WINDOW_HEIGHT);
        // A work area with room for the window is used as it stands, margins and all.
        assert_eq!(clamp_panel_height(500.0, Some(200.0)), 200.0 - 2.0 * PANEL_MARGIN);
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
        // a const now, so the literal only appears in the event handler below.
        let positions: Vec<usize> = ["&toggle_item", "\"settings\"", "\"restart\"", "\"quit\""]
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

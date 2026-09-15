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

#[tauri::command]
async fn panel_snapshot(state: tauri::State<'_, PanelState>) -> Result<Value, String> {
    service_get(&state, "/api/snapshots").await
}

#[tauri::command]
async fn panel_settings(state: tauri::State<'_, PanelState>) -> Result<Value, String> {
    service_get(&state, "/api/settings").await
}

#[tauri::command]
async fn panel_update_settings(
    state: tauri::State<'_, PanelState>,
    patch: Value,
) -> Result<Value, String> {
    service_mutation(&state, "PUT", "/api/settings", Some(patch)).await
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
    state: tauri::State<'_, PanelState>,
    target: String,
    secret: String,
) -> Result<Value, String> {
    service_mutation(
        &state,
        "PUT",
        &format!("/api/credentials/{target}"),
        Some(json!({ "secret": secret })),
    )
    .await
}

#[tauri::command]
async fn panel_delete_credential(
    state: tauri::State<'_, PanelState>,
    target: String,
) -> Result<Value, String> {
    service_mutation(
        &state,
        "DELETE",
        &format!("/api/credentials/{target}"),
        None,
    )
    .await
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
        return PANEL_MIN_HEIGHT;
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

// ---------------------------------------------------------------------------
// Window behaviour (tasks 5.2–5.6)
// ---------------------------------------------------------------------------

/// Logical inset between the panel and the status bar / screen edge.
const PANEL_MARGIN: f64 = 10.0;

/// Panel width in logical pixels: the content is designed for it and never resizes.
const PANEL_WIDTH: f64 = 350.0;
/// Floor for the self-sized panel. Matches `min-height` on `.panel` in panel.css.
const PANEL_MIN_HEIGHT: f64 = 320.0;
/// Ceiling for the self-sized panel, whatever the content asks for: the panel
/// follows its content but is never taller than one screen of cards.
const PANEL_MAX_HEIGHT: f64 = 900.0;

/// Clamp a requested panel height to something a display can actually show.
///
/// Split out from the command so the bounds are testable without a window: the
/// panel asks for the height its content needs, and this decides how much of that
/// request the screen allows.
fn clamp_panel_height(requested: f64, work_area_height: Option<f64>) -> f64 {
    // A display can be shorter than the floor; the floor wins there, which is why
    // the limit is itself clamped rather than used directly.
    let upper = match work_area_height.map(|height| height - 2.0 * PANEL_MARGIN) {
        Some(limit) if limit.is_finite() => limit.clamp(PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT),
        _ => PANEL_MAX_HEIGHT,
    };
    if requested.is_finite() {
        requested.clamp(PANEL_MIN_HEIGHT, upper)
    } else {
        PANEL_MIN_HEIGHT
    }
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

            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "toggle", "显示/隐藏面板", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
                ],
            )?;

            let tray = TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/tray-template.png"
                ))?)
                .icon_as_template(true)
                .tooltip("用量面板")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_panel(app, None),
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
            panel_open_web_version
        ])
        .build(context)
        .expect("failed to build the agents-usage desktop host")
}

pub fn run() {
    build(tauri::generate_context!()).run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app.state::<PanelState>();
            let connection = state
                .service
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if connection.owned_by_desktop {
                if let Some(child) = &connection.child {
                    if let Ok(mut child) = child.lock() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
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
    fn panel_height_is_clamped_to_the_display_and_the_floor() {
        // A tall ask stops at the display less the panel's own margins, which on a
        // 900pt work area is tighter than the hard ceiling.
        assert_eq!(
            clamp_panel_height(1400.0, Some(900.0)),
            900.0 - 2.0 * PANEL_MARGIN
        );
        // On a display with room to spare, the hard ceiling is what binds.
        assert_eq!(clamp_panel_height(1400.0, Some(1400.0)), PANEL_MAX_HEIGHT);
        // A short ask is honoured as-is: the panel follows small content.
        assert_eq!(clamp_panel_height(420.0, Some(900.0)), 420.0);
        // The floor holds even when the content is one line tall.
        assert_eq!(clamp_panel_height(40.0, Some(900.0)), PANEL_MIN_HEIGHT);
        // A work area shorter than the floor cannot invert the clamp.
        assert_eq!(clamp_panel_height(500.0, Some(200.0)), PANEL_MIN_HEIGHT);
        // No monitor (or a nonsense value) still yields something drawable.
        assert_eq!(clamp_panel_height(500.0, None), 500.0);
        assert_eq!(clamp_panel_height(f64::NAN, Some(900.0)), PANEL_MIN_HEIGHT);
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
}

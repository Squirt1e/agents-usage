//! Authenticated loopback HTTP API for the desktop panel and companion web page.
//!
//! Every response is redacted before serialization; mutations require the
//! session token plus a loopback Host/Origin; the discovery token never appears
//! in a URL or a log line (tasks 4.4, 4.5).

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::RwLock;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt as _;

use usage_core::adapters::codex::{CodexCollector, CollectionContext};
use usage_core::adapters::deepseek::DeepSeekCollector;
use usage_core::adapters::deepseek_web::{web_connection, DeepSeekWebCollector};
use usage_core::adapters::glm::{
    glm_wallet_allowed_hosts, GlmQuotaCollector, GlmRefreshContext, GlmWalletCollector,
};
use usage_core::contracts::{
    DesktopSettings, IsoTimestamp, ProviderId, ProviderSnapshot, ProviderState,
};
use usage_core::credentials::{
    keychain_delete_sync, keychain_get_sync, keychain_set_sync, CredentialStatus, CredentialTarget,
};
use usage_core::estimate::Timezone;
use usage_core::transport::SharedHttpTransport;
use usage_core::redaction::redact;
use usage_core::scheduler::RefreshScheduler;

use crate::{run_connection, Collectors};

/// A redacted event broadcast to the SSE stream.
#[derive(Clone, Debug)]
pub enum ServiceEvent {
    Snapshot(Vec<ProviderState>),
}

/// Shared state handed to every request handler.
pub struct AppState {
    pub store: Arc<std::sync::Mutex<usage_core::storage::Store>>,
    pub settings: Arc<RwLock<DesktopSettings>>,
    pub scheduler: Arc<RefreshScheduler>,
    pub collectors: Arc<Collectors>,
    pub transport: SharedHttpTransport,
    pub session_token: String,
    pub instance_id: String,
    pub timezone: String,
    pub events: broadcast::Sender<ServiceEvent>,
}

impl AppState {
    /// Persisted provider states for the snapshot endpoint.
    pub fn provider_states(&self) -> Result<Vec<ProviderState>, crate::ServiceError> {
        let store = self
            .store
            .lock()
            .map_err(|_| crate::ServiceError::Other("store lock poisoned".to_string()))?;
        Ok(store.provider_states()?)
    }

    /// Current settings plus the masked credential statuses.
    pub async fn settings_payload(&self) -> Result<Value, crate::ServiceError> {
        let settings = self.settings.read().unwrap().clone();
        let mut payload = serde_json::to_value(settings)
            .map_err(|error| crate::ServiceError::Other(error.to_string()))?;
        let credentials = self.credential_statuses().await?;
        payload["credentials"] = serde_json::to_value(credentials)
            .map_err(|error| crate::ServiceError::Other(error.to_string()))?;
        Ok(redact(&payload))
    }

    async fn credential_statuses(&self) -> Result<Vec<CredentialStatus>, crate::ServiceError> {
        let settings = self.settings.read().unwrap().clone();
        let mut statuses = Vec::new();
        for target in [
            CredentialTarget::GlmQuota,
            CredentialTarget::GlmWallet,
            CredentialTarget::DeepSeek,
            CredentialTarget::DeepSeekWeb,
        ] {
            let enabled = credential_enabled(target, &settings);
            statuses.push(match keychain_get_sync(target) {
                Ok(Some(secret)) => CredentialStatus::configured(target, &secret, enabled),
                Ok(None) => CredentialStatus::missing(target, enabled),
                Err(_) => CredentialStatus::missing(target, enabled),
            });
        }
        statuses.push(CredentialStatus::missing(
            CredentialTarget::CodexDelegated,
            true,
        ));
        Ok(statuses)
    }

    /// Validate a candidate credential against the real read-only endpoint.
    async fn validate_credential(
        &self,
        target: CredentialTarget,
        secret: &str,
    ) -> Result<(), String> {
        let transport = Arc::clone(&self.transport);
        let result = match target {
            CredentialTarget::DeepSeek => DeepSeekCollector::new(transport, secret.to_string())
                .refresh()
                .await
                .map(|_| ()),
            CredentialTarget::GlmQuota => {
                let region = self.settings.read().unwrap().glm_region;
                let context = GlmRefreshContext::new(self.timezone.clone(), chrono::Utc::now());
                GlmQuotaCollector::new(transport)
                    .with_region(region)
                    .with_credential_value(secret.to_string())
                    .refresh(&context)
                    .await
                    .map(|_| ())
            }
            CredentialTarget::GlmWallet => {
                let endpoint =
                    std::env::var("AGENTS_USAGE_GLM_WALLET_ENDPOINT").unwrap_or_default();
                GlmWalletCollector::new(transport)
                    .with_enabled_flag(true)
                    .with_endpoint(endpoint)
                    .with_allowed_hosts(glm_wallet_allowed_hosts())
                    .with_credential_value(secret.to_string())
                    .refresh(chrono::Utc::now())
                    .await
                    .map(|_| ())
            }
            CredentialTarget::DeepSeekWeb => {
                let timezone = self.settings.read().unwrap().timezone.clone();
                DeepSeekWebCollector::new(transport, timezone)
                    .with_enabled_flag(true)
                    .with_credential_value(secret.to_string())
                    .refresh(chrono::Utc::now())
                    .await
                    .map(|_| ())
            }
            CredentialTarget::CodexDelegated => {
                return Err("Codex 登录由本机 Codex 管理，面板不保存凭据".to_string())
            }
        };
        result.map_err(|error| error.message.clone())
    }

    /// Refresh the Codex connection only (the rate-limit notification path).
    pub async fn refresh_codex(&self, codex: &Arc<CodexCollector>) {
        let now = chrono::Utc::now();
        let context = CollectionContext::new(codex_usage_day_at(now), "UTC", IsoTimestamp::now());
        let task: crate::RefreshTask<usage_core::contracts::ProviderSnapshot> = {
            let codex = Arc::clone(codex);
            Arc::new(move || {
                let codex = Arc::clone(&codex);
                let context = context.clone();
                Box::pin(async move { codex.refresh(&context).await })
            })
        };
        let connection = usage_core::contracts::ConnectionId::new(ProviderId::Codex, "account");
        crate::run_connection_forced(
            &self.scheduler,
            &self.store,
            "codex:account",
            ProviderId::Codex,
            &connection,
            task,
            true,
        )
        .await;
        self.publish().await;
    }

    /// Refresh every connection once through the shared scheduler.
    pub async fn refresh_all(&self) -> Result<(), crate::ServiceError> {
        let settings = self.settings.read().unwrap().clone();
        let timezone = settings.timezone.clone();
        let now = chrono::Utc::now();

        if let Some(codex) = &self.collectors.codex {
            let context =
                CollectionContext::new(codex_usage_day_at(now), "UTC", IsoTimestamp::now());
            let task: crate::RefreshTask<usage_core::contracts::ProviderSnapshot> = {
                let codex = Arc::clone(codex);
                Arc::new(move || {
                    let codex = Arc::clone(&codex);
                    let context = context.clone();
                    Box::pin(async move { codex.refresh(&context).await })
                })
            };
            let connection = usage_core::contracts::ConnectionId::new(ProviderId::Codex, "account");
            run_connection(
                &self.scheduler,
                &self.store,
                "codex:account",
                ProviderId::Codex,
                &connection,
                task,
            )
            .await;
        }

        let glm_context = GlmRefreshContext::new(timezone.clone(), now);
        {
            let quota = Arc::clone(&self.collectors.glm_quota);
            let context = glm_context.clone();
            let task: crate::RefreshTask<usage_core::contracts::ProviderSnapshot> =
                Arc::new(move || {
                    let quota = Arc::clone(&quota);
                    let context = context.clone();
                    Box::pin(async move { quota.refresh(&context).await })
                });
            let connection = usage_core::contracts::ConnectionId::new(ProviderId::Glm, "quota");
            run_connection(
                &self.scheduler,
                &self.store,
                "glm:quota",
                ProviderId::Glm,
                &connection,
                task,
            )
            .await;
        }
        // A switched-off experimental connection is not attempted at all: an
        // opt-out is the user's choice, not a connection failure, and recording
        // it would leave a "disabled" verdict in the connection's health that
        // later reads as the latest attempt — pointing at "enable it" as the fix
        // for a connection that is already enabled. Same rule as a missing Codex
        // CLI: nothing is attempted, so nothing is recorded.
        if self.collectors.glm_wallet.is_enabled() {
            let wallet = Arc::clone(&self.collectors.glm_wallet);
            let task: crate::RefreshTask<usage_core::contracts::ProviderSnapshot> =
                Arc::new(move || {
                    let wallet = Arc::clone(&wallet);
                    Box::pin(async move { wallet.refresh(chrono::Utc::now()).await })
                });
            let connection = usage_core::contracts::ConnectionId::new(ProviderId::Glm, "wallet");
            run_connection(
                &self.scheduler,
                &self.store,
                "glm:wallet",
                ProviderId::Glm,
                &connection,
                task,
            )
            .await;
        }
        {
            let deepseek = Arc::clone(&self.collectors.deepseek);
            let task: crate::RefreshTask<usage_core::contracts::ProviderSnapshot> =
                Arc::new(move || {
                    let deepseek = Arc::clone(&deepseek);
                    Box::pin(async move { deepseek.refresh().await })
                });
            let connection =
                usage_core::contracts::ConnectionId::new(ProviderId::Deepseek, "wallet");
            run_connection(
                &self.scheduler,
                &self.store,
                "deepseek:wallet",
                ProviderId::Deepseek,
                &connection,
                task,
            )
            .await;
        }
        if self.collectors.deepseek_web.is_enabled() {
            let web = Arc::clone(&self.collectors.deepseek_web);
            let task: crate::RefreshTask<usage_core::contracts::ProviderSnapshot> =
                Arc::new(move || {
                    let web = Arc::clone(&web);
                    Box::pin(async move { web.refresh(chrono::Utc::now()).await })
                });
            run_connection(
                &self.scheduler,
                &self.store,
                "deepseek:web",
                ProviderId::Deepseek,
                &web_connection(),
                task,
            )
            .await;
        }

        self.publish().await;
        Ok(())
    }

    /// Broadcast the current persisted states to every SSE listener.
    pub async fn publish(&self) {
        if let Ok(states) = self.provider_states() {
            let _ = self.events.send(ServiceEvent::Snapshot(states));
        }
    }
}

/// Codex app-server's `dailyUsageBuckets` are keyed by the provider's UTC day.
/// Keep that range separate from the user's display timezone so the metric does
/// not disappear between local midnight and UTC midnight.
fn codex_usage_day_at(now: chrono::DateTime<chrono::Utc>) -> String {
    now.format("%Y-%m-%d").to_string()
}

/// Security helpers used by every request: loopback + Host + Origin + token.
fn host_is_loopback(host: &str) -> bool {
    let host = host.split(':').next().unwrap_or(host);
    matches!(host, "127.0.0.1" | "::1" | "localhost")
}

fn origin_is_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(axum::http::header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(url) = origin.parse::<url::Url>() else {
        return false;
    };
    // Mutations arrive from the companion web page (http) over loopback, or the
    // desktop webview (tauri) when a bridge is absent. Both are same-origin
    // local surfaces.
    (url.scheme() == "http" || url.scheme() == "tauri")
        && url.host_str().is_some_and(|host| {
            matches!(host, "127.0.0.1" | "::1" | "localhost" | "tauri.localhost")
        })
}

fn token_is_valid(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get("x-session-token")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == state.session_token)
}

/// Build the router.
pub fn router(state: Arc<AppState>, client_dir: Option<PathBuf>) -> Router {
    let router = Router::new()
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/snapshots", get(snapshots))
        .route("/api/settings", get(settings).put(update_settings))
        .route("/api/diagnostics", get(diagnostics))
        .route(
            "/api/credentials/{target}",
            put(put_credential).delete(delete_credential),
        )
        .route(
            "/api/refresh/{provider}",
            axum::routing::post(refresh_provider),
        )
        .route("/events", get(events))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            security_guard,
        ))
        .with_state(state);

    match client_dir {
        Some(dir) => router.fallback_service(tower_http::services::ServeDir::new(dir)),
        None => router,
    }
}

/// Every request must target a loopback host; mutations must also carry an
/// allowed Origin and the session token. Binding to `127.0.0.1` already limits
/// the socket to loopback, so the Host/Origin checks are the header-level guard
/// that stops a foreign page from being served or from mutating state.
async fn security_guard(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let host_ok = request
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(host_is_loopback);
    if !host_ok {
        return error_response(StatusCode::FORBIDDEN, "Loopback access only");
    }

    let method = request.method().clone();
    let is_mutation = method != axum::http::Method::GET
        && method != axum::http::Method::HEAD
        && method != axum::http::Method::OPTIONS;
    if is_mutation {
        if !origin_is_allowed(request.headers()) {
            return error_response(StatusCode::FORBIDDEN, "Untrusted origin");
        }
        if !token_is_valid(&state, request.headers()) {
            return error_response(StatusCode::FORBIDDEN, "Invalid local session token");
        }
    }

    next.run(request).await
}

async fn bootstrap(State(state): State<Arc<AppState>>) -> Response {
    let settings = match state.settings_payload().await {
        Ok(settings) => settings,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    Json(json!({
        "sessionToken": state.session_token,
        "settings": settings,
    }))
    .into_response()
}

async fn snapshots(State(state): State<Arc<AppState>>) -> Response {
    match state.provider_states() {
        Ok(providers) => Json(
            json!({ "providers": redact(&serde_json::to_value(providers).unwrap_or(Value::Null)) }),
        )
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

async fn settings(State(state): State<Arc<AppState>>) -> Response {
    match state.settings_payload().await {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPatch {
    theme: Option<String>,
    timezone: Option<String>,
    glm_region: Option<String>,
    glm_wallet_enabled: Option<bool>,
    deepseek_web_enabled: Option<bool>,
    platform_visibility: Option<std::collections::BTreeMap<String, bool>>,
    platform_order: Option<Vec<String>>,
    codex_cli_path: Option<String>,
    codex_reset_format: Option<String>,
    glm_reset_format: Option<String>,
    codex_quota_display: Option<String>,
    glm_quota_display: Option<String>,
    quota_value_mode: Option<String>,
    quota_warning_threshold: Option<serde_json::Value>,
    /// Parsed leniently by the same function the stored record uses: an entry
    /// the panel should not have sent is dropped, not failed.
    peak_reminder: Option<serde_json::Value>,
}

fn parse_reset_format(value: &str) -> Option<usage_core::contracts::ResetTimeFormat> {
    match value {
        "countdown" => Some(usage_core::contracts::ResetTimeFormat::Countdown),
        "absolute" => Some(usage_core::contracts::ResetTimeFormat::Absolute),
        _ => None,
    }
}

fn parse_quota_display(value: &str) -> Option<usage_core::contracts::QuotaDisplayMode> {
    match value {
        "ring" => Some(usage_core::contracts::QuotaDisplayMode::Ring),
        "bar" => Some(usage_core::contracts::QuotaDisplayMode::Bar),
        _ => None,
    }
}

fn parse_quota_value_mode(value: &str) -> Option<usage_core::contracts::QuotaValueMode> {
    match value {
        "remaining" => Some(usage_core::contracts::QuotaValueMode::Remaining),
        "used" => Some(usage_core::contracts::QuotaValueMode::Used),
        _ => None,
    }
}

async fn update_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(patch): Json<SettingsPatch>,
) -> Response {
    if !token_is_valid(&state, &headers) {
        return error_response(StatusCode::FORBIDDEN, "Invalid local session token");
    }
    let quota_warning_threshold = match patch.quota_warning_threshold.as_ref() {
        Some(value) => match value.as_u64().filter(|value| *value <= 100) {
            Some(value) => Some(value as u8),
            None => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "Invalid quota warning threshold",
                )
            }
        },
        None => None,
    };
    // Apply the patch under a scoped write lock, then release it before the
    // response is read back (settings_payload re-acquires the read lock, and a
    // sync RwLock is not reentrant).
    {
        let mut settings = state.settings.write().unwrap();
        if let Some(theme) = patch.theme {
            settings.theme = match theme.as_str() {
                "light" => usage_core::contracts::ThemePreference::Light,
                "dark" => usage_core::contracts::ThemePreference::Dark,
                "system" => usage_core::contracts::ThemePreference::System,
                _ => return error_response(StatusCode::BAD_REQUEST, "Invalid theme"),
            };
        }
        if let Some(timezone) = patch.timezone {
            if Timezone::parse(&timezone).is_err() {
                return error_response(StatusCode::BAD_REQUEST, "Invalid timezone");
            }
            settings.timezone = timezone;
        }
        if let Some(region) = patch.glm_region {
            settings.glm_region = match region.as_str() {
                "china" => usage_core::contracts::GlmRegion::China,
                "international" => usage_core::contracts::GlmRegion::International,
                _ => return error_response(StatusCode::BAD_REQUEST, "Invalid GLM region"),
            };
        }
        if let Some(enabled) = patch.glm_wallet_enabled {
            settings.glm_wallet_enabled = enabled;
        }
        if let Some(enabled) = patch.deepseek_web_enabled {
            settings.deepseek_web_enabled = enabled;
        }
        if let Some(visibility) = patch.platform_visibility {
            for (provider, visible) in visibility {
                let Some(provider) = parse_provider(&provider) else {
                    continue;
                };
                settings.platform_visibility.insert(provider, visible);
            }
        }
        if let Some(order) = patch.platform_order {
            let mut parsed = Vec::new();
            for provider in order {
                if let Some(provider) = parse_provider(&provider) {
                    parsed.push(provider);
                }
            }
            if !parsed.is_empty() {
                settings.platform_order = parsed;
            }
        }
        if let Some(path) = patch.codex_cli_path {
            settings.codex_cli_path = if path.trim().is_empty() {
                None
            } else {
                Some(path)
            };
        }
        if let Some(format) = patch.codex_reset_format {
            settings.codex_reset_format = match parse_reset_format(&format) {
                Some(parsed) => parsed,
                None => {
                    return error_response(StatusCode::BAD_REQUEST, "Invalid reset time format")
                }
            };
        }
        if let Some(format) = patch.glm_reset_format {
            settings.glm_reset_format = match parse_reset_format(&format) {
                Some(parsed) => parsed,
                None => {
                    return error_response(StatusCode::BAD_REQUEST, "Invalid reset time format")
                }
            };
        }
        if let Some(display) = patch.codex_quota_display {
            settings.codex_quota_display = match parse_quota_display(&display) {
                Some(parsed) => parsed,
                None => return error_response(StatusCode::BAD_REQUEST, "Invalid quota display"),
            };
        }
        if let Some(display) = patch.glm_quota_display {
            settings.glm_quota_display = match parse_quota_display(&display) {
                Some(parsed) => parsed,
                None => return error_response(StatusCode::BAD_REQUEST, "Invalid quota display"),
            };
        }
        if let Some(mode) = patch.quota_value_mode {
            settings.quota_value_mode = match parse_quota_value_mode(&mode) {
                Some(parsed) => parsed,
                None => return error_response(StatusCode::BAD_REQUEST, "Invalid quota value mode"),
            };
        }
        if let Some(threshold) = quota_warning_threshold {
            settings.quota_warning_threshold = threshold;
        }
        if let Some(value) = patch.peak_reminder {
            // An unusable map degrades to unset here too, so a bad patch can
            // never poison the stored settings the way a bad record could not.
            settings.peak_reminder = usage_core::contracts::peak_reminder_from_value(&value);
        }

        if let Ok(mut store) = state.store.lock() {
            if let Err(error) = store.save_desktop_settings(&settings) {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string());
            }
        }
    }

    match state.settings_payload().await {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

async fn diagnostics(State(state): State<Arc<AppState>>) -> Response {
    let store_diagnostics = {
        let store = match state.store.lock() {
            Ok(store) => store,
            Err(_) => {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, "store lock poisoned")
            }
        };
        json!({
            "location": store.location(),
            "sizeBytes": store.size_bytes(),
            "snapshotCount": store.snapshot_count().unwrap_or(0),
            "observationCount": store.observation_count().unwrap_or(0),
            "schemaVersion": store.schema_version().unwrap_or(0),
        })
    };
    let settings = state.settings.read().unwrap().clone();
    let payload = json!({
        "instanceId": state.instance_id,
        "origin": "loopback",
        "database": store_diagnostics,
        "settings": redact(&serde_json::to_value(settings).unwrap_or(Value::Null)),
    });
    Json(redact(&payload)).into_response()
}

/// The value a pasted credential is reduced to before it is validated and stored.
///
/// Every collector adds its own scheme (`Bearer <secret>`), and the documented
/// way to obtain a web token is to copy it out of an `Authorization` request
/// header. Users paste the whole header value often enough that sending it
/// verbatim (`Bearer Bearer <token>`) is a rejection the panel cannot explain —
/// the console answers `40003 Authorization Failed (invalid token)`, which reads
/// as an expired session. Stripping a leading scheme here keeps the stored value
/// the token itself, so both validation and collection send the same header.
fn normalize_credential(secret: &str) -> String {
    const BEARER: &[u8] = b"bearer ";
    let trimmed = secret.trim();
    // Compare bytes so a pasted value that is not valid UTF-8 at that offset
    // cannot panic on a slice; the matched prefix is ASCII, so the index below is
    // a character boundary.
    if trimmed.len() >= BEARER.len() && trimmed.as_bytes()[..BEARER.len()].eq_ignore_ascii_case(BEARER) {
        return trimmed[BEARER.len()..].trim().to_string();
    }
    trimmed.to_string()
}

async fn put_credential(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(target): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if !token_is_valid(&state, &headers) {
        return error_response(StatusCode::FORBIDDEN, "Invalid local session token");
    }
    let Some(target) = CredentialTarget::parse(&target) else {
        return error_response(StatusCode::NOT_FOUND, "Unknown credential target");
    };
    let Some(secret) = body.get("secret").and_then(Value::as_str) else {
        return error_response(StatusCode::BAD_REQUEST, "Credential is required");
    };
    let secret = normalize_credential(secret);
    if secret.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Credential is required");
    }

    match state.validate_credential(target, &secret).await {
        Ok(()) => {}
        Err(message) => {
            return error_response(StatusCode::BAD_REQUEST, &message);
        }
    }
    if let Err(error) = keychain_set_sync(target, &secret) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.message);
    }
    let status = match keychain_get_sync(target) {
        Ok(Some(stored)) => {
            let enabled = credential_enabled(target, &state.settings.read().unwrap());
            CredentialStatus::configured(target, &stored, enabled)
        }
        _ => CredentialStatus::missing(target, true),
    };
    Json(status).into_response()
}

async fn delete_credential(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(target): Path<String>,
) -> Response {
    if !token_is_valid(&state, &headers) {
        return error_response(StatusCode::FORBIDDEN, "Invalid local session token");
    }
    let Some(target) = CredentialTarget::parse(&target) else {
        return error_response(StatusCode::NOT_FOUND, "Unknown credential target");
    };
    if let Err(error) = keychain_delete_sync(target) {
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.message);
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn refresh_provider(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(provider): Path<String>,
) -> Response {
    if !token_is_valid(&state, &headers) {
        return error_response(StatusCode::FORBIDDEN, "Invalid local session token");
    }
    let Some(provider) = parse_provider(&provider) else {
        return error_response(StatusCode::NOT_FOUND, "Unknown provider");
    };

    // Manual refresh: run that provider's connection(s) with a forced refresh so
    // a user action bypasses the cooldown.
    match provider {
        ProviderId::Codex => {
            if let Some(codex) = &state.collectors.codex {
                state.refresh_codex(codex).await;
            }
        }
        ProviderId::Glm => {
            let context = GlmRefreshContext::new(state.timezone.clone(), chrono::Utc::now());
            let quota_task: crate::RefreshTask<ProviderSnapshot> = {
                let quota = Arc::clone(&state.collectors.glm_quota);
                let context = context.clone();
                Arc::new(move || {
                    let quota = Arc::clone(&quota);
                    let context = context.clone();
                    Box::pin(async move { quota.refresh(&context).await })
                })
            };
            let quota_connection =
                usage_core::contracts::ConnectionId::new(ProviderId::Glm, "quota");
            crate::run_connection_forced(
                &state.scheduler,
                &state.store,
                "glm:quota",
                ProviderId::Glm,
                &quota_connection,
                quota_task,
                true,
            )
            .await;

            // Manual refresh follows the same rule as the schedule: a switched-off
            // experimental connection is not attempted, so it gains no fresh
            // verdict from a click that never had anything to refresh.
            if state.collectors.glm_wallet.is_enabled() {
                let wallet_task: crate::RefreshTask<ProviderSnapshot> = {
                    let wallet = Arc::clone(&state.collectors.glm_wallet);
                    Arc::new(move || {
                        let wallet = Arc::clone(&wallet);
                        Box::pin(async move { wallet.refresh(chrono::Utc::now()).await })
                    })
                };
                let wallet_connection =
                    usage_core::contracts::ConnectionId::new(ProviderId::Glm, "wallet");
                crate::run_connection_forced(
                    &state.scheduler,
                    &state.store,
                    "glm:wallet",
                    ProviderId::Glm,
                    &wallet_connection,
                    wallet_task,
                    true,
                )
                .await;
            }
        }
        ProviderId::Deepseek => {
            let deepseek_task: crate::RefreshTask<ProviderSnapshot> = {
                let deepseek = Arc::clone(&state.collectors.deepseek);
                Arc::new(move || {
                    let deepseek = Arc::clone(&deepseek);
                    Box::pin(async move { deepseek.refresh().await })
                })
            };
            let connection =
                usage_core::contracts::ConnectionId::new(ProviderId::Deepseek, "wallet");
            crate::run_connection_forced(
                &state.scheduler,
                &state.store,
                "deepseek:wallet",
                ProviderId::Deepseek,
                &connection,
                deepseek_task,
                true,
            )
            .await;

            if state.collectors.deepseek_web.is_enabled() {
                let web_task: crate::RefreshTask<ProviderSnapshot> = {
                    let web = Arc::clone(&state.collectors.deepseek_web);
                    Arc::new(move || {
                        let web = Arc::clone(&web);
                        Box::pin(async move { web.refresh(chrono::Utc::now()).await })
                    })
                };
                crate::run_connection_forced(
                    &state.scheduler,
                    &state.store,
                    "deepseek:web",
                    ProviderId::Deepseek,
                    &web_connection(),
                    web_task,
                    true,
                )
                .await;
            }
        }
    }
    state.publish().await;
    Json(json!({ "status": "refresh-requested" })).into_response()
}

async fn events(State(state): State<Arc<AppState>>) -> Response {
    let receiver = state.events.subscribe();
    let stream = BroadcastStream::new(receiver).map(|item| {
        let event = match item {
            Ok(ServiceEvent::Snapshot(states)) => {
                let payload = serde_json::to_string(&redact(
                    &serde_json::to_value(states).unwrap_or(Value::Null),
                ))
                .unwrap_or_else(|_| "null".to_string());
                Event::default().event("snapshot").data(payload)
            }
            Err(_) => Event::default().event("closed").data("event stream closed"),
        };
        Ok::<_, Infallible>(event)
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn parse_provider(value: &str) -> Option<ProviderId> {
    match value {
        "codex" => Some(ProviderId::Codex),
        "glm" => Some(ProviderId::Glm),
        "deepseek" => Some(ProviderId::Deepseek),
        _ => None,
    }
}

/// Whether the connection that uses this credential is switched on in the
/// settings. Experimental connections follow their own flags; the stable
/// connections are always on.
fn credential_enabled(target: CredentialTarget, settings: &DesktopSettings) -> bool {
    match target {
        CredentialTarget::GlmWallet => settings.glm_wallet_enabled,
        CredentialTarget::DeepSeekWeb => settings.deepseek_web_enabled,
        _ => true,
    }
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": usage_core::redaction::redact_str(message) })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{codex_usage_day_at, normalize_credential};
    use chrono::{TimeZone, Utc};

    #[test]
    fn codex_usage_day_follows_the_provider_utc_bucket() {
        let after_shanghai_midnight = Utc
            .with_ymd_and_hms(2026, 9, 10, 16, 30, 0)
            .single()
            .expect("valid instant");

        assert_eq!(codex_usage_day_at(after_shanghai_midnight), "2026-09-10");
    }

    #[test]
    fn a_pasted_authorization_header_is_reduced_to_its_token() {
        // Users copy the whole header value; the collectors add `Bearer `
        // themselves, so the scheme must not survive into what is stored.
        assert_eq!(normalize_credential("Bearer sk-abc123"), "sk-abc123");
        assert_eq!(normalize_credential("bearer\tsk-abc123"), "bearer\tsk-abc123");
        assert_eq!(normalize_credential("Bearer   sk-abc123  "), "sk-abc123");
        assert_eq!(normalize_credential("BEARER sk-abc123"), "sk-abc123");
        // A token is only stripped when the scheme is really a prefix.
        assert_eq!(normalize_credential("  sk-abc123\n"), "sk-abc123");
        assert_eq!(normalize_credential("Bearer"), "Bearer");
        assert_eq!(normalize_credential("sk-Bearer-abc"), "sk-Bearer-abc");
    }
}

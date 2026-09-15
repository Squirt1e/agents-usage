//! The Codex collector: app-server session, quota normalization and CLI
//! discovery.
//!
//! ## What is collected
//!
//! Codex exposes everything through the local `codex app-server` JSON-RPC
//! process, so the collector never reads credential files and never calls a
//! model:
//!
//! - `account/read` answers whether a Codex account is signed in. Signed out is
//!   an `ErrorKind::Authentication` failure whose message points the user at
//!   Codex itself (the panel must not ask for a Codex key it cannot use);
//! - `account/rateLimits/read` carries the quota buckets, normalized by
//!   [`normalize_codex_rate_limits`];
//! - `account/usage/read` is optional activity data, normalized by
//!   [`normalize_codex_usage`]. A failure there must never remove the
//!   authoritative quota metrics.
//!
//! ## Normalization rules
//!
//! - Bucket ids come from `limitId`, falling back to the key of
//!   `rateLimitsByLimitId`; `rateLimitsByLimitId` is preferred over the legacy
//!   shared `rateLimits` object, which keeps the old `codex` bucket id.
//! - `primary` and `secondary` are read from each bucket's **own** metadata, so a
//!   bucket whose windows arrive out of order, or whose length is unknown, is
//!   still normalized without disturbing any other bucket.
//! - `windowSeconds = windowDurationMins * 60`, and only when the length is
//!   present; a missing `resetsAt` leaves `resetAt` absent instead of inventing a
//!   time.
//! - `resetsAt` is unix **seconds** and becomes ISO-8601 **milliseconds**.
//! - A bucket whose `usedPercent` is absent or out of range makes the payload
//!   incompatible: the collector reports `ErrorKind::Compatibility` and the
//!   caller keeps the previous snapshot rather than showing a zero it never
//!   received.
//! - `credits.balance` becomes `<bucketId>.credits.balance` with unit `credits`
//!   and direction `balance`, and is absent when the platform did not report it.
//!
//! The shared golden expectations live in `fixtures/contracts/codex-windows.json`
//! and are asserted by `crates/usage-core/tests/codex_collector.rs`.

pub mod cli;
pub mod json_rpc;

use std::fmt;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::contracts::{
    Confidence, ConnectionId, ConnectionStatus, IsoTimestamp, MetricCapability, MetricDirection,
    MetricInput, MetricValue, ProviderId, ProviderSnapshot, StatisticScope, UsageMetric,
};
use crate::http::{CollectorError, CommandRunner};
use crate::redaction::redact_str;

pub use crate::adapters::codex::cli::{
    discover_codex_cli, CodexCli, CodexCliCandidate, CodexCliDiscoveryOptions, CodexCliOrigin,
    CodexVersion, SystemCommandRunner, COMMON_CODEX_CLI_LOCATIONS,
};
pub use crate::adapters::codex::json_rpc::{
    ClientInfo, CodexAppServerSupervisor, CodexSupervisorOptions, JsonRpcClient,
    NotificationHandler, RpcMessage, RpcTransport, SharedRpcTransport, SleepFn, StdioRpcCommand,
    StdioRpcTransport, TransportFactory, APP_SERVER_ARGS, DEFAULT_BASE_BACKOFF,
    DEFAULT_MAX_BACKOFF, DEFAULT_REQUEST_TIMEOUT,
};

/// `source` value every Codex metric carries.
pub const CODEX_SOURCE: &str = "codex-app-server";

/// Stable connection identifier for the Codex account.
pub const CODEX_CONNECTION: &str = "account";

/// Methods of the app-server protocol the collector uses.
pub const ACCOUNT_READ: &str = "account/read";
pub const RATE_LIMITS_READ: &str = "account/rateLimits/read";
pub const USAGE_READ: &str = "account/usage/read";
/// Notification Codex sends when a quota window changed.
pub const RATE_LIMITS_UPDATED: &str = "account/rateLimits/updated";

/// The Codex account connection, as stored in the snapshot and its metrics.
pub fn codex_connection() -> ConnectionId {
    ConnectionId::with_label(ProviderId::Codex, CODEX_CONNECTION, "Codex")
}

/// Callback invoked when Codex reports a quota change.
pub type RateLimitUpdateHandler = Arc<dyn Fn() + Send + Sync>;

/// The JSON-RPC capability the adapter needs.
///
/// Implemented by [`JsonRpcClient`] and by [`CodexAppServerSupervisor`], and by
/// tests with a scripted fake, so normalization can be exercised without a child
/// process.
pub trait CodexRpc: Send + Sync + fmt::Debug {
    /// Issue one request. Implementations apply their own timeout.
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, CollectorError>> + Send + 'a>>;

    /// Register a notification handler.
    fn on_notification(&self, method: &str, handler: NotificationHandler);
}

impl CodexRpc for JsonRpcClient {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, CollectorError>> + Send + 'a>> {
        Box::pin(JsonRpcClient::request(self, method, params))
    }

    fn on_notification(&self, method: &str, handler: NotificationHandler) {
        JsonRpcClient::on_notification(self, method, handler);
    }
}

impl CodexRpc for CodexAppServerSupervisor {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, CollectorError>> + Send + 'a>> {
        Box::pin(CodexAppServerSupervisor::request(self, method, params))
    }

    fn on_notification(&self, method: &str, handler: NotificationHandler) {
        CodexAppServerSupervisor::on_notification(self, method, handler);
    }
}

/// When the collection happened and which statistics day it describes.
///
/// The statistics day is supplied by the caller because the service knows the
/// provider's bucket timezone. Codex daily usage buckets use UTC; the adapter
/// records that timezone in the emitted metric scope.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionContext {
    /// Provider statistics date, `YYYY-MM-DD`.
    pub local_day: String,
    /// IANA timezone `local_day` was computed in.
    pub timezone: String,
    /// Capture time recorded on the snapshot.
    pub captured_at: IsoTimestamp,
}

impl CollectionContext {
    pub fn new(
        local_day: impl Into<String>,
        timezone: impl Into<String>,
        captured_at: IsoTimestamp,
    ) -> Self {
        Self {
            local_day: local_day.into(),
            timezone: timezone.into(),
            captured_at,
        }
    }

    /// A context captured now.
    pub fn now(local_day: impl Into<String>, timezone: impl Into<String>) -> Self {
        Self::new(local_day, timezone, IsoTimestamp::now())
    }
}

/// Collects Codex usage from an app-server session.
pub struct CodexAdapter {
    rpc: Arc<dyn CodexRpc>,
    update_handlers: Mutex<Vec<RateLimitUpdateHandler>>,
}

impl fmt::Debug for CodexAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexAdapter")
            .field("provider", &CodexAdapter::PROVIDER)
            .field("rpc", &self.rpc)
            .field("update_handlers", &lock(&self.update_handlers).len())
            .finish()
    }
}

impl CodexAdapter {
    pub const PROVIDER: ProviderId = ProviderId::Codex;
    pub const SOURCE: &'static str = CODEX_SOURCE;

    /// Build an adapter and subscribe to `account/rateLimits/updated`.
    ///
    /// The notification handler keeps only a [`Weak`] reference so the session
    /// does not extend the adapter's lifetime.
    pub fn new(rpc: Arc<dyn CodexRpc>) -> Arc<Self> {
        let adapter = Arc::new(Self {
            rpc,
            update_handlers: Mutex::new(Vec::new()),
        });
        let weak: Weak<Self> = Arc::downgrade(&adapter);
        adapter.rpc.on_notification(
            RATE_LIMITS_UPDATED,
            Arc::new(move |_params| {
                if let Some(adapter) = weak.upgrade() {
                    adapter.notify_update_handlers();
                }
            }),
        );
        adapter
    }

    /// Register a callback invoked when Codex reports a quota change.
    pub fn on_rate_limits_updated(&self, handler: RateLimitUpdateHandler) {
        lock(&self.update_handlers).push(handler);
    }

    fn notify_update_handlers(&self) {
        let handlers: Vec<RateLimitUpdateHandler> = lock(&self.update_handlers).clone();
        for handler in handlers {
            handler();
        }
    }

    /// Refresh one snapshot.
    ///
    /// Failures are returned to the caller, which is expected to keep the
    /// previous snapshot and mark it stale ([`codex_stale_snapshot`]) instead of
    /// showing zeroed data.
    pub async fn refresh(
        &self,
        context: &CollectionContext,
    ) -> Result<ProviderSnapshot, CollectorError> {
        let account = self.rpc.request(ACCOUNT_READ, json!({})).await?;
        let signed_in = account
            .get("account")
            .map(|account| !account.is_null())
            .unwrap_or(false);
        if !signed_in {
            return Err(CollectorError::authentication(
                "Codex is not signed in; complete sign-in through the Codex app or CLI, then refresh",
            ));
        }

        let rate_limits = self.rpc.request(RATE_LIMITS_READ, json!({})).await?;
        let mut snapshot = normalize_codex_rate_limits(&rate_limits, &context.captured_at)?;

        // Daily activity is optional: any failure here leaves the authoritative
        // quota metrics in place.
        if let Ok(usage) = self.rpc.request(USAGE_READ, json!({})).await {
            if let Ok(activity) =
                normalize_codex_usage(&usage, &context.local_day, &context.timezone)
            {
                snapshot.metrics.extend(activity);
            }
        }

        Ok(snapshot)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A snapshot for a Codex failure with no usable data.
///
/// `missing_config` and `authentication` mean the connection was never
/// established, so the contract reports `disconnected`; anything else is
/// `unavailable`. Metrics stay empty: a failure never fabricates values.
pub fn codex_unavailable_snapshot(error: &CollectorError, at: &IsoTimestamp) -> ProviderSnapshot {
    let mut snapshot = ProviderSnapshot::unavailable(
        ProviderId::Codex,
        CODEX_SOURCE,
        error.to_contract(at.clone()),
    );
    snapshot.connection = Some(codex_connection());
    snapshot
}

/// The previous snapshot marked stale after a failure: same capture time, same
/// values, `degraded` status and a `stale` confidence on every metric.
pub fn codex_stale_snapshot(
    previous: &ProviderSnapshot,
    error: &CollectorError,
    at: &IsoTimestamp,
) -> ProviderSnapshot {
    previous.mark_stale(error.to_contract(at.clone()))
}

/// Which of the two windows a bucket may carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowName {
    Primary,
    Secondary,
}

impl WindowName {
    const ALL: [WindowName; 2] = [WindowName::Primary, WindowName::Secondary];

    fn as_str(self) -> &'static str {
        match self {
            WindowName::Primary => "primary",
            WindowName::Secondary => "secondary",
        }
    }
}

fn incompatible(message: impl AsRef<str>) -> CollectorError {
    CollectorError::compatibility(message)
}

/// A validated bucket together with the id it will be keyed under.
struct Bucket<'a> {
    id: String,
    name: Option<String>,
    plan_type: Option<String>,
    value: &'a Value,
}

fn bucket_id(bucket: &Value, key: &str) -> String {
    bucket
        .get("limitId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(key)
        .to_string()
}

fn optional_string(bucket: &Value, field: &str) -> Option<String> {
    bucket
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Positive window length in seconds, when the platform reported a usable one.
///
/// A missing, null, zero or non-numeric length means "not reported": the metric
/// then carries no `windowSeconds`, which is what
/// `fixtures/contracts/codex-windows.json` pins for the `unknown-window` bucket.
fn window_seconds(window: &Value) -> Option<u64> {
    let minutes = window.get("windowDurationMins")?.as_f64()?;
    if !minutes.is_finite() || minutes <= 0.0 {
        return None;
    }
    let seconds = (minutes * 60.0).round();
    if !seconds.is_finite() || seconds <= 0.0 || seconds > u64::MAX as f64 {
        return None;
    }
    Some(seconds as u64)
}

/// Reset time as ISO-8601 milliseconds, converted from unix **seconds**.
///
/// An absent, null or non-positive `resetsAt` leaves `resetAt` absent: an
/// unknown reset time must never become "now" or 1970.
fn reset_at(window: &Value) -> Option<IsoTimestamp> {
    let value = window.get("resetsAt")?;
    if value.is_null() {
        return None;
    }
    if let Some(seconds) = value.as_i64() {
        return (seconds > 0).then(|| IsoTimestamp::from_unix_seconds(seconds));
    }
    let seconds = value.as_f64()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    Some(IsoTimestamp::from_unix_millis(
        (seconds * 1_000.0).round() as i64
    ))
}

fn used_percent(window: &Value) -> Result<f64, CollectorError> {
    let raw = window
        .get("usedPercent")
        .ok_or_else(|| incompatible("Codex rate-limit window has no usedPercent"))?;
    let percent = raw
        .as_f64()
        .ok_or_else(|| incompatible("Codex rate-limit usedPercent is not a number"))?;
    if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
        // Matches the TypeScript schema (`min(0).max(100)`): an out-of-range
        // percentage is an incompatible payload, never a value to clamp or zero.
        return Err(incompatible(
            "Codex rate-limit usedPercent is outside 0..=100",
        ));
    }
    Ok(percent)
}

fn window_details(bucket: &Bucket<'_>) -> Map<String, Value> {
    let mut details = Map::new();
    details.insert("bucketId".to_string(), Value::String(bucket.id.clone()));
    if let Some(name) = bucket.name.as_ref() {
        details.insert("bucketName".to_string(), Value::String(name.clone()));
    }
    if let Some(plan_type) = bucket.plan_type.as_ref() {
        details.insert("planType".to_string(), Value::String(plan_type.clone()));
    }
    details
}

fn window_metrics(
    bucket: &Bucket<'_>,
    name: WindowName,
) -> Result<Vec<UsageMetric>, CollectorError> {
    let Some(window) = bucket
        .value
        .get(name.as_str())
        .filter(|window| !window.is_null())
    else {
        return Ok(Vec::new());
    };
    if !window.is_object() {
        return Err(incompatible(format!(
            "Codex rate-limit {} window is not an object",
            name.as_str()
        )));
    }

    let percent = used_percent(window)?;
    let reset_at = reset_at(window);
    let window_seconds = window_seconds(window);
    let label = format!(
        "{} {}",
        bucket.name.clone().unwrap_or_else(|| bucket.id.clone()),
        name.as_str()
    );
    let details = window_details(bucket);

    let mut metrics = Vec::with_capacity(2);
    for (suffix, value, direction) in [
        ("used", percent, MetricDirection::Used),
        ("remaining", 100.0 - percent, MetricDirection::Remaining),
    ] {
        metrics.push(
            UsageMetric::normalize(MetricInput {
                key: format!("{}.{}.{}", bucket.id, name.as_str(), suffix),
                label: Some(label.clone()),
                value: Some(MetricValue::Number(value)),
                unit: "percent".to_string(),
                direction,
                limit: None,
                reset_at: reset_at.clone(),
                window_seconds,
                confidence: Some(vec![Confidence::Authoritative]),
                source: CODEX_SOURCE.to_string(),
                details: Some(details.clone()),
                connection: Some(codex_connection()),
                capability: Some(MetricCapability::Supported),
                scope: None,
            })
            .map_err(|error| {
                incompatible(format!("Codex rate-limit metric is invalid: {error}"))
            })?,
        );
    }
    Ok(metrics)
}

fn credit_metric(
    bucket: &Bucket<'_>,
    credits: &Value,
) -> Result<Option<UsageMetric>, CollectorError> {
    if !credits.is_object() {
        return Ok(None);
    }
    let Some(balance) = credits.get("balance").filter(|balance| !balance.is_null()) else {
        return Ok(None);
    };

    // A string balance is the documented shape (`"12.50"`); a numeric balance is
    // accepted as well. A non-numeric string is kept as text so the platform
    // value is reported verbatim instead of being dropped or turned into NaN.
    let value = match balance {
        Value::Number(number) => number.as_f64().map(MetricValue::Number),
        Value::String(text) => {
            let trimmed = text.trim();
            match trimmed.parse::<f64>() {
                Ok(number) if number.is_finite() => Some(MetricValue::Number(number)),
                _ => Some(MetricValue::Text(trimmed.to_string())),
            }
        }
        _ => None,
    };
    let Some(value) = value else {
        return Ok(None);
    };

    let mut details = Map::new();
    details.insert("bucketId".to_string(), Value::String(bucket.id.clone()));
    for field in ["hasCredits", "unlimited"] {
        if let Some(flag) = credits.get(field).and_then(Value::as_bool) {
            details.insert(field.to_string(), Value::Bool(flag));
        }
    }

    Ok(Some(
        UsageMetric::normalize(MetricInput {
            key: format!("{}.credits.balance", bucket.id),
            label: Some("Credits".to_string()),
            value: Some(value),
            unit: "credits".to_string(),
            direction: MetricDirection::Balance,
            confidence: Some(vec![Confidence::Authoritative]),
            source: CODEX_SOURCE.to_string(),
            details: Some(details),
            connection: Some(codex_connection()),
            capability: Some(MetricCapability::Supported),
            ..MetricInput::default()
        })
        .map_err(|error| incompatible(format!("Codex credits metric is invalid: {error}")))?,
    ))
}

/// Normalize `account/rateLimits/read` into a snapshot.
///
/// See the module docs for the exact rules; the shared golden expectations live
/// in `fixtures/contracts/codex-windows.json`.
pub fn normalize_codex_rate_limits(
    payload: &Value,
    captured_at: &IsoTimestamp,
) -> Result<ProviderSnapshot, CollectorError> {
    let response = payload
        .as_object()
        .ok_or_else(|| incompatible("Codex rate-limit response is not an object"))?;

    let by_limit_id = response
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .filter(|buckets| !buckets.is_empty());

    let mut fallback = Map::new();
    if let Some(legacy) = response.get("rateLimits").filter(|value| !value.is_null()) {
        if !legacy.is_object() {
            return Err(incompatible("Codex rateLimits is not an object"));
        }
        // The legacy shape has no per-bucket id, so it keeps the shared `codex`
        // bucket id exactly like the TypeScript implementation.
        fallback.insert("codex".to_string(), legacy.clone());
    }

    let buckets: Vec<(&String, &Value)> = match by_limit_id {
        Some(buckets) => buckets.iter().collect(),
        None => {
            if fallback.is_empty() {
                return Err(incompatible("Codex rate-limit response has no buckets"));
            }
            fallback.iter().collect()
        }
    };

    let mut metrics: Vec<UsageMetric> = Vec::new();
    for (key, value) in &buckets {
        if !value.is_object() {
            return Err(incompatible(format!(
                "Codex rate-limit bucket {key} is not an object"
            )));
        }
        let bucket = Bucket {
            id: bucket_id(value, key),
            name: optional_string(value, "limitName"),
            plan_type: optional_string(value, "planType"),
            value,
        };
        for name in WindowName::ALL {
            metrics.extend(window_metrics(&bucket, name)?);
        }
        if let Some(credits) = bucket
            .value
            .get("credits")
            .filter(|credits| !credits.is_null())
        {
            if let Some(metric) = credit_metric(&bucket, credits)? {
                metrics.push(metric);
            }
        }
    }

    // `sharedBucket` mirrors the TypeScript diagnostic: it tells the panel
    // whether the shared `codex` bucket is present in this response.
    let mut diagnostic = Map::new();
    if let Some(account_id) = response
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        diagnostic.insert(
            "accountId".to_string(),
            Value::String(redact_str(account_id)),
        );
    }
    diagnostic.insert(
        "sharedBucket".to_string(),
        if buckets.iter().any(|(key, _)| key.as_str() == "codex") {
            Value::String("codex".to_string())
        } else {
            Value::Null
        },
    );

    Ok(ProviderSnapshot {
        provider: ProviderId::Codex,
        connection: Some(codex_connection()),
        status: ConnectionStatus::Connected,
        captured_at: captured_at.clone(),
        last_success_at: Some(captured_at.clone()),
        source: CODEX_SOURCE.to_string(),
        metrics,
        error: None,
        diagnostic: Some(diagnostic),
        extra: Map::new(),
    })
}

/// Normalize `account/usage/read` into optional activity metrics.
///
/// `local_day` is the requested statistics date. Only a `dailyUsageBuckets` entry
/// whose `startDate` equals it produces `activity.daily.tokens`, so a bucket for
/// another day is never shown as today. A reported `0` is a reliable zero and is
/// kept. `activity.lifetime.tokens` is emitted only when the summary provides it.
pub fn normalize_codex_usage(
    payload: &Value,
    local_day: &str,
    timezone: &str,
) -> Result<Vec<UsageMetric>, CollectorError> {
    let response = payload
        .as_object()
        .ok_or_else(|| incompatible("Codex usage response is not an object"))?;
    let summary = response
        .get("summary")
        .and_then(Value::as_object)
        .ok_or_else(|| incompatible("Codex usage response has no summary"))?;

    let mut metrics: Vec<UsageMetric> = Vec::new();

    if let Some(buckets) = response
        .get("dailyUsageBuckets")
        .filter(|value| !value.is_null())
    {
        let buckets = buckets
            .as_array()
            .ok_or_else(|| incompatible("Codex dailyUsageBuckets is not an array"))?;
        for bucket in buckets {
            let bucket = bucket
                .as_object()
                .ok_or_else(|| incompatible("Codex dailyUsageBuckets entry is not an object"))?;
            let start_date = bucket
                .get("startDate")
                .and_then(Value::as_str)
                .ok_or_else(|| incompatible("Codex dailyUsageBuckets entry has no startDate"))?;
            let tokens = bucket
                .get("tokens")
                .and_then(Value::as_f64)
                .filter(|tokens| tokens.is_finite() && *tokens >= 0.0)
                .ok_or_else(|| {
                    incompatible("Codex dailyUsageBuckets entry has no usable tokens")
                })?;

            if start_date != local_day {
                continue;
            }

            let mut details = Map::new();
            details.insert(
                "startDate".to_string(),
                Value::String(start_date.to_string()),
            );
            details.insert(
                "bucketField".to_string(),
                Value::String("startDate".to_string()),
            );
            metrics.push(
                UsageMetric::normalize(MetricInput {
                    key: "activity.daily.tokens".to_string(),
                    label: Some("Today tokens".to_string()),
                    value: Some(MetricValue::Number(tokens)),
                    unit: "tokens".to_string(),
                    direction: MetricDirection::Activity,
                    confidence: Some(vec![Confidence::Authoritative]),
                    source: CODEX_SOURCE.to_string(),
                    details: Some(details),
                    connection: Some(codex_connection()),
                    capability: Some(MetricCapability::Supported),
                    // The statistics date and the day the response confirmed.
                    // Codex answers with a date bucket, so the requested local
                    // day is recorded here instead of being re-derived later.
                    scope: Some(StatisticScope {
                        local_day: local_day.to_string(),
                        timezone: timezone.to_string(),
                        range_start: None,
                        range_end: None,
                        range_confirmed: true,
                    }),
                    ..MetricInput::default()
                })
                .map_err(|error| {
                    incompatible(format!("Codex activity metric is invalid: {error}"))
                })?,
            );
            break;
        }
    }

    if let Some(lifetime) = summary
        .get("lifetimeTokens")
        .filter(|value| !value.is_null())
        .and_then(Value::as_f64)
        .filter(|tokens| tokens.is_finite() && *tokens >= 0.0)
    {
        metrics.push(
            UsageMetric::normalize(MetricInput {
                key: "activity.lifetime.tokens".to_string(),
                label: Some("Lifetime tokens".to_string()),
                value: Some(MetricValue::Number(lifetime)),
                unit: "tokens".to_string(),
                direction: MetricDirection::Activity,
                confidence: Some(vec![Confidence::Authoritative]),
                source: CODEX_SOURCE.to_string(),
                connection: Some(codex_connection()),
                capability: Some(MetricCapability::Supported),
                ..MetricInput::default()
            })
            .map_err(|error| incompatible(format!("Codex activity metric is invalid: {error}")))?,
        );
    }

    Ok(metrics)
}

/// Options a service uses to build a Codex collector.
#[derive(Debug, Clone)]
pub struct CodexCollectorOptions {
    pub client_info: ClientInfo,
    pub request_timeout: Option<Duration>,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for CodexCollectorOptions {
    fn default() -> Self {
        Self {
            client_info: ClientInfo::default(),
            request_timeout: Some(DEFAULT_REQUEST_TIMEOUT),
            base_backoff: DEFAULT_BASE_BACKOFF,
            max_backoff: DEFAULT_MAX_BACKOFF,
        }
    }
}

impl CodexCollectorOptions {
    /// Supervisor options with the same policy and no test seam.
    pub fn supervisor_options(&self) -> CodexSupervisorOptions {
        CodexSupervisorOptions {
            client_info: self.client_info.clone(),
            request_timeout: self.request_timeout,
            base_backoff: self.base_backoff,
            max_backoff: self.max_backoff,
            sleep: None,
        }
    }
}

/// What the service layer uses: a supervised app-server session plus the adapter
/// that normalizes it.
#[derive(Debug, Clone)]
pub struct CodexCollector {
    supervisor: Arc<CodexAppServerSupervisor>,
    adapter: Arc<CodexAdapter>,
}

impl CodexCollector {
    /// Collect from the Codex CLI at `program` (the absolute path from
    /// [`discover_codex_cli`] or from settings).
    pub fn new(program: impl Into<PathBuf>, options: CodexCollectorOptions) -> Self {
        let supervisor = CodexAppServerSupervisor::for_cli(program, options.supervisor_options());
        Self::from_supervisor(supervisor)
    }

    /// Collect from a supervisor the caller already owns (a shared session, or a
    /// test with an injected transport).
    pub fn from_supervisor(supervisor: Arc<CodexAppServerSupervisor>) -> Self {
        let adapter = CodexAdapter::new(Arc::clone(&supervisor) as Arc<dyn CodexRpc>);
        Self {
            supervisor,
            adapter,
        }
    }

    /// Refresh one snapshot.
    pub async fn refresh(
        &self,
        context: &CollectionContext,
    ) -> Result<ProviderSnapshot, CollectorError> {
        self.adapter.refresh(context).await
    }

    /// Register a callback invoked when Codex reports a quota change.
    pub fn on_rate_limits_updated(&self, handler: RateLimitUpdateHandler) {
        self.adapter.on_rate_limits_updated(handler);
    }

    /// Drop the session so no Codex child process is left behind.
    pub async fn shutdown(&self) {
        self.supervisor.shutdown().await;
    }

    pub fn supervisor(&self) -> &Arc<CodexAppServerSupervisor> {
        &self.supervisor
    }

    pub fn adapter(&self) -> &Arc<CodexAdapter> {
        &self.adapter
    }
}

/// Discover the CLI and build a collector in one step.
///
/// The two failure kinds stay distinct on purpose: `missing_config` means the
/// user has to install the CLI or set an absolute path, `process` means a binary
/// was found but could not answer. Both only affect Codex.
pub async fn codex_collector_from_discovery<R: CommandRunner>(
    runner: &R,
    options: &CodexCliDiscoveryOptions,
    collector_options: CodexCollectorOptions,
) -> Result<(CodexCli, CodexCollector), CollectorError> {
    let cli = discover_codex_cli(runner, options).await?;
    let collector = CodexCollector::new(cli.path.clone(), collector_options);
    Ok((cli, collector))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::contracts::ErrorKind;

    fn captured() -> IsoTimestamp {
        IsoTimestamp::parse("2026-09-10T08:00:00.000Z").expect("timestamp must parse")
    }

    #[test]
    fn the_codex_connection_is_stable() {
        assert_eq!(codex_connection().key(), "codex:account");
        assert_eq!(codex_connection().label.as_deref(), Some("Codex"));
    }

    #[test]
    fn a_response_without_buckets_is_incompatible_instead_of_empty() {
        let error =
            normalize_codex_rate_limits(&json!({}), &captured()).expect_err("no buckets must fail");
        assert_eq!(error.kind, ErrorKind::Compatibility);
        assert!(error.message.contains("no buckets"));
    }

    #[test]
    fn reset_times_missing_or_unusable_stay_absent() {
        assert_eq!(reset_at(&json!({})), None);
        assert_eq!(reset_at(&json!({ "resetsAt": null })), None);
        assert_eq!(reset_at(&json!({ "resetsAt": 0 })), None);
        assert_eq!(reset_at(&json!({ "resetsAt": -5 })), None);
        assert_eq!(
            reset_at(&json!({ "resetsAt": 1_789_000_000 })).map(|value| value.as_str().to_string()),
            Some("2026-09-10T00:26:40.000Z".to_string())
        );
    }

    #[test]
    fn window_lengths_without_a_usable_number_stay_absent() {
        assert_eq!(window_seconds(&json!({})), None);
        assert_eq!(window_seconds(&json!({ "windowDurationMins": null })), None);
        assert_eq!(window_seconds(&json!({ "windowDurationMins": 0 })), None);
        assert_eq!(window_seconds(&json!({ "windowDurationMins": -60 })), None);
        assert_eq!(
            window_seconds(&json!({ "windowDurationMins": "300" })),
            None
        );
        assert_eq!(
            window_seconds(&json!({ "windowDurationMins": 300 })),
            Some(18_000)
        );
        assert_eq!(
            window_seconds(&json!({ "windowDurationMins": 10_080 })),
            Some(604_800)
        );
    }

    #[test]
    fn an_absent_percentage_is_never_zero_filled() {
        let payload = json!({
            "rateLimitsByLimitId": {
                "codex": { "limitId": "codex", "primary": { "windowDurationMins": 300 } }
            }
        });
        let error = normalize_codex_rate_limits(&payload, &captured())
            .expect_err("a missing usedPercent must fail");
        assert_eq!(error.kind, ErrorKind::Compatibility);
        assert!(error.message.contains("usedPercent"));

        let out_of_range = json!({
            "rateLimitsByLimitId": {
                "codex": { "limitId": "codex", "primary": { "usedPercent": 140 } }
            }
        });
        let error =
            normalize_codex_rate_limits(&out_of_range, &captured()).expect_err("140% must fail");
        assert_eq!(error.kind, ErrorKind::Compatibility);
    }

    #[test]
    fn the_legacy_bucket_keeps_the_codex_id() {
        let payload = json!({
            "rateLimits": { "planType": "pro", "primary": { "usedPercent": 10, "windowDurationMins": 300 } }
        });
        let snapshot = normalize_codex_rate_limits(&payload, &captured())
            .expect("legacy payload must normalize");
        let keys: Vec<&str> = snapshot
            .metrics
            .iter()
            .map(|metric| metric.key.as_str())
            .collect();
        assert_eq!(keys, vec!["codex.primary.used", "codex.primary.remaining"]);
        assert_eq!(
            snapshot
                .diagnostic
                .as_ref()
                .and_then(|map| map.get("sharedBucket")),
            Some(&Value::String("codex".to_string()))
        );
    }

    #[test]
    fn an_unparsable_credit_balance_is_kept_as_text() {
        let payload = json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "credits": { "hasCredits": true, "unlimited": false, "balance": "unlimited" }
                }
            }
        });
        let snapshot =
            normalize_codex_rate_limits(&payload, &captured()).expect("payload must normalize");
        let credits = snapshot
            .metric("codex.credits.balance")
            .expect("credits metric");
        assert!(matches!(credits.value, MetricValue::Text(ref text) if text == "unlimited"));
        assert!(!credits.has_confidence(Confidence::Unavailable));
    }

    #[test]
    fn a_failure_snapshot_keeps_the_connection_and_no_metrics() {
        let at = captured();
        let error = CollectorError::authentication("Codex is not signed in");
        let snapshot = codex_unavailable_snapshot(&error, &at);
        assert_eq!(snapshot.status, ConnectionStatus::Disconnected);
        assert_eq!(
            snapshot.connection.as_ref().map(ConnectionId::key),
            Some("codex:account".to_string())
        );
        assert!(snapshot.metrics.is_empty());
        assert_eq!(
            snapshot.error.as_ref().map(|error| error.kind),
            Some(ErrorKind::Authentication)
        );
    }

    #[test]
    fn usage_ignores_other_days_and_keeps_a_reliable_zero() {
        let payload = json!({
            "summary": { "lifetimeTokens": 1_000_000 },
            "dailyUsageBuckets": [
                { "startDate": "2026-09-09", "tokens": 7 },
                { "startDate": "2026-09-10", "tokens": 0 }
            ]
        });
        let metrics = normalize_codex_usage(&payload, "2026-09-10", "Asia/Shanghai")
            .expect("usage must normalize");
        let daily = metrics
            .iter()
            .find(|metric| metric.key == "activity.daily.tokens")
            .expect("daily metric");
        assert_eq!(daily.value, MetricValue::Number(0.0));
        assert!(!daily.is_missing());
        let lifetime = metrics
            .iter()
            .find(|metric| metric.key == "activity.lifetime.tokens")
            .expect("lifetime metric");
        assert_eq!(lifetime.value, MetricValue::Number(1_000_000.0));
    }

    #[test]
    fn usage_for_another_day_produces_no_daily_metric() {
        let payload = json!({
            "summary": {},
            "dailyUsageBuckets": [{ "startDate": "2026-09-09", "tokens": 7 }]
        });
        let metrics =
            normalize_codex_usage(&payload, "2026-09-10", "UTC").expect("usage must normalize");
        assert!(metrics.is_empty());
    }

    #[test]
    fn a_malformed_usage_response_is_incompatible() {
        let error = normalize_codex_usage(
            &json!({ "dailyUsageBuckets": "not-an-array" }),
            "2026-09-10",
            "UTC",
        )
        .expect_err("a missing summary must fail");
        assert_eq!(error.kind, ErrorKind::Compatibility);

        let error = normalize_codex_usage(
            &json!({ "summary": {}, "dailyUsageBuckets": [{ "startDate": "2026-09-10" }] }),
            "2026-09-10",
            "UTC",
        )
        .expect_err("a bucket without tokens must fail");
        assert_eq!(error.kind, ErrorKind::Compatibility);
    }
}

//! GLM collectors: the Coding Plan quota connection, the separate experimental
//! wallet connection, and the composed view the panel renders.
//!
//! # Connections
//!
//! GLM has two independent connections. They are validated, cached and reported
//! separately (see `docs/desktop/semantic-map.md`, section 6):
//!
//! | connection | source | collector |
//! | --- | --- | --- |
//! | `quota` (`glm-quota` in the fixtures) | `glm-monitor` | [`GlmQuotaCollector`] |
//! | `wallet` (`glm-wallet` in the fixtures) | `glm-wallet-experimental` | [`GlmWalletCollector`] |
//!
//! [`GlmView`] keeps one [`ConnectionView`] per connection, so a failing or
//! unconfigured side never erases, stales or hides the other.
//!
//! # Statistics range (task 3.4)
//!
//! The legacy implementation queried GLM activity with a rolling ~24 hour window
//! (yesterday at the current hour → today at the current minute) and then
//! labelled the result "today". [`GlmRefreshContext::range`] replaces that with
//! the configured timezone's local midnight of the statistics date up to the
//! current instant, and every activity metric carries a [`StatisticScope`] whose
//! `rangeConfirmed` flag is only `true` when the response actually confirmed the
//! requested range — otherwise the panel must not call the data "today".
//!
//! # Spend estimation
//!
//! The GLM wallet does not invent its own estimator seam: it feeds the shared
//! balance-delta estimator through
//! [`GlmWalletCollector::with_estimator`](wallet::GlmWalletCollector::with_estimator)
//! and [`GlmWalletCollector::with_balance_store`](wallet::GlmWalletCollector::with_balance_store),
//! exactly like the DeepSeek wallet (`crate::estimate::DailySpendRecorder`). The
//! estimator isolates every sample by platform, connection, currency and local
//! day, so the composed view never mixes balances itself.
//!
//! # Secrets
//!
//! Credentials live in the macOS Keychain and reach a collector through a
//! closure, so nothing is cached here. Error messages, diagnostics and the
//! `Debug` output of both collectors are secret free by construction.

pub mod quota;
pub mod wallet;

pub use quota::{normalize_glm_payloads, GlmQuotaCollector};
pub use wallet::GlmWalletCollector;

use std::sync::Arc;

use chrono::{DateTime, LocalResult, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value};

use crate::contracts::{
    CollectorError, ConnectionId, ErrorKind, IsoTimestamp, ProviderId, ProviderSnapshot,
    StatisticScope, UsageMetric,
};
use crate::transport::{CollectorError as CollectorFailure, HttpGet, HttpResponse, SharedHttpTransport};
use crate::redaction::redact;

/// Machine identifier of the GLM Coding Plan quota connection.
pub const QUOTA_CONNECTION: &str = "quota";
/// Machine identifier of the experimental GLM wallet connection.
pub const WALLET_CONNECTION: &str = "wallet";
/// Source string of the Coding Plan monitor API.
pub const QUOTA_SOURCE: &str = "glm-monitor";
/// Source string of the experimental wallet API.
pub const WALLET_SOURCE: &str = "glm-wallet-experimental";

/// Human readable label for the quota connection.
pub const QUOTA_LABEL: &str = "Coding Plan";
/// Human readable label for the wallet connection.
pub const WALLET_LABEL: &str = "Wallet";

/// Connection identity of the GLM quota connection (`glm-quota` in the fixtures).
pub fn quota_connection() -> ConnectionId {
    ConnectionId::with_label(ProviderId::Glm, QUOTA_CONNECTION, QUOTA_LABEL)
}

/// Connection identity of the experimental GLM wallet (`glm-wallet` in the fixtures).
pub fn wallet_connection() -> ConnectionId {
    ConnectionId::with_label(ProviderId::Glm, WALLET_CONNECTION, WALLET_LABEL)
}

/// Provider-owned hosts a GLM wallet endpoint may live on.
///
/// A caller must still pass its own allow-list into [`GlmWalletCollector`]; this
/// helper only names the two domains that belong to the GLM regions.
pub fn glm_wallet_allowed_hosts() -> Vec<String> {
    ["open.bigmodel.cn", "api.z.ai"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// Everything a GLM refresh needs from the caller's settings.
///
/// The collector never reads a clock or a settings store itself: the service
/// passes one context per refresh cycle, which keeps region and timezone
/// resolution at refresh time and makes the range reproducible in tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlmRefreshContext {
    /// IANA timezone from the non-sensitive settings, e.g. `Asia/Shanghai`.
    pub timezone: String,
    /// The instant of this refresh cycle.
    pub now: DateTime<Utc>,
    /// Statistics date to query. Defaults to the local day of [`Self::now`].
    pub statistics_date: Option<NaiveDate>,
}

impl GlmRefreshContext {
    /// Build a context for the local day that contains `now`.
    pub fn new(timezone: impl Into<String>, now: DateTime<Utc>) -> Self {
        Self {
            timezone: timezone.into(),
            now,
            statistics_date: None,
        }
    }

    /// Query a specific statistics date instead of the local day of `now`.
    pub fn with_statistics_date(mut self, statistics_date: NaiveDate) -> Self {
        self.statistics_date = Some(statistics_date);
        self
    }

    /// Resolve the configured timezone name.
    ///
    /// An unknown name is a configuration problem, not a platform failure, so it
    /// reports [`ErrorKind::MissingConfig`] instead of silently guessing UTC.
    pub fn resolved_timezone(&self) -> Result<Tz, CollectorFailure> {
        let name = self.timezone.trim();
        if name.is_empty() {
            return Err(CollectorFailure::missing_config(
                "the configured timezone is empty",
            ));
        }
        name.parse::<Tz>().map_err(|_| {
            CollectorFailure::missing_config(format!(
                "the configured timezone `{name}` is not a known IANA timezone"
            ))
        })
    }

    /// The statistics date: the configured one, else the local day of `now`.
    pub fn local_day(&self) -> Result<NaiveDate, CollectorFailure> {
        match self.statistics_date {
            Some(date) => Ok(date),
            None => Ok(self
                .now
                .with_timezone(&self.resolved_timezone()?)
                .date_naive()),
        }
    }

    /// The GLM activity query range for this cycle.
    pub fn range(&self) -> Result<StatisticsRange, CollectorFailure> {
        let timezone = self.resolved_timezone()?;
        let local_day = self.local_day()?;
        let start = local_instant(timezone, local_day.and_time(NaiveTime::MIN));
        let local_now = self.now.with_timezone(&timezone);
        let end = local_now.with_nanosecond(0).unwrap_or(local_now);

        Ok(StatisticsRange {
            local_day,
            timezone: self.timezone.trim().to_string(),
            start_local: format_local(start),
            end_local: format_local(end),
            start: IsoTimestamp::from_datetime(start.with_timezone(&Utc)),
            end: IsoTimestamp::from_datetime(end.with_timezone(&Utc)),
        })
    }
}

/// The GLM activity query range, in the format the provider expects.
///
/// `start_local`/`end_local` are `YYYY-MM-DD HH:mm:ss` in the configured
/// timezone; `start`/`end` are the same instants as contract timestamps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatisticsRange {
    /// Local statistics date the range belongs to.
    pub local_day: NaiveDate,
    /// IANA timezone the range was computed in.
    pub timezone: String,
    /// Local midnight of the statistics date, `YYYY-MM-DD HH:mm:ss`.
    pub start_local: String,
    /// Current instant in the same local format.
    pub end_local: String,
    /// Inclusive start of the range as a contract timestamp.
    pub start: IsoTimestamp,
    /// End of the range as a contract timestamp.
    pub end: IsoTimestamp,
}

impl StatisticsRange {
    /// `startTime=…&endTime=…`, encoded exactly like the legacy
    /// `URLSearchParams` implementation so the provider sees the same query.
    pub fn query_string(&self) -> String {
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("startTime", &self.start_local)
            .append_pair("endTime", &self.end_local)
            .finish()
    }

    /// The [`StatisticScope`] to attach to a metric sourced from this range.
    ///
    /// `confirmed` must only be `true` when the response confirmed that its data
    /// covers this exact range; see [`range_confirmed_from_envelope`].
    pub fn scope(&self, confirmed: bool) -> StatisticScope {
        StatisticScope {
            local_day: self.local_day.to_string(),
            timezone: self.timezone.clone(),
            range_start: Some(self.start.clone()),
            range_end: Some(self.end.clone()),
            range_confirmed: confirmed,
        }
    }
}

/// Longest DST gap a local midnight can fall into; the probe is bounded so a
/// pathological timezone can never spin.
const MAX_DST_GAP_MINUTES: i64 = 180;

/// Milliseconds beyond which a reset time is not believable (2100-01-01).
const MAX_RESET_MILLIS: f64 = 4_102_444_800_000.0;

/// Resolve a local wall-clock time to an instant without panicking.
///
/// Ambiguous times (a DST fall-back) resolve to the earliest instant; times that
/// do not exist (a DST spring-forward gap that swallowed midnight) resolve to the
/// first minute after the gap, which is the start of that local day. Shared with
/// the DeepSeek web collector, whose query windows are also local-day based.
pub(crate) fn local_instant(timezone: Tz, local: chrono::NaiveDateTime) -> DateTime<Tz> {
    match timezone.from_local_datetime(&local) {
        LocalResult::Single(instant) => instant,
        LocalResult::Ambiguous(earliest, _) => earliest,
        LocalResult::None => {
            let mut probe = local;
            for _ in 0..MAX_DST_GAP_MINUTES {
                probe += chrono::Duration::minutes(1);
                if let LocalResult::Single(instant) | LocalResult::Ambiguous(instant, _) =
                    timezone.from_local_datetime(&probe)
                {
                    return instant;
                }
            }
            Utc.from_utc_datetime(&local).with_timezone(&timezone)
        }
    }
}

/// `YYYY-MM-DD HH:mm:ss` in the instant's own offset.
fn format_local(instant: DateTime<Tz>) -> String {
    instant.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// A read-only GET with the headers the legacy GLM monitor requests sent.
pub(crate) fn quota_get(url: impl Into<String>, credential: &str) -> HttpGet {
    HttpGet::new(url)
        .with_header("Authorization", credential)
        .with_header("Accept-Language", "en-US,en")
        .with_header("Content-Type", "application/json")
}

/// A read-only GET carrying a single `Authorization` header.
pub(crate) fn authorized_get(url: impl Into<String>, credential: &str) -> HttpGet {
    HttpGet::new(url).with_header("Authorization", credential)
}

/// Unwrap the `{success, data}` envelope the monitor API uses.
pub(crate) fn unwrap_data(value: &Value) -> &Value {
    value.get("data").unwrap_or(value)
}

/// Read one GLM response body, mirroring the legacy error classification.
///
/// 401/403 are authentication, 429 is a rate limit, any other non-2xx is a
/// network failure (this is what refuses a redirect: a 3xx is never success), and
/// a body that is not JSON is a compatibility failure. An HTTP 200 body carrying
/// `success: false` is a *business* rejection: a missing Coding Plan subscription
/// reports missing configuration, everything else authentication.
pub(crate) fn read_json(response: HttpResponse, label: &str) -> Result<Value, CollectorFailure> {
    if response.status == 401 || response.status == 403 {
        return Err(CollectorFailure::authentication(format!(
            "{label} rejected the credential (HTTP {})",
            response.status
        )));
    }
    if response.status == 429 {
        return Err(CollectorFailure::rate_limit(
            "GLM usage endpoint is rate limited",
        ));
    }
    if !response.is_success() {
        return Err(CollectorFailure::network(format!(
            "{label} failed with HTTP {}",
            response.status
        )));
    }

    let value: Value = serde_json::from_str(&response.body)
        .map_err(|_| CollectorFailure::compatibility(format!("{label} returned invalid JSON")))?;

    if value.get("success").and_then(Value::as_bool) == Some(false) {
        let raw = value
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let message = if raw.is_empty() {
            "request rejected".to_string()
        } else {
            short(raw, 300)
        };
        let kind = if rejection_means_missing_config(&message) {
            ErrorKind::MissingConfig
        } else {
            ErrorKind::Authentication
        };
        let mut error = CollectorFailure::new(kind, format!("GLM: {message}"));
        if let Some(code) = value.get("code").filter(|code| !code.is_null()) {
            error = error.with_diagnostic("code", code.to_string());
        }
        return Err(error);
    }

    Ok(value)
}

/// The legacy regex `/coding\s*plan|套餐|未开通|不存在/i`: a business rejection
/// that means "this account has no Coding Plan", not "the key is wrong".
fn rejection_means_missing_config(message: &str) -> bool {
    let lowered = message.to_lowercase();
    let compact: String = lowered
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    compact.contains("codingplan")
        || lowered.contains("套餐")
        || lowered.contains("未开通")
        || lowered.contains("不存在")
}

/// Refuse a response that came back from another origin.
///
/// The shared transport already refuses cross-origin redirects; this is the
/// collector-side check that a credential was never carried to a host other than
/// the one it was addressed to.
pub(crate) fn ensure_same_origin(
    response: &HttpResponse,
    expected: &url::Url,
) -> Result<(), CollectorFailure> {
    let Some(final_url) = response.final_url.as_deref() else {
        return Ok(());
    };
    let actual = url::Url::parse(final_url)
        .map_err(|_| CollectorFailure::network("the response reported an unusable final URL"))?;
    if actual.scheme() != expected.scheme() || actual.host_str() != expected.host_str() {
        return Err(CollectorFailure::network(
            "the request left the configured provider origin and was refused",
        ));
    }
    Ok(())
}

/// Parse `5h` / `7d` / `168h` style window durations into seconds.
///
/// Returns `None` for anything else, exactly like the legacy
/// `/^(\d+)\s*([hd])$/i` matcher, so the 5h/weekly fallbacks stay scoped.
pub(crate) fn duration_seconds(window: &str) -> Option<u64> {
    let trimmed = window.trim();
    let mut digits_end = 0usize;
    for (index, character) in trimmed.char_indices() {
        if character.is_ascii_digit() {
            digits_end = index + character.len_utf8();
        } else {
            break;
        }
    }
    if digits_end == 0 {
        return None;
    }
    let value: u64 = trimmed[..digits_end].parse().ok()?;
    let multiplier = match trimmed[digits_end..].trim() {
        "h" | "H" => 3_600u64,
        "d" | "D" => 86_400u64,
        _ => return None,
    };
    value.checked_mul(multiplier)
}

/// Convert provider milliseconds into a contract timestamp.
///
/// Absent, non-numeric, zero, negative or absurd values stay absent: a missing
/// reset time is missing, never "now" and never zero.
pub(crate) fn reset_at_from_millis(raw: Option<&Value>) -> Option<IsoTimestamp> {
    let millis = raw.and_then(Value::as_f64)?;
    if !millis.is_finite() || millis < 1.0 || millis > MAX_RESET_MILLIS {
        return None;
    }
    Some(IsoTimestamp::from_unix_millis(millis as i64))
}

/// Truncate free-form platform text so a diagnostic cannot grow without bound.
pub(crate) fn short(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Does the response envelope confirm the range that was requested?
///
/// The activity endpoints are not documented to echo the query, so a plain
/// `{data: […]}` response confirms nothing and its metrics keep
/// `rangeConfirmed: false` — the panel then refuses to label them "today". When
/// the envelope does echo `startTime`/`endTime` (at the top level or inside a
/// `range` object) and both equal the requested strings, the range is confirmed.
pub(crate) fn range_confirmed_from_envelope(envelope: &Value, range: &StatisticsRange) -> bool {
    let echoed = |key: &str| {
        envelope.get(key).and_then(Value::as_str).or_else(|| {
            envelope
                .get("range")
                .and_then(|range| range.get(key))
                .and_then(Value::as_str)
        })
    };
    match (echoed("startTime"), echoed("endTime")) {
        (Some(start), Some(end)) => {
            start.trim() == range.start_local && end.trim() == range.end_local
        }
        _ => false,
    }
}

/// Redact a platform payload before it is stored anywhere.
pub(crate) fn redacted_entry(entry: &Value) -> Value {
    redact(entry)
}

/// Diagnostic map holding the quota entries the collector did not recognize.
pub(crate) fn unknown_limits_diagnostic(unknown_limits: Vec<Value>) -> Map<String, Value> {
    let mut diagnostic = Map::new();
    diagnostic.insert("unknownLimits".to_string(), Value::Array(unknown_limits));
    diagnostic
}

/// The independent state of one GLM connection.
///
/// `snapshot` is the last *successful* snapshot and is never replaced by a
/// failure, `error` is the most recent failure of this connection only, and
/// `last_success_at` is when the cached snapshot was captured.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionView {
    /// Connection identity, also present on the cached snapshot.
    pub connection: ConnectionId,
    /// Source string this connection reports.
    pub source: String,
    /// Last successful snapshot, kept across failures.
    pub snapshot: Option<ProviderSnapshot>,
    /// Most recent failure of this connection, cleared by the next success.
    pub error: Option<CollectorError>,
    /// Capture time of the cached snapshot; unchanged by a failure.
    pub last_success_at: Option<IsoTimestamp>,
}

impl ConnectionView {
    pub fn new(connection: ConnectionId, source: impl Into<String>) -> Self {
        Self {
            connection,
            source: source.into(),
            snapshot: None,
            error: None,
            last_success_at: None,
        }
    }

    /// Record the outcome of one refresh attempt for this connection.
    pub fn record(&mut self, result: Result<ProviderSnapshot, CollectorFailure>, at: IsoTimestamp) {
        match result {
            Ok(snapshot) => self.record_success(snapshot),
            Err(failure) => self.record_failure(&failure, at),
        }
    }

    /// Store a successful snapshot.
    pub fn record_success(&mut self, mut snapshot: ProviderSnapshot) {
        if snapshot.connection.is_none() {
            snapshot.connection = Some(self.connection.clone());
        }
        let captured = snapshot.captured_at.clone();
        self.last_success_at = snapshot.last_success_at.clone().or(Some(captured));
        self.snapshot = Some(snapshot);
        self.error = None;
    }

    /// Store a failure without touching the cached snapshot.
    pub fn record_failure(&mut self, failure: &CollectorFailure, at: IsoTimestamp) {
        self.error = Some(failure.to_contract(at));
    }

    /// True when this connection has a successful snapshot.
    pub fn has_data(&self) -> bool {
        self.snapshot.is_some()
    }

    /// Metrics of the cached snapshot; empty when nothing succeeded yet.
    pub fn metrics(&self) -> &[UsageMetric] {
        self.snapshot
            .as_ref()
            .map_or(&[], |snapshot| snapshot.metrics.as_slice())
    }

    /// What the panel should render for this connection.
    ///
    /// A connection with a cached snapshot and a newer failure renders that
    /// snapshot marked `degraded` with the `stale` confidence; a connection that
    /// has never succeeded renders an unavailable snapshot carrying its error;
    /// a connection that has not been attempted yet renders nothing.
    pub fn display_snapshot(&self) -> Option<ProviderSnapshot> {
        match (&self.snapshot, &self.error) {
            (Some(snapshot), Some(error)) => Some(snapshot.mark_stale(error.clone())),
            (Some(snapshot), None) => Some(snapshot.clone()),
            (None, Some(error)) => {
                let mut unavailable = ProviderSnapshot::unavailable(
                    self.connection.provider,
                    self.source.clone(),
                    error.clone(),
                );
                unavailable.connection = Some(self.connection.clone());
                Some(unavailable)
            }
            (None, None) => None,
        }
    }
}

/// Outcome of one composed GLM refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GlmRefreshReport {
    /// The quota connection produced a snapshot in this cycle.
    pub quota_ok: bool,
    /// The wallet connection produced a snapshot in this cycle.
    pub wallet_ok: bool,
}

/// The composed GLM card: both connections, each with its own health.
#[derive(Debug, Clone, PartialEq)]
pub struct GlmView {
    pub quota: ConnectionView,
    pub wallet: ConnectionView,
}

impl GlmView {
    pub fn new() -> Self {
        Self {
            quota: ConnectionView::new(quota_connection(), QUOTA_SOURCE),
            wallet: ConnectionView::new(wallet_connection(), WALLET_SOURCE),
        }
    }

    /// Refresh both connections for one cycle.
    ///
    /// The two collectors run concurrently but their results are recorded
    /// independently: a quota failure leaves the wallet view untouched, a wallet
    /// failure (or a disabled wallet) leaves the quota view untouched, and each
    /// connection's own estimator input is forwarded by that connection's
    /// collector.
    pub async fn refresh(
        &mut self,
        quota_collector: &GlmQuotaCollector,
        wallet_collector: &GlmWalletCollector,
        context: &GlmRefreshContext,
    ) -> GlmRefreshReport {
        let at = IsoTimestamp::from_datetime(context.now);
        let (quota_result, wallet_result) = tokio::join!(
            quota_collector.refresh(context),
            wallet_collector.refresh(context.now)
        );

        self.quota.record(quota_result, at.clone());
        self.wallet.record(wallet_result, at);

        GlmRefreshReport {
            quota_ok: self.quota.error.is_none(),
            wallet_ok: self.wallet.error.is_none(),
        }
    }

    /// Record a quota result that was produced elsewhere (e.g. a cached refresh).
    pub fn record_quota(
        &mut self,
        result: Result<ProviderSnapshot, CollectorFailure>,
        at: IsoTimestamp,
    ) {
        self.quota.record(result, at);
    }

    /// Record a wallet result that was produced elsewhere.
    pub fn record_wallet(
        &mut self,
        result: Result<ProviderSnapshot, CollectorFailure>,
        at: IsoTimestamp,
    ) {
        self.wallet.record(result, at);
    }

    /// Both connection identities, in panel order.
    pub fn connections(&self) -> Vec<ConnectionId> {
        vec![
            self.quota.connection.clone(),
            self.wallet.connection.clone(),
        ]
    }

    /// True when at least one connection has usable data.
    pub fn has_data(&self) -> bool {
        self.quota.has_data() || self.wallet.has_data()
    }

    /// Snapshots the panel should render, skipping connections without data.
    pub fn display_snapshots(&self) -> Vec<ProviderSnapshot> {
        [
            self.quota.display_snapshot(),
            self.wallet.display_snapshot(),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}

impl Default for GlmView {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared handle to a settings-backed region resolver.
///
/// The region is asked for at refresh time, so a settings change applies to the
/// next refresh instead of being captured when the collector is built.
pub type RegionResolver = Arc<dyn Fn() -> crate::contracts::GlmRegion + Send + Sync>;

/// Shared handle to a credential lookup (macOS Keychain in production).
/// Returning `Ok(None)` means "not configured"; the collector must never cache
/// the value.
pub type CredentialResolver = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// Shared handle to the HTTP transport every GLM collector uses.
pub type Transport = SharedHttpTransport;

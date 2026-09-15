//! DeepSeek wallet balance collector and its daily spend estimate.
//!
//! The rules are the ones this project has always used, carried over from its
//! earlier TypeScript collector. The collector issues exactly one
//! read-only `GET` per refresh — `https://api.deepseek.com/user/balance` with a
//! bearer credential — and turns the documented body
//!
//! ```json
//! {
//!   "is_available": true,
//!   "balance_infos": [
//!     { "currency": "CNY", "total_balance": "86.42",
//!       "granted_balance": "0.00", "topped_up_balance": "86.42" }
//!   ]
//! }
//! ```
//!
//! into three balance metrics per currency (`wallet.<CUR>.total`,
//! `wallet.<CUR>.granted`, `wallet.<CUR>.topped-up`), plus one estimated daily
//! spend metric per currency when a [`DailySpendRecorder`] is attached.
//!
//! Two rules are load bearing:
//!
//! * **A missing value stays missing.** An absent (or `null`) balance component
//!   becomes a `null` metric with the `unavailable` confidence, never `0`; only a
//!   balance the provider actually reported as zero is a reliable zero.
//! * **Nothing unverified is invented.** DeepSeek has no verified plan quota and
//!   no verified daily-token source, so this module produces no `quota.*`,
//!   `plan.*` or `tokens.*` metric — only the balance the endpoint really
//!   returns, and a spend estimate derived from its own samples.

use std::fmt;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::contracts::{
    Confidence, ConnectionId, ConnectionStatus, ErrorKind, IsoTimestamp, MetricCapability,
    MetricDirection, MetricInput, MetricValue, ProviderId, ProviderSnapshot, StatisticScope,
    UsageMetric,
};
use crate::estimate::{
    BalanceStore, DailySpendEstimator, DailySpendRecorder, DailySummary, EstimateError, Money,
    Timezone, WALLET_CONNECTION,
};
use crate::http::{CollectorError, HttpGet, SharedHttpTransport};
use crate::redaction::redact_str;

/// The documented, read-only balance endpoint.
pub const BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
/// Source string for the balance metrics (`docs/desktop/semantic-map.md` §3).
pub const BALANCE_SOURCE: &str = "deepseek-balance";
/// Source string for the derived daily spend metric.
pub const ESTIMATOR_SOURCE: &str = "balance-delta-estimator";

const TOTAL_COMPONENT: &str = "total";
const GRANTED_COMPONENT: &str = "granted";
const TOPPED_UP_COMPONENT: &str = "topped-up";
const TOTAL_LABEL: &str = "Total balance";
const GRANTED_LABEL: &str = "Granted balance";
const TOPPED_UP_LABEL: &str = "Topped-up balance";
const SPEND_LABEL: &str = "Today spend";
/// Longest currency code accepted, matching the TypeScript schema (`max(12)`).
const MAX_CURRENCY_LENGTH: usize = 12;
/// Connection that owns the balance samples.
const BALANCE_CONNECTION: &str = WALLET_CONNECTION;

// ---------------------------------------------------------------------------
// Credential and clock seams
// ---------------------------------------------------------------------------

/// Supplies the DeepSeek API key.
///
/// The service owns Keychain access; this module only needs the key for one
/// request. Implemented by any closure returning
/// `Result<Option<String>, CollectorError>` — so a fallible Keychain lookup plugs
/// in directly — and for `Option<String>` / `String`.
pub trait ApiKeySource: Send + Sync {
    /// `Ok(None)` means nothing is configured. `Err` reports a credential-store
    /// failure, which must not be reported as "not configured".
    fn api_key(&self) -> Result<Option<String>, CollectorError>;
}

impl<F> ApiKeySource for F
where
    F: Fn() -> Result<Option<String>, CollectorError> + Send + Sync,
{
    fn api_key(&self) -> Result<Option<String>, CollectorError> {
        self()
    }
}

impl ApiKeySource for Option<String> {
    fn api_key(&self) -> Result<Option<String>, CollectorError> {
        Ok(self.clone())
    }
}

impl ApiKeySource for String {
    fn api_key(&self) -> Result<Option<String>, CollectorError> {
        Ok(Some(self.clone()))
    }
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/// The DeepSeek wallet collector.
///
/// `refresh` takes `&self` so the collector can live in an `Arc` behind the
/// service's connection registry; the attached estimator is internally
/// synchronised for that reason.
pub struct DeepSeekCollector {
    transport: SharedHttpTransport,
    api_key: Box<dyn ApiKeySource>,
    estimator: Option<Mutex<Box<dyn DailySpendRecorder>>>,
    now: Box<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

impl fmt::Debug for DeepSeekCollector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeepSeekCollector")
            .field("source", &BALANCE_SOURCE)
            .field("connection", &BALANCE_CONNECTION)
            .field("estimator", &self.estimator.is_some())
            .finish_non_exhaustive()
    }
}

impl DeepSeekCollector {
    /// Build a collector for the DeepSeek wallet connection.
    pub fn new(transport: SharedHttpTransport, api_key: impl ApiKeySource + 'static) -> Self {
        Self {
            transport,
            api_key: Box::new(api_key),
            estimator: None,
            now: Box::new(Utc::now),
        }
    }

    /// Attach the daily spend estimator used for `spend.<CUR>.daily`.
    ///
    /// Without an estimator the collector still reports every balance; the spend
    /// metric stays absent instead of being invented. Use
    /// [`DeepSeekCollector::with_balance_store`] to attach the persistence layer
    /// directly.
    pub fn with_estimator<R: DailySpendRecorder + 'static>(mut self, recorder: R) -> Self {
        self.estimator = Some(Mutex::new(Box::new(recorder)));
        self
    }

    /// Attach a [`BalanceStore`] through a DeepSeek wallet estimator.
    ///
    /// This is the wiring the desktop service uses: the SQLite store implements
    /// [`BalanceStore`] and the collector owns the estimator that writes to it.
    pub fn with_balance_store<S: BalanceStore + Send + 'static>(
        self,
        store: S,
        timezone: Timezone,
    ) -> Self {
        self.with_estimator(DailySpendEstimator::deepseek_wallet(store, timezone))
    }

    /// Override the clock, used by tests and fixture replay.
    pub fn with_now(mut self, now: impl Fn() -> DateTime<Utc> + Send + Sync + 'static) -> Self {
        self.now = Box::new(now);
        self
    }

    /// The wallet connection identity of this collector.
    ///
    /// Also what the service needs for an unavailable snapshot, which
    /// `ProviderSnapshot::unavailable` cannot fill in by itself.
    pub fn wallet_connection() -> ConnectionId {
        ConnectionId::new(ProviderId::Deepseek, BALANCE_CONNECTION)
    }

    /// The connection identity of this collector instance.
    pub fn connection(&self) -> ConnectionId {
        Self::wallet_connection()
    }

    /// Read the balance once and normalize it.
    ///
    /// A missing key, a rejected key, a rate limit, a transport failure and an
    /// incompatible body are reported with the shared error vocabulary; the
    /// transport's own classification is passed through unchanged, so a rate
    /// limit keeps its retry-after diagnostic.
    pub async fn refresh(&self) -> Result<ProviderSnapshot, CollectorError> {
        let api_key = self.resolve_api_key()?;
        let request = HttpGet::new(BALANCE_URL)
            .with_header("Authorization", format!("Bearer {api_key}"))
            .with_header("Accept", "application/json");
        let response = self.transport.get(request).await?;
        if !response.is_success() {
            // The shared transport normally fails before this point; classifying
            // here too keeps the error kind identical for a transport that hands
            // the response back verbatim, and never parses an error page as data.
            return Err(classify_status(
                response.status,
                response.retry_after_seconds,
            ));
        }
        let payload = response.json()?;
        let parsed = parse_balance(&payload).map_err(incompatible_response)?;
        let captured_at = IsoTimestamp::from_datetime((self.now)());
        self.build_snapshot(&parsed, captured_at)
    }

    /// The stored estimate of the most recent local day, without a new request.
    ///
    /// The panel's cached-read path uses it so reading state never triggers
    /// collection. `None` means no sample is stored (or no estimator is
    /// attached), which stays missing instead of becoming a zero.
    pub fn current_estimate(&self, currency: &str) -> Result<Option<DailySummary>, CollectorError> {
        let Some(estimator) = &self.estimator else {
            return Ok(None);
        };
        let recorder = estimator.lock().map_err(|_| {
            CollectorError::new(
                ErrorKind::Storage,
                "the DeepSeek balance estimator lock was poisoned by an earlier panic",
            )
        })?;
        recorder.current(currency).map_err(estimate_failure_error)
    }

    fn resolve_api_key(&self) -> Result<String, CollectorError> {
        match self.api_key.api_key()? {
            Some(key) if !key.trim().is_empty() => Ok(key),
            _ => Err(CollectorError::missing_config(
                "DeepSeek API key is not configured",
            )),
        }
    }

    fn build_snapshot(
        &self,
        parsed: &ParsedBalance,
        captured_at: IsoTimestamp,
    ) -> Result<ProviderSnapshot, CollectorError> {
        let connection = self.connection();
        let mut metrics = balance_metrics(parsed, &connection)?;
        let mut diagnostic = base_diagnostic(parsed);

        if self.estimator.is_some() {
            let estimates = self.estimate(parsed, &captured_at, &connection)?;
            metrics.extend(estimates.metrics);
            if !estimates.failures.is_empty() {
                diagnostic.insert(
                    "estimateFailures".to_string(),
                    Value::Array(estimates.failures),
                );
            }
        }

        Ok(ProviderSnapshot {
            provider: ProviderId::Deepseek,
            connection: Some(connection),
            status: ConnectionStatus::Connected,
            captured_at: captured_at.clone(),
            last_success_at: Some(captured_at),
            source: BALANCE_SOURCE.to_string(),
            metrics,
            error: None,
            diagnostic: Some(diagnostic),
            extra: Map::new(),
        })
    }

    /// Record every reported balance total and build the daily spend metrics.
    ///
    /// A storage failure is *not* fatal for the balance: the reported balances
    /// are real, so they are still returned and the failure is reported in
    /// `diagnostic.estimateFailures` while the spend metric stays absent.
    fn estimate(
        &self,
        parsed: &ParsedBalance,
        captured_at: &IsoTimestamp,
        connection: &ConnectionId,
    ) -> Result<EstimateOutcome, CollectorError> {
        let Some(estimator) = &self.estimator else {
            return Ok(EstimateOutcome::default());
        };
        let mut recorder = match estimator.lock() {
            Ok(recorder) => recorder,
            Err(_) => {
                return Ok(EstimateOutcome {
                    metrics: Vec::new(),
                    failures: vec![failure_value(
                        "",
                        ErrorKind::Storage,
                        "the DeepSeek balance estimator lock was poisoned by an earlier panic",
                    )],
                })
            }
        };

        let timezone = recorder.timezone_name().to_string();
        let mut outcome = EstimateOutcome::default();
        for entry in &parsed.entries {
            // An absent total is not an observation: it is not recorded, and no
            // spend is estimated from a value the provider never reported.
            let Some(total) = entry.total else {
                continue;
            };
            match recorder.record(&entry.currency, total, captured_at) {
                Ok(summary) => outcome
                    .metrics
                    .push(spend_metric(connection, &summary, &timezone)?),
                Err(error) => outcome.failures.push(failure_value(
                    &entry.currency,
                    error.kind(),
                    &error.to_string(),
                )),
            }
        }
        Ok(outcome)
    }
}

/// Metrics and diagnostics produced by one estimation pass.
#[derive(Debug, Default)]
struct EstimateOutcome {
    metrics: Vec<UsageMetric>,
    failures: Vec<Value>,
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/// Normalize a documented balance body without a transport.
///
/// Mirrors the TypeScript `normalizeDeepSeekBalance`; used by
/// [`DeepSeekCollector::refresh`] and by fixture-driven tests, so the shared
/// `fixtures/contracts/deepseek-currencies.json` expectations can be checked
/// without a network.
pub fn normalize_balance(
    value: &Value,
    captured_at: IsoTimestamp,
) -> Result<ProviderSnapshot, CollectorError> {
    let parsed = parse_balance(value).map_err(incompatible_response)?;
    let connection = DeepSeekCollector::wallet_connection();
    Ok(ProviderSnapshot {
        provider: ProviderId::Deepseek,
        connection: Some(connection.clone()),
        status: ConnectionStatus::Connected,
        captured_at: captured_at.clone(),
        last_success_at: Some(captured_at),
        source: BALANCE_SOURCE.to_string(),
        metrics: balance_metrics(&parsed, &connection)?,
        error: None,
        diagnostic: Some(base_diagnostic(&parsed)),
        extra: Map::new(),
    })
}

/// One currency entry of `balance_infos`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BalanceEntry {
    currency: String,
    total: Option<Money>,
    granted: Option<Money>,
    topped_up: Option<Money>,
}

/// A parsed balance body: the availability flag plus one entry per currency.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedBalance {
    is_available: bool,
    entries: Vec<BalanceEntry>,
}

/// Why a balance body does not match the documented schema.
///
/// The reason names a field path and the expectation; it never echoes provider
/// values or the response body.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{reason}")]
pub struct BalancePayloadError {
    reason: String,
}

impl BalancePayloadError {
    pub fn new(reason: impl AsRef<str>) -> Self {
        Self {
            reason: redact_str(reason.as_ref()),
        }
    }

    /// Short, redacted explanation suitable for an error message or diagnostic.
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

fn parse_balance(value: &Value) -> Result<ParsedBalance, BalancePayloadError> {
    let object = value
        .as_object()
        .ok_or_else(|| BalancePayloadError::new("the response body is not a JSON object"))?;
    let is_available = object
        .get("is_available")
        .and_then(Value::as_bool)
        .ok_or_else(|| BalancePayloadError::new("is_available is missing or is not a boolean"))?;
    let infos = object
        .get("balance_infos")
        .and_then(Value::as_array)
        .ok_or_else(|| BalancePayloadError::new("balance_infos is missing or is not an array"))?;

    let mut entries = Vec::with_capacity(infos.len());
    for (index, info) in infos.iter().enumerate() {
        let entry = info.as_object().ok_or_else(|| {
            BalancePayloadError::new(format!("balance_infos[{index}] is not an object"))
        })?;
        let currency = entry
            .get("currency")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|currency| !currency.is_empty() && currency.len() <= MAX_CURRENCY_LENGTH)
            .ok_or_else(|| {
                BalancePayloadError::new(format!(
                    "balance_infos[{index}].currency is missing or is not a currency code"
                ))
            })?;
        entries.push(BalanceEntry {
            currency: currency.to_string(),
            total: optional_money(entry, "total_balance", index)?,
            granted: optional_money(entry, "granted_balance", index)?,
            topped_up: optional_money(entry, "topped_up_balance", index)?,
        });
    }
    Ok(ParsedBalance {
        is_available,
        entries,
    })
}

/// Read one money field.
///
/// Absent and `null` both mean "the provider did not report this component", so
/// the metric stays absent. A value that is present must be an exact decimal
/// string: a number, an object or a malformed amount makes the response
/// incompatible rather than becoming `0`.
fn optional_money(
    entry: &Map<String, Value>,
    field: &str,
    index: usize,
) -> Result<Option<Money>, BalancePayloadError> {
    match entry.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => Money::parse(raw).map(Some).map_err(|error| {
            BalancePayloadError::new(format!(
                "balance_infos[{index}].{field} is not an exact decimal amount: {error}"
            ))
        }),
        Some(_) => Err(BalancePayloadError::new(format!(
            "balance_infos[{index}].{field} must be a decimal string"
        ))),
    }
}

fn incompatible_response(error: BalancePayloadError) -> CollectorError {
    CollectorError::compatibility(format!(
        "DeepSeek balance response is incompatible: {}",
        error.reason()
    ))
    .with_diagnostic("endpoint", BALANCE_URL)
}

fn balance_metrics(
    parsed: &ParsedBalance,
    connection: &ConnectionId,
) -> Result<Vec<UsageMetric>, CollectorError> {
    let mut metrics = Vec::with_capacity(parsed.entries.len() * 3);
    for entry in &parsed.entries {
        metrics.push(balance_metric(
            connection,
            &entry.currency,
            TOTAL_COMPONENT,
            TOTAL_LABEL,
            entry.total,
            Some(parsed.is_available),
        )?);
        metrics.push(balance_metric(
            connection,
            &entry.currency,
            GRANTED_COMPONENT,
            GRANTED_LABEL,
            entry.granted,
            None,
        )?);
        metrics.push(balance_metric(
            connection,
            &entry.currency,
            TOPPED_UP_COMPONENT,
            TOPPED_UP_LABEL,
            entry.topped_up,
            None,
        )?);
    }
    Ok(metrics)
}

fn balance_metric(
    connection: &ConnectionId,
    currency: &str,
    component: &str,
    label: &str,
    value: Option<Money>,
    available: Option<bool>,
) -> Result<UsageMetric, CollectorError> {
    let mut details = Map::new();
    if let Some(available) = available {
        details.insert("available".to_string(), Value::Bool(available));
    }
    UsageMetric::normalize(MetricInput {
        key: format!("wallet.{currency}.{component}"),
        label: Some(label.to_string()),
        value: value.map(|money| MetricValue::Number(money.to_f64())),
        unit: currency.to_string(),
        direction: MetricDirection::Balance,
        limit: None,
        reset_at: None,
        window_seconds: None,
        // A balance is a point-in-time fact, so it carries no daily scope: the
        // panel must not read it as "today".
        confidence: None,
        source: BALANCE_SOURCE.to_string(),
        details: if details.is_empty() {
            None
        } else {
            Some(details)
        },
        connection: Some(connection.clone()),
        capability: Some(MetricCapability::Supported),
        scope: None,
    })
    .map_err(|error| {
        CollectorError::compatibility(format!("cannot build a DeepSeek balance metric: {error}"))
    })
}

fn spend_metric(
    connection: &ConnectionId,
    summary: &DailySummary,
    timezone: &str,
) -> Result<UsageMetric, CollectorError> {
    let mut details = Map::new();
    details.insert(
        "localDay".to_string(),
        Value::String(summary.local_day.clone()),
    );
    details.insert(
        "adjustmentCount".to_string(),
        Value::Number(serde_json::Number::from(summary.adjustment_count)),
    );
    let confidence = if summary.partial {
        vec![Confidence::Estimated, Confidence::Partial]
    } else {
        vec![Confidence::Estimated]
    };

    UsageMetric::normalize(MetricInput {
        key: format!("spend.{}.daily", summary.currency),
        label: Some(SPEND_LABEL.to_string()),
        value: Some(MetricValue::Number(summary.estimated_spend_f64())),
        unit: summary.currency.clone(),
        direction: MetricDirection::Spend,
        limit: None,
        reset_at: None,
        window_seconds: None,
        confidence: Some(confidence),
        source: ESTIMATOR_SOURCE.to_string(),
        details: Some(details),
        connection: Some(connection.clone()),
        capability: Some(MetricCapability::Supported),
        // The scope describes the *estimate's* local day. `range_confirmed` is
        // true because the observation itself is real, not because DeepSeek
        // confirmed a range: no `rangeStart`/`rangeEnd` is attached, since the
        // provider never reported a daily range and inventing one would present
        // an estimate as provider data.
        scope: Some(StatisticScope {
            local_day: summary.local_day.clone(),
            timezone: timezone.to_string(),
            range_start: None,
            range_end: None,
            range_confirmed: true,
        }),
    })
    .map_err(|error| {
        CollectorError::compatibility(format!("cannot build the DeepSeek spend metric: {error}"))
    })
}

fn base_diagnostic(parsed: &ParsedBalance) -> Map<String, Value> {
    let mut diagnostic = Map::new();
    diagnostic.insert("available".to_string(), Value::Bool(parsed.is_available));
    diagnostic.insert(
        "currencies".to_string(),
        Value::Array(
            parsed
                .entries
                .iter()
                .map(|entry| Value::String(redact_str(&entry.currency)))
                .collect(),
        ),
    );
    diagnostic
}

fn failure_value(currency: &str, kind: ErrorKind, message: &str) -> Value {
    let mut failure = Map::new();
    failure.insert("currency".to_string(), Value::String(redact_str(currency)));
    failure.insert("kind".to_string(), Value::String(kind.as_str().to_string()));
    failure.insert("message".to_string(), Value::String(redact_str(message)));
    Value::Object(failure)
}

fn estimate_failure_error(error: EstimateError) -> CollectorError {
    CollectorError::new(
        error.kind(),
        format!("the DeepSeek daily spend estimate is unavailable: {error}"),
    )
}

/// Classify a non-success status handed back instead of a transport error.
///
/// The mapping is identical to the shared transport's so an error kind never
/// depends on which transport produced the response.
fn classify_status(status: u16, retry_after_seconds: Option<u64>) -> CollectorError {
    match status {
        401 | 403 => {
            CollectorError::authentication(format!("DeepSeek rejected the API key (HTTP {status})"))
        }
        429 => {
            let mut error = CollectorError::rate_limit("DeepSeek balance endpoint is rate limited");
            if let Some(seconds) = retry_after_seconds {
                error = error.with_diagnostic("retryAfterSeconds", seconds.to_string());
            }
            error
        }
        _ => CollectorError::network(format!(
            "DeepSeek balance request failed with HTTP {status}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn absent_components_stay_absent_and_reliable_zeros_are_kept() {
        let snapshot = normalize_balance(
            &json!({
                "is_available": true,
                "balance_infos": [
                    { "currency": "CNY", "total_balance": "86.42", "granted_balance": "0.00" }
                ]
            }),
            IsoTimestamp::parse("2026-09-09T16:00:00.000Z").expect("timestamp"),
        )
        .expect("snapshot");

        let granted = snapshot
            .metric("wallet.CNY.granted")
            .expect("granted metric");
        assert_eq!(granted.value.as_number(), Some(0.0));
        assert!(!granted.is_missing());
        assert!(!granted.has_confidence(Confidence::Unavailable));

        let topped_up = snapshot
            .metric("wallet.CNY.topped-up")
            .expect("topped-up metric");
        assert!(topped_up.is_missing());
        assert!(topped_up.has_confidence(Confidence::Unavailable));
    }

    #[test]
    fn malformed_bodies_are_incompatible() {
        for body in [
            json!({ "balance_infos": [] }),
            json!({ "is_available": "yes", "balance_infos": [] }),
            json!({ "is_available": true, "balance_infos": {} }),
            json!({ "is_available": true, "balance_infos": [ { "currency": "", "total_balance": "1.00" } ] }),
            json!({ "is_available": true, "balance_infos": [ { "currency": "CNY", "total_balance": 86.42 } ] }),
            json!({ "is_available": true, "balance_infos": [ { "currency": "CNY", "total_balance": "not-money" } ] }),
        ] {
            let error =
                normalize_balance(&body, IsoTimestamp::now()).expect_err("must be incompatible");
            assert_eq!(error.kind, ErrorKind::Compatibility, "{body}");
        }
    }
}

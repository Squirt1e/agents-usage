//! The separate experimental GLM wallet connection (task 3.5) and its own daily
//! spend estimate input (task 3.6).
//!
//! The wallet is *not* the Coding Plan: it holds its own credential, its own
//! cache, its own estimator and its own health, it is only collected when the
//! user explicitly enabled it, and its value is always reported with the
//! `experimental` confidence. The panel may hide it, which must not stop
//! collection or delete the credential — that separation lives in the settings,
//! not here.
//!
//! # Source validation
//!
//! The endpoint is an explicitly configured absolute URL and it has to pass three
//! checks *before any request is sent*:
//!
//! 1. the scheme must be `https`;
//! 2. the host must be on the caller-provided allow-list (for GLM:
//!    [`super::glm_wallet_allowed_hosts`]);
//! 3. the URL must not embed credentials of its own.
//!
//! A failing check reports `missing_config`, so the panel asks the user to fix the
//! configuration instead of showing a platform error. The credential is sent only
//! to that validated host, the transport refuses cross-origin redirects, and a
//! redirect status is never treated as success.
//!
//! # Schema changes
//!
//! A response that no longer matches `{balance, currency}` reports
//! `compatibility` and produces no snapshot: the caller keeps its previous
//! snapshot and no fabricated balance is ever written.
//!
//! # Spend estimation
//!
//! The wallet has no reliable daily-spend endpoint, so it feeds its balance
//! samples into the shared balance-delta estimator ([`DailySpendEstimator`], the
//! same seam the DeepSeek wallet uses through
//! [`crate::adapters::deepseek::DeepSeekCollector::with_balance_store`]). The
//! estimator is isolated by platform, connection, currency and local day, so a
//! GLM wallet balance can never be folded into a DeepSeek one. A storage failure
//! is never fatal for the balance: the reported balance is real, so it is still
//! returned, the `spend.<CUR>.daily` metric stays absent, and the failure is
//! reported in `diagnostic.estimateFailures`.

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use super::{
    authorized_get, ensure_same_origin, read_json, short, unwrap_data, wallet_connection,
    CredentialResolver, WALLET_SOURCE,
};
use crate::contracts::{
    Confidence, ConnectionStatus, ErrorKind, IsoTimestamp, MetricCapability, MetricDirection,
    MetricInput, MetricValue, ProviderId, ProviderSnapshot, StatisticScope, UsageMetric,
};
use crate::estimate::{
    BalanceStore, DailySpendEstimator, DailySpendRecorder, DailySummary, Money, Timezone,
};
use crate::transport::{CollectorError as CollectorFailure, SharedHttpTransport};
use crate::redaction::redact_str;

/// Source string of the balance-delta spend estimate.
///
/// Shared with the DeepSeek estimator and pinned by
/// `docs/desktop/semantic-map.md` section 3: the estimate is never attributed to
/// the wallet's own endpoint.
pub const ESTIMATOR_SOURCE: &str = "balance-delta-estimator";

/// Label of the estimated daily spend metric.
pub const SPEND_LABEL: &str = "Today spend";

/// Largest balance a `f64` JSON number can be turned into an exact amount for.
const MAX_EXACT_AMOUNT: f64 = 9_000_000_000_000.0;

/// Reads the experimental GLM wallet balance.
pub struct GlmWalletCollector {
    transport: SharedHttpTransport,
    endpoint: Option<String>,
    allowed_hosts: Vec<String>,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    credential: CredentialResolver,
    estimator: Option<Mutex<Box<dyn DailySpendRecorder>>>,
}

impl std::fmt::Debug for GlmWalletCollector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Neither the credential nor a full endpoint URL is rendered; the host is
        // the only part that matters for diagnosing source validation.
        formatter
            .debug_struct("GlmWalletCollector")
            .field("enabled", &(self.enabled)())
            .field("endpoint_host", &self.endpoint_host())
            .field("allowed_hosts", &self.allowed_hosts)
            .field("estimator", &self.estimator.is_some())
            .finish_non_exhaustive()
    }
}

impl GlmWalletCollector {
    /// Build a collector that is disabled and has no endpoint configured.
    ///
    /// Both are required: nothing is collected until the caller sets an endpoint,
    /// an allow-list and `enabled`.
    pub fn new(transport: SharedHttpTransport) -> Self {
        Self {
            transport,
            endpoint: None,
            allowed_hosts: Vec::new(),
            enabled: Arc::new(|| false),
            credential: Arc::new(|| None),
            estimator: None,
        }
    }

    /// Set the absolute endpoint URL from the settings.
    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = Some(endpoint.into());
        self
    }

    /// Set the hosts the endpoint may live on. An empty list refuses every host,
    /// so a caller must opt in explicitly.
    pub fn with_allowed_hosts<I, S>(mut self, hosts: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.allowed_hosts = hosts.into_iter().map(Into::into).collect();
        self
    }

    /// Drive enablement from the settings on every refresh.
    pub fn with_enabled(mut self, enabled: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.enabled = enabled;
        self
    }

    /// Use a fixed enablement flag.
    pub fn with_enabled_flag(mut self, enabled: bool) -> Self {
        self.enabled = Arc::new(move || enabled);
        self
    }

    /// Read the experimental credential on every refresh.
    pub fn with_credential(mut self, credential: CredentialResolver) -> Self {
        self.credential = credential;
        self
    }

    /// Convenience for a credential that is already available.
    pub fn with_credential_value(mut self, credential: impl Into<String>) -> Self {
        let credential = credential.into();
        self.credential = Arc::new(move || Some(credential.clone()));
        self
    }

    /// Attach the daily spend estimator used for `spend.<CUR>.daily`.
    ///
    /// Without an estimator the collector still reports every balance; the spend
    /// metric stays absent instead of being invented.
    pub fn with_estimator<R: DailySpendRecorder + 'static>(mut self, recorder: R) -> Self {
        self.estimator = Some(Mutex::new(Box::new(recorder)));
        self
    }

    /// Attach a [`BalanceStore`] through a GLM wallet estimator.
    ///
    /// This is the wiring the desktop service uses: the SQLite store implements
    /// [`BalanceStore`] and the collector owns the estimator that writes to it.
    /// The estimator runs on *this* collector's wallet connection, so the stored
    /// samples and the snapshot agree on the connection identity.
    pub fn with_balance_store<S: BalanceStore + Send + 'static>(
        self,
        store: S,
        timezone: Timezone,
    ) -> Self {
        self.with_estimator(DailySpendEstimator::new(
            store,
            ProviderId::Glm,
            wallet_connection(),
            timezone,
        ))
    }

    /// Whether the connection is enabled right now.
    pub fn is_enabled(&self) -> bool {
        (self.enabled)()
    }

    /// The configured endpoint host, if it can be parsed.
    pub fn endpoint_host(&self) -> Option<String> {
        url::Url::parse(self.endpoint.as_deref()?.trim())
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
    }

    /// The stored estimate of the most recent local day, without a new request.
    ///
    /// `Ok(None)` means no sample is stored for that currency (or no estimator is
    /// attached): an unobserved day is missing, never a zero estimate.
    pub fn current_estimate(
        &self,
        currency: &str,
    ) -> Result<Option<DailySummary>, CollectorFailure> {
        let Some(estimator) = &self.estimator else {
            return Ok(None);
        };
        let recorder = estimator.lock().map_err(|_| {
            CollectorFailure::new(
                ErrorKind::Storage,
                "the GLM wallet estimator lock was poisoned by an earlier panic",
            )
        })?;
        recorder.current(currency).map_err(estimate_failure_error)
    }

    /// Collect the wallet balance for `now`.
    pub async fn refresh(&self, now: DateTime<Utc>) -> Result<ProviderSnapshot, CollectorFailure> {
        if !self.is_enabled() {
            return Err(CollectorFailure::missing_config(
                "the experimental GLM wallet connection is disabled",
            ));
        }

        let credential = (self.credential)();
        let credential = credential
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                CollectorFailure::missing_config(
                    "the experimental GLM wallet credential is not configured",
                )
            })?;

        let endpoint = self.endpoint.as_deref().ok_or_else(|| {
            CollectorFailure::missing_config(
                "the experimental GLM wallet endpoint is not configured",
            )
        })?;
        let url = validate_endpoint(endpoint, &self.allowed_hosts)?;

        let response = self
            .transport
            .get(authorized_get(url.as_str(), credential))
            .await?;
        ensure_same_origin(&response, &url)?;
        let raw = read_json(response, "Experimental GLM wallet")?;

        let data = unwrap_data(&raw);
        let raw_balance = data.get("balance").filter(|value| !value.is_null());
        let balance = raw_balance.and_then(wallet_amount).ok_or_else(|| {
            CollectorFailure::compatibility(
                "the experimental GLM wallet response no longer provides a numeric balance",
            )
        })?;
        let currency = data
            .get("currency")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|currency| !currency.is_empty())
            .ok_or_else(|| {
                CollectorFailure::compatibility(
                    "the experimental GLM wallet response no longer provides a currency",
                )
            })?
            .to_string();

        let captured_at = IsoTimestamp::from_datetime(now);
        let metric = UsageMetric::normalize(MetricInput {
            key: format!("wallet.{currency}.balance"),
            label: Some("Wallet balance".to_string()),
            value: Some(MetricValue::Number(balance)),
            unit: currency.clone(),
            direction: MetricDirection::Balance,
            confidence: Some(vec![Confidence::Experimental]),
            source: WALLET_SOURCE.to_string(),
            details: None,
            connection: Some(wallet_connection()),
            capability: Some(MetricCapability::Supported),
            scope: None,
            ..MetricInput::default()
        })
        .map_err(|error| {
            CollectorFailure::compatibility(format!("the GLM wallet balance was rejected: {error}"))
        })?;

        // The estimator only ever receives the balance the provider reported, and
        // its outcome can never remove that balance from the snapshot.
        let mut metrics = vec![metric];
        let mut diagnostic = Map::new();
        if let Some(raw_balance) = raw_balance {
            if let Some(outcome) = self.estimate(&currency, raw_balance, &captured_at) {
                if let Some(spend) = outcome.metric {
                    metrics.push(spend);
                }
                if let Some(failure) = outcome.failure {
                    diagnostic.insert("estimateFailures".to_string(), Value::Array(vec![failure]));
                }
            }
        }

        Ok(ProviderSnapshot {
            provider: ProviderId::Glm,
            connection: Some(wallet_connection()),
            status: ConnectionStatus::Connected,
            captured_at: captured_at.clone(),
            last_success_at: Some(captured_at),
            source: WALLET_SOURCE.to_string(),
            metrics,
            error: None,
            diagnostic: if diagnostic.is_empty() {
                None
            } else {
                Some(diagnostic)
            },
            extra: Map::new(),
        })
    }

    /// Record the reported balance and build the `spend.<CUR>.daily` metric.
    ///
    /// `None` means no estimator is attached, so no estimate is produced and no
    /// sample is stored.
    fn estimate(
        &self,
        currency: &str,
        raw_balance: &Value,
        observed_at: &IsoTimestamp,
    ) -> Option<EstimateOutcome> {
        let estimator = self.estimator.as_ref()?;

        let mut recorder = match estimator.lock() {
            Ok(recorder) => recorder,
            Err(_) => {
                return Some(EstimateOutcome {
                    metric: None,
                    failure: Some(failure_value(
                        currency,
                        ErrorKind::Storage,
                        "the GLM wallet estimator lock was poisoned by an earlier panic",
                    )),
                })
            }
        };

        let Some(total) = wallet_money(raw_balance) else {
            return Some(EstimateOutcome {
                metric: None,
                failure: Some(failure_value(
                    currency,
                    ErrorKind::Compatibility,
                    "the reported balance cannot be represented as an exact amount",
                )),
            });
        };

        let timezone = recorder.timezone_name().to_string();
        match recorder.record(currency, total, observed_at) {
            Ok(summary) => match spend_metric(&summary, &timezone) {
                Ok(metric) => Some(EstimateOutcome {
                    metric: Some(metric),
                    failure: None,
                }),
                Err(error) => Some(EstimateOutcome {
                    metric: None,
                    failure: Some(failure_value(currency, error.kind, &error.message)),
                }),
            },
            Err(error) => Some(EstimateOutcome {
                metric: None,
                failure: Some(failure_value(currency, error.kind(), &error.to_string())),
            }),
        }
    }
}

/// Metrics and diagnostic produced by one estimation pass.
struct EstimateOutcome {
    metric: Option<UsageMetric>,
    failure: Option<Value>,
}

/// Validate the configured endpoint before any request is sent.
///
/// Returns the parsed URL so the caller can pin the same origin for the response
/// check: the credential must never be addressed to, or accepted from, any other
/// host.
pub fn validate_endpoint(
    endpoint: &str,
    allowed_hosts: &[String],
) -> Result<url::Url, CollectorFailure> {
    let trimmed = endpoint.trim();
    if trimmed.is_empty() {
        return Err(CollectorFailure::missing_config(
            "the experimental GLM wallet endpoint is not configured",
        ));
    }
    let url = url::Url::parse(trimmed).map_err(|_| {
        CollectorFailure::missing_config(
            "the experimental GLM wallet endpoint is not a valid absolute URL",
        )
    })?;

    if url.scheme() != "https" {
        return Err(CollectorFailure::missing_config(
            "the experimental GLM wallet endpoint must use HTTPS",
        ));
    }

    let Some(host) = url.host_str() else {
        return Err(CollectorFailure::missing_config(
            "the experimental GLM wallet endpoint does not name a host",
        ));
    };
    let host = normalize_host(host);
    let allowed = allowed_hosts
        .iter()
        .map(|allowed| normalize_host(allowed))
        .any(|allowed| !allowed.is_empty() && allowed == host);
    if !allowed {
        return Err(CollectorFailure::missing_config(format!(
            "the experimental GLM wallet endpoint host `{host}` is not on the allowed provider host list"
        )));
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(CollectorFailure::missing_config(
            "the experimental GLM wallet endpoint must not embed credentials in the URL",
        ));
    }

    Ok(url)
}

/// Lowercase a host and drop a trailing dot so `api.z.ai.` cannot slip past the
/// allow-list.
fn normalize_host(host: &str) -> String {
    short(host.trim().trim_end_matches('.'), 253).to_ascii_lowercase()
}

/// A wallet amount: a JSON number, or an unambiguous numeric string (the
/// experimental endpoint has sent amounts as strings). Anything else stays
/// missing and becomes a compatibility failure rather than a zero.
fn wallet_amount(raw: &Value) -> Option<f64> {
    match raw {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite()),
        _ => None,
    }
}

/// The exact amount the estimator stores for one reported balance.
///
/// A JSON number is parsed from the literal the provider sent (`42.6` → exact
/// `42.6`) and a string through [`Money::parse`]; only a number whose literal the
/// exact decimal form cannot express falls back to rounding micro-units, and an
/// absurd magnitude stays unrepresentable instead of saturating.
fn wallet_money(raw: &Value) -> Option<Money> {
    match raw {
        Value::String(text) => Money::parse(text.trim()).ok(),
        Value::Number(number) => Money::parse(&number.to_string()).ok().or_else(|| {
            let value = number.as_f64()?;
            if !value.is_finite() || value.abs() > MAX_EXACT_AMOUNT {
                return None;
            }
            Some(Money::from_micro_units(
                (value * Money::SCALE as f64).round() as i64,
            ))
        }),
        _ => None,
    }
}

/// One `spend.<CUR>.daily` metric for the estimate's own local day.
fn spend_metric(summary: &DailySummary, timezone: &str) -> Result<UsageMetric, CollectorFailure> {
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
        connection: Some(wallet_connection()),
        capability: Some(MetricCapability::Supported),
        // The scope describes the *estimate's* local day, exactly like the
        // DeepSeek wallet: no range is attached, because the wallet never
        // reported a daily range and inventing one would present an estimate as
        // provider data.
        scope: Some(StatisticScope {
            local_day: summary.local_day.clone(),
            timezone: timezone.to_string(),
            range_start: None,
            range_end: None,
            range_confirmed: true,
        }),
    })
    .map_err(|error| {
        CollectorFailure::compatibility(format!(
            "the GLM wallet spend estimate was rejected: {error}"
        ))
    })
}

/// One entry of `diagnostic.estimateFailures`, redacted like every other output.
fn failure_value(currency: &str, kind: ErrorKind, message: &str) -> Value {
    let mut failure = Map::new();
    failure.insert("currency".to_string(), Value::String(redact_str(currency)));
    failure.insert("kind".to_string(), Value::String(kind.as_str().to_string()));
    failure.insert("message".to_string(), Value::String(redact_str(message)));
    Value::Object(failure)
}

fn estimate_failure_error(error: crate::estimate::EstimateError) -> CollectorFailure {
    CollectorFailure::new(
        error.kind(),
        format!("the GLM wallet daily spend estimate is unavailable: {error}"),
    )
}

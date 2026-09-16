//! The experimental DeepSeek web usage connection (`deepseek:web`).
//!
//! DeepSeek's documented API has no usage endpoint — only `user/balance` — so
//! the daily spend the stable wallet connection reports is a balance-delta
//! estimate. The developer console (platform.deepseek.com) *does* show billed
//! usage, backed by two undocumented, session-authenticated endpoints. This
//! collector calls those endpoints directly and turns the billed aggregates
//! into `experimental`-confidence metrics, exactly like the experimental GLM
//! wallet does for its balance:
//!
//! * the connection is **off until the settings enable it** and never issues a
//!   request before that;
//! * the credential is the **web login token** (not the API key), read from the
//!   Keychain on every refresh and sent only to `platform.deepseek.com` over
//!   HTTPS, never to a redirected origin;
//! * a failure of this connection is **independent** of the stable wallet:
//!   callers record it against `deepseek:web` only, and the panel keeps
//!   showing balances and the estimate.
//!
//! # Response shapes (confirmed against the console's own front end)
//!
//! Both endpoints answer `{code, msg, data}`, with the usage payload under
//! `data.biz_data`; the console reports an unauthenticated caller with
//! `code: 40002` (`Missing Token`) when no token arrived at all and `code: 40003`
//! (`Authorization Failed (invalid token)`) when the token was not accepted. Both
//! are the same recovery for the user — paste a fresh login token — so both map to
//! `authentication`.
//!
//! `start`/`end` are Unix seconds and `tz` the configured timezone's offset in
//! seconds, and the window is the **whole local day**: the console's own usage
//! page builds its query from day presets (today / yesterday / last7Days /
//! last30Days), so `end` is the next local midnight, never "now" — see
//! [`DeepSeekWebCollector::window`]. The payload the window returns is:
//!
//! ```json
//! // /api/v0/usage/by_api_key/cost → data.biz_data
//! { "start": 1757500800, "end": 1757548800, "bucket": "hour",
//!   "models": [...],
//!   "data": [ { "currency": "CNY",
//!               "series": [ { "api_key": "…", "model": "…",
//!                             "buckets": [ { "time": 1757500800, "cost": 1.63 } ] } ] } ] }
//! // /api/v0/usage/by_api_key/amount → data.biz_data
//! { "series": [ { "api_key": "…", "model": "…",
//!                 "buckets": [ { "time": 1757500800,
//!                                "usage": { "PROMPT_CACHE_HIT_TOKEN": 10,
//!                                           "PROMPT_CACHE_MISS_TOKEN": 20,
//!                                           "RESPONSE_TOKEN": 30,
//!                                           "REQUEST": 2 } } ] } ] }
//! ```
//!
//! One metric per currency sums the `cost` buckets; tokens sum the three token
//! counters and requests sum `REQUEST` across every api key and model. Fields
//! that are absent stay absent — a bucket the console did not quantify is never
//! counted as zero.

use std::sync::Arc;

use chrono::{DateTime, NaiveTime, Offset as _, Utc};
use chrono_tz::Tz;
use serde_json::{Map, Value};

use super::glm::{ensure_same_origin, local_instant, short};
use crate::contracts::{
    Confidence, ConnectionId, ConnectionStatus, ErrorKind, IsoTimestamp, MetricCapability,
    MetricDirection, MetricInput, MetricValue, ProviderId, ProviderSnapshot, StatisticScope,
    UsageMetric,
};
use crate::estimate::Money;
use crate::transport::{CollectorError as CollectorFailure, HttpGet, HttpResponse, SharedHttpTransport};
use crate::redaction::redact_str;

/// Machine identifier of the experimental web usage connection.
pub const WEB_CONNECTION: &str = "web";
/// Human readable label of the experimental web usage connection.
pub const WEB_LABEL: &str = "Web usage";
/// Source string of the billed usage metrics.
pub const WEB_SOURCE: &str = "deepseek-web-usage";
/// The only origin the login token may be sent to.
pub const PLATFORM_ORIGIN: &str = "https://platform.deepseek.com";
/// Billed spend per api key and model.
pub const COST_PATH: &str = "/api/v0/usage/by_api_key/cost";
/// Token and request counts per api key and model.
pub const AMOUNT_PATH: &str = "/api/v0/usage/by_api_key/amount";
/// Business code the console answers with when the login token is absent; mapped
/// to `authentication` so the panel asks for a fresh paste.
const MISSING_TOKEN_CODE: f64 = 40002.0;
/// Business code the console answers with when the login token is present but
/// not accepted (`Authorization Failed (invalid token)`): an expired or wrongly
/// copied session token. Same recovery as the missing one — the panel must ask
/// for a fresh paste rather than report an interface change.
const INVALID_TOKEN_CODE: f64 = 40003.0;

const SPEND_LABEL: &str = "Today billed spend";
const TOKENS_LABEL: &str = "Today tokens";
const REQUESTS_LABEL: &str = "Today requests";

/// Connection identity of the experimental web usage connection.
pub fn web_connection() -> ConnectionId {
    ConnectionId::with_label(ProviderId::Deepseek, WEB_CONNECTION, WEB_LABEL)
}

/// Reads the DeepSeek web login token. Same seam as the GLM wallet's
/// credential resolver: `None` means nothing is configured.
pub type CredentialResolver = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// The local-day query window, in the units the console endpoints expect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageWindow {
    /// Local statistics date, `YYYY-MM-DD`.
    pub local_day: String,
    /// IANA timezone the day was computed in.
    pub timezone: String,
    /// Local midnight of the day, Unix seconds.
    pub start_sec: i64,
    /// Local midnight of the next day — the window covers the **whole** local day.
    pub end_sec: i64,
    /// The timezone's offset from UTC at the window start, seconds.
    pub tz_sec: i32,
    /// The same instants as contract timestamps.
    pub start: IsoTimestamp,
    pub end: IsoTimestamp,
}

impl UsageWindow {
    /// `start=…&end=…&tz=…`, percent-encoded.
    pub fn query_string(&self) -> String {
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("start", &self.start_sec.to_string())
            .append_pair("end", &self.end_sec.to_string())
            .append_pair("tz", &self.tz_sec.to_string())
            .finish()
    }
}

/// Reads the billed usage for one refresh cycle.
pub struct DeepSeekWebCollector {
    transport: SharedHttpTransport,
    timezone: String,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    credential: CredentialResolver,
}

impl std::fmt::Debug for DeepSeekWebCollector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeepSeekWebCollector")
            .field("enabled", &(self.enabled)())
            .field("timezone", &self.timezone)
            .field("origin", &PLATFORM_ORIGIN)
            .finish_non_exhaustive()
    }
}

impl DeepSeekWebCollector {
    /// Build a collector for the given display timezone; disabled and without a
    /// credential until the caller says otherwise.
    pub fn new(transport: SharedHttpTransport, timezone: impl Into<String>) -> Self {
        Self {
            transport,
            timezone: timezone.into(),
            enabled: Arc::new(|| false),
            credential: Arc::new(|| None),
        }
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

    /// Read the web login token on every refresh.
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

    /// Whether the connection is enabled right now.
    pub fn is_enabled(&self) -> bool {
        (self.enabled)()
    }

    /// The local-day window that contains `now` in the configured timezone.
    ///
    /// The window covers the **whole** local day — `[local midnight, next local
    /// midnight)` — because that is the only window shape this endpoint is known
    /// to answer: the console's own usage page always asks for whole days (its
    /// presets are today/yesterday/last7Days/last30Days/…), and a window that
    /// stops at the current instant is a shape nothing has ever exercised. The
    /// next midnight is computed in the timezone rather than by adding 86400, so
    /// a day that is 23 or 25 hours long still ends at the right instant.
    ///
    /// An unknown timezone is a configuration problem, not a platform failure,
    /// and reports `missing_config` instead of silently falling back to UTC.
    pub fn window(&self, now: DateTime<Utc>) -> Result<UsageWindow, CollectorFailure> {
        let name = self.timezone.trim();
        if name.is_empty() {
            return Err(CollectorFailure::missing_config(
                "the configured timezone is empty",
            ));
        }
        let timezone = name.parse::<Tz>().map_err(|_| {
            CollectorFailure::missing_config(format!(
                "the configured timezone `{name}` is not a known IANA timezone"
            ))
        })?;
        let local_day = now.with_timezone(&timezone).date_naive();
        let start = local_instant(timezone, local_day.and_time(NaiveTime::MIN));
        let next_day = local_day.succ_opt().ok_or_else(|| {
            CollectorFailure::missing_config("the local statistics date cannot be advanced")
        })?;
        let end = local_instant(timezone, next_day.and_time(NaiveTime::MIN));
        let tz_sec = start.offset().fix().local_minus_utc();
        let start_sec = start.timestamp();
        let end_sec = end.timestamp();
        Ok(UsageWindow {
            local_day: local_day.to_string(),
            timezone: name.to_string(),
            start_sec,
            end_sec,
            tz_sec,
            start: IsoTimestamp::from_datetime(start.with_timezone(&Utc)),
            end: IsoTimestamp::from_datetime(end.with_timezone(&Utc)),
        })
    }

    /// Collect the billed usage for `now`.
    pub async fn refresh(
        &self,
        now: DateTime<Utc>,
    ) -> Result<ProviderSnapshot, CollectorFailure> {
        if !self.is_enabled() {
            return Err(CollectorFailure::missing_config(
                "the experimental DeepSeek web usage connection is disabled",
            ));
        }
        let credential = (self.credential)();
        let credential = credential
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                CollectorFailure::missing_config(
                    "the experimental DeepSeek web usage credential is not configured",
                )
            })?;
        let window = self.window(now)?;

        let cost_url = format!("{PLATFORM_ORIGIN}{COST_PATH}?{}", window.query_string());
        let amount_url = format!("{PLATFORM_ORIGIN}{AMOUNT_PATH}?{}", window.query_string());
        let request = |url: String| {
            HttpGet::new(url)
                .with_header("Authorization", format!("Bearer {credential}"))
                .with_header("Accept", "application/json")
        };
        let (cost_response, amount_response) = tokio::join!(
            self.transport.get(request(cost_url)),
            self.transport.get(request(amount_url))
        );
        let cost_envelope = self.read_envelope(cost_response, "DeepSeek web cost").await?;
        let amount_envelope = self
            .read_envelope(amount_response, "DeepSeek web amount")
            .await?;

        let captured_at = IsoTimestamp::from_datetime(now);
        normalize_usage(&cost_envelope, &amount_envelope, &window, captured_at)
    }

    /// Read one console response: same-origin, status classification, then the
    /// `{code, msg, data}` envelope.
    async fn read_envelope(
        &self,
        response: Result<HttpResponse, CollectorFailure>,
        label: &str,
    ) -> Result<Value, CollectorFailure> {
        let response = response?;
        let url = url::Url::parse(PLATFORM_ORIGIN)
            .expect("the platform origin must always parse");
        ensure_same_origin(&response, &url)?;
        if response.status == 401 || response.status == 403 {
            return Err(CollectorFailure::authentication(format!(
                "{label} rejected the login token (HTTP {}); paste a fresh one",
                response.status
            )));
        }
        if response.status == 429 {
            return Err(CollectorFailure::rate_limit(
                "the DeepSeek web usage endpoint is rate limited",
            ));
        }
        if !response.is_success() {
            return Err(CollectorFailure::network(format!(
                "{label} failed with HTTP {}",
                response.status
            )));
        }
        let envelope: Value = serde_json::from_str(&response.body)
            .map_err(|_| CollectorFailure::compatibility(format!("{label} returned invalid JSON")))?;
        match envelope.get("code").and_then(Value::as_f64) {
            None | Some(0.0) => Ok(envelope),
            Some(code) if code == MISSING_TOKEN_CODE => Err(CollectorFailure::authentication(
                "the DeepSeek web login token is missing; paste a fresh one from the developer console",
            )),
            Some(code) if code == INVALID_TOKEN_CODE => Err(CollectorFailure::authentication(
                "the DeepSeek web login token was rejected as invalid or expired; paste a fresh one",
            )),
            Some(code) => {
                let raw = envelope
                    .get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let message = if raw.is_empty() {
                    "request rejected".to_string()
                } else {
                    short(raw, 300)
                };
                Err(CollectorFailure::compatibility(format!(
                    "{label} rejected the request (code {code}): {}",
                    redact_str(&message)
                )))
            }
        }
    }
}

/// Turn one cost and one amount envelope into the billed usage snapshot.
///
/// Also the seam the fixture-driven tests use, so the response shapes can be
/// pinned without a network.
pub fn normalize_usage(
    cost_envelope: &Value,
    amount_envelope: &Value,
    window: &UsageWindow,
    captured_at: IsoTimestamp,
) -> Result<ProviderSnapshot, CollectorFailure> {
    let cost_data = biz_data(cost_envelope, "cost")?;
    let amount_data = biz_data(amount_envelope, "amount")?;
    let confirmed = echo_confirms_window(cost_data, window) && echo_confirms_window(amount_data, window);
    let scope = StatisticScope {
        local_day: window.local_day.clone(),
        timezone: window.timezone.clone(),
        range_start: Some(window.start.clone()),
        range_end: Some(window.end.clone()),
        range_confirmed: confirmed,
    };

    let mut metrics = Vec::new();
    for (currency, total) in parse_costs(cost_data)? {
        metrics.push(number_metric(
            &format!("spend.{currency}.daily.billed"),
            SPEND_LABEL,
            total.to_f64(),
            currency.clone(),
            MetricDirection::Spend,
            &scope,
        )?);
    }
    let (tokens, requests) = parse_amounts(amount_data)?;
    if let Some(tokens) = tokens {
        metrics.push(number_metric(
            "activity.daily.tokens",
            TOKENS_LABEL,
            tokens,
            "tokens".to_string(),
            MetricDirection::Activity,
            &scope,
        )?);
    }
    if let Some(requests) = requests {
        metrics.push(number_metric(
            "activity.daily.requests",
            REQUESTS_LABEL,
            requests,
            "requests".to_string(),
            MetricDirection::Activity,
            &scope,
        )?);
    }

    let mut diagnostic = Map::new();
    diagnostic.insert("windowConfirmed".to_string(), Value::Bool(confirmed));

    Ok(ProviderSnapshot {
        provider: ProviderId::Deepseek,
        connection: Some(web_connection()),
        status: ConnectionStatus::Connected,
        captured_at: captured_at.clone(),
        last_success_at: Some(captured_at),
        source: WEB_SOURCE.to_string(),
        metrics,
        error: None,
        diagnostic: Some(diagnostic),
        extra: Map::new(),
    })
}

/// The usage payload of one envelope.
///
/// The console's own front end reads `data.biz_data`, which is the shape both
/// endpoints are known to answer. Two things are handled without giving up on the
/// data: an envelope that puts the payload **directly** under `data` — the same
/// object, minus the wrapper — and the **nested business code** the platform API
/// answers with (`data.biz_code`, documented by other clients of these very
/// endpoints), which reports the real verdict when the payload is empty. A nested
/// `40002`/`40003` is an unauthenticated caller like the top-level one, and any
/// other nested code is named instead of being described as a parse failure.
///
/// A null `data`/`biz_data` next to a zero code stays a failure rather than being
/// read as "zero usage": the console maps over `biz_data.series` without a guard,
/// so an account that works in the console never answers that way, and calling it
/// an empty day would hide a changed API behind a card that simply shows nothing.
///
/// Every failure message names what actually arrived — the envelope's own keys are
/// field names, never values, so saying them is what makes a changed API
/// diagnosable from the panel instead of a dead end.
fn biz_data<'a>(
    envelope: &'a Value,
    label: &str,
) -> Result<&'a Map<String, Value>, CollectorFailure> {
    let Some(data) = envelope.get("data").filter(|value| !value.is_null()) else {
        return Err(missing_biz_data(label, envelope, "`data` is null or absent"));
    };
    let Some(object) = data.as_object() else {
        return Err(missing_biz_data(label, envelope, "`data` is not an object"));
    };
    match object.get("biz_data") {
        Some(payload) => payload
            .as_object()
            .ok_or_else(|| unreadable_biz_data(label, envelope, object, "`data.biz_data` is not an object")),
        // No wrapper: accept a payload that is recognisably the usage data itself.
        None if looks_like_usage(object) => Ok(object),
        None => Err(unreadable_biz_data(
            label,
            envelope,
            object,
            "neither `data.biz_data` nor a usage payload under `data`",
        )),
    }
}

/// Does this object carry the fields the usage endpoints answer with?
fn looks_like_usage(object: &Map<String, Value>) -> bool {
    ["series", "data", "models", "bucket"]
        .iter()
        .any(|key| object.contains_key(*key))
}

/// The nested business verdict, when the payload cannot be read.
///
/// The platform API carries a second, nested code next to the top-level one; when
/// the payload is empty this is where the reason is. Only read on the failure path,
/// so a shape we did not expect can never turn a readable answer into an error.
fn nested_verdict(object: &Map<String, Value>) -> Option<CollectorFailure> {
    for key in ["biz_code", "code"] {
        let Some(code) = object.get(key).and_then(Value::as_f64) else {
            continue;
        };
        if code == 0.0 {
            continue;
        }
        let raw = ["biz_msg", "msg"]
            .iter()
            .find_map(|name| object.get(*name).and_then(Value::as_str))
            .unwrap_or("")
            .trim();
        if code == MISSING_TOKEN_CODE || code == INVALID_TOKEN_CODE {
            return Some(CollectorFailure::authentication(format!(
                "the DeepSeek web login token was rejected (code {code}); paste a fresh one"
            )));
        }
        let message = if raw.is_empty() {
            "no message".to_string()
        } else {
            redact_str(&short(raw, 300))
        };
        return Some(CollectorFailure::compatibility(format!(
            "the DeepSeek web console answered with business code {code} (`data.{key}`, {message})"
        )));
    }
    None
}

/// A payload that is missing, null or unreadable: report the nested verdict if the
/// response carried one, otherwise the shape that actually arrived.
fn unreadable_biz_data(
    label: &str,
    envelope: &Value,
    data: &Map<String, Value>,
    detail: &str,
) -> CollectorFailure {
    nested_verdict(data).unwrap_or_else(|| missing_biz_data(label, envelope, detail))
}

fn missing_biz_data(label: &str, envelope: &Value, detail: &str) -> CollectorFailure {
    CollectorFailure::compatibility(format!(
        "the DeepSeek web {label} response no longer provides biz_data ({detail}; envelope keys: {})",
        key_list(envelope)
    ))
}

/// The keys of a JSON value, comma-separated: a shape, never a value.
fn key_list(value: &Value) -> String {
    match value.as_object() {
        Some(object) if !object.is_empty() => object.keys().cloned().collect::<Vec<_>>().join(", "),
        Some(_) => "none".to_string(),
        None => "not an object".to_string(),
    }
}

/// One summed cost per currency, in first-seen order.
fn parse_costs(
    biz_data: &Map<String, Value>,
) -> Result<Vec<(String, Money)>, CollectorFailure> {
    let entries = biz_data
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CollectorFailure::compatibility(
                "the DeepSeek web cost response no longer provides a data array",
            )
        })?;
    let mut totals: Vec<(String, Money)> = Vec::new();
    for (entry_index, entry) in entries.iter().enumerate() {
        let currency = entry
            .get("currency")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|currency| !currency.is_empty())
            .ok_or_else(|| {
                CollectorFailure::compatibility(format!(
                    "the DeepSeek web cost response data[{entry_index}] has no currency"
                ))
            })?
            .to_string();
        let series = entry.get("series").and_then(Value::as_array).ok_or_else(|| {
            CollectorFailure::compatibility(format!(
                "the DeepSeek web cost response data[{entry_index}] has no series array"
            ))
        })?;
        let mut total = Money::from_micro_units(0);
        for serie in series {
            let buckets = serie
                .get("buckets")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    CollectorFailure::compatibility(
                        "the DeepSeek web cost series no longer provides buckets",
                    )
                })?;
            for bucket in buckets {
                // A bucket without a cost stays absent; only a real number (or a
                // numeric string, the console has sent both) is counted.
                if let Some(cost) = bucket.get("cost").and_then(number_value) {
                    let Some(money) = money_value(cost) else {
                        return Err(CollectorFailure::compatibility(
                            "the DeepSeek web cost response has an unrepresentable cost amount",
                        ));
                    };
                    total = total.checked_add(money).ok_or_else(|| {
                        CollectorFailure::compatibility(
                            "the DeepSeek web cost amounts overflow the exact decimal range",
                        )
                    })?;
                }
            }
        }
        if let Some((_, existing)) = totals.iter_mut().find(|(name, _)| *name == currency) {
            *existing = existing.checked_add(total).ok_or_else(|| {
                CollectorFailure::compatibility(
                    "the DeepSeek web cost amounts overflow the exact decimal range",
                )
            })?;
        } else {
            totals.push((currency, total));
        }
    }
    Ok(totals)
}

/// Sums of the token counters and request counts across every series.
fn parse_amounts(biz_data: &Map<String, Value>) -> Result<(Option<f64>, Option<f64>), CollectorFailure> {
    let series = biz_data
        .get("series")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CollectorFailure::compatibility(
                "the DeepSeek web amount response no longer provides a series array",
            )
        })?;
    let mut tokens: Option<f64> = None;
    let mut requests: Option<f64> = None;
    for serie in series {
        let buckets = serie
            .get("buckets")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CollectorFailure::compatibility(
                    "the DeepSeek web amount series no longer provides buckets",
                )
            })?;
        for bucket in buckets {
            let Some(usage) = bucket.get("usage") else {
                continue;
            };
            // The console counts tokens as cache-hit + cache-miss + response;
            // a counter that is absent is not a zero and never invents usage.
            let hit = usage.get("PROMPT_CACHE_HIT_TOKEN").and_then(number_value);
            let miss = usage
                .get("PROMPT_CACHE_MISS_TOKEN")
                .and_then(number_value);
            let response = usage.get("RESPONSE_TOKEN").and_then(number_value);
            if hit.is_some() || miss.is_some() || response.is_some() {
                let bucket_tokens =
                    hit.unwrap_or(0.0) + miss.unwrap_or(0.0) + response.unwrap_or(0.0);
                tokens = Some(tokens.unwrap_or(0.0) + bucket_tokens);
            }
            if let Some(count) = usage.get("REQUEST").and_then(number_value) {
                requests = Some(requests.unwrap_or(0.0) + count);
            }
        }
    }
    Ok((tokens, requests))
}

/// Does the envelope echo the requested window back unchanged?
///
/// `biz_data.start`/`end` mirror the query in the console's own front end;
/// accepting the window as confirmed only on an exact echo keeps the scope's
/// `rangeConfirmed` honest even when the format changes.
fn echo_confirms_window(biz_data: &Map<String, Value>, window: &UsageWindow) -> bool {
    let echoed = |key: &str| -> Option<i64> {
        let raw = biz_data.get(key)?;
        if let Some(seconds) = raw.as_i64() {
            return Some(seconds);
        }
        raw.as_str()?.trim().parse::<i64>().ok()
    };
    echoed("start") == Some(window.start_sec) && echoed("end") == Some(window.end_sec)
}

/// A finite JSON number or an unambiguous numeric string; anything else stays
/// absent.
fn number_value(raw: &Value) -> Option<f64> {
    match raw {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::String(text) => text.trim().parse::<f64>().ok().filter(|value| value.is_finite()),
        _ => None,
    }
}

/// Exact decimal representation of a cost amount.
fn money_value(value: f64) -> Option<Money> {
    Money::parse(&format!("{value}")).ok().or_else(|| {
        if !value.is_finite() || value.abs() > 9_000_000_000_000.0 {
            return None;
        }
        Some(Money::from_micro_units(
            (value * Money::SCALE as f64).round() as i64,
        ))
    })
}

#[allow(clippy::too_many_arguments)]
fn number_metric(
    key: &str,
    label: &str,
    value: f64,
    unit: String,
    direction: MetricDirection,
    scope: &StatisticScope,
) -> Result<UsageMetric, CollectorFailure> {
    UsageMetric::normalize(MetricInput {
        key: key.to_string(),
        label: Some(label.to_string()),
        value: Some(MetricValue::Number(value)),
        unit,
        direction,
        limit: None,
        reset_at: None,
        window_seconds: None,
        confidence: Some(vec![Confidence::Experimental]),
        source: WEB_SOURCE.to_string(),
        details: None,
        connection: Some(web_connection()),
        capability: Some(MetricCapability::Supported),
        scope: Some(scope.clone()),
    })
    .map_err(|error| {
        CollectorFailure::new(
            ErrorKind::Compatibility,
            format!("cannot build the DeepSeek billed usage metric: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn window() -> UsageWindow {
        UsageWindow {
            local_day: "2026-09-10".to_string(),
            timezone: "Asia/Shanghai".to_string(),
            start_sec: 1_788_969_600,
            // The whole local day: next local midnight, not the query instant.
            end_sec: 1_789_056_000,
            tz_sec: 28_800,
            start: IsoTimestamp::parse("2026-09-10T00:00:00+08:00").expect("start"),
            end: IsoTimestamp::parse("2026-09-11T00:00:00+08:00").expect("end"),
        }
    }

    fn cost_envelope(confirmed: bool) -> Value {
        let (start, end) = if confirmed {
            (json!(1_788_969_600), json!(1_789_056_000))
        } else {
            (json!("not-a-number"), json!(1_789_056_000))
        };
        json!({
            "code": 0,
            "msg": "success",
            "data": { "biz_data": {
                "start": start, "end": end, "bucket": "hour", "models": [],
                "data": [
                    { "currency": "CNY", "series": [
                        { "api_key": "a", "model": "deepseek-flash",
                          "buckets": [ { "time": 1_788_969_600, "cost": 1.63 },
                                       { "time": 1_757_437_200, "cost": 2.00 } ] },
                        { "api_key": "b", "model": "deepseek-v4-pro",
                          "buckets": [ { "time": 1_788_969_600, "cost": "11.10" } ] }
                    ] },
                    { "currency": "USD", "series": [
                        { "api_key": "a", "model": "deepseek-flash",
                          "buckets": [ { "time": 1_788_969_600, "cost": 0.42 } ] }
                    ] }
                ]
            } }
        })
    }

    fn amount_envelope() -> Value {
        json!({
            "code": 0,
            "data": { "biz_data": {
                "start": 1_788_969_600, "end": 1_789_056_000, "bucket": "hour", "models": [],
                "series": [
                    { "api_key": "a", "model": "deepseek-flash", "buckets": [
                        { "time": 1_788_969_600, "usage": {
                            "PROMPT_CACHE_HIT_TOKEN": 10, "PROMPT_CACHE_MISS_TOKEN": 20,
                            "RESPONSE_TOKEN": 30, "REQUEST": 2 } },
                        { "time": 1_757_437_200, "usage": {
                            "PROMPT_CACHE_HIT_TOKEN": 1, "PROMPT_CACHE_MISS_TOKEN": 2,
                            "RESPONSE_TOKEN": 3, "REQUEST": 1 } }
                    ] },
                    { "api_key": "b", "model": "deepseek-v4-pro", "buckets": [
                        { "time": 1_788_969_600, "usage": {
                            "PROMPT_CACHE_HIT_TOKEN": 100, "PROMPT_CACHE_MISS_TOKEN": 200,
                            "RESPONSE_TOKEN": 300, "REQUEST": 5 } }
                    ] }
                ]
            } }
        })
    }

    #[test]
    fn costs_sum_per_currency_and_currencies_never_merge() {
        let snapshot = normalize_usage(
            &cost_envelope(true),
            &amount_envelope(),
            &window(),
            IsoTimestamp::now(),
        )
        .expect("snapshot");

        let cny = snapshot.metric("spend.CNY.daily.billed").expect("CNY");
        assert_eq!(cny.value.as_number(), Some(14.73));
        assert_eq!(cny.unit, "CNY");
        let usd = snapshot.metric("spend.USD.daily.billed").expect("USD");
        assert_eq!(usd.value.as_number(), Some(0.42));
    }

    #[test]
    fn tokens_sum_the_three_counters_and_requests_sum_request() {
        let snapshot = normalize_usage(
            &cost_envelope(true),
            &amount_envelope(),
            &window(),
            IsoTimestamp::now(),
        )
        .expect("snapshot");

        let tokens = snapshot.metric("activity.daily.tokens").expect("tokens");
        // (10+20+30) + (1+2+3) + (100+200+300)
        assert_eq!(tokens.value.as_number(), Some(666.0));
        assert_eq!(tokens.unit, "tokens");
        let requests = snapshot.metric("activity.daily.requests").expect("requests");
        assert_eq!(requests.value.as_number(), Some(8.0));
        assert_eq!(requests.unit, "requests");
    }

    #[test]
    fn every_metric_is_experimental_and_scoped_to_the_local_day() {
        let snapshot = normalize_usage(
            &cost_envelope(true),
            &amount_envelope(),
            &window(),
            IsoTimestamp::now(),
        )
        .expect("snapshot");

        assert_eq!(snapshot.connection, Some(web_connection()));
        assert_eq!(snapshot.source, WEB_SOURCE);
        for key in ["spend.CNY.daily.billed", "activity.daily.tokens"] {
            let metric = snapshot.metric(key).expect(key);
            assert!(metric.has_confidence(Confidence::Experimental), "{key}");
            let scope = metric.scope.as_ref().expect("scope");
            assert_eq!(scope.local_day, "2026-09-10");
            assert!(scope.range_confirmed, "{key}");
        }
    }

    #[test]
    fn an_unconfirmed_window_keeps_range_confirmed_false() {
        let snapshot = normalize_usage(
            &cost_envelope(false),
            &amount_envelope(),
            &window(),
            IsoTimestamp::now(),
        )
        .expect("snapshot");

        let spend = snapshot
            .metric("spend.CNY.daily.billed")
            .expect("the spend metric still exists");
        assert!(!spend.scope.as_ref().expect("scope").range_confirmed);
    }

    #[test]
    fn absent_counters_stay_absent_instead_of_becoming_zero() {
        let amount = json!({
            "code": 0,
            "data": { "biz_data": { "series": [ { "buckets": [
                { "time": 1, "usage": { "REQUEST": 3 } }
            ] } ] } }
        });
        let snapshot = normalize_usage(&cost_envelope(true), &amount, &window(), IsoTimestamp::now())
            .expect("snapshot");

        assert!(snapshot.metric("activity.daily.tokens").is_none());
        let requests = snapshot.metric("activity.daily.requests").expect("requests");
        assert_eq!(requests.value.as_number(), Some(3.0));
    }

    #[test]
    fn malformed_bodies_are_compatibility_failures() {
        let cases: Vec<(Value, Value)> = vec![
            // envelope without data
            (json!({ "code": 0 }), amount_envelope()),
            // data null, as answered with business errors
            (json!({ "code": 1, "msg": "boom", "data": null }), amount_envelope()),
            // cost data is not an array
            (
                json!({ "code": 0, "data": { "biz_data": { "data": {} } } }),
                amount_envelope(),
            ),
            // a cost entry without a currency
            (
                json!({ "code": 0, "data": { "biz_data": { "data": [
                    { "series": [] }
                ] } } }),
                amount_envelope(),
            ),
            // a cost entry without series
            (
                json!({ "code": 0, "data": { "biz_data": { "data": [
                    { "currency": "CNY" }
                ] } } }),
                amount_envelope(),
            ),
            // amount series without buckets
            (
                json!({ "code": 0, "data": { "biz_data": { "series": [ {} ] } } }),
                amount_envelope(),
            ),
        ];
        for (cost, amount) in cases {
            let error = normalize_usage(&cost, &amount, &window(), IsoTimestamp::now())
                .expect_err("must be incompatible");
            assert_eq!(error.kind, ErrorKind::Compatibility);
        }
    }

    #[test]
    fn a_payload_answered_without_the_biz_data_wrapper_is_still_read() {
        // The wrapper is how the console reads this endpoint, but the same object
        // without it is the same usage data: refusing it would throw away a day's
        // readings over a naming difference.
        let unwrapped = json!({
            "code": 0,
            "data": {
                "start": 1_788_969_600, "end": 1_789_056_000, "bucket": "hour", "models": [],
                "data": [ { "currency": "CNY", "series": [
                    { "api_key": "a", "model": "deepseek-flash",
                      "buckets": [ { "time": 1_788_969_600, "cost": 2.50 } ] }
                ] } ]
            }
        });
        let snapshot = normalize_usage(&unwrapped, &amount_envelope(), &window(), IsoTimestamp::now())
            .expect("snapshot");

        let spend = snapshot.metric("spend.CNY.daily.billed").expect("CNY");
        assert_eq!(spend.value.as_number(), Some(2.50));
        // The window echo rides on the payload, so it is confirmed either way.
        assert!(spend.scope.as_ref().expect("scope").range_confirmed);
    }

    #[test]
    fn an_unreadable_answer_names_the_shape_it_actually_got() {
        // A dead end for the user ("no longer provides biz_data") is not a
        // diagnosable failure. The keys of the envelope say what arrived, and a
        // field name is never a value.
        let cases = [
            (json!({ "code": 0, "data": null }), "data` is null"),
            (json!({ "code": 0, "msg": "ok" }), "data` is null or absent"),
            (
                json!({ "code": 0, "data": { "biz_data": null } }),
                "`data.biz_data` is not an object",
            ),
            (
                json!({ "code": 0, "data": { "totals": 1 } }),
                "neither `data.biz_data` nor a usage payload under `data`",
            ),
        ];
        for (cost, expected) in cases {
            let error = normalize_usage(&cost, &amount_envelope(), &window(), IsoTimestamp::now())
                .expect_err("must be incompatible");
            assert_eq!(error.kind, ErrorKind::Compatibility);
            assert!(error.message.contains(expected), "{}", error.message);
            // The envelope's own keys are named, so a changed API is diagnosable.
            assert!(error.message.contains("envelope keys:"), "{}", error.message);
        }
    }

    #[test]
    fn a_nested_authentication_code_is_an_authentication_failure() {
        // The platform API carries a second code inside `data`. A payload that came
        // back empty with one of these in it is a rejected session, not a changed
        // interface — reading it as a parse failure is what left the user with
        // "no longer provides biz_data" and no idea what to do.
        let empty_with_code = |code: Value| {
            json!({ "code": 0, "msg": "success", "data": {
                "biz_code": code, "biz_msg": "Authorization Failed (invalid token)", "biz_data": null
            } })
        };
        for code in [40002, 40003] {
            let error = normalize_usage(
                &empty_with_code(json!(code)),
                &amount_envelope(),
                &window(),
                IsoTimestamp::now(),
            )
            .expect_err("rejected session");
            assert_eq!(error.kind, ErrorKind::Authentication, "code {code}");
            assert!(error.message.contains("paste a fresh one"), "{}", error.message);
        }
    }

    #[test]
    fn another_nested_business_code_is_named_with_its_message() {
        // Not an authentication problem and not a shape problem: say which code the
        // console returned, so the answer is the console's own verdict.
        let error = normalize_usage(
            &json!({ "code": 0, "data": {
                "biz_code": 50001, "biz_msg": "usage is not available for this account", "biz_data": null
            } }),
            &amount_envelope(),
            &window(),
            IsoTimestamp::now(),
        )
        .expect_err("business error");
        assert_eq!(error.kind, ErrorKind::Compatibility);
        assert!(error.message.contains("business code 50001"), "{}", error.message);
        assert!(
            error.message.contains("usage is not available for this account"),
            "{}",
            error.message
        );
    }
}

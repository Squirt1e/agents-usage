//! GLM collector tests: the Coding Plan quota connection (task 3.4), the
//! experimental wallet connection (task 3.5) and the composed view (task 3.6).
//!
//! Every test runs against a scripted in-memory [`HttpTransport`], so no test
//! touches the network and no credential is ever real.
//!
//! The expectations come from the shared fixtures: `glm-connections.json` pins
//! the connection identities, the metric keys, the unknown-limit diagnostic and
//! the empty-activity rule, and `daily-statistics.json` pins the statistics date,
//! the local midnight and the corrected GLM activity range.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};
use usage_core::adapters::glm::quota::{MODEL_USAGE_PATH, QUOTA_LIMIT_PATH, TOOL_USAGE_PATH};
use usage_core::adapters::glm::wallet::ESTIMATOR_SOURCE;
use usage_core::adapters::glm::{
    normalize_glm_payloads, wallet_connection, GlmQuotaCollector, GlmRefreshContext, GlmView,
    GlmWalletCollector,
};
use usage_core::contracts::{
    Confidence, ConnectionId, ErrorKind, GlmRegion, IsoTimestamp, MetricDirection, ProviderId,
    ProviderSnapshot, UsageMetric,
};
use usage_core::estimate::{
    BalanceKey, BalanceObservation, BalanceStore, MemoryBalanceStore, Money, StoreError, Timezone,
};
use usage_core::fixtures::load_fixture;
use usage_core::transport::{CollectorError, HttpGet, HttpResponse, HttpTransport};

// ---------------------------------------------------------------------------
// Scripted in-memory transport
// ---------------------------------------------------------------------------

type Handler = Arc<dyn Fn(&HttpGet) -> Result<HttpResponse, CollectorError> + Send + Sync>;

/// A transport that answers from a closure and logs every request it received.
#[derive(Clone)]
struct ScriptedTransport {
    handler: Handler,
    requests: Arc<Mutex<Vec<HttpGet>>>,
}

impl fmt::Debug for ScriptedTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ScriptedTransport")
    }
}

impl ScriptedTransport {
    fn new<F>(handler: F) -> Self
    where
        F: Fn(&HttpGet) -> Result<HttpResponse, CollectorError> + Send + Sync + 'static,
    {
        Self {
            handler: Arc::new(handler),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn requests(&self) -> Vec<HttpGet> {
        self.requests
            .lock()
            .map(|requests| requests.clone())
            .unwrap_or_default()
    }
}

impl HttpTransport for ScriptedTransport {
    fn get(
        &self,
        request: HttpGet,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, CollectorError>> + Send + '_>> {
        let handler = Arc::clone(&self.handler);
        let requests = Arc::clone(&self.requests);
        Box::pin(async move {
            if let Ok(mut logged) = requests.lock() {
                logged.push(request.clone());
            }
            handler(&request)
        })
    }
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const TIMEZONE: &str = "Asia/Shanghai";
const REFRESH_INSTANT: &str = "2026-09-10T08:23:45.000Z";

fn glm_fixture() -> Value {
    load_fixture("glm-connections")
}

fn fixture_quota_payload() -> Value {
    glm_fixture()["input"]["quota"].clone()
}

fn fixture_model_payload() -> Value {
    glm_fixture()["input"]["modelUsage"].clone()
}

fn fixture_tool_payload() -> Value {
    glm_fixture()["input"]["toolUsage"].clone()
}

fn fixture_wallet_payload() -> Value {
    glm_fixture()["input"]["wallet"].clone()
}

fn empty_activity() -> Value {
    json!({ "data": [] })
}

fn parse_instant(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("test instant must be valid RFC-3339")
        .with_timezone(&Utc)
}

fn context_at(instant: &str) -> GlmRefreshContext {
    GlmRefreshContext::new(TIMEZONE, parse_instant(instant))
}

/// Responses for the three monitor paths, keyed by path.
fn monitor_transport(quota: Value, model: Value, tool: Value) -> ScriptedTransport {
    ScriptedTransport::new(move |request| {
        if request.url.contains(QUOTA_LIMIT_PATH) {
            return Ok(HttpResponse::new(200, quota.to_string()));
        }
        if request.url.contains(MODEL_USAGE_PATH) {
            return Ok(HttpResponse::new(200, model.to_string()));
        }
        if request.url.contains(TOOL_USAGE_PATH) {
            return Ok(HttpResponse::new(200, tool.to_string()));
        }
        Err(CollectorError::compatibility(
            "the test script received an unexpected request",
        ))
    })
}

fn fixture_monitor_transport() -> ScriptedTransport {
    monitor_transport(
        fixture_quota_payload(),
        fixture_model_payload(),
        fixture_tool_payload(),
    )
}

fn quota_collector(transport: &Arc<dyn HttpTransport>, credential: &str) -> GlmQuotaCollector {
    GlmQuotaCollector::new(Arc::clone(transport))
        .with_region(GlmRegion::China)
        .with_credential_value(credential)
}

fn wallet_collector(transport: &Arc<dyn HttpTransport>, endpoint: &str) -> GlmWalletCollector {
    GlmWalletCollector::new(Arc::clone(transport))
        .with_enabled_flag(true)
        .with_endpoint(endpoint)
        .with_allowed_hosts(vec!["api.z.ai".to_string()])
        .with_credential_value("wallet-key-value")
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    parsed
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn metric<'a>(snapshot: &'a ProviderSnapshot, key: &str) -> &'a UsageMetric {
    snapshot
        .metrics
        .iter()
        .find(|metric| metric.key == key)
        .unwrap_or_else(|| panic!("metric {key} is missing from the snapshot"))
}

fn number(snapshot: &ProviderSnapshot, key: &str) -> Option<f64> {
    snapshot
        .metrics
        .iter()
        .find(|metric| metric.key == key)
        .and_then(|metric| metric.value.as_number())
}

fn keys(snapshot: &ProviderSnapshot) -> Vec<String> {
    snapshot
        .metrics
        .iter()
        .map(|metric| metric.key.clone())
        .collect()
}

fn fixture_strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("fixture value must be an array")
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .expect("fixture entry must be a string")
                .to_string()
        })
        .collect()
}

/// Asia/Shanghai has no DST, so the local midnight of a day is exactly
/// `previous day T16:00:00Z`. Derived independently of the collector.
fn expected_local_midnight_utc(local_day: &str) -> String {
    let date = NaiveDate::parse_from_str(local_day, "%Y-%m-%d").expect("fixture local day");
    let previous = date.pred_opt().expect("a previous local day exists");
    format!("{previous}T16:00:00.000Z")
}

/// Balance store that fails every write, to prove a storage failure never
/// removes a reported balance and never invents a spend metric.
#[derive(Debug, Clone, Default)]
struct FailingStore;

impl BalanceStore for FailingStore {
    fn latest(&self, _key: &BalanceKey) -> Result<Option<BalanceObservation>, StoreError> {
        Err(StoreError::new("the balance store is unavailable"))
    }

    fn list_day(
        &self,
        _key: &BalanceKey,
        _local_day: &str,
    ) -> Result<Vec<BalanceObservation>, StoreError> {
        Err(StoreError::new("the balance store is unavailable"))
    }

    fn insert(&mut self, _observation: BalanceObservation) -> Result<(), StoreError> {
        Err(StoreError::new("the balance store is unavailable"))
    }

    fn save_summary(
        &mut self,
        _summary: usage_core::estimate::DailySummary,
    ) -> Result<(), StoreError> {
        Err(StoreError::new("the balance store is unavailable"))
    }
}

fn shanghai() -> Timezone {
    Timezone::parse(TIMEZONE).expect("the fixture timezone must be known")
}

fn wallet_key(currency: &str) -> BalanceKey {
    BalanceKey {
        provider: ProviderId::Glm,
        connection: wallet_connection(),
        currency: currency.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Task 3.4 — quota collection, region selection, corrected range
// ---------------------------------------------------------------------------

#[tokio::test]
async fn selects_the_region_domain_and_resolves_the_region_at_refresh_time() {
    assert_eq!(GlmRegion::China.base_domain(), "https://open.bigmodel.cn");
    assert_eq!(GlmRegion::International.base_domain(), "https://api.z.ai");

    let selected = Arc::new(AtomicU8::new(0));
    let resolver = {
        let selected = Arc::clone(&selected);
        Arc::new(move || {
            if selected.load(Ordering::SeqCst) == 0 {
                GlmRegion::China
            } else {
                GlmRegion::International
            }
        })
    };

    let transport = Arc::new(fixture_monitor_transport());
    let collector = GlmQuotaCollector::new(Arc::clone(&transport) as Arc<dyn HttpTransport>)
        .with_region_resolver(resolver)
        .with_credential_value("glm-key-value");
    let context = context_at(REFRESH_INSTANT);

    assert_eq!(GlmQuotaCollector::region(&collector), GlmRegion::China);
    collector
        .refresh(&context)
        .await
        .expect("first refresh must succeed");

    selected.store(1, Ordering::SeqCst);
    assert_eq!(collector.base_domain(), "https://api.z.ai");
    collector
        .refresh(&context)
        .await
        .expect("second refresh must succeed");

    let urls: Vec<String> = transport
        .requests()
        .iter()
        .map(|request| request.url.clone())
        .collect();
    assert_eq!(urls.len(), 6, "two cycles of three read-only GETs");
    for cycle in urls.chunks(3) {
        assert!(cycle.iter().any(|url| url.contains(MODEL_USAGE_PATH)));
        assert!(cycle.iter().any(|url| url.contains(TOOL_USAGE_PATH)));
        assert!(cycle.iter().any(|url| url.contains(QUOTA_LIMIT_PATH)));
    }
    assert!(urls[..3]
        .iter()
        .all(|url| url.starts_with("https://open.bigmodel.cn/api/monitor/usage/")));
    assert!(urls[3..]
        .iter()
        .all(|url| url.starts_with("https://api.z.ai/api/monitor/usage/")));
}

#[test]
fn quota_metrics_match_the_shared_fixture() {
    let fixture = glm_fixture();
    let context = context_at("2026-09-10T08:00:00.000Z");
    let snapshot = normalize_glm_payloads(
        &fixture["input"]["quota"],
        &fixture["input"]["modelUsage"],
        &fixture["input"]["toolUsage"],
        &context,
    )
    .expect("the fixture payload must normalize");

    // The empty activity responses produce no activity metrics at all.
    assert_eq!(
        fixture["expect"]["emptyActivityProducesNoMetric"],
        json!(true)
    );
    assert_eq!(
        keys(&snapshot),
        fixture_strings(&fixture["expect"]["quotaMetricKeys"])
    );

    assert_eq!(number(&snapshot, "quota.5h.used"), Some(28.0));
    assert_eq!(number(&snapshot, "quota.5h.remaining"), Some(72.0));
    assert_eq!(number(&snapshot, "quota.weekly.used"), Some(16.0));
    assert_eq!(number(&snapshot, "quota.weekly.remaining"), Some(84.0));
    assert_eq!(number(&snapshot, "quota.tools.monthly.used"), Some(20.0));
    assert_eq!(
        number(&snapshot, "quota.tools.monthly.remaining"),
        Some(80.0)
    );

    // `nextResetTime` is unix milliseconds.
    let five_hour = metric(&snapshot, "quota.5h.used");
    assert_eq!(
        five_hour.reset_at.as_ref().map(IsoTimestamp::as_str),
        Some(IsoTimestamp::from_unix_millis(1_789_000_000_000).as_str())
    );
    assert_eq!(five_hour.window_seconds, Some(18_000));
    assert_eq!(five_hour.unit, "percent");
    assert_eq!(five_hour.direction, MetricDirection::Used);
    assert_eq!(five_hour.source, "glm-monitor");
    assert_eq!(
        five_hour
            .connection
            .as_ref()
            .map(|connection| connection.key()),
        Some("glm:quota".to_string())
    );
    assert_eq!(
        five_hour
            .details
            .as_ref()
            .and_then(|details| details.get("type")),
        Some(&json!("TOKENS_LIMIT"))
    );
    assert_eq!(
        five_hour
            .details
            .as_ref()
            .and_then(|details| details.get("currentValue")),
        Some(&json!(28_000.0))
    );
    assert_eq!(
        five_hour
            .details
            .as_ref()
            .and_then(|details| details.get("limit")),
        Some(&json!(100_000.0))
    );

    // Window lengths come from `windowDuration`; the fallbacks stay scoped.
    assert_eq!(
        metric(&snapshot, "quota.weekly.used").window_seconds,
        Some(604_800)
    );
    assert_eq!(
        metric(&snapshot, "quota.tools.monthly.used").window_seconds,
        Some(30 * 86_400)
    );
    assert!(metric(&snapshot, "quota.tools.monthly.used")
        .reset_at
        .is_some());

    // `TIME_LIMIT` is the monthly tool quota, never a weekly window.
    assert_eq!(fixture["expect"]["timeLimitIsNotWeekly"], json!(true));
    assert_eq!(
        metric(&snapshot, "quota.tools.monthly.used")
            .details
            .as_ref()
            .and_then(|details| details.get("type")),
        Some(&json!("TIME_LIMIT"))
    );
    assert_eq!(
        metric(&snapshot, "quota.weekly.used")
            .details
            .as_ref()
            .and_then(|details| details.get("type")),
        Some(&json!("WEEKLY_LIMIT"))
    );

    // The unknown entry is a diagnostic only.
    let unknown = fixture["expect"]["unknownLimitIsDiagnosticOnly"]
        .as_str()
        .expect("unknown limit name");
    assert_eq!(
        fixture["expect"]["unknownLimitIsDiagnosticOnly"],
        json!("FUTURE_LIMIT")
    );
    let diagnostic = snapshot
        .diagnostic
        .as_ref()
        .and_then(|diagnostic| diagnostic.get("unknownLimits"))
        .and_then(Value::as_array)
        .expect("unknownLimits diagnostic");
    assert_eq!(diagnostic.len(), 1);
    assert_eq!(diagnostic[0]["type"], json!(unknown));
    assert!(!keys(&snapshot).iter().any(|key| key.contains(unknown)));

    assert_eq!(snapshot.provider, usage_core::contracts::ProviderId::Glm);
    assert_eq!(
        snapshot.status,
        usage_core::contracts::ConnectionStatus::Connected
    );
    assert_eq!(
        snapshot
            .connection
            .as_ref()
            .map(|connection| connection.key()),
        Some("glm:quota".to_string())
    );
    assert_eq!(
        snapshot.last_success_at,
        Some(IsoTimestamp::from_datetime(context.now))
    );
}

#[test]
fn token_and_credit_limits_use_provider_window_units() {
    let quota = json!({ "data": { "limits": [
        { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 17, "nextResetTime": 1_789_000_000_000_i64 },
        { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 43, "nextResetTime": 1_789_600_000_000_i64 }
    ] } });
    let snapshot = normalize_glm_payloads(
        &quota,
        &empty_activity(),
        &empty_activity(),
        &context_at("2026-09-10T08:00:00.000Z"),
    )
    .expect("provider windows normalize");

    assert_eq!(number(&snapshot, "quota.5h.used"), Some(17.0));
    assert_eq!(number(&snapshot, "quota.weekly.used"), Some(43.0));
    assert_eq!(number(&snapshot, "quota.weekly.remaining"), Some(57.0));
    assert_eq!(
        metric(&snapshot, "quota.weekly.used").window_seconds,
        Some(604_800)
    );
    assert_eq!(
        keys(&snapshot)
            .iter()
            .filter(|key| *key == "quota.5h.used")
            .count(),
        1
    );

    let credit_only = json!({ "data": { "limits": [
        { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "percentage": 20 },
        { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "percentage": 62 }
    ] } });
    let snapshot = normalize_glm_payloads(
        &credit_only,
        &empty_activity(),
        &empty_activity(),
        &context_at("2026-09-10T08:00:00.000Z"),
    )
    .expect("credit windows normalize");
    assert_eq!(number(&snapshot, "quota.5h.used"), Some(20.0));
    assert_eq!(number(&snapshot, "quota.weekly.used"), Some(62.0));
}

#[test]
fn unknown_limit_entries_are_redacted_and_never_leak_a_token() {
    let context = context_at("2026-09-10T08:00:00.000Z");
    let quota = json!({
        "success": true,
        "data": {
            "limits": [
                { "type": "TOKENS_LIMIT", "percentage": 18, "windowDuration": "5h", "nextResetTime": 1_789_000_000_000_i64 },
                { "type": "NEW_UNKNOWN_LIMIT", "percentage": 9, "privateToken": "must-not-leak" }
            ]
        }
    });

    let snapshot = normalize_glm_payloads(&quota, &empty_activity(), &empty_activity(), &context)
        .expect("the recognized entry must keep the snapshot usable");

    let encoded = serde_json::to_string(&snapshot).expect("snapshot must serialize");
    assert!(
        !encoded.contains("must-not-leak"),
        "the raw token leaked into the snapshot"
    );
    assert!(
        encoded.contains("NEW_UNKNOWN_LIMIT"),
        "the redacted entry stays diagnosable"
    );
    assert_eq!(
        keys(&snapshot).len(),
        2,
        "an unknown entry produces no metric"
    );
    assert_eq!(
        snapshot
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.get("unknownLimits"))
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(|entry| entry.get("privateToken")),
        Some(&json!("[REDACTED]"))
    );

    // When nothing is recognized the refresh is a compatibility failure, and
    // neither the message nor the diagnostic may carry the raw token.
    let only_unknown = json!({
        "data": { "limits": [ { "type": "FUTURE_LIMIT", "percentage": 3, "sessionToken": "must-not-leak" } ] }
    });
    let error = normalize_glm_payloads(
        &only_unknown,
        &empty_activity(),
        &empty_activity(),
        &context,
    )
    .expect_err("no recognized entries must fail");
    assert_eq!(error.kind, ErrorKind::Compatibility);
    let rendered = format!("{error:?}");
    assert!(
        !rendered.contains("must-not-leak"),
        "the raw token leaked into the error"
    );
    let diagnostic = error
        .diagnostic
        .get("unknownLimits")
        .cloned()
        .unwrap_or_default();
    assert!(diagnostic.contains("FUTURE_LIMIT"));
    assert!(!diagnostic.contains("must-not-leak"));
}

#[test]
fn activity_metrics_appear_only_for_real_activity_entries() {
    let context = context_at("2026-09-10T08:00:00.000Z");
    let quota = fixture_quota_payload();

    let empty = normalize_glm_payloads(&quota, &empty_activity(), &empty_activity(), &context)
        .expect("empty activity must still produce the quota metrics");
    assert!(!keys(&empty).iter().any(|key| key.starts_with("model.")));
    assert!(!keys(&empty).iter().any(|key| key.starts_with("tool.")));

    // A response that is not an array produces nothing, and a usable zero stays
    // a real zero instead of becoming absent.
    let activity = normalize_glm_payloads(
        &quota,
        &json!({ "data": [
            { "model": "glm-5", "tokens": 1200 },
            { "model": "glm-zero", "tokens": 0 },
            { "model": "glm-text", "tokens": "1200" },
            { "tokens": 5 }
        ] }),
        &json!({ "data": {} }),
        &context,
    )
    .expect("activity must normalize");

    assert_eq!(number(&activity, "model.glm-5.tokens"), Some(1200.0));
    assert_eq!(number(&activity, "model.glm-zero.tokens"), Some(0.0));
    assert_eq!(
        activity
            .metrics
            .iter()
            .find(|m| m.key == "model.glm-zero.tokens")
            .map(|m| m.is_missing()),
        Some(false)
    );
    assert!(!keys(&activity).iter().any(|key| key.contains("glm-text")));
    assert!(!keys(&activity).iter().any(|key| key.starts_with("tool.")));

    let tools = normalize_glm_payloads(
        &quota,
        &empty_activity(),
        &json!({ "data": [
            { "tool": "web-search", "count": 4 },
            { "tool": "web-reader", "usage": 2 }
        ] }),
        &context,
    )
    .expect("tool activity must normalize");
    assert_eq!(number(&tools, "tool.web-search.count"), Some(4.0));
    assert_eq!(number(&tools, "tool.web-reader.count"), Some(2.0));
    assert_eq!(metric(&tools, "tool.web-search.count").unit, "calls");
    assert_eq!(
        metric(&tools, "tool.web-search.count").direction,
        MetricDirection::Activity
    );
}

#[tokio::test]
async fn activity_query_covers_local_midnight_to_now() {
    let transport = Arc::new(fixture_monitor_transport());
    let collector = quota_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "glm-key-value",
    );
    let context = context_at(REFRESH_INSTANT);

    collector
        .refresh(&context)
        .await
        .expect("refresh must succeed");

    let requests = transport.requests();
    let activity: Vec<&HttpGet> = requests
        .iter()
        .filter(|request| !request.url.contains(QUOTA_LIMIT_PATH))
        .collect();
    assert_eq!(activity.len(), 2);
    for request in activity {
        assert_eq!(
            query_param(&request.url, "startTime").as_deref(),
            Some("2026-09-10 00:00:00"),
            "the range must start at the statistics date's local midnight"
        );
        assert_eq!(
            query_param(&request.url, "endTime").as_deref(),
            Some("2026-09-10 16:23:45"),
            "the range must end at the current instant in the configured timezone"
        );
    }

    // The quota window endpoint is not a statistics query.
    let quota_request = requests
        .iter()
        .find(|request| request.url.contains(QUOTA_LIMIT_PATH))
        .expect("the quota request must have been sent");
    assert!(!quota_request.url.contains("startTime"));

    let range = context.range().expect("range must resolve");
    assert_eq!(range.local_day.to_string(), "2026-09-10");
    assert_eq!(range.timezone, TIMEZONE);
    assert_eq!(range.start.as_str(), "2026-09-09T16:00:00.000Z");
    assert_eq!(range.end.as_str(), REFRESH_INSTANT);

    // A rolling ~24 hour window is exactly what task 3.4 removed.
    let span = range.end.to_datetime() - range.start.to_datetime();
    assert!(
        span < chrono::Duration::hours(24),
        "the range must not be a rolling 24 hours"
    );
    assert_eq!(
        span,
        chrono::Duration::minutes(16 * 60 + 23) + chrono::Duration::seconds(45)
    );
}

#[test]
fn local_day_and_range_follow_the_configured_timezone_across_midnight() {
    let fixture = load_fixture("daily-statistics");
    let timezone = fixture["timezone"].as_str().expect("fixture timezone");
    assert_eq!(timezone, "Asia/Shanghai");

    // The documented local midnight of 2026-09-10 in this timezone.
    let midnight_case = &fixture["localMidnightUtc"];
    let documented_day = midnight_case["localDay"].as_str().expect("localDay");
    assert_eq!(
        expected_local_midnight_utc(documented_day),
        midnight_case["expect"].as_str().expect("expected midnight")
    );

    for case in fixture["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("case name");
        let instant = case["instant"].as_str().expect("case instant");
        let expected_day = case["expect"]["localDay"].as_str().expect("case localDay");
        let context = GlmRefreshContext::new(timezone, parse_instant(instant));
        let range = context.range().expect("range must resolve");

        assert_eq!(range.local_day.to_string(), expected_day, "case {name}");
        assert_eq!(
            range.start_local,
            format!("{expected_day} 00:00:00"),
            "case {name}"
        );
        assert_eq!(
            range.start.as_str(),
            expected_local_midnight_utc(expected_day),
            "case {name}"
        );
        assert!(
            range.end.to_datetime() >= range.start.to_datetime(),
            "case {name}"
        );
    }

    // Cross-midnight: the same local day just before midnight…
    let before = GlmRefreshContext::new(timezone, parse_instant("2026-09-10T15:59:00.000Z"))
        .range()
        .expect("range must resolve");
    assert_eq!(before.local_day.to_string(), "2026-09-10");
    assert_eq!(before.start_local, "2026-09-10 00:00:00");
    assert_eq!(before.end_local, "2026-09-10 23:59:00");
    assert_eq!(before.start.as_str(), "2026-09-09T16:00:00.000Z");
    assert_ne!(before.start_local, "2026-09-09 23:59:00");

    // …and the new local day two minutes later.
    let after = GlmRefreshContext::new(timezone, parse_instant("2026-09-10T16:01:00.000Z"))
        .range()
        .expect("range must resolve");
    assert_eq!(after.local_day.to_string(), "2026-09-11");
    assert_eq!(after.start_local, "2026-09-11 00:00:00");
    assert_eq!(after.end_local, "2026-09-11 00:01:00");
    assert_eq!(after.start.as_str(), "2026-09-10T16:00:00.000Z");

    // A configured statistics date wins over the local day of `now`.
    let explicit = GlmRefreshContext::new(timezone, parse_instant(REFRESH_INSTANT))
        .with_statistics_date(NaiveDate::from_ymd_opt(2026, 9, 11).expect("valid date"));
    let range = explicit.range().expect("range must resolve");
    assert_eq!(range.local_day.to_string(), "2026-09-11");
    assert_eq!(range.start_local, "2026-09-11 00:00:00");

    // An unknown timezone is a configuration problem, not a guessed UTC day.
    let error = GlmRefreshContext::new("Mars/Olympus", parse_instant(REFRESH_INSTANT))
        .range()
        .expect_err("an unknown timezone must fail");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
}

#[test]
fn activity_range_is_only_confirmed_when_the_source_echoes_it() {
    let quota = fixture_quota_payload();
    let context = context_at(REFRESH_INSTANT);

    let plain = normalize_glm_payloads(
        &quota,
        &json!({ "data": [{ "model": "glm-5", "tokens": 1200 }] }),
        &empty_activity(),
        &context,
    )
    .expect("activity must normalize");
    let scope = metric(&plain, "model.glm-5.tokens")
        .scope
        .clone()
        .expect("activity metrics carry a scope");
    assert_eq!(scope.local_day, "2026-09-10");
    assert_eq!(scope.timezone, TIMEZONE);
    assert!(
        !scope.range_confirmed,
        "a plain data array confirms nothing"
    );
    assert_eq!(
        scope.range_start.as_ref().map(IsoTimestamp::as_str),
        Some("2026-09-09T16:00:00.000Z")
    );
    assert_eq!(
        scope.range_end.as_ref().map(IsoTimestamp::as_str),
        Some(REFRESH_INSTANT)
    );

    // A response that echoes the queried range confirms it.
    let echoed = normalize_glm_payloads(
        &quota,
        &json!({
            "startTime": "2026-09-10 00:00:00",
            "endTime": "2026-09-10 16:23:45",
            "data": [{ "model": "glm-5", "tokens": 1200 }]
        }),
        &json!({
            "range": { "startTime": "2026-09-10 00:00:00", "endTime": "2026-09-10 16:23:45" },
            "data": [{ "tool": "web-search", "count": 4 }]
        }),
        &context,
    )
    .expect("activity must normalize");
    assert_eq!(
        metric(&echoed, "model.glm-5.tokens")
            .scope
            .as_ref()
            .map(|scope| scope.range_confirmed),
        Some(true)
    );
    assert_eq!(
        metric(&echoed, "tool.web-search.count")
            .scope
            .as_ref()
            .map(|scope| scope.range_confirmed),
        Some(true)
    );

    // A response that covers a different range is not today's data.
    let other_range = normalize_glm_payloads(
        &quota,
        &json!({
            "startTime": "2026-09-09 00:00:00",
            "endTime": "2026-09-09 23:59:59",
            "data": [{ "model": "glm-5", "tokens": 1200 }]
        }),
        &empty_activity(),
        &context,
    )
    .expect("activity must normalize");
    assert_eq!(
        metric(&other_range, "model.glm-5.tokens")
            .scope
            .as_ref()
            .map(|scope| scope.range_confirmed),
        Some(false)
    );
}

#[tokio::test]
async fn quota_failures_use_the_shared_error_vocabulary() {
    // No credential: nothing is requested at all.
    let transport = Arc::new(fixture_monitor_transport());
    let collector = GlmQuotaCollector::new(Arc::clone(&transport) as Arc<dyn HttpTransport>)
        .with_region(GlmRegion::China);
    let error = collector
        .refresh(&context_at(REFRESH_INSTANT))
        .await
        .expect_err("a missing credential must fail");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert!(transport.requests().is_empty());

    // HTTP status classification.
    for (status, kind) in [
        (401_u16, ErrorKind::Authentication),
        (403, ErrorKind::Authentication),
        (429, ErrorKind::RateLimit),
        (500, ErrorKind::Network),
        (302, ErrorKind::Network),
    ] {
        let transport = Arc::new(ScriptedTransport::new(move |_request| {
            Ok(HttpResponse::new(status, "{}"))
        }));
        let collector = quota_collector(
            &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
            "glm-key-value",
        );
        let error = collector
            .refresh(&context_at(REFRESH_INSTANT))
            .await
            .expect_err("a non-success status must fail");
        assert_eq!(error.kind, kind, "status {status}");
    }

    // A body that is not JSON.
    let transport = Arc::new(ScriptedTransport::new(|_request| {
        Ok(HttpResponse::new(200, "<html>gateway</html>"))
    }));
    let error = quota_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "glm-key-value",
    )
    .refresh(&context_at(REFRESH_INSTANT))
    .await
    .expect_err("invalid JSON must fail");
    assert_eq!(error.kind, ErrorKind::Compatibility);

    // A quota payload without a limits array.
    let transport = Arc::new(monitor_transport(
        json!({ "data": { "changed": true } }),
        empty_activity(),
        empty_activity(),
    ));
    let error = quota_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "glm-key-value",
    )
    .refresh(&context_at(REFRESH_INSTANT))
    .await
    .expect_err("a schema change must fail");
    assert_eq!(error.kind, ErrorKind::Compatibility);

    // A recognized entry without a percentage cannot be rendered as a number.
    let transport = Arc::new(monitor_transport(
        json!({ "data": { "limits": [{ "type": "TOKENS_LIMIT", "windowDuration": "5h" }] } }),
        empty_activity(),
        empty_activity(),
    ));
    let error = quota_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "glm-key-value",
    )
    .refresh(&context_at(REFRESH_INSTANT))
    .await
    .expect_err("a missing percentage must fail");
    assert_eq!(error.kind, ErrorKind::Compatibility);
}

#[tokio::test]
async fn coding_plan_business_rejections_are_classified_like_the_legacy_regex() {
    let business_rejection = |message: &str| {
        let message = message.to_string();
        Arc::new(ScriptedTransport::new(move |_request| {
            Ok(HttpResponse::new(
                200,
                json!({ "code": 500, "msg": message, "success": false }).to_string(),
            ))
        }))
    };

    let transport = business_rejection("当前用户不存在coding plan");
    let error = quota_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "glm-key-value",
    )
    .refresh(&context_at(REFRESH_INSTANT))
    .await
    .expect_err("a business rejection must fail");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert_eq!(error.message, "GLM: 当前用户不存在coding plan");
    assert!(
        transport.requests().len() == 3,
        "the rejection is classified after the request"
    );

    for message in ["套餐未开通", "该账号不存在", "Coding Plan is required"] {
        let transport = business_rejection(message);
        let error = quota_collector(
            &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
            "glm-key-value",
        )
        .refresh(&context_at(REFRESH_INSTANT))
        .await
        .expect_err("a business rejection must fail");
        assert_eq!(error.kind, ErrorKind::MissingConfig, "message {message}");
    }

    let transport = business_rejection("invalid api key");
    let error = quota_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "glm-key-value",
    )
    .refresh(&context_at(REFRESH_INSTANT))
    .await
    .expect_err("a rejected key must fail");
    assert_eq!(error.kind, ErrorKind::Authentication);
    assert_eq!(
        error.diagnostic.get("code").map(String::as_str),
        Some("500")
    );
}

// ---------------------------------------------------------------------------
// Task 3.5 — the experimental wallet connection
// ---------------------------------------------------------------------------

fn wallet_response(payload: Value) -> Arc<ScriptedTransport> {
    Arc::new(ScriptedTransport::new(move |_request| {
        Ok(HttpResponse::new(200, payload.to_string()))
    }))
}

#[tokio::test]
async fn the_wallet_runs_only_when_enabled_and_configured() {
    let transport = wallet_response(fixture_wallet_payload());

    // Disabled: no request, no credential lookup.
    let disabled = GlmWalletCollector::new(Arc::clone(&transport) as Arc<dyn HttpTransport>)
        .with_endpoint("https://api.z.ai/experimental/wallet/balance")
        .with_allowed_hosts(vec!["api.z.ai".to_string()])
        .with_credential_value("wallet-key-value");
    let error = disabled
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect_err("a disabled wallet must not collect");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert!(transport.requests().is_empty());

    // Enabled but without a credential.
    let no_credential = GlmWalletCollector::new(Arc::clone(&transport) as Arc<dyn HttpTransport>)
        .with_enabled_flag(true)
        .with_endpoint("https://api.z.ai/experimental/wallet/balance")
        .with_allowed_hosts(vec!["api.z.ai".to_string()]);
    let error = no_credential
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect_err("a wallet without a credential must not collect");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert!(transport.requests().is_empty());

    // Enabled, credentialed, but with no endpoint configured.
    let no_endpoint = GlmWalletCollector::new(Arc::clone(&transport) as Arc<dyn HttpTransport>)
        .with_enabled_flag(true)
        .with_allowed_hosts(vec!["api.z.ai".to_string()])
        .with_credential_value("wallet-key-value");
    let error = no_endpoint
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect_err("a wallet without an endpoint must not collect");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert!(transport.requests().is_empty());
}

#[tokio::test]
async fn the_wallet_refuses_a_non_https_or_unlisted_endpoint_before_sending_anything() {
    let transport = wallet_response(fixture_wallet_payload());

    for endpoint in [
        "http://api.z.ai/experimental/wallet/balance",
        "ftp://api.z.ai/experimental/wallet/balance",
    ] {
        let collector = wallet_collector(
            &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
            endpoint,
        );
        let error = collector
            .refresh(parse_instant(REFRESH_INSTANT))
            .await
            .expect_err("a non-HTTPS endpoint must be refused");
        assert_eq!(error.kind, ErrorKind::MissingConfig, "endpoint {endpoint}");
    }

    for endpoint in [
        "https://evil.example/balance",
        "https://api.z.ai.evil.example/balance",
        // A userinfo host would send the credential to `evil.example`.
        "https://user:secret@evil.example/balance",
    ] {
        let collector = wallet_collector(
            &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
            endpoint,
        );
        let error = collector
            .refresh(parse_instant(REFRESH_INSTANT))
            .await
            .expect_err("an endpoint outside the allow-list must be refused");
        assert_eq!(error.kind, ErrorKind::MissingConfig, "endpoint {endpoint}");
    }

    // An allow-list is required: an empty list refuses every host.
    let no_allow_list = GlmWalletCollector::new(Arc::clone(&transport) as Arc<dyn HttpTransport>)
        .with_enabled_flag(true)
        .with_endpoint("https://api.z.ai/experimental/wallet/balance")
        .with_credential_value("wallet-key-value");
    assert_eq!(
        no_allow_list
            .refresh(parse_instant(REFRESH_INSTANT))
            .await
            .expect_err("an empty allow-list must refuse the endpoint")
            .kind,
        ErrorKind::MissingConfig
    );

    // Nothing was ever sent, so the credential was never offered to any host.
    assert!(transport.requests().is_empty());
}

#[tokio::test]
async fn a_successful_wallet_read_produces_the_experimental_balance_metric() {
    let fixture = glm_fixture();
    let transport = wallet_response(fixture["input"]["wallet"].clone());
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    );
    let snapshot = collector
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect("the fixture wallet payload must normalize");

    assert_eq!(
        fixture["expect"]["walletMetricKeys"],
        json!(["wallet.CNY.balance"])
    );
    assert_eq!(keys(&snapshot), vec!["wallet.CNY.balance".to_string()]);
    let balance = metric(&snapshot, "wallet.CNY.balance");
    assert_eq!(
        balance.value,
        usage_core::contracts::MetricValue::Number(42.6)
    );
    assert_eq!(balance.unit, fixture["expect"]["walletCurrency"]);
    assert_eq!(balance.direction, MetricDirection::Balance);
    assert_eq!(balance.confidence, vec![Confidence::Experimental]);
    assert_eq!(fixture["expect"]["walletConfidence"], json!("experimental"));
    assert_eq!(fixture["expect"]["walletDirection"], json!("balance"));
    assert_eq!(balance.source, "glm-wallet-experimental");
    assert_eq!(
        balance
            .connection
            .as_ref()
            .map(|connection| connection.key()),
        Some("glm:wallet".to_string())
    );
    assert!(snapshot.error.is_none());
    assert_eq!(
        snapshot.status,
        usage_core::contracts::ConnectionStatus::Connected
    );
    assert_eq!(
        snapshot.last_success_at,
        Some(IsoTimestamp::parse(REFRESH_INSTANT).expect("instant"))
    );

    // Without an estimator attached the spend metric stays absent instead of
    // being invented.
    assert!(!keys(&snapshot).iter().any(|key| key.starts_with("spend.")));
    assert!(snapshot.diagnostic.is_none());
    assert_eq!(
        collector.current_estimate("CNY").expect("no estimator"),
        None
    );

    // The credential went to the configured host only, as the sole header.
    let requests = transport.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].url,
        "https://api.z.ai/experimental/wallet/balance"
    );
    assert_eq!(requests[0].headers.len(), 1);
    assert_eq!(
        requests[0].headers.get("Authorization").map(String::as_str),
        Some("wallet-key-value")
    );
}

#[tokio::test]
async fn a_wallet_schema_change_is_incompatible_and_never_fabricates_a_balance() {
    let cases = [
        json!({ "data": { "amount": "42.6" } }),
        json!({ "data": { "balance": "not a number", "currency": "CNY" } }),
        json!({ "data": { "balance": 42.6 } }),
        json!({ "data": { "balance": 42.6, "currency": "" } }),
        json!({ "data": { "balance": 42.6, "currency": 7 } }),
        json!({ "data": [] }),
        json!({ "data": null }),
    ];

    for payload in cases {
        let transport = wallet_response(payload.clone());
        let collector = wallet_collector(
            &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
            "https://api.z.ai/experimental/wallet/balance",
        );
        let store = MemoryBalanceStore::new();
        let collector = collector.with_balance_store(store.clone(), shanghai());
        let error = collector
            .refresh(parse_instant(REFRESH_INSTANT))
            .await
            .expect_err("a schema change must be incompatible");
        assert_eq!(error.kind, ErrorKind::Compatibility, "payload {payload}");
        assert!(
            store.observations().is_empty(),
            "no sample is stored for a rejected payload"
        );
    }

    // A business rejection on the wallet endpoint follows the same vocabulary.
    let transport =
        wallet_response(json!({ "success": false, "msg": "invalid token", "code": 401 }));
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    );
    let error = collector
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect_err("a rejected wallet credential must fail");
    assert_eq!(error.kind, ErrorKind::Authentication);

    // A numeric string is an unambiguous amount and is accepted.
    let transport = wallet_response(json!({ "data": { "balance": "88.5", "currency": "USD" } }));
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    );
    let snapshot = collector
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect("a numeric string amount is usable");
    assert_eq!(number(&snapshot, "wallet.USD.balance"), Some(88.5));

    // A reliable zero is a real observation, not a missing value.
    let transport = wallet_response(json!({ "data": { "balance": 0, "currency": "CNY" } }));
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    );
    let snapshot = collector
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect("a zero balance is usable");
    let zero = metric(&snapshot, "wallet.CNY.balance");
    assert_eq!(zero.value, usage_core::contracts::MetricValue::Number(0.0));
    assert!(!zero.is_missing());
    assert!(!zero.has_confidence(Confidence::Unavailable));
}

#[tokio::test]
async fn a_redirect_is_never_treated_as_a_successful_wallet_read() {
    // The shared transport refuses cross-origin redirects; a scripted transport
    // that hands the response back anyway must not turn it into data.
    let transport = Arc::new(ScriptedTransport::new(|_request| {
        Ok(HttpResponse {
            status: 302,
            final_url: Some("https://evil.example/balance".to_string()),
            body: json!({ "data": { "balance": 42.6, "currency": "CNY" } }).to_string(),
            retry_after_seconds: None,
        })
    }));
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    );
    let store = MemoryBalanceStore::new();
    let collector = collector.with_balance_store(store.clone(), shanghai());
    let error = collector
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect_err("a redirect response is not success");
    assert_eq!(error.kind, ErrorKind::Network);
    assert!(store.observations().is_empty());

    // Same for a 200 whose transport reports a cross-origin final URL.
    let transport = Arc::new(ScriptedTransport::new(|_request| {
        Ok(HttpResponse {
            status: 200,
            final_url: Some("https://evil.example/balance".to_string()),
            body: json!({ "data": { "balance": 42.6, "currency": "CNY" } }).to_string(),
            retry_after_seconds: None,
        })
    }));
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    );
    let error = collector
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect_err("a response from another origin is refused");
    assert_eq!(error.kind, ErrorKind::Network);

    // A same-origin redirect target is acceptable.
    let transport = Arc::new(ScriptedTransport::new(|_request| {
        Ok(HttpResponse {
            status: 200,
            final_url: Some("https://api.z.ai/experimental/wallet/balance".to_string()),
            body: json!({ "data": { "balance": 42.6, "currency": "CNY" } }).to_string(),
            retry_after_seconds: None,
        })
    }));
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    );
    assert!(collector
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .is_ok());
}

// ---------------------------------------------------------------------------
// Task 3.6 — composition and the daily spend estimator input
// ---------------------------------------------------------------------------

/// A transport whose behaviour can change between refresh cycles.
///
/// Mode 0: quota healthy, wallet healthy.
/// Mode 1: quota fails with HTTP 500.
/// Mode 2: wallet answers with an incompatible schema.
fn two_cycle_transport(mode: Arc<AtomicU8>) -> Arc<ScriptedTransport> {
    let quota = fixture_quota_payload();
    let wallet = fixture_wallet_payload();
    Arc::new(ScriptedTransport::new(move |request| {
        let mode = mode.load(Ordering::SeqCst);
        if request.url.contains("/api/monitor/usage/") {
            if mode == 1 {
                return Ok(HttpResponse::new(500, "{}"));
            }
            if request.url.contains(QUOTA_LIMIT_PATH) {
                return Ok(HttpResponse::new(200, quota.to_string()));
            }
            return Ok(HttpResponse::new(200, empty_activity().to_string()));
        }
        if mode == 2 {
            return Ok(HttpResponse::new(
                200,
                json!({ "data": { "amount": "42.6" } }).to_string(),
            ));
        }
        Ok(HttpResponse::new(200, wallet.to_string()))
    }))
}

fn two_cycle_collectors(
    transport: &Arc<ScriptedTransport>,
) -> (GlmQuotaCollector, GlmWalletCollector) {
    let shared = Arc::clone(transport) as Arc<dyn HttpTransport>;
    (
        quota_collector(&shared, "quota-key-value"),
        wallet_collector(&shared, "https://api.z.ai/experimental/wallet/balance"),
    )
}

#[tokio::test]
async fn a_quota_failure_keeps_a_healthy_wallet() {
    let mode = Arc::new(AtomicU8::new(0));
    let transport = two_cycle_transport(Arc::clone(&mode));
    let (quota, wallet) = two_cycle_collectors(&transport);
    let context = context_at(REFRESH_INSTANT);
    let mut view = GlmView::new();

    let healthy = view.refresh(&quota, &wallet, &context).await;
    assert!(healthy.quota_ok && healthy.wallet_ok);
    let quota_last_success = view.quota.last_success_at.clone();
    let wallet_last_success = view.wallet.last_success_at.clone();

    // The quota connection now fails; the wallet is untouched.
    mode.store(1, Ordering::SeqCst);
    let later = parse_instant("2026-09-10T09:23:45.000Z");
    let broken = view
        .refresh(&quota, &wallet, &GlmRefreshContext::new(TIMEZONE, later))
        .await;

    assert!(!broken.quota_ok);
    assert!(broken.wallet_ok, "a quota failure must not fail the wallet");
    assert_eq!(
        view.quota.error.as_ref().map(|error| error.kind),
        Some(ErrorKind::Network)
    );
    assert_eq!(
        number(
            &view.wallet.snapshot.clone().expect("wallet snapshot"),
            "wallet.CNY.balance"
        ),
        Some(42.6)
    );
    assert!(view.wallet.error.is_none());
    assert_eq!(
        view.wallet
            .metrics()
            .iter()
            .find(|metric| metric.key == "wallet.CNY.balance")
            .map(|metric| metric.has_confidence(Confidence::Stale)),
        Some(false),
        "the wallet is not staled by a quota failure"
    );

    // The quota connection keeps its last successful snapshot and capture time,
    // and only its own view reports the failure.
    assert_eq!(
        number(
            &view.quota.snapshot.clone().expect("cached quota snapshot"),
            "quota.5h.used"
        ),
        Some(28.0)
    );
    assert_eq!(view.quota.last_success_at, quota_last_success);
    assert_ne!(
        view.quota.last_success_at,
        Some(IsoTimestamp::from_datetime(later))
    );
    // The wallet refreshed successfully in the same cycle, so its own success
    // time is the newer one: the two connections do not share a health record.
    assert_ne!(view.wallet.last_success_at, wallet_last_success);
    assert_eq!(
        view.wallet.last_success_at,
        Some(IsoTimestamp::from_datetime(later))
    );
    let displayed = view
        .quota
        .display_snapshot()
        .expect("cached quota snapshot");
    assert_eq!(
        displayed.status,
        usage_core::contracts::ConnectionStatus::Degraded
    );
    assert!(metric(&displayed, "quota.5h.used").has_confidence(Confidence::Stale));
    assert!(view
        .display_snapshots()
        .iter()
        .any(|snapshot| snapshot.source == "glm-wallet-experimental"
            && snapshot.status == usage_core::contracts::ConnectionStatus::Connected));

    assert_eq!(view.connections().len(), 2);
    assert!(view.has_data());
}

#[tokio::test]
async fn a_wallet_failure_keeps_a_healthy_quota_and_the_previous_balance() {
    let mode = Arc::new(AtomicU8::new(0));
    let transport = two_cycle_transport(Arc::clone(&mode));
    let (quota, wallet) = two_cycle_collectors(&transport);
    let context = context_at(REFRESH_INSTANT);
    let mut view = GlmView::new();

    let healthy = view.refresh(&quota, &wallet, &context).await;
    assert!(healthy.quota_ok && healthy.wallet_ok);
    let wallet_last_success = view.wallet.last_success_at.clone();
    let quota_last_success = view.quota.last_success_at.clone();
    assert!(wallet_last_success.is_some() && quota_last_success.is_some());

    // The wallet schema changes on the next cycle.
    mode.store(2, Ordering::SeqCst);
    let later = parse_instant("2026-09-10T09:23:45.000Z");
    let broken = view
        .refresh(&quota, &wallet, &GlmRefreshContext::new(TIMEZONE, later))
        .await;

    assert!(broken.quota_ok, "a wallet failure must not fail the quota");
    assert!(!broken.wallet_ok);
    assert_eq!(
        view.wallet.error.as_ref().map(|error| error.kind),
        Some(ErrorKind::Compatibility)
    );

    // The previous wallet balance is retained and rendered as stale.
    assert_eq!(
        number(
            &view.wallet.snapshot.clone().expect("wallet snapshot"),
            "wallet.CNY.balance"
        ),
        Some(42.6)
    );
    assert_eq!(view.wallet.last_success_at, wallet_last_success);
    let displayed = view
        .wallet
        .display_snapshot()
        .expect("cached wallet snapshot");
    assert_eq!(
        displayed.status,
        usage_core::contracts::ConnectionStatus::Degraded
    );
    assert!(metric(&displayed, "wallet.CNY.balance").has_confidence(Confidence::Stale));

    // The quota connection refreshed normally and kept its own success time.
    assert!(view.quota.error.is_none());
    assert!(view.quota.last_success_at.is_some());
    assert!(
        number(
            &view.quota.snapshot.clone().expect("quota snapshot"),
            "quota.5h.used"
        ) == Some(28.0)
    );
    assert_eq!(
        view.quota.last_success_at,
        Some(IsoTimestamp::from_datetime(later))
    );
}

#[tokio::test]
async fn a_disabled_wallet_leaves_the_quota_connection_alone() {
    let mode = Arc::new(AtomicU8::new(0));
    let transport = two_cycle_transport(Arc::clone(&mode));
    let (quota, _) = two_cycle_collectors(&transport);
    let disabled_wallet = GlmWalletCollector::new(Arc::clone(&transport) as Arc<dyn HttpTransport>)
        .with_endpoint("https://api.z.ai/experimental/wallet/balance")
        .with_allowed_hosts(vec!["api.z.ai".to_string()])
        .with_credential_value("wallet-key-value");
    let mut view = GlmView::new();

    let report = view
        .refresh(&quota, &disabled_wallet, &context_at(REFRESH_INSTANT))
        .await;

    assert!(report.quota_ok);
    assert!(!report.wallet_ok);
    assert_eq!(
        view.wallet.error.as_ref().map(|error| error.kind),
        Some(ErrorKind::MissingConfig)
    );
    assert!(view.wallet.snapshot.is_none());
    assert!(view.wallet.last_success_at.is_none());
    // Only the three quota requests were made.
    let urls: Vec<String> = transport
        .requests()
        .iter()
        .map(|request| request.url.clone())
        .collect();
    assert_eq!(urls.len(), 3);
    assert!(urls.iter().all(|url| url.contains("/api/monitor/usage/")));

    // The panel still renders the quota side, and the wallet side reports why it
    // has nothing, without a fabricated zero balance.
    let displayed = view.display_snapshots();
    assert_eq!(displayed.len(), 2);
    assert!(displayed
        .iter()
        .any(|snapshot| snapshot.source == "glm-monitor" && !snapshot.metrics.is_empty()));
    let wallet_snapshot = displayed
        .iter()
        .find(|snapshot| snapshot.source == "glm-wallet-experimental")
        .expect("the wallet connection reports its own state");
    assert!(wallet_snapshot.metrics.is_empty());
    assert_eq!(
        wallet_snapshot.error.as_ref().map(|error| error.kind),
        Some(ErrorKind::MissingConfig)
    );
}

#[tokio::test]
async fn each_connection_sends_only_its_own_credential() {
    let mode = Arc::new(AtomicU8::new(0));
    let transport = two_cycle_transport(Arc::clone(&mode));
    let (quota, wallet) = two_cycle_collectors(&transport);
    let mut view = GlmView::new();

    view.refresh(&quota, &wallet, &context_at(REFRESH_INSTANT))
        .await;

    let requests = transport.requests();
    let quota_requests: Vec<&HttpGet> = requests
        .iter()
        .filter(|request| request.url.contains("/api/monitor/usage/"))
        .collect();
    let wallet_requests: Vec<&HttpGet> = requests
        .iter()
        .filter(|request| !request.url.contains("/api/monitor/usage/"))
        .collect();

    assert_eq!(quota_requests.len(), 3);
    assert_eq!(
        wallet_requests.len(),
        1,
        "the wallet credit is never used for quota"
    );

    for request in &quota_requests {
        assert_eq!(
            request.headers.get("Authorization").map(String::as_str),
            Some("quota-key-value")
        );
        assert!(request
            .headers
            .values()
            .all(|value| !value.contains("wallet-key-value")));
        assert!(!request.url.contains("wallet-key-value"));
    }
    assert_eq!(
        quota_requests[0]
            .headers
            .get("Accept-Language")
            .map(String::as_str),
        Some("en-US,en")
    );
    assert_eq!(
        quota_requests[0]
            .headers
            .get("Content-Type")
            .map(String::as_str),
        Some("application/json")
    );

    for request in &wallet_requests {
        assert_eq!(
            request.headers.get("Authorization").map(String::as_str),
            Some("wallet-key-value")
        );
        assert!(request
            .headers
            .values()
            .all(|value| !value.contains("quota-key-value")));
        assert!(!request.url.contains("quota-key-value"));
    }
}

#[tokio::test]
async fn the_wallet_feeds_only_its_own_estimator_series() {
    let transport = Arc::new(ScriptedTransport::new(|request| {
        if request.url.contains("/api/monitor/usage/") {
            if request.url.contains(QUOTA_LIMIT_PATH) {
                return Ok(HttpResponse::new(200, fixture_quota_payload().to_string()));
            }
            return Ok(HttpResponse::new(200, empty_activity().to_string()));
        }
        Ok(HttpResponse::new(
            200,
            json!({ "success": true, "data": { "balance": 12.5, "currency": "USD" } }).to_string(),
        ))
    }));
    let store = MemoryBalanceStore::new();
    let shared = Arc::clone(&transport) as Arc<dyn HttpTransport>;
    let quota = quota_collector(&shared, "quota-key-value");
    let wallet = wallet_collector(&shared, "https://api.z.ai/experimental/wallet/balance")
        .with_balance_store(store.clone(), shanghai());
    let mut view = GlmView::new();

    let report = view
        .refresh(&quota, &wallet, &context_at(REFRESH_INSTANT))
        .await;
    assert!(report.quota_ok && report.wallet_ok);

    // The sample belongs to the GLM wallet connection and its own currency.
    let samples = store.day(&wallet_key("USD"), "2026-09-10");
    assert_eq!(samples.len(), 1);
    assert_eq!(samples[0].total, Money::parse("12.5").expect("exact money"));
    assert_eq!(samples[0].observed_at.as_str(), REFRESH_INSTANT);
    assert_eq!(samples[0].connection.key(), "glm:wallet");
    assert_eq!(samples[0].provider, ProviderId::Glm);
    assert_eq!(
        samples[0].local_day, "2026-09-10",
        "the estimator computes the local day in the configured timezone"
    );

    // Nothing was written for another provider, another connection or another
    // currency, so a GLM wallet balance can never be folded into a DeepSeek one.
    let deepseek_key = BalanceKey {
        provider: ProviderId::Deepseek,
        connection: ConnectionId::new(ProviderId::Deepseek, "wallet"),
        currency: "USD".to_string(),
    };
    assert!(store.day(&deepseek_key, "2026-09-10").is_empty());
    assert!(store.day(&wallet_key("CNY"), "2026-09-10").is_empty());
    assert!(store
        .observations()
        .iter()
        .all(|sample| sample.provider == ProviderId::Glm));

    assert_eq!(
        keys(&view.wallet.snapshot.clone().expect("wallet")),
        vec![
            "wallet.USD.balance".to_string(),
            "spend.USD.daily".to_string()
        ]
    );
    assert_eq!(
        view.wallet
            .metrics()
            .iter()
            .filter(|metric| metric.key.starts_with("spend."))
            .count(),
        1,
        "the quota connection never feeds the wallet estimator"
    );
}

// ---------------------------------------------------------------------------
// Task 3.6 — the wallet's own daily spend estimate
// ---------------------------------------------------------------------------

/// A wallet transport that answers successive reads with successive balances.
fn sequenced_wallet_transport(balances: &[f64]) -> Arc<ScriptedTransport> {
    let balances: Vec<f64> = balances.to_vec();
    let index = Arc::new(Mutex::new(0usize));
    Arc::new(ScriptedTransport::new(move |_request| {
        let position = index.lock().map(|cursor| *cursor).unwrap_or(0);
        if let Ok(mut cursor) = index.lock() {
            *cursor = position + 1;
        }
        let balance = balances.get(position).copied().unwrap_or(0.0);
        Ok(HttpResponse::new(
            200,
            json!({ "success": true, "data": { "balance": balance, "currency": "CNY" } })
                .to_string(),
        ))
    }))
}

#[tokio::test]
async fn the_wallet_estimates_its_own_daily_spend() {
    const LOCAL_MIDNIGHT: &str = "2026-09-09T16:00:00.000Z";
    const LOCAL_NOON: &str = "2026-09-10T04:00:00.000Z";

    let store = MemoryBalanceStore::new();
    let transport = sequenced_wallet_transport(&[100.0, 96.5]);
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    )
    .with_balance_store(store.clone(), shanghai());

    let first = collector
        .refresh(parse_instant(LOCAL_MIDNIGHT))
        .await
        .expect("the first observation must succeed");
    // A finished day with no decrease is a reliable zero, not a missing value.
    assert_eq!(number(&first, "spend.CNY.daily"), Some(0.0));
    assert_eq!(
        metric(&first, "spend.CNY.daily").confidence,
        vec![Confidence::Estimated]
    );

    let second = collector
        .refresh(parse_instant(LOCAL_NOON))
        .await
        .expect("the second observation must succeed");
    let spend = metric(&second, "spend.CNY.daily");
    assert_eq!(spend.value.as_number(), Some(3.5));
    assert_eq!(spend.unit, "CNY");
    assert_eq!(spend.direction, MetricDirection::Spend);
    assert_eq!(spend.source, ESTIMATOR_SOURCE);
    assert_eq!(spend.confidence, vec![Confidence::Estimated]);
    assert_eq!(
        spend.connection.as_ref().map(|connection| connection.key()),
        Some("glm:wallet".to_string())
    );
    assert_eq!(
        spend
            .details
            .as_ref()
            .and_then(|details| details.get("localDay")),
        Some(&json!("2026-09-10"))
    );
    assert_eq!(
        spend
            .details
            .as_ref()
            .and_then(|details| details.get("adjustmentCount")),
        Some(&json!(0))
    );
    let scope = spend.scope.clone().expect("the estimate carries a scope");
    assert_eq!(scope.local_day, "2026-09-10");
    assert_eq!(scope.timezone, TIMEZONE);
    assert!(scope.range_start.is_none() && scope.range_end.is_none());

    // The balance is untouched by the estimate, and the samples are the wallet's.
    assert_eq!(number(&second, "wallet.CNY.balance"), Some(96.5));
    assert!(second.error.is_none());
    assert_eq!(store.day(&wallet_key("CNY"), "2026-09-10").len(), 2);
    assert_eq!(
        store.day(&wallet_key("CNY"), "2026-09-10")[1].total,
        Money::parse("96.5").expect("exact money")
    );
    let current = collector
        .current_estimate("CNY")
        .expect("the estimator is attached")
        .expect("the day has a stored estimate");
    assert_eq!(
        current.estimated_spend,
        Money::parse("3.5").expect("exact money")
    );
    assert!(!current.partial);
}

#[tokio::test]
async fn a_midday_wallet_start_marks_the_estimate_partial_like_the_fixture() {
    let fixture = load_fixture("daily-statistics");
    let case = &fixture["balanceEstimator"]["middayStart"];
    let timezone = fixture["timezone"].as_str().expect("fixture timezone");
    let observations = case["observations"]
        .as_array()
        .expect("fixture observations");
    let balances: Vec<f64> = observations
        .iter()
        .map(|observation| observation["total"].as_f64().expect("fixture total"))
        .collect();
    let expected_spend = case["expect"]["estimatedSpend"]
        .as_f64()
        .expect("fixture estimatedSpend");
    let expected_partial = case["expect"]["partial"]
        .as_bool()
        .expect("fixture partial");
    assert_eq!(
        case["expect"]["unobservedHoursAreNotExtrapolated"],
        json!(true)
    );

    let store = MemoryBalanceStore::new();
    let transport = sequenced_wallet_transport(&balances);
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    )
    .with_balance_store(
        store.clone(),
        Timezone::parse(timezone).expect("fixture timezone must be known"),
    );

    let mut snapshot = None;
    for observation in observations {
        let instant = observation["observedAt"]
            .as_str()
            .expect("fixture observedAt");
        snapshot = Some(
            collector
                .refresh(parse_instant(instant))
                .await
                .expect("a midday observation must succeed"),
        );
    }
    let snapshot = snapshot.expect("the fixture has observations");
    let spend = metric(&snapshot, "spend.CNY.daily");
    assert_eq!(spend.value.as_number(), Some(expected_spend));
    assert_eq!(
        spend.confidence,
        if expected_partial {
            vec![Confidence::Estimated, Confidence::Partial]
        } else {
            vec![Confidence::Estimated]
        },
        "a partial day must be marked, and never extrapolated"
    );
}

#[tokio::test]
async fn a_store_failure_keeps_the_balance_and_reports_the_estimate_failure() {
    let transport = wallet_response(fixture_wallet_payload());
    let collector = wallet_collector(
        &(Arc::clone(&transport) as Arc<dyn HttpTransport>),
        "https://api.z.ai/experimental/wallet/balance",
    )
    .with_balance_store(FailingStore, shanghai());

    let snapshot = collector
        .refresh(parse_instant(REFRESH_INSTANT))
        .await
        .expect("the reported balance must still be returned");

    assert_eq!(number(&snapshot, "wallet.CNY.balance"), Some(42.6));
    assert!(
        snapshot.metric("spend.CNY.daily").is_none(),
        "a storage failure must not invent a spend estimate"
    );
    let failures = snapshot
        .diagnostic
        .as_ref()
        .and_then(|diagnostic| diagnostic.get("estimateFailures"))
        .and_then(Value::as_array)
        .expect("estimateFailures diagnostic");
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["currency"], json!("CNY"));
    assert_eq!(failures[0]["kind"], json!("storage"));
    assert!(snapshot.error.is_none(), "the connection itself is healthy");

    let encoded = serde_json::to_string(&snapshot).expect("snapshot must serialize");
    assert!(!encoded.contains("wallet-key-value"));
    assert!(collector
        .current_estimate("CNY")
        .is_err_and(|error| error.kind == ErrorKind::Storage));
}

//! DeepSeek wallet collector tests.
//!
//! These pin the migrated TypeScript behaviour (`tests/deepseek.test.ts`) plus
//! the shared golden expectations in
//! `fixtures/contracts/deepseek-currencies.json`: exact decimal money, a
//! reliable zero, absent values that stay absent, the shared error vocabulary,
//! and a daily spend estimate that is never invented — and never a quota, plan
//! or token metric, because DeepSeek has no verified source for those.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use usage_core::adapters::deepseek::{
    normalize_balance, DeepSeekCollector, BALANCE_SOURCE, BALANCE_URL, ESTIMATOR_SOURCE,
};
use usage_core::contracts::{
    Confidence, ConnectionStatus, ErrorKind, IsoTimestamp, MetricDirection, MetricValue,
    ProviderId, UsageMetric,
};
use usage_core::estimate::{
    BalanceKey, BalanceObservation, BalanceStore, DailySummary, MemoryBalanceStore, Money,
    StoreError, Timezone,
};
use usage_core::fixtures::load_fixture;
use usage_core::http::{CollectorError, HttpGet, HttpResponse, HttpTransport};

const LOCAL_MIDNIGHT: &str = "2026-09-09T16:00:00.000Z";
const LOCAL_NOON: &str = "2026-09-10T04:00:00.000Z";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// Transport that replays scripted responses and records every request.
#[derive(Debug, Default)]
struct ScriptedTransport {
    responses: Mutex<VecDeque<Result<HttpResponse, CollectorError>>>,
    requests: Mutex<Vec<HttpGet>>,
}

impl ScriptedTransport {
    fn new(responses: Vec<Result<HttpResponse, CollectorError>>) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(responses.into()),
            requests: Mutex::new(Vec::new()),
        })
    }

    fn served(response: HttpResponse) -> Arc<Self> {
        Self::new(vec![Ok(response)])
    }

    fn with_bodies(bodies: Vec<Value>) -> Arc<Self> {
        Self::new(
            bodies
                .into_iter()
                .map(|body| Ok(HttpResponse::new(200, body.to_string())))
                .collect(),
        )
    }

    fn status(status: u16, retry_after_seconds: Option<u64>) -> Arc<Self> {
        Self::served(HttpResponse {
            status,
            final_url: None,
            body: "{}".to_string(),
            retry_after_seconds,
        })
    }

    fn raw(body: &str) -> Arc<Self> {
        Self::served(HttpResponse::new(200, body))
    }

    fn failing(error: CollectorError) -> Arc<Self> {
        Self::new(vec![Err(error)])
    }

    fn requests(&self) -> Vec<HttpGet> {
        self.requests.lock().expect("request log").clone()
    }
}

impl HttpTransport for ScriptedTransport {
    fn get(
        &self,
        request: HttpGet,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, CollectorError>> + Send + '_>> {
        self.requests.lock().expect("request log").push(request);
        let response = self.responses.lock().expect("response script").pop_front();
        Box::pin(async move {
            response.unwrap_or_else(|| Err(CollectorError::network("no scripted response is left")))
        })
    }
}

/// Clock that hands out scripted instants in order.
#[derive(Debug, Clone)]
struct SequenceClock {
    instants: Arc<Mutex<VecDeque<DateTime<Utc>>>>,
}

impl SequenceClock {
    fn new(instants: &[&str]) -> Self {
        Self {
            instants: Arc::new(Mutex::new(
                instants.iter().map(|raw| at(raw)).collect::<VecDeque<_>>(),
            )),
        }
    }

    fn next(&self) -> DateTime<Utc> {
        self.instants
            .lock()
            .expect("clock")
            .pop_front()
            .expect("a scripted instant must remain")
    }
}

/// Store whose every operation fails, to prove a storage failure never loses
/// the balances the provider really reported.
#[derive(Debug, Default, Clone)]
struct FailingStore;

const STORE_FAILURE: &str = "sqlite: cannot write balance samples for api_key=super-secret-value";

impl BalanceStore for FailingStore {
    fn latest(&self, _key: &BalanceKey) -> Result<Option<BalanceObservation>, StoreError> {
        Err(StoreError::new(STORE_FAILURE))
    }

    fn list_day(
        &self,
        _key: &BalanceKey,
        _local_day: &str,
    ) -> Result<Vec<BalanceObservation>, StoreError> {
        Err(StoreError::new(STORE_FAILURE))
    }

    fn insert(&mut self, _observation: BalanceObservation) -> Result<(), StoreError> {
        Err(StoreError::new(STORE_FAILURE))
    }

    fn save_summary(&mut self, _summary: DailySummary) -> Result<(), StoreError> {
        Err(StoreError::new(STORE_FAILURE))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn at(raw: &str) -> DateTime<Utc> {
    IsoTimestamp::parse(raw)
        .expect("timestamp must parse")
        .to_datetime()
}

fn shanghai() -> Timezone {
    Timezone::parse("Asia/Shanghai").expect("timezone must resolve")
}

fn balance_body(entries: Vec<Value>) -> Value {
    json!({ "is_available": true, "balance_infos": entries })
}

fn entry(currency: &str, total: &str, granted: &str, topped_up: &str) -> Value {
    json!({
        "currency": currency,
        "total_balance": total,
        "granted_balance": granted,
        "topped_up_balance": topped_up
    })
}

fn two_currencies() -> Value {
    balance_body(vec![
        entry("CNY", "86.42", "0.00", "86.42"),
        entry("USD", "12.05", "2.05", "10.00"),
    ])
}

fn collector(transport: Arc<ScriptedTransport>, api_key: Option<&str>) -> DeepSeekCollector {
    DeepSeekCollector::new(transport, api_key.map(str::to_string))
        .with_now(move || at(LOCAL_MIDNIGHT))
}

fn confidence_json(metric: &UsageMetric) -> Value {
    serde_json::to_value(&metric.confidence).expect("confidence must serialize")
}

fn number(metric: &UsageMetric) -> Option<f64> {
    metric.value.as_number()
}

fn wallet_key(currency: &str) -> BalanceKey {
    BalanceKey {
        provider: ProviderId::Deepseek,
        connection: DeepSeekCollector::wallet_connection(),
        currency: currency.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Balance collection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reads_the_documented_endpoint_once_with_the_configured_key() {
    let transport = ScriptedTransport::with_bodies(vec![two_currencies()]);
    let snapshot = collector(transport.clone(), Some("sk-live-key"))
        .refresh()
        .await
        .expect("refresh must succeed");

    let requests = transport.requests();
    assert_eq!(requests.len(), 1, "one read-only GET per refresh");
    assert_eq!(requests[0].url, BALANCE_URL);
    assert_eq!(
        requests[0].headers.get("Authorization").map(String::as_str),
        Some("Bearer sk-live-key")
    );
    assert_eq!(
        requests[0].headers.get("Accept").map(String::as_str),
        Some("application/json")
    );
    assert_eq!(snapshot.provider, ProviderId::Deepseek);
    assert_eq!(snapshot.source, BALANCE_SOURCE);
    assert_eq!(
        snapshot.connection,
        Some(DeepSeekCollector::wallet_connection())
    );
    assert_eq!(
        snapshot.captured_at,
        IsoTimestamp::parse(LOCAL_MIDNIGHT).expect("stamp")
    );
    assert_eq!(snapshot.last_success_at, Some(snapshot.captured_at.clone()));
    assert_eq!(
        snapshot.diagnostic.as_ref().expect("diagnostic")["available"],
        json!(true)
    );
}

#[tokio::test]
async fn parses_multiple_currencies_exactly_and_keeps_a_reliable_zero() {
    let snapshot = collector(
        ScriptedTransport::with_bodies(vec![two_currencies()]),
        Some("key"),
    )
    .refresh()
    .await
    .expect("refresh must succeed");

    let keys: Vec<&str> = snapshot
        .metrics
        .iter()
        .map(|metric| metric.key.as_str())
        .collect();
    assert_eq!(
        keys,
        vec![
            "wallet.CNY.total",
            "wallet.CNY.granted",
            "wallet.CNY.topped-up",
            "wallet.USD.total",
            "wallet.USD.granted",
            "wallet.USD.topped-up",
        ]
    );

    let total = snapshot.metric("wallet.CNY.total").expect("total metric");
    assert_eq!(number(total), Some(86.42));
    assert_eq!(total.unit, "CNY");
    assert_eq!(total.direction, MetricDirection::Balance);
    assert_eq!(total.source, BALANCE_SOURCE);
    assert_eq!(confidence_json(total), json!(["authoritative"]));
    assert_eq!(
        total.details.as_ref().expect("details")["available"],
        json!(true)
    );

    // `"0.00"` is money the provider really reported: a reliable zero, not an
    // absent value.
    let granted = snapshot
        .metric("wallet.CNY.granted")
        .expect("granted metric");
    assert_eq!(number(granted), Some(0.0));
    assert!(!granted.is_missing());
    assert!(!granted.has_confidence(Confidence::Unavailable));
    assert_eq!(granted.unit, "CNY");

    assert_eq!(
        number(snapshot.metric("wallet.CNY.topped-up").expect("metric")),
        Some(86.42)
    );
    assert_eq!(
        number(snapshot.metric("wallet.USD.total").expect("metric")),
        Some(12.05)
    );
    assert_eq!(
        number(snapshot.metric("wallet.USD.granted").expect("metric")),
        Some(2.05)
    );
    assert_eq!(
        number(snapshot.metric("wallet.USD.topped-up").expect("metric")),
        Some(10.0)
    );

    for metric in &snapshot.metrics {
        let currency = metric.key.split('.').nth(1).expect("currency segment");
        assert_eq!(metric.unit, currency, "unit must be the provider currency");
        assert_eq!(metric.direction, MetricDirection::Balance);
        assert_eq!(
            metric.connection,
            Some(DeepSeekCollector::wallet_connection()),
            "every metric carries the wallet connection"
        );
    }
}

#[tokio::test]
async fn an_unavailable_account_still_reports_the_balances_it_returned() {
    // `is_available` describes the account, not the trustworthiness of the
    // numbers: the balances the provider returned are still reported verbatim,
    // and the flag travels in the metric details instead of being guessed.
    let body = json!({
        "is_available": false,
        "balance_infos": [ entry("CNY", "0.00", "0.00", "0.00") ]
    });
    let snapshot = collector(ScriptedTransport::with_bodies(vec![body]), Some("key"))
        .refresh()
        .await
        .expect("refresh must succeed");

    assert_eq!(snapshot.status, ConnectionStatus::Connected);
    assert_eq!(
        snapshot.diagnostic.as_ref().expect("diagnostic")["available"],
        json!(false)
    );
    let total = snapshot.metric("wallet.CNY.total").expect("total");
    assert_eq!(number(total), Some(0.0));
    assert!(!total.is_missing(), "a reported 0.00 is a reliable zero");
    assert_eq!(
        total.details.as_ref().expect("details")["available"],
        json!(false)
    );
}

#[tokio::test]
async fn absent_components_and_absent_currency_entries_stay_absent() {
    // An entry that omits two components: those metrics exist but stay absent.
    let partial = balance_body(vec![json!({ "currency": "CNY", "total_balance": "86.42" })]);
    let snapshot = collector(ScriptedTransport::with_bodies(vec![partial]), Some("key"))
        .refresh()
        .await
        .expect("refresh must succeed");

    let granted = snapshot
        .metric("wallet.CNY.granted")
        .expect("granted metric");
    assert!(granted.is_missing());
    assert_eq!(granted.value, MetricValue::Null);
    assert!(granted.has_confidence(Confidence::Unavailable));
    assert_eq!(number(granted), None, "an absent balance is never zero");
    assert!(snapshot
        .metric("wallet.CNY.topped-up")
        .expect("metric")
        .is_missing());

    // An explicit `null` is the same as absent.
    let nulled = balance_body(vec![json!({
        "currency": "CNY",
        "total_balance": "86.42",
        "granted_balance": null,
        "topped_up_balance": "86.42"
    })]);
    let snapshot = collector(ScriptedTransport::with_bodies(vec![nulled]), Some("key"))
        .refresh()
        .await
        .expect("refresh must succeed");
    assert!(snapshot
        .metric("wallet.CNY.granted")
        .expect("metric")
        .is_missing());

    // A currency the response does not mention has no metric at all: nothing is
    // fabricated for it.
    let cny_only = balance_body(vec![entry("CNY", "86.42", "0.00", "86.42")]);
    let snapshot = collector(ScriptedTransport::with_bodies(vec![cny_only]), Some("key"))
        .refresh()
        .await
        .expect("refresh must succeed");
    assert!(snapshot.metric("wallet.USD.total").is_none());
    assert_eq!(
        snapshot.diagnostic.as_ref().expect("diagnostic")["currencies"],
        json!(["CNY"])
    );
}

#[tokio::test]
async fn no_quota_plan_or_token_metric_is_invented() {
    let store = MemoryBalanceStore::new();
    let snapshot = DeepSeekCollector::new(
        ScriptedTransport::with_bodies(vec![two_currencies()]),
        Some("key".to_string()),
    )
    .with_balance_store(store, shanghai())
    .with_now(move || at(LOCAL_MIDNIGHT))
    .refresh()
    .await
    .expect("refresh must succeed");

    for metric in &snapshot.metrics {
        let key = metric.key.to_ascii_lowercase();
        for forbidden in ["quota", "plan", "token"] {
            assert!(
                !key.contains(forbidden),
                "DeepSeek has no verified {forbidden} source, so {} must not exist",
                metric.key
            );
        }
    }
    let spend_keys: Vec<&str> = snapshot
        .metrics
        .iter()
        .map(|metric| metric.key.as_str())
        .filter(|key| key.starts_with("spend."))
        .collect();
    assert_eq!(spend_keys, vec!["spend.CNY.daily", "spend.USD.daily"]);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[tokio::test]
async fn missing_configuration_is_reported_without_a_request() {
    let transport = ScriptedTransport::with_bodies(vec![two_currencies()]);
    let error = DeepSeekCollector::new(transport.clone(), None::<String>)
        .refresh()
        .await
        .expect_err("a missing key must fail");

    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert!(error.message.contains("API key"));
    assert!(transport.requests().is_empty(), "no request without a key");

    // An empty key is missing configuration, not a credential to send.
    let blank = DeepSeekCollector::new(transport.clone(), Some("   ".to_string()))
        .refresh()
        .await
        .expect_err("a blank key must fail");
    assert_eq!(blank.kind, ErrorKind::MissingConfig);
    assert!(transport.requests().is_empty());

    // A credential-store failure is not "missing config".
    let failing = DeepSeekCollector::new(
        transport.clone(),
        || -> Result<Option<String>, CollectorError> {
            Err(CollectorError::new(
                ErrorKind::Storage,
                "keychain is locked",
            ))
        },
    )
    .refresh()
    .await
    .expect_err("a store failure must fail");
    assert_eq!(failing.kind, ErrorKind::Storage);
    assert!(transport.requests().is_empty());
}

#[tokio::test]
async fn authentication_failures_are_classified() {
    for status in [401u16, 403] {
        let error = collector(ScriptedTransport::status(status, None), Some("bad-key"))
            .refresh()
            .await
            .expect_err("rejected credentials must fail");
        assert_eq!(error.kind, ErrorKind::Authentication, "HTTP {status}");
    }
}

#[tokio::test]
async fn rate_limits_keep_the_retry_after_diagnostic() {
    let error = collector(ScriptedTransport::status(429, Some(30)), Some("key"))
        .refresh()
        .await
        .expect_err("a rate limit must fail");
    assert_eq!(error.kind, ErrorKind::RateLimit);
    assert_eq!(
        error
            .diagnostic
            .get("retryAfterSeconds")
            .map(String::as_str),
        Some("30")
    );

    // The shared transport already classifies the status; its error is passed
    // through unchanged, diagnostic included.
    let classified = CollectorError::rate_limit("the provider is rate limiting this connection")
        .with_diagnostic("retryAfterSeconds", "42");
    let error = collector(ScriptedTransport::failing(classified.clone()), Some("key"))
        .refresh()
        .await
        .expect_err("a rate limit must fail");
    assert_eq!(error, classified);
}

#[tokio::test]
async fn server_failures_are_network_errors() {
    for status in [500u16, 503, 404] {
        let error = collector(ScriptedTransport::status(status, None), Some("key"))
            .refresh()
            .await
            .expect_err("HTTP {status} must fail");
        assert_eq!(error.kind, ErrorKind::Network, "HTTP {status}");
        assert!(error.message.contains(&status.to_string()));
    }
}

#[tokio::test]
async fn malformed_json_is_incompatible_and_never_a_balance() {
    let error = collector(
        ScriptedTransport::raw("<!doctype html>not json"),
        Some("key"),
    )
    .refresh()
    .await
    .expect_err("malformed JSON must fail");
    assert_eq!(error.kind, ErrorKind::Compatibility);
    assert!(error.message.contains("not valid JSON"));
}

#[tokio::test]
async fn unexpected_field_types_are_incompatible() {
    let bodies = vec![
        json!({ "is_available": "yes", "balance_infos": [] }),
        json!({ "balance_infos": [] }),
        json!({ "is_available": true }),
        json!({ "is_available": true, "balance_infos": { "currency": "CNY" } }),
        json!({ "is_available": true, "balance_infos": ["CNY"] }),
        json!({ "is_available": true, "balance_infos": [ { "total_balance": "1.00" } ] }),
        json!({ "is_available": true, "balance_infos": [ { "currency": "CNY", "total_balance": 86.42 } ] }),
        json!({ "is_available": true, "balance_infos": [ { "currency": "CNY", "total_balance": null, "granted_balance": [] } ] }),
        json!({ "is_available": true, "balance_infos": [ { "currency": "CNY", "total_balance": "not-money" } ] }),
        json!({ "is_available": true, "balance_infos": [ { "currency": "CNY", "total_balance": "-1.00" } ] }),
        json!({ "is_available": true, "balance_infos": [ { "currency": "CNY", "total_balance": "1.1234567" } ] }),
    ];
    for body in bodies {
        let error = collector(
            ScriptedTransport::with_bodies(vec![body.clone()]),
            Some("key"),
        )
        .refresh()
        .await
        .expect_err("an incompatible body must fail");
        assert_eq!(error.kind, ErrorKind::Compatibility, "{body}");
        assert!(
            error.message.contains("incompatible"),
            "message must say why: {}",
            error.message
        );
        assert_eq!(
            error.diagnostic.get("endpoint").map(String::as_str),
            Some(BALANCE_URL)
        );
    }
}

#[tokio::test]
async fn transport_failures_pass_through_redacted() {
    let transport_error = CollectorError::network("upstream refused: Bearer sk-live-2-secret");
    let error = collector(ScriptedTransport::failing(transport_error), Some("key"))
        .refresh()
        .await
        .expect_err("a transport failure must fail");

    assert_eq!(error.kind, ErrorKind::Network);
    assert!(error.message.contains("[REDACTED]"));
    assert!(!error.message.contains("sk-live-2-secret"));
}

// ---------------------------------------------------------------------------
// Daily spend metric
// ---------------------------------------------------------------------------

#[tokio::test]
async fn appends_a_daily_spend_metric_with_estimated_confidence() {
    let store = MemoryBalanceStore::new();
    let transport = ScriptedTransport::with_bodies(vec![
        two_currencies(),
        balance_body(vec![
            entry("CNY", "84.42", "0.00", "84.42"),
            entry("USD", "12.05", "2.05", "10.00"),
        ]),
    ]);
    let collector = DeepSeekCollector::new(transport, Some("key".to_string()))
        .with_balance_store(store.clone(), shanghai())
        .with_now({
            let clock = SequenceClock::new(&[LOCAL_MIDNIGHT, LOCAL_NOON]);
            move || clock.next()
        });

    let first = collector.refresh().await.expect("first refresh");
    let spend = first.metric("spend.CNY.daily").expect("spend metric");
    assert_eq!(number(spend), Some(0.0));
    assert_eq!(spend.direction, MetricDirection::Spend);
    assert_eq!(spend.source, ESTIMATOR_SOURCE);
    assert_eq!(spend.unit, "CNY");
    assert_eq!(confidence_json(spend), json!(["estimated"]));
    let details = spend.details.as_ref().expect("details");
    assert_eq!(details["localDay"], json!("2026-09-10"));
    assert_eq!(details["adjustmentCount"], json!(0));
    let scope = spend.scope.as_ref().expect("scope");
    assert_eq!(scope.local_day, "2026-09-10");
    assert_eq!(scope.timezone, "Asia/Shanghai");
    assert!(scope.range_confirmed);
    assert!(
        scope.range_start.is_none() && scope.range_end.is_none(),
        "the provider never confirmed a daily range, so no range is attached"
    );

    // A second refresh inside the same local day extends the estimate. The day
    // started at local midnight, so coverage is still complete.
    let second = collector.refresh().await.expect("second refresh");
    let spend = second.metric("spend.CNY.daily").expect("spend metric");
    assert_eq!(number(spend), Some(2.0));
    assert_eq!(confidence_json(spend), json!(["estimated"]));
    assert_eq!(
        number(second.metric("spend.USD.daily").expect("usd spend")),
        Some(0.0)
    );

    // The samples were persisted with the exact decimal representation.
    let observed = store.day(&wallet_key("CNY"), "2026-09-10");
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0].total, Money::parse("86.42").expect("money"));
    assert_eq!(observed[1].total, Money::parse("84.42").expect("money"));
    assert_eq!(observed[0].observed_at.as_str(), LOCAL_MIDNIGHT);
}

#[tokio::test]
async fn a_midday_start_marks_the_estimate_partial() {
    let store = MemoryBalanceStore::new();
    let transport = ScriptedTransport::with_bodies(vec![
        balance_body(vec![entry("CNY", "80.00", "0.00", "80.00")]),
        balance_body(vec![entry("CNY", "78.50", "0.00", "78.50")]),
    ]);
    let collector = DeepSeekCollector::new(transport, Some("key".to_string()))
        .with_balance_store(store, shanghai())
        .with_now({
            let clock =
                SequenceClock::new(&["2026-09-10T04:00:00.000Z", "2026-09-10T05:00:00.000Z"]);
            move || clock.next()
        });

    let first = collector.refresh().await.expect("first refresh");
    assert_eq!(
        confidence_json(first.metric("spend.CNY.daily").expect("spend")),
        json!(["estimated", "partial"])
    );

    let second = collector.refresh().await.expect("second refresh");
    let spend = second.metric("spend.CNY.daily").expect("spend metric");
    assert_eq!(number(spend), Some(1.5));
    assert_eq!(confidence_json(spend), json!(["estimated", "partial"]));
    assert_eq!(
        spend.details.as_ref().expect("details")["adjustmentCount"],
        json!(0)
    );
    assert_eq!(
        spend.details.as_ref().expect("details")["localDay"],
        json!("2026-09-10")
    );
}

#[tokio::test]
async fn balances_survive_a_store_failure_and_the_spend_metric_stays_missing() {
    let snapshot = DeepSeekCollector::new(
        ScriptedTransport::with_bodies(vec![two_currencies()]),
        Some("key".to_string()),
    )
    .with_balance_store(FailingStore, shanghai())
    .with_now(move || at(LOCAL_MIDNIGHT))
    .refresh()
    .await
    .expect("the reported balances must still be returned");

    assert_eq!(
        number(snapshot.metric("wallet.CNY.total").expect("total")),
        Some(86.42)
    );
    assert!(
        snapshot.metric("spend.CNY.daily").is_none(),
        "no estimate was stored"
    );

    let failures = snapshot.diagnostic.as_ref().expect("diagnostic")["estimateFailures"]
        .as_array()
        .expect("failure list")
        .clone();
    assert_eq!(failures.len(), 2, "one failure per currency: {failures:?}");
    assert_eq!(failures[0]["currency"], json!("CNY"));
    assert_eq!(failures[0]["kind"], json!("storage"));
    let message = failures[0]["message"].as_str().expect("message");
    assert!(message.contains("[REDACTED]"), "{message}");
    assert!(!message.contains("super-secret-value"));
    assert!(
        snapshot.has_data(),
        "the snapshot still carries the real balances"
    );
}

#[tokio::test]
async fn a_collector_without_an_estimator_reports_no_estimate() {
    let snapshot = collector(
        ScriptedTransport::with_bodies(vec![two_currencies()]),
        Some("key"),
    )
    .refresh()
    .await
    .expect("refresh must succeed");

    assert!(snapshot.metric("spend.CNY.daily").is_none());
    assert!(snapshot.metric("wallet.CNY.total").is_some());
}

#[tokio::test]
async fn a_restart_reuses_stored_samples_and_their_original_observation_time() {
    let store = MemoryBalanceStore::new();
    let first_transport = ScriptedTransport::with_bodies(vec![balance_body(vec![entry(
        "CNY", "100.00", "0.00", "100.00",
    )])]);
    let first = DeepSeekCollector::new(first_transport, Some("key".to_string()))
        .with_balance_store(store.clone(), shanghai())
        .with_now(move || at(LOCAL_MIDNIGHT))
        .refresh()
        .await
        .expect("first refresh");
    assert_eq!(
        number(first.metric("spend.CNY.daily").expect("spend")),
        Some(0.0)
    );
    drop(first);

    // A new process reads the earlier sample back and keeps its own timestamp.
    let second_transport = ScriptedTransport::with_bodies(vec![balance_body(vec![entry(
        "CNY", "95.00", "0.00", "95.00",
    )])]);
    let second = DeepSeekCollector::new(second_transport, Some("key".to_string()))
        .with_balance_store(store.clone(), shanghai())
        .with_now(move || at("2026-09-09T18:00:00.000Z"))
        .refresh()
        .await
        .expect("second refresh");

    let spend = second.metric("spend.CNY.daily").expect("spend metric");
    assert_eq!(
        number(spend),
        Some(5.0),
        "the stored day continues after a restart"
    );
    assert_eq!(
        spend.details.as_ref().expect("details")["localDay"],
        json!("2026-09-10")
    );

    let observed = store.day(&wallet_key("CNY"), "2026-09-10");
    assert_eq!(observed.len(), 2);
    assert_eq!(
        observed[0].observed_at.as_str(),
        LOCAL_MIDNIGHT,
        "the restart must not rewrite the first observation's time"
    );
    assert_eq!(observed[1].observed_at.as_str(), "2026-09-09T18:00:00.000Z");
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

#[tokio::test]
async fn matches_the_shared_deepseek_currency_fixture() {
    let fixture = load_fixture("deepseek-currencies");
    let expect = &fixture["expect"];
    let snapshot = normalize_balance(
        &fixture["input"],
        IsoTimestamp::parse(LOCAL_MIDNIGHT).expect("timestamp"),
    )
    .expect("the fixture body must normalize");

    assert_eq!(snapshot.status, ConnectionStatus::Connected);
    assert_eq!(snapshot.source, fixture["source"].as_str().expect("source"));

    let currencies: Vec<String> = snapshot.diagnostic.as_ref().expect("diagnostic")["currencies"]
        .as_array()
        .expect("currencies")
        .iter()
        .map(|value| value.as_str().expect("currency").to_string())
        .collect();
    let expected_currencies: Vec<String> = expect["currencies"]
        .as_array()
        .expect("expected currencies")
        .iter()
        .map(|value| value.as_str().expect("currency").to_string())
        .collect();
    assert_eq!(currencies, expected_currencies);

    let totals: Vec<String> = snapshot
        .metrics
        .iter()
        .filter(|metric| metric.key.ends_with(".total"))
        .map(|metric| metric.key.clone())
        .collect();
    let expected_totals: Vec<String> = expect["totalMetricKeys"]
        .as_array()
        .expect("expected totals")
        .iter()
        .map(|value| value.as_str().expect("key").to_string())
        .collect();
    assert_eq!(totals, expected_totals);

    for metric in &snapshot.metrics {
        assert_eq!(metric.unit, metric.key.split('.').nth(1).expect("currency"));
        assert_eq!(
            serde_json::to_value(metric.direction).expect("direction"),
            expect["balanceDirection"]
        );
        assert_eq!(confidence_json(metric), json!(["authoritative"]));
    }

    let zero = snapshot
        .metric(expect["zeroIsReliable"]["metricKey"].as_str().expect("key"))
        .expect("the reliable zero metric");
    assert_eq!(
        number(zero),
        Some(expect["zeroIsReliable"]["value"].as_f64().expect("value"))
    );
    assert!(!zero.is_missing());

    assert!(snapshot
        .metrics
        .iter()
        .all(|metric| !metric.key.contains("quota")
            && !metric.key.contains("plan")
            && !metric.key.contains("token")));

    // The estimation half of the same fixture: a day that starts at local
    // midnight reports plain `estimated`, a day that starts later is partial,
    // and crossing local midnight settles the finished day.
    let store = MemoryBalanceStore::new();
    let transport = ScriptedTransport::with_bodies(vec![
        fixture["input"].clone(),
        balance_body(vec![entry("CNY", "80.00", "0.00", "80.00")]),
        balance_body(vec![entry("CNY", "78.00", "0.00", "78.00")]),
    ]);
    let collector = DeepSeekCollector::new(transport, Some("key".to_string()))
        .with_balance_store(store.clone(), shanghai())
        .with_now({
            let clock =
                SequenceClock::new(&[LOCAL_MIDNIGHT, LOCAL_NOON, "2026-09-10T16:30:00.000Z"]);
            move || clock.next()
        });

    let spend_key = expect["spendMetric"]["key"].as_str().expect("spend key");
    let complete = collector.refresh().await.expect("first refresh");
    let spend = complete.metric(spend_key).expect("spend metric");
    assert_eq!(
        serde_json::to_value(spend.direction).expect("direction"),
        expect["spendMetric"]["direction"]
    );
    assert_eq!(confidence_json(spend), expect["spendMetric"]["confidence"]);
    assert_eq!(spend.unit, "CNY");
    assert_eq!(number(spend), Some(0.0));

    let same_day = collector.refresh().await.expect("second refresh");
    let spend = same_day.metric(spend_key).expect("spend metric");
    assert_eq!(number(spend), Some(6.42));
    assert_eq!(confidence_json(spend), expect["spendMetric"]["confidence"]);

    // 16:30Z on 2026-09-10 is 00:30 local on 2026-09-11: the finished day is
    // settled once, and the new day is partial from its start.
    let next_day = collector.refresh().await.expect("third refresh");
    let spend = next_day.metric(spend_key).expect("spend metric");
    assert_eq!(
        confidence_json(spend),
        expect["spendMetric"]["partialConfidence"]
    );
    assert_eq!(number(spend), Some(0.0));
    assert_eq!(
        spend.details.as_ref().expect("details")["localDay"],
        json!("2026-09-11")
    );
    let settled = store
        .summary(&wallet_key("CNY"), "2026-09-10")
        .expect("the finished day must be settled");
    assert_eq!(
        settled.estimated_spend,
        Money::parse("6.42").expect("money")
    );
    assert!(!settled.partial);
    assert_eq!(settled.adjustment_count, 0);
}

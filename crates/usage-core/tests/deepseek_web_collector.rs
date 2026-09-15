//! DeepSeek experimental web usage collector tests.
//!
//! Every test runs against a scripted in-memory [`HttpTransport`], so no test
//! touches the network and no login token is ever real. The expectations pin
//! the response shapes the console's own front end reads (see the module docs
//! of [`usage_core::adapters::deepseek_web`]): disabled means zero requests,
//! the credential rides only to `platform.deepseek.com`, unauthenticated
//! answers map to `authentication`, and the query window is the configured
//! timezone's local day.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use usage_core::adapters::deepseek_web::{
    web_connection, AMOUNT_PATH, COST_PATH, PLATFORM_ORIGIN,
};
use usage_core::contracts::{Confidence, ErrorKind, ProviderSnapshot, UsageMetric};
use usage_core::http::{CollectorError, HttpGet, HttpResponse, HttpTransport};
use usage_core::adapters::deepseek_web::DeepSeekWebCollector;

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
    fn new<F>(handler: F) -> Arc<Self>
    where
        F: Fn(&HttpGet) -> Result<HttpResponse, CollectorError> + Send + Sync + 'static,
    {
        Arc::new(Self {
            handler: Arc::new(handler),
            requests: Arc::new(Mutex::new(Vec::new())),
        })
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
// Helpers
// ---------------------------------------------------------------------------

const NOW: &str = "2026-09-10T02:24:00Z";

fn collector(transport: Arc<dyn HttpTransport>) -> DeepSeekWebCollector {
    DeepSeekWebCollector::new(transport, "Asia/Shanghai")
        .with_enabled_flag(true)
        .with_credential_value("web-login-token")
}

fn success_envelope(cost_body: Value, amount_body: Value) -> impl Fn(&HttpGet) -> Result<HttpResponse, CollectorError> {
    move |request: &HttpGet| {
        let url = request.url.clone();
        let body = if url.contains(COST_PATH) {
            cost_body.to_string()
        } else if url.contains(AMOUNT_PATH) {
            amount_body.to_string()
        } else {
            return Err(CollectorError::network(format!("unexpected URL {url}")));
        };
        Ok(HttpResponse::new(200, body))
    }
}

fn cost_envelope() -> Value {
    json!({
        "code": 0, "msg": "success",
        "data": { "biz_data": {
            "start": 1_788_969_600u64, "end": 1_789_056_000u64, "bucket": "hour", "models": [],
            "data": [ { "currency": "CNY", "series": [
                { "api_key": "a", "model": "deepseek-flash",
                  "buckets": [ { "time": 1_788_969_600u64, "cost": 1.63 },
                               { "time": 1_788_973_200u64, "cost": 2.00 } ] }
            ] } ]
        } }
    })
}

fn amount_envelope() -> Value {
    json!({
        "code": 0,
        "data": { "biz_data": {
            "start": 1_788_969_600u64, "end": 1_789_056_000u64, "bucket": "hour", "models": [],
            "series": [ { "api_key": "a", "model": "deepseek-flash", "buckets": [
                { "time": 1_788_969_600u64, "usage": {
                    "PROMPT_CACHE_HIT_TOKEN": 10, "PROMPT_CACHE_MISS_TOKEN": 20,
                    "RESPONSE_TOKEN": 30, "REQUEST": 2 } }
            ] } ]
        } }
    })
}

fn metric<'a>(snapshot: &'a ProviderSnapshot, key: &str) -> &'a UsageMetric {
    snapshot
        .metrics
        .iter()
        .find(|metric| metric.key == key)
        .unwrap_or_else(|| panic!("missing metric {key}"))
}

// ---------------------------------------------------------------------------
// Gate and credential
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_disabled_connection_issues_no_request_at_all() {
    let transport = ScriptedTransport::new(|_| {
        panic!("no request may be sent while the connection is disabled");
    });
    let collector = DeepSeekWebCollector::new(transport.clone(), "Asia/Shanghai")
        .with_enabled_flag(false)
        .with_credential_value("web-login-token");

    let error = collector
        .refresh(DateTime::parse_from_rfc3339(NOW).expect("now").with_timezone(&Utc))
        .await
        .expect_err("disabled");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert!(transport.requests().is_empty());
}

#[tokio::test]
async fn a_missing_credential_is_a_configuration_problem() {
    let transport = ScriptedTransport::new(|_| {
        panic!("no request may be sent without a credential");
    });
    let collector = DeepSeekWebCollector::new(transport, "Asia/Shanghai").with_enabled_flag(true);

    let error = collector
        .refresh(DateTime::parse_from_rfc3339(NOW).expect("now").with_timezone(&Utc))
        .await
        .expect_err("no credential");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn refresh_queries_both_endpoints_with_the_local_day_window() {
    let transport = ScriptedTransport::new(success_envelope(cost_envelope(), amount_envelope()));
    let collector = collector(transport.clone());

    let snapshot = collector
        .refresh(DateTime::parse_from_rfc3339(NOW).expect("now").with_timezone(&Utc))
        .await
        .expect("snapshot");

    let requests = transport.requests();
    assert_eq!(requests.len(), 2, "cost and amount, nothing else");
    for request in &requests {
        let url = &request.url;
        assert!(url.starts_with(PLATFORM_ORIGIN), "{url}");
        assert!(url.contains(COST_PATH) || url.contains(AMOUNT_PATH), "{url}");
        // Local midnight of 2026-09-10 in Asia/Shanghai is 2026-09-09T16:00Z, and
        // the window is the whole local day — the shape the console's own day
        // presets produce — so `end` is the next local midnight, not `now`.
        assert!(url.contains("start=1788969600"), "{url}");
        assert!(!url.contains("end=1789007040"), "a window ending at `now`: {url}");
        assert!(url.contains("end=1789056000"), "{url}");
        assert!(url.contains("tz=28800"), "{url}");
        assert_eq!(
            request.headers.get("Authorization").map(String::as_str),
            Some("Bearer web-login-token")
        );
    }

    assert_eq!(snapshot.connection, Some(web_connection()));
    let spend = metric(&snapshot, "spend.CNY.daily.billed");
    assert_eq!(spend.value.as_number(), Some(3.63));
    assert!(spend.has_confidence(Confidence::Experimental));
    let tokens = metric(&snapshot, "activity.daily.tokens");
    assert_eq!(tokens.value.as_number(), Some(60.0));
    let requests = metric(&snapshot, "activity.daily.requests");
    assert_eq!(requests.value.as_number(), Some(2.0));
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn http_unauthorized_is_an_authentication_failure() {
    let transport = ScriptedTransport::new(|_| Ok(HttpResponse::new(401, "unauthorized")));
    let collector = collector(transport);

    let error = collector
        .refresh(DateTime::parse_from_rfc3339(NOW).expect("now").with_timezone(&Utc))
        .await
        .expect_err("unauthorized");
    assert_eq!(error.kind, ErrorKind::Authentication);
    assert!(error.message.contains("paste a fresh one"));
}

#[tokio::test]
async fn the_missing_token_business_code_is_an_authentication_failure() {
    // The console answers {"code":40002,...,"data":null} when no login token
    // arrived at all.
    let transport = ScriptedTransport::new(|_| {
        Ok(HttpResponse::new(
            200,
            json!({ "code": 40002, "msg": "Missing Token", "data": null }).to_string(),
        ))
    });
    let collector = collector(transport);

    let error = collector
        .refresh(DateTime::parse_from_rfc3339(NOW).expect("now").with_timezone(&Utc))
        .await
        .expect_err("expired login");
    assert_eq!(error.kind, ErrorKind::Authentication);
    assert!(error.message.contains("paste a fresh one"));
}

#[tokio::test]
async fn the_invalid_token_business_code_is_an_authentication_failure() {
    // What the console really answers for a pasted value it will not accept
    // (`Authorization Failed (invalid token)`): an expired session or a mistyped
    // token — never an interface change. Reading it as compatibility made the
    // panel tell the user the console had been redesigned instead of asking for a
    // fresh paste.
    let transport = ScriptedTransport::new(|_| {
        Ok(HttpResponse::new(
            200,
            json!({ "code": 40003, "msg": "Authorization Failed (invalid token)", "data": null })
                .to_string(),
        ))
    });
    let collector = collector(transport);

    let error = collector
        .refresh(DateTime::parse_from_rfc3339(NOW).expect("now").with_timezone(&Utc))
        .await
        .expect_err("invalid token");
    assert_eq!(error.kind, ErrorKind::Authentication);
    assert!(error.message.contains("paste a fresh one"));
}

#[tokio::test]
async fn rate_limiting_keeps_its_error_kind() {
    let transport = ScriptedTransport::new(|_| Ok(HttpResponse::new(429, "slow down")));
    let collector = collector(transport);

    let error = collector
        .refresh(DateTime::parse_from_rfc3339(NOW).expect("now").with_timezone(&Utc))
        .await
        .expect_err("rate limited");
    assert_eq!(error.kind, ErrorKind::RateLimit);
}

#[tokio::test]
async fn a_console_redesign_is_a_compatibility_failure_not_a_crash() {
    let transport = ScriptedTransport::new(success_envelope(
        json!({ "code": 0, "data": { "usage_v3": { "unexpected": true } } }),
        amount_envelope(),
    ));
    let collector = collector(transport);

    let error = collector
        .refresh(DateTime::parse_from_rfc3339(NOW).expect("now").with_timezone(&Utc))
        .await
        .expect_err("redesigned body");
    assert_eq!(error.kind, ErrorKind::Compatibility);
}

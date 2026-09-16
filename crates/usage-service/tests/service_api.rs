//! Service integration tests for the ownership, authentication and API surface
//! (tasks 4.3, 4.4, 4.6).
//!
//! These never touch the network or the Keychain: the transport is an
//! always-failing stub, so collectors degrade gracefully while the HTTP layer
//! still answers from the store.

use std::path::PathBuf;
use std::sync::Arc;

use usage_core::transport::{
    CollectorError, HttpGet, HttpResponse, HttpTransport, UnavailableHttpTransport,
};
use usage_service::{ServiceBuilder, ServiceConfig, ServiceError};

fn temp_data_dir() -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "agents-usage-service-test-{}-{unique}",
        std::process::id()
    ))
}

fn config(data_dir: PathBuf) -> ServiceConfig {
    ServiceConfig {
        data_dir,
        host: "127.0.0.1".to_string(),
        port: 0, // ephemeral
        timezone: "Asia/Shanghai".to_string(),
        codex_cli_path: Some("/definitely/missing/codex".to_string()),
        client_dir: None,
        auto_refresh: false,
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct FailingTransport;

impl HttpTransport for FailingTransport {
    fn get(
        &self,
        _request: HttpGet,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, CollectorError>> + Send + '_>,
    > {
        Box::pin(async { Err(CollectorError::network("offline test transport")) })
    }
}

/// Records every URL a collector asked for, so a test can prove that a
/// switched-off connection never reached the network at all.
#[derive(Debug, Default, Clone)]
struct RecordingTransport {
    urls: Arc<std::sync::Mutex<Vec<String>>>,
}

impl HttpTransport for RecordingTransport {
    fn get(
        &self,
        request: HttpGet,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, CollectorError>> + Send + '_>,
    > {
        let urls = Arc::clone(&self.urls);
        Box::pin(async move {
            urls.lock().expect("transport log").push(request.url);
            Err(CollectorError::network("offline test transport"))
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bootstrap_and_snapshots_work_without_credentials() {
    let data_dir = temp_data_dir();
    let transport: std::sync::Arc<dyn HttpTransport> = Arc::new(FailingTransport);
    let mut running = ServiceBuilder::with_transport(config(data_dir.clone()), transport)
        .start()
        .await
        .expect("service must start");
    let origin = running.origin();
    let http = running.take_http_server().expect("http server");
    let server = tokio::spawn(http.serve());

    let bootstrap: serde_json::Value = reqwest::get(format!("{origin}/api/bootstrap"))
        .await
        .expect("bootstrap request")
        .json()
        .await
        .expect("bootstrap json");
    assert!(bootstrap["sessionToken"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert!(bootstrap["settings"]["timezone"].as_str() == Some("Asia/Shanghai"));

    let snapshots: serde_json::Value = reqwest::get(format!("{origin}/api/snapshots"))
        .await
        .expect("snapshots request")
        .json()
        .await
        .expect("snapshots json");
    assert!(snapshots["providers"].is_array());

    running.shutdown().await;
    server.abort();
    std::fs::remove_dir_all(&data_dir).ok();
}

/// Connection names the snapshot records for one provider.
fn recorded_connections(snapshots: &serde_json::Value, provider: &str) -> Vec<String> {
    snapshots["providers"]
        .as_array()
        .expect("providers")
        .iter()
        .filter(|state| state["provider"] == provider)
        .flat_map(|state| {
            state["connections"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|connection| connection["connection"].as_str().map(str::to_string))
        .collect()
}

/// The failure message the snapshot reports for one provider/connection.
fn recorded_error(
    snapshots: &serde_json::Value,
    provider: &str,
    connection: &str,
) -> Option<String> {
    snapshots["providers"]
        .as_array()?
        .iter()
        .find(|state| {
            state["provider"] == provider
                && state["connections"].as_array().is_some_and(|list| {
                    list.iter().any(|entry| entry["connection"] == connection)
                })
        })
        .and_then(|state| state["error"]["message"].as_str())
        .map(str::to_string)
}

/// A switched-off experimental connection is not attempted and not recorded: an
/// opt-out is the user's choice, not a connection failure, and a stored
/// "disabled" verdict would later read as the connection's latest attempt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_switched_off_experimental_connection_is_never_attempted() {
    let data_dir = temp_data_dir();
    let transport = RecordingTransport::default();
    let requested = Arc::clone(&transport.urls);
    let mut running = ServiceBuilder::with_transport(config(data_dir.clone()), Arc::new(transport))
        .start()
        .await
        .expect("service must start");
    let origin = running.origin();
    let http = running.take_http_server().expect("http server");
    let server = tokio::spawn(http.serve());

    let bootstrap: serde_json::Value = reqwest::get(format!("{origin}/api/bootstrap"))
        .await
        .expect("bootstrap")
        .json()
        .await
        .expect("json");
    let token = bootstrap["sessionToken"]
        .as_str()
        .expect("token")
        .to_string();
    assert_eq!(bootstrap["settings"]["deepseekWebEnabled"], false);
    assert_eq!(bootstrap["settings"]["glmWalletEnabled"], false);
    let client = reqwest::Client::new();

    for provider in ["glm", "deepseek"] {
        let refreshed = client
            .post(format!("{origin}/api/refresh/{provider}"))
            .header("x-session-token", &token)
            .send()
            .await
            .expect("refresh request");
        assert_eq!(refreshed.status(), reqwest::StatusCode::OK);
    }

    let snapshots: serde_json::Value = reqwest::get(format!("{origin}/api/snapshots"))
        .await
        .expect("snapshots")
        .json()
        .await
        .expect("json");
    assert!(
        !recorded_connections(&snapshots, "glm").contains(&"wallet".to_string()),
        "a switched-off wallet must leave no health record: {snapshots}"
    );
    assert!(
        !recorded_connections(&snapshots, "deepseek").contains(&"web".to_string()),
        "a switched-off web usage connection must leave no health record: {snapshots}"
    );
    // Nothing reached the console endpoints of the connection that is off.
    let before = requested.lock().expect("transport log").clone();
    assert!(
        before
            .iter()
            .all(|url| !url.contains("platform.deepseek.com")),
        "no request may be sent while the connection is off: {before:?}"
    );

    // The switch is what makes the connection attempt and report its own failure.
    let enabled = client
        .put(format!("{origin}/api/settings"))
        .header("x-session-token", &token)
        .json(&serde_json::json!({ "deepseekWebEnabled": true }))
        .send()
        .await
        .expect("settings request");
    assert_eq!(enabled.status(), reqwest::StatusCode::OK);
    let refreshed = client
        .post(format!("{origin}/api/refresh/deepseek"))
        .header("x-session-token", &token)
        .send()
        .await
        .expect("refresh request");
    assert_eq!(refreshed.status(), reqwest::StatusCode::OK);

    let snapshots: serde_json::Value = reqwest::get(format!("{origin}/api/snapshots"))
        .await
        .expect("snapshots")
        .json()
        .await
        .expect("json");
    assert!(
        recorded_connections(&snapshots, "deepseek").contains(&"web".to_string()),
        "an enabled connection reports its own state: {snapshots}"
    );
    // And it reports its own reason, rather than the "connection is disabled"
    // verdict the switch used to leave. Which reason that is depends on machine
    // state this test does not own — with no token stored the collector reports
    // the missing credential, with one stored the request itself fails — so what
    // is pinned here is the part that is behaviour: a genuine collection outcome
    // came back, never the disabled verdict.
    let detail = recorded_error(&snapshots, "deepseek", "web").unwrap_or_default();
    assert!(
        !detail.is_empty() && !detail.contains("disabled"),
        "the enabled connection reports its own failure, not a disabled verdict: {snapshots}"
    );

    running.shutdown().await;
    server.abort();
    let _ = server.await;
    drop(running);
    std::fs::remove_dir_all(&data_dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutations_require_the_session_token() {
    let data_dir = temp_data_dir();
    let transport: std::sync::Arc<dyn HttpTransport> = Arc::new(FailingTransport);
    let mut running = ServiceBuilder::with_transport(config(data_dir.clone()), transport)
        .start()
        .await
        .expect("service must start");
    let origin = running.origin();
    let http = running.take_http_server().expect("http server");
    let server = tokio::spawn(http.serve());

    let client = reqwest::Client::new();

    // Without a token the mutation is refused.
    let refused = client
        .put(format!("{origin}/api/settings"))
        .json(&serde_json::json!({ "glmRegion": "international" }))
        .send()
        .await
        .expect("request");
    assert_eq!(refused.status(), reqwest::StatusCode::FORBIDDEN);

    // With the token it succeeds.
    let bootstrap: serde_json::Value = reqwest::get(format!("{origin}/api/bootstrap"))
        .await
        .expect("bootstrap")
        .json()
        .await
        .expect("json");
    let token = bootstrap["sessionToken"]
        .as_str()
        .expect("token")
        .to_string();
    let accepted = client
        .put(format!("{origin}/api/settings"))
        .header("x-session-token", &token)
        .json(&serde_json::json!({
            "glmRegion": "international",
            "codexQuotaDisplay": "bar",
            "glmQuotaDisplay": "ring",
            "quotaValueMode": "used"
        }))
        .send()
        .await
        .expect("request");
    assert_eq!(accepted.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = accepted.json().await.expect("json");
    assert_eq!(body["glmRegion"], "international");
    assert_eq!(body["codexQuotaDisplay"], "bar");
    assert_eq!(body["glmQuotaDisplay"], "ring");
    assert_eq!(body["quotaValueMode"], "used");

    running.shutdown().await;
    server.abort();
    std::fs::remove_dir_all(&data_dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_launch_reports_the_existing_service() {
    let data_dir = temp_data_dir();
    let transport: std::sync::Arc<dyn HttpTransport> = Arc::new(FailingTransport);
    let mut running = ServiceBuilder::with_transport(config(data_dir.clone()), transport)
        .start()
        .await
        .expect("service must start");

    let second = ServiceBuilder::with_transport(
        config(data_dir.clone()),
        Arc::new(UnavailableHttpTransport),
    )
    .start()
    .await;

    match second {
        Err(ServiceError::AlreadyRunning { origin, .. }) => {
            assert!(origin.starts_with("http://127.0.0.1:"));
        }
        Err(other) => panic!("expected AlreadyRunning, got {other}"),
        Ok(_) => panic!("expected AlreadyRunning, got a running service"),
    }

    running.shutdown().await;
    // After shutdown the lock is released, so a fresh start succeeds again.
    let third = ServiceBuilder::with_transport(
        config(data_dir.clone()),
        Arc::new(UnavailableHttpTransport),
    )
    .start()
    .await;
    assert!(
        third.is_ok(),
        "shutdown must release the data-directory lock"
    );

    if let Ok(mut third) = third {
        third.shutdown().await;
    }
    std::fs::remove_dir_all(&data_dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_invalid_timezone_is_rejected() {
    let data_dir = temp_data_dir();
    let transport: std::sync::Arc<dyn HttpTransport> = Arc::new(FailingTransport);
    let mut running = ServiceBuilder::with_transport(config(data_dir.clone()), transport)
        .start()
        .await
        .expect("service must start");
    let origin = running.origin();
    let http = running.take_http_server().expect("http server");
    let server = tokio::spawn(http.serve());

    let bootstrap: serde_json::Value = reqwest::get(format!("{origin}/api/bootstrap"))
        .await
        .expect("bootstrap")
        .json()
        .await
        .expect("json");
    let token = bootstrap["sessionToken"]
        .as_str()
        .expect("token")
        .to_string();

    let response = reqwest::Client::new()
        .put(format!("{origin}/api/settings"))
        .header("x-session-token", token)
        .json(&serde_json::json!({ "timezone": "Not/AZone" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

    running.shutdown().await;
    server.abort();
    std::fs::remove_dir_all(&data_dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn theme_settings_are_validated_and_survive_restart() {
    let data_dir = temp_data_dir();
    let mut running =
        ServiceBuilder::with_transport(config(data_dir.clone()), Arc::new(FailingTransport))
            .start()
            .await
            .expect("service");
    let origin = running.origin();
    let server = tokio::spawn(running.take_http_server().unwrap().serve());
    let client = reqwest::Client::new();
    let bootstrap: serde_json::Value = client
        .get(format!("{origin}/api/bootstrap"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bootstrap["settings"]["theme"], "dark");
    let token = bootstrap["sessionToken"].as_str().unwrap();
    for theme in ["light", "dark", "system"] {
        let response = client
            .put(format!("{origin}/api/settings"))
            .header("x-session-token", token)
            .json(&serde_json::json!({ "theme": theme }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["theme"], theme);
    }
    let invalid = client
        .put(format!("{origin}/api/settings"))
        .header("x-session-token", token)
        .json(&serde_json::json!({ "theme": "sepia" }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), reqwest::StatusCode::BAD_REQUEST);
    running.shutdown().await;
    server.abort();
    let _ = server.await;
    drop(running);

    let mut restarted =
        ServiceBuilder::with_transport(config(data_dir.clone()), Arc::new(FailingTransport))
            .start()
            .await
            .expect("restart");
    let origin = restarted.origin();
    let server = tokio::spawn(restarted.take_http_server().unwrap().serve());
    let settings: serde_json::Value = client
        .get(format!("{origin}/api/settings"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(settings["theme"], "system");
    restarted.shutdown().await;
    server.abort();
    std::fs::remove_dir_all(data_dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deepseek_web_usage_is_off_by_default_and_round_trips() {
    let data_dir = temp_data_dir();
    let transport: std::sync::Arc<dyn HttpTransport> = Arc::new(FailingTransport);
    let mut running = ServiceBuilder::with_transport(config(data_dir.clone()), transport)
        .start()
        .await
        .expect("service must start");
    let origin = running.origin();
    let server = tokio::spawn(running.take_http_server().expect("http server").serve());

    let bootstrap: serde_json::Value = reqwest::get(format!("{origin}/api/bootstrap"))
        .await
        .expect("bootstrap")
        .json()
        .await
        .expect("json");
    let token = bootstrap["sessionToken"].as_str().expect("token").to_string();
    let client = reqwest::Client::new();

    // The experimental connection ships disabled: no collector may touch the
    // console endpoints until the user opts in. `configured` is deliberately not
    // asserted: whether a token is already in the keychain is machine state this
    // test does not own, while `enabled` is the settings flag under test.
    assert_eq!(bootstrap["settings"]["deepseekWebEnabled"], false);
    let web_status = bootstrap["settings"]["credentials"]
        .as_array()
        .expect("credentials")
        .iter()
        .find(|status| status["target"] == "deepseek-web")
        .expect("deepseek-web credential status must be reported");
    assert_eq!(web_status["enabled"], false);

    // The opt-in persists and flips the credential's enabled flag with it.
    let enabled = client
        .put(format!("{origin}/api/settings"))
        .header("x-session-token", &token)
        .json(&serde_json::json!({ "deepseekWebEnabled": true }))
        .send()
        .await
        .expect("request");
    assert_eq!(enabled.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = enabled.json().await.expect("json");
    assert_eq!(body["deepseekWebEnabled"], true);
    let web_status = body["credentials"]
        .as_array()
        .expect("credentials")
        .iter()
        .find(|status| status["target"] == "deepseek-web")
        .expect("deepseek-web credential status");
    assert_eq!(web_status["enabled"], true);

    // And it turns back off.
    let disabled = client
        .put(format!("{origin}/api/settings"))
        .header("x-session-token", &token)
        .json(&serde_json::json!({ "deepseekWebEnabled": false }))
        .send()
        .await
        .expect("request");
    let body: serde_json::Value = disabled.json().await.expect("json");
    assert_eq!(body["deepseekWebEnabled"], false);

    running.shutdown().await;
    server.abort();
    let _ = server.await;
    drop(running);
    std::fs::remove_dir_all(&data_dir).ok();
}

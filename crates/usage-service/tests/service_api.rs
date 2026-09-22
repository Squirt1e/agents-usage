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
async fn quota_warning_threshold_is_validated_without_losing_the_saved_value() {
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
    assert_eq!(bootstrap["settings"]["quotaWarningThreshold"], 10);
    let token = bootstrap["sessionToken"].as_str().unwrap();

    for threshold in [serde_json::json!(15), serde_json::json!(0)] {
        let response = client
            .put(format!("{origin}/api/settings"))
            .header("x-session-token", token)
            .json(&serde_json::json!({ "quotaWarningThreshold": threshold }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["quotaWarningThreshold"], threshold);
    }

    let saved = 0;
    for invalid in [
        serde_json::json!(-1),
        serde_json::json!(101),
        serde_json::json!(10.5),
        serde_json::json!("10"),
        serde_json::json!(true),
    ] {
        let response = client
            .put(format!("{origin}/api/settings"))
            .header("x-session-token", token)
            .json(&serde_json::json!({ "quotaWarningThreshold": invalid }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

        let settings: serde_json::Value = client
            .get(format!("{origin}/api/settings"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(settings["quotaWarningThreshold"], saved);
    }

    running.shutdown().await;
    server.abort();
    std::fs::remove_dir_all(data_dir).ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn balance_warning_threshold_accepts_decimals_and_preserves_the_saved_value_after_rejection() {
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
    assert_eq!(bootstrap["settings"]["balanceWarningThreshold"], 10.0);
    let token = bootstrap["sessionToken"].as_str().unwrap();

    for threshold in [serde_json::json!(12.5), serde_json::json!(0)] {
        let response = client
            .put(format!("{origin}/api/settings"))
            .header("x-session-token", token)
            .json(&serde_json::json!({ "balanceWarningThreshold": threshold }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["balanceWarningThreshold"].as_f64(), threshold.as_f64());
    }

    for invalid in [
        serde_json::json!(-1),
        serde_json::json!("10"),
        serde_json::json!(true),
    ] {
        let response = client
            .put(format!("{origin}/api/settings"))
            .header("x-session-token", token)
            .json(&serde_json::json!({ "balanceWarningThreshold": invalid }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

        let settings: serde_json::Value = client
            .get(format!("{origin}/api/settings"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(settings["balanceWarningThreshold"].as_f64(), Some(0.0));
    }

    running.shutdown().await;
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
/// A stand-in for the Codex CLI: it answers the version probe discovery runs and
/// nothing else, so a collector built from it fails while talking the app-server
/// protocol instead of being reported as a CLI that is not there.
fn fake_codex_cli(dir: &std::path::Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("codex");
    std::fs::write(
        &path,
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"codex-cli 9.9.9\"; exit 0; fi\nexit 1\n",
    )
    .expect("the fake CLI must be written");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
        .expect("the fake CLI must be executable");
    path
}

/// Put a stored CLI path in place before the service starts.
///
/// A *configured* path is reported as-is when it does not exist rather than
/// falling back to another binary, which is what makes the starting verdict
/// deterministic: auto-discovery would find whatever Codex the machine running
/// these tests happens to have on its `PATH`.
fn seed_stored_codex_path(data_dir: &std::path::Path, path: &str) {
    let directory = usage_core::storage::data_dir::DataDirectory::open(data_dir)
        .expect("the data directory must open");
    let mut store =
        usage_core::storage::Store::open(directory.database_path()).expect("the store must open");
    let mut settings = store
        .desktop_settings("Asia/Shanghai")
        .expect("settings must load");
    settings.codex_cli_path = Some(path.to_string());
    store
        .save_desktop_settings(&settings)
        .expect("settings must save");
}

/// Saving a CLI path has to take effect on the next collection.
///
/// The service used to resolve the Codex CLI once at startup: with no CLI at that
/// moment there was no collector at all, so every refresh skipped Codex and the
/// panel's "save the path" step only worked after quitting and reopening the app —
/// which is exactly the remedy a Finder launch cannot offer, and the only reason
/// the setting exists.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_codex_path_collects_without_restarting_the_service() {
    let data_dir = temp_data_dir();
    seed_stored_codex_path(&data_dir, "/definitely/missing/codex");
    let mut service_config = config(data_dir.clone());
    // The command line override wins over the stored path, and the stored path is
    // the one under test here.
    service_config.codex_cli_path = None;

    let transport: std::sync::Arc<dyn HttpTransport> = Arc::new(FailingTransport);
    let mut running = ServiceBuilder::with_transport(service_config, transport)
        .start()
        .await
        .expect("service must start");
    let origin = running.origin();
    let http = running.take_http_server().expect("http server");
    let server = tokio::spawn(http.serve());
    let client = reqwest::Client::new();

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

    // The service starts with a path that is not there, and says so.
    let snapshots: serde_json::Value = reqwest::get(format!("{origin}/api/snapshots"))
        .await
        .expect("snapshots")
        .json()
        .await
        .expect("json");
    let before = recorded_error(&snapshots, "codex", "account").expect("a recorded Codex failure");
    assert!(before.contains("/definitely/missing/codex"), "{before}");

    // The user saves the path to a CLI that is really there and asks for a refresh.
    let cli = fake_codex_cli(&data_dir);
    let saved = client
        .put(format!("{origin}/api/settings"))
        .header("x-session-token", &token)
        .json(&serde_json::json!({ "codexCliPath": cli.to_string_lossy() }))
        .send()
        .await
        .expect("settings write");
    assert_eq!(saved.status(), reqwest::StatusCode::OK);
    let refreshed = client
        .post(format!("{origin}/api/refresh/codex"))
        .header("x-session-token", &token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(refreshed.status(), reqwest::StatusCode::OK);

    // Without restarting anything, the next verdict is about the new path. The
    // stand-in cannot speak the app-server protocol, so the collection fails — with
    // an error that is no longer "the path you configured does not exist".
    let mut after = None;
    for _ in 0..50 {
        let snapshots: serde_json::Value = reqwest::get(format!("{origin}/api/snapshots"))
            .await
            .expect("snapshots")
            .json()
            .await
            .expect("json");
        after = recorded_error(&snapshots, "codex", "account");
        if after
            .as_deref()
            .is_some_and(|message| message != before.as_str())
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let after = after.expect("a recorded Codex failure");
    assert_ne!(after, before, "the saved path never reached the collector");
    assert!(!after.contains("does not exist"), "{after}");

    running.shutdown().await;
    server.abort();
    let _ = server.await;
    drop(running);
    std::fs::remove_dir_all(&data_dir).ok();
}

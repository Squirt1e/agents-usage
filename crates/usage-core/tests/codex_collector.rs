//! Codex collector conformance: protocol handling, quota normalization and CLI
//! discovery.
//!
//! These tests are the Rust half of the Codex migration (tasks 3.1-3.3). They
//! use three seams so no test needs a real Codex install or a signed-in account:
//!
//! - a scripted [`FakeTransport`] for the JSON-RPC layer,
//! - a real [`StdioRpcTransport`] over `/bin/sh` when the process lifecycle
//!   itself is under test,
//! - the shared fixtures in `fixtures/contracts/` for the normalization
//!   expectations that the TypeScript runtime pins as well, plus the rate-limit
//!   payloads in this crate's `tests/fixtures/` that only the Rust suite reads.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use usage_core::adapters::codex::cli::{
    discover_codex_cli, CodexCliDiscoveryOptions, CodexCliOrigin, COMMON_CODEX_CLI_LOCATIONS,
};
use usage_core::adapters::codex::json_rpc::{
    CloseHandler, CodexAppServerSupervisor, CodexSupervisorOptions, JsonRpcClient, MessageHandler,
    NotificationHandler, RpcMessage, RpcTransport, SharedRpcTransport, StdioRpcCommand,
    StdioRpcTransport, TransportFactory, APP_SERVER_ARGS,
};
use usage_core::adapters::codex::{
    codex_stale_snapshot, codex_unavailable_snapshot, normalize_codex_rate_limits,
    normalize_codex_usage, CodexAdapter, CodexCollector, CodexRpc, CollectionContext, ACCOUNT_READ,
    CODEX_SOURCE, RATE_LIMITS_READ, RATE_LIMITS_UPDATED, USAGE_READ,
};
use usage_core::contracts::{
    Confidence, ConnectionStatus, ErrorKind, IsoTimestamp, MetricDirection, MetricValue,
    ProviderId, ProviderSnapshot,
};
use usage_core::fixtures::load_fixture;
use usage_core::http::{CollectorError, CommandOutput, CommandRunner};

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The capture time every normalization test pins.
fn captured() -> IsoTimestamp {
    IsoTimestamp::parse("2026-09-10T08:00:00.000Z").expect("timestamp must parse")
}

fn context(local_day: &str) -> CollectionContext {
    CollectionContext::new(local_day, "Asia/Shanghai", captured())
}

async fn recv<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("a value must arrive within the test timeout")
        .expect("the channel must stay open")
}

// ---------------------------------------------------------------------------
// Scripted transport
// ---------------------------------------------------------------------------

#[derive(Default)]
struct FakeTransportState {
    sent: Vec<RpcMessage>,
    replies: HashMap<String, Value>,
    manual: HashSet<String>,
    answered: HashSet<i64>,
    message_handlers: Vec<MessageHandler>,
    close_handlers: Vec<CloseHandler>,
    closed: Option<CollectorError>,
}

/// An [`RpcTransport`] that answers requests from a script and lets a test emit
/// notifications, hold replies and simulate a process exit.
#[derive(Default)]
struct FakeTransport {
    state: Mutex<FakeTransportState>,
}

impl std::fmt::Debug for FakeTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FakeTransport")
            .finish_non_exhaustive()
    }
}

impl FakeTransport {
    fn reply(&self, method: &str, result: Value) {
        lock(&self.state).replies.insert(method.to_string(), result);
    }

    /// Require an explicit [`FakeTransport::respond`] for this method.
    fn hold(&self, method: &str) {
        lock(&self.state).manual.insert(method.to_string());
    }

    fn sent(&self) -> Vec<RpcMessage> {
        lock(&self.state).sent.clone()
    }

    fn sent_methods(&self) -> Vec<String> {
        self.sent()
            .into_iter()
            .filter_map(|message| message.method)
            .collect()
    }

    /// Ask whether a message for `method` has been sent, waiting up to two
    /// seconds. Used instead of sleeping so the tests stay fast and deterministic.
    async fn await_sent(&self, method: &str) -> RpcMessage {
        for _ in 0..400 {
            if let Some(message) = self
                .sent()
                .into_iter()
                .find(|message| message.method.as_deref() == Some(method))
            {
                return message;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("{method} was never sent");
    }

    fn emit(&self, message: RpcMessage) {
        let handlers = lock(&self.state).message_handlers.clone();
        for handler in handlers {
            handler(message.clone());
        }
    }

    fn emit_notification(&self, method: &str, params: Value) {
        self.emit(RpcMessage::notification_with_params(method, params));
    }

    /// Answer the earliest unanswered request for `method`.
    fn respond(&self, method: &str, result: Value) {
        let (handlers, response) = {
            let mut state = lock(&self.state);
            let target = state
                .sent
                .iter()
                .filter(|message| message.method.as_deref() == Some(method))
                .filter_map(RpcMessage::numeric_id)
                .find(|id| !state.answered.contains(id));
            match target {
                Some(id) => {
                    state.answered.insert(id);
                    (
                        state.message_handlers.clone(),
                        Some(RpcMessage {
                            id: Some(Value::from(id)),
                            result: Some(result),
                            ..RpcMessage::default()
                        }),
                    )
                }
                None => (Vec::new(), None),
            }
        };
        if let Some(response) = response {
            for handler in handlers {
                handler(response.clone());
            }
        }
    }

    /// Report that the session died, failing every pending request.
    fn fail(&self, error: CollectorError) {
        let handlers = {
            let mut state = lock(&self.state);
            state.closed = Some(error.clone());
            state.close_handlers.clone()
        };
        for handler in handlers {
            handler(error.clone());
        }
    }
}

impl RpcTransport for FakeTransport {
    fn send(&self, message: RpcMessage) -> Result<(), CollectorError> {
        let (handlers, response) = {
            let mut state = lock(&self.state);
            if let Some(error) = state.closed.clone() {
                return Err(error);
            }
            state.sent.push(message.clone());

            let mut response = None;
            if let Some(id) = message.numeric_id() {
                if let Some(method) = message.method.as_deref() {
                    if !state.manual.contains(method) {
                        if let Some(result) = state.replies.get(method).cloned() {
                            state.answered.insert(id);
                            response = Some(RpcMessage {
                                id: Some(Value::from(id)),
                                result: Some(result),
                                ..RpcMessage::default()
                            });
                        }
                    }
                }
            }
            (state.message_handlers.clone(), response)
        };
        if let Some(response) = response {
            for handler in handlers {
                handler(response.clone());
            }
        }
        Ok(())
    }

    fn on_message(&self, handler: MessageHandler) {
        lock(&self.state).message_handlers.push(handler);
    }

    fn on_close(&self, handler: CloseHandler) {
        if let Some(error) = lock(&self.state).closed.clone() {
            handler(error);
            return;
        }
        lock(&self.state).close_handlers.push(handler);
    }

    fn close(&self) {
        self.fail(CollectorError::new(
            ErrorKind::Process,
            "Codex app-server closed",
        ));
    }
}

fn shared(transport: &Arc<FakeTransport>) -> SharedRpcTransport {
    Arc::clone(transport) as SharedRpcTransport
}

// ---------------------------------------------------------------------------
// Scripted RPC facade
// ---------------------------------------------------------------------------

#[derive(Default)]
struct FakeRpcState {
    calls: Vec<String>,
    responses: HashMap<String, Result<Value, CollectorError>>,
    notifications: HashMap<String, Vec<NotificationHandler>>,
}

/// A [`CodexRpc`] fake: scripted responses, recorded calls and controllable
/// notifications.
#[derive(Default)]
struct FakeRpc {
    state: Mutex<FakeRpcState>,
}

impl std::fmt::Debug for FakeRpc {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("FakeRpc").finish_non_exhaustive()
    }
}

impl FakeRpc {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn reply(&self, method: &str, value: Value) {
        lock(&self.state)
            .responses
            .insert(method.to_string(), Ok(value));
    }

    fn fail(&self, method: &str, error: CollectorError) {
        lock(&self.state)
            .responses
            .insert(method.to_string(), Err(error));
    }

    fn calls(&self) -> Vec<String> {
        lock(&self.state).calls.clone()
    }

    fn registered_methods(&self) -> Vec<String> {
        let mut methods: Vec<String> = lock(&self.state).notifications.keys().cloned().collect();
        methods.sort();
        methods
    }

    fn emit_notification(&self, method: &str, params: Value) {
        let handlers = lock(&self.state)
            .notifications
            .get(method)
            .cloned()
            .unwrap_or_default();
        for handler in handlers {
            handler(params.clone());
        }
    }
}

impl CodexRpc for FakeRpc {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, CollectorError>> + Send + 'a>> {
        let outcome = {
            let mut state = lock(&self.state);
            state.calls.push(method.to_string());
            state.responses.get(method).cloned()
        };
        let method = method.to_string();
        Box::pin(async move {
            let _ = params;
            outcome.unwrap_or_else(|| {
                Err(CollectorError::compatibility(format!(
                    "unexpected method {method}"
                )))
            })
        })
    }

    fn on_notification(&self, method: &str, handler: NotificationHandler) {
        lock(&self.state)
            .notifications
            .entry(method.to_string())
            .or_default()
            .push(handler);
    }
}

// ---------------------------------------------------------------------------
// Shared fixture access
// ---------------------------------------------------------------------------

fn fixture(name: &str) -> Value {
    load_fixture(name)
}

/// Rate-limit payload snapshots kept next to this crate's integration tests;
/// the TypeScript suite pins the shared corpus, not these files.
fn crate_fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

fn codex_windows_input() -> Value {
    fixture("codex-windows")["input"].clone()
}

fn account_payload() -> Value {
    json!({ "account": { "type": "chatgpt" }, "requiresOpenaiAuth": true })
}

fn snapshot_from_windows() -> ProviderSnapshot {
    normalize_codex_rate_limits(&codex_windows_input(), &captured())
        .expect("fixture must normalize")
}

fn other_provider_snapshot() -> ProviderSnapshot {
    // Stands in for a GLM/DeepSeek refresh that must keep working while Codex is
    // unavailable.
    serde_json::from_value(json!({
        "provider": "glm",
        "connection": { "provider": "glm", "connection": "quota", "label": "Coding Plan" },
        "status": "connected",
        "capturedAt": "2026-09-10T08:00:00.000Z",
        "lastSuccessAt": "2026-09-10T08:00:00.000Z",
        "source": "glm-monitor",
        "metrics": [{
            "key": "quota.5h.used",
            "value": 28,
            "unit": "percent",
            "direction": "used",
            "confidence": ["authoritative"],
            "source": "glm-monitor"
        }]
    }))
    .expect("the other provider snapshot must parse")
}

// ---------------------------------------------------------------------------
// 3.1 protocol: handshake, correlation, notifications, timeouts, process exit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn initialize_sends_the_handshake_then_the_initialized_notification() {
    let transport = Arc::new(FakeTransport::default());
    transport.reply(
        "initialize",
        json!({
            "userAgent": "codex-cli/0.152.0",
            "codexHome": "/tmp/codex",
            "platformFamily": "unix",
            "platformOs": "macos"
        }),
    );

    let client = JsonRpcClient::new(shared(&transport), Some(Duration::from_secs(5)));
    let result = client
        .initialize(usage_core::adapters::codex::ClientInfo::new(
            "agents-usage",
            "0.1.0",
        ))
        .await
        .expect("the handshake must succeed");
    assert_eq!(result["platformOs"], json!("macos"));

    let sent = transport.sent();
    assert_eq!(
        sent.len(),
        2,
        "the handshake is a request plus a notification"
    );
    assert_eq!(sent[0].numeric_id(), Some(1));
    assert_eq!(sent[0].method.as_deref(), Some("initialize"));
    let params = sent[0].params.clone().expect("initialize carries params");
    assert_eq!(params["clientInfo"]["name"], json!("agents-usage"));
    assert_eq!(params["clientInfo"]["version"], json!("0.1.0"));
    assert_eq!(params["capabilities"], Value::Null);
    // Exactly the TypeScript shape: a notification with no id and no params key.
    assert_eq!(sent[1], RpcMessage::notification("initialized"));
    assert_eq!(
        serde_json::to_value(&sent[1]).expect("serializes"),
        json!({ "method": "initialized" })
    );
    assert_eq!(client.pending_count(), 0);
}

#[tokio::test]
async fn concurrent_requests_are_correlated_by_id_not_by_order() {
    let transport = Arc::new(FakeTransport::default());
    transport.hold("alpha");
    transport.hold("beta");
    let client = JsonRpcClient::new(shared(&transport), Some(Duration::from_secs(5)));

    let alpha = tokio::spawn({
        let client = Arc::clone(&client);
        async move { client.request("alpha", json!({})).await }
    });
    let beta = tokio::spawn({
        let client = Arc::clone(&client);
        async move { client.request("beta", json!({})).await }
    });

    transport.await_sent("alpha").await;
    transport.await_sent("beta").await;
    assert_eq!(client.pending_count(), 2, "both requests are in flight");

    let ids: Vec<i64> = transport
        .sent()
        .iter()
        .filter_map(RpcMessage::numeric_id)
        .collect();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1], "concurrent ids must be unique");

    // Answer the second request first: correlation must follow the id.
    transport.respond("beta", json!({ "who": "beta" }));
    transport.respond("alpha", json!({ "who": "alpha" }));

    let alpha = tokio::time::timeout(Duration::from_secs(5), alpha)
        .await
        .expect("alpha must resolve")
        .expect("the task must not panic")
        .expect("alpha must succeed");
    let beta = tokio::time::timeout(Duration::from_secs(5), beta)
        .await
        .expect("beta must resolve")
        .expect("the task must not panic")
        .expect("beta must succeed");
    assert_eq!(alpha["who"], json!("alpha"));
    assert_eq!(beta["who"], json!("beta"));
    assert_eq!(client.pending_count(), 0);
}

#[tokio::test]
async fn notifications_are_dispatched_by_method() {
    let transport = Arc::new(FakeTransport::default());
    let client = JsonRpcClient::new(shared(&transport), Some(Duration::from_secs(5)));

    let (tx, mut rx) = mpsc::unbounded_channel();
    client.on_notification(
        RATE_LIMITS_UPDATED,
        Arc::new(move |params| {
            let _ = tx.send(params);
        }),
    );

    transport.emit_notification(
        RATE_LIMITS_UPDATED,
        json!({ "rateLimits": { "primary": { "usedPercent": 8 } } }),
    );
    let params = recv(&mut rx).await;
    assert_eq!(params["rateLimits"]["primary"]["usedPercent"], json!(8));

    // A notification for a method nobody registered is dropped, not fatal.
    transport.emit_notification("codex/something-new", json!({}));
    assert!(!client.is_closed());

    let pending = tokio::spawn({
        let client = Arc::clone(&client);
        async move { client.request("silent", json!({})).await }
    });
    transport.await_sent("silent").await;
    transport.emit_notification(RATE_LIMITS_UPDATED, json!({ "sequence": 2 }));
    assert_eq!(recv(&mut rx).await["sequence"], json!(2));
    assert_eq!(
        client.pending_count(),
        1,
        "a notification must not resolve a pending request"
    );
    pending.abort();
}

#[tokio::test]
async fn a_silent_transport_times_out_with_a_network_error() {
    let transport = Arc::new(FakeTransport::default());
    let client = JsonRpcClient::new(shared(&transport), None);

    let error = client
        .request_with_timeout("account/read", json!({}), Some(Duration::from_millis(40)))
        .await
        .expect_err("a silent transport must not hang the caller");
    assert_eq!(error.kind, ErrorKind::Network);
    assert!(error.message.contains("Codex app-server request timed out"));
    assert_eq!(
        error.diagnostic.get("method").map(String::as_str),
        Some("account/read")
    );
    assert_eq!(
        client.pending_count(),
        0,
        "the timed-out request is dropped"
    );

    // A response that arrives after the timeout is ignored, and the session stays
    // usable for the next request.
    transport.respond("account/read", json!({ "late": true }));
    transport.reply(RATE_LIMITS_READ, json!({ "ok": true }));
    let result = client
        .request_with_timeout(RATE_LIMITS_READ, json!({}), Some(Duration::from_secs(2)))
        .await
        .expect("the session must keep working after a timeout");
    assert_eq!(result["ok"], json!(true));
}

#[tokio::test]
async fn a_process_exit_fails_the_pending_request_and_keeps_the_previous_snapshot() {
    let transport = StdioRpcTransport::spawn(StdioRpcCommand::new(
        "/bin/sh",
        vec![
            "-c".to_string(),
            "printf '{\"id\":1,\"result\":{\"userAgent\":\"codex-cli/0.152.0\"}}\\n'; sleep 0.4; \
             printf 'app-server crashed: api_key=not-a-real-key\\n' >&2; exit 7"
                .to_string(),
        ],
    ))
    .expect("the script must start");

    let client = JsonRpcClient::new(
        transport as SharedRpcTransport,
        Some(Duration::from_secs(5)),
    );
    let handshake = client
        .initialize(usage_core::adapters::codex::ClientInfo::default())
        .await
        .expect("the handshake must succeed before the crash");
    assert_eq!(handshake["userAgent"], json!("codex-cli/0.152.0"));

    let error = client
        .request(RATE_LIMITS_READ, json!({}))
        .await
        .expect_err("the exit must fail the pending request");
    assert_eq!(error.kind, ErrorKind::Process);
    assert!(error.message.contains("exited (7)"), "{}", error.message);
    assert!(
        error.message.contains("app-server crashed"),
        "{}",
        error.message
    );
    assert!(
        !error.message.contains("not-a-real-key"),
        "process output must be redacted: {}",
        error.message
    );
    assert!(client.is_closed());

    // The caller keeps the last good snapshot and marks it stale.
    let previous = snapshot_from_windows();
    let stale = codex_stale_snapshot(&previous, &error, &captured());
    assert_eq!(stale.status, ConnectionStatus::Degraded);
    assert_eq!(stale.captured_at, previous.captured_at);
    assert_eq!(stale.last_success_at, previous.last_success_at);
    assert_eq!(stale.metrics.len(), previous.metrics.len());
    let used = stale
        .metric("codex.primary.used")
        .expect("the previous value is kept");
    assert_eq!(used.value.as_number(), Some(15.0));
    assert!(used.has_confidence(Confidence::Stale));
    assert!(used.has_confidence(Confidence::Authoritative));
    assert_eq!(
        stale.error.as_ref().map(|error| error.kind),
        Some(ErrorKind::Process)
    );
}

#[tokio::test]
async fn codex_reconnect_does_not_stop_other_providers() {
    let failing = Arc::new(FakeTransport::default());
    failing.fail(CollectorError::new(
        ErrorKind::Process,
        "Codex app-server exited (127)",
    ));

    let factory: TransportFactory = Arc::new({
        let failing = Arc::clone(&failing);
        move || -> Result<SharedRpcTransport, CollectorError> { Ok(shared(&failing)) }
    });
    let supervisor = CodexAppServerSupervisor::with_transport_factory(
        factory,
        CodexSupervisorOptions::immediate(),
    );
    let adapter = CodexAdapter::new(Arc::clone(&supervisor) as Arc<dyn CodexRpc>);

    // The Codex refresh fails while an unrelated provider refresh completes.
    let collection = context("2026-09-10");
    let (codex, other) = tokio::join!(adapter.refresh(&collection), async {
        tokio::time::sleep(Duration::from_millis(5)).await;
        other_provider_snapshot()
    });

    let error = codex.expect_err("a dead app-server must be reported, not retried forever");
    assert_eq!(error.kind, ErrorKind::Process);
    assert_eq!(other.status, ConnectionStatus::Connected);
    assert_eq!(other.provider, ProviderId::Glm);
    assert_eq!(
        other
            .metric("quota.5h.used")
            .and_then(|metric| metric.value.as_number()),
        Some(28.0)
    );

    // Codex reports its own state without touching anyone else's metrics.
    let unavailable = codex_unavailable_snapshot(&error, &captured());
    assert_eq!(unavailable.status, ConnectionStatus::Unavailable);
    assert_eq!(
        unavailable
            .connection
            .as_ref()
            .map(|connection| connection.key()),
        Some("codex:account".to_string())
    );
    assert!(unavailable.metrics.is_empty());
    assert_eq!(unavailable.source, CODEX_SOURCE);
}

#[tokio::test]
async fn a_broken_session_is_replaced_after_a_bounded_backoff_and_keeps_working() {
    let first = Arc::new(FakeTransport::default());
    let second = Arc::new(FakeTransport::default());
    first.reply("initialize", json!({ "platformOs": "macos" }));
    second.reply("initialize", json!({ "platformOs": "macos" }));
    second.reply(ACCOUNT_READ, account_payload());
    second.reply(RATE_LIMITS_READ, codex_windows_input());
    // `first` is silent for account/read, so the request stays in flight until it
    // is failed below.

    let available: Arc<Mutex<Vec<Arc<FakeTransport>>>> =
        Arc::new(Mutex::new(vec![Arc::clone(&first), Arc::clone(&second)]));
    let factory: TransportFactory = Arc::new({
        let available = Arc::clone(&available);
        move || -> Result<SharedRpcTransport, CollectorError> {
            let next = {
                let mut queue = lock(&available);
                if queue.is_empty() {
                    None
                } else {
                    Some(queue.remove(0))
                }
            };
            match next {
                Some(transport) => Ok(shared(&transport)),
                None => Err(CollectorError::new(
                    ErrorKind::Process,
                    "no more transports",
                )),
            }
        }
    });

    let waits: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
    let sleep: usage_core::adapters::codex::SleepFn = Arc::new({
        let waits = Arc::clone(&waits);
        move |duration: Duration| {
            lock(&waits).push(duration.as_millis() as u64);
            let ready: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(std::future::ready(()));
            ready
        }
    });

    let supervisor = CodexAppServerSupervisor::with_transport_factory(
        factory,
        CodexSupervisorOptions {
            base_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_millis(1_000),
            sleep: Some(sleep),
            ..CodexSupervisorOptions::default()
        },
    );

    let request = tokio::spawn({
        let supervisor = Arc::clone(&supervisor);
        async move { supervisor.request(ACCOUNT_READ, json!({})).await }
    });
    first.await_sent(ACCOUNT_READ).await;
    first.fail(CollectorError::new(
        ErrorKind::Process,
        "Codex app-server exited (1): crash",
    ));

    let result = tokio::time::timeout(Duration::from_secs(5), request)
        .await
        .expect("the retry must finish")
        .expect("the task must not panic")
        .expect("the retry must succeed on the second session");
    assert_eq!(result["account"]["type"], json!("chatgpt"));

    assert_eq!(
        *lock(&waits),
        vec![250],
        "the first retry waits the base delay"
    );
    assert_eq!(
        second.sent_methods(),
        vec!["initialize", "initialized", ACCOUNT_READ],
        "the replacement session runs a fresh handshake"
    );

    // Continued operation: the same session serves the next request.
    let limits = supervisor
        .request(RATE_LIMITS_READ, json!({}))
        .await
        .expect("the reconnected session keeps working");
    assert_eq!(
        limits["rateLimitsByLimitId"]["codex"]["primary"]["usedPercent"],
        json!(15)
    );
    assert_eq!(
        second
            .sent_methods()
            .iter()
            .filter(|method| method.as_str() == "initialize")
            .count(),
        1,
        "an existing session is reused instead of reconnecting per request"
    );
}

#[tokio::test]
async fn notification_handlers_are_re_registered_after_a_reconnect() {
    let first = Arc::new(FakeTransport::default());
    let second = Arc::new(FakeTransport::default());
    for transport in [&first, &second] {
        transport.reply("initialize", json!({ "platformOs": "macos" }));
        transport.reply(ACCOUNT_READ, account_payload());
    }

    let queue: Arc<Mutex<Vec<Arc<FakeTransport>>>> =
        Arc::new(Mutex::new(vec![Arc::clone(&first), Arc::clone(&second)]));
    let factory: TransportFactory = Arc::new({
        let queue = Arc::clone(&queue);
        move || -> Result<SharedRpcTransport, CollectorError> {
            let next = {
                let mut queue = lock(&queue);
                if queue.is_empty() {
                    None
                } else {
                    Some(queue.remove(0))
                }
            };
            next.map(|transport| shared(&transport))
                .ok_or_else(|| CollectorError::new(ErrorKind::Process, "no more transports"))
        }
    });
    let supervisor = CodexAppServerSupervisor::with_transport_factory(
        factory,
        CodexSupervisorOptions::immediate(),
    );

    let (tx, mut rx) = mpsc::unbounded_channel();
    supervisor.on_notification(
        RATE_LIMITS_UPDATED,
        Arc::new(move |params| {
            let _ = tx.send(params);
        }),
    );

    supervisor
        .request(ACCOUNT_READ, json!({}))
        .await
        .expect("first session");
    first.emit_notification(RATE_LIMITS_UPDATED, json!({ "session": 1 }));
    assert_eq!(recv(&mut rx).await["session"], json!(1));

    // After a reconnect the handler is registered on the new session, so a quota
    // notification still reaches the adapter.
    supervisor.invalidate().await;
    supervisor
        .request(ACCOUNT_READ, json!({}))
        .await
        .expect("second session");
    second.emit_notification(RATE_LIMITS_UPDATED, json!({ "session": 2 }));
    assert_eq!(recv(&mut rx).await["session"], json!(2));

    // A handler added while a session is live is attached to it immediately.
    let (late_tx, mut late_rx) = mpsc::unbounded_channel();
    supervisor.on_notification(
        RATE_LIMITS_UPDATED,
        Arc::new(move |params| {
            let _ = late_tx.send(params);
        }),
    );
    second.emit_notification(RATE_LIMITS_UPDATED, json!({ "session": 3 }));
    assert_eq!(recv(&mut rx).await["session"], json!(3));
    assert_eq!(recv(&mut late_rx).await["session"], json!(3));
}

// ---------------------------------------------------------------------------
// 3.2 normalization and supervised retry
// ---------------------------------------------------------------------------

#[tokio::test]
async fn refresh_normalizes_quota_plus_optional_activity() {
    let rpc = FakeRpc::new();
    rpc.reply(ACCOUNT_READ, account_payload());
    rpc.reply(RATE_LIMITS_READ, codex_windows_input());
    rpc.reply(
        USAGE_READ,
        json!({
            "summary": { "lifetimeTokens": 1_000_000, "currentStreakDays": 3 },
            "dailyUsageBuckets": [{ "startDate": "2026-09-10", "tokens": 42_000 }]
        }),
    );

    let adapter = CodexAdapter::new(Arc::clone(&rpc) as Arc<dyn CodexRpc>);
    let snapshot = adapter
        .refresh(&context("2026-09-10"))
        .await
        .expect("refresh must succeed");

    assert_eq!(snapshot.provider, ProviderId::Codex);
    assert_eq!(snapshot.source, CODEX_SOURCE);
    assert_eq!(snapshot.status, ConnectionStatus::Connected);
    assert_eq!(
        snapshot
            .connection
            .as_ref()
            .map(|connection| connection.key()),
        Some("codex:account".to_string())
    );
    assert_eq!(snapshot.last_success_at, Some(captured()));
    assert_eq!(
        snapshot
            .metric("codex.primary.used")
            .and_then(|metric| metric.value.as_number()),
        Some(15.0)
    );
    assert_eq!(
        snapshot
            .metric("activity.daily.tokens")
            .and_then(|metric| metric.value.as_number()),
        Some(42_000.0)
    );
    assert_eq!(
        snapshot
            .metric("activity.lifetime.tokens")
            .and_then(|metric| metric.value.as_number()),
        Some(1_000_000.0)
    );
    assert_eq!(
        rpc.calls(),
        vec![ACCOUNT_READ, RATE_LIMITS_READ, USAGE_READ]
    );
    // The notification subscription the adapter relies on is registered.
    assert_eq!(
        rpc.registered_methods(),
        vec![RATE_LIMITS_UPDATED.to_string()]
    );
}

#[tokio::test]
async fn a_failed_optional_activity_call_keeps_the_quota_metrics() {
    let rpc = FakeRpc::new();
    rpc.reply(ACCOUNT_READ, account_payload());
    rpc.reply(RATE_LIMITS_READ, codex_windows_input());
    rpc.fail(
        USAGE_READ,
        CollectorError::network("activity endpoint is offline"),
    );
    let adapter = CodexAdapter::new(Arc::clone(&rpc) as Arc<dyn CodexRpc>);

    let snapshot = adapter
        .refresh(&context("2026-09-10"))
        .await
        .expect("quota must survive");
    assert!(snapshot.metric("codex.primary.used").is_some());
    assert!(snapshot.metric("activity.daily.tokens").is_none());
    assert!(snapshot.metric("activity.lifetime.tokens").is_none());

    // The same is true for a malformed activity payload.
    let rpc = FakeRpc::new();
    rpc.reply(ACCOUNT_READ, account_payload());
    rpc.reply(RATE_LIMITS_READ, codex_windows_input());
    rpc.reply(USAGE_READ, json!({ "dailyUsageBuckets": "not-an-array" }));
    let adapter = CodexAdapter::new(Arc::clone(&rpc) as Arc<dyn CodexRpc>);
    let snapshot = adapter
        .refresh(&context("2026-09-10"))
        .await
        .expect("quota must survive");
    assert!(snapshot.metric("codex.primary.used").is_some());
    assert!(snapshot.metric("activity.daily.tokens").is_none());
}

#[tokio::test]
async fn a_rate_limit_notification_triggers_a_fresh_refresh() {
    let rpc = FakeRpc::new();
    rpc.reply(ACCOUNT_READ, account_payload());
    rpc.reply(
        RATE_LIMITS_READ,
        json!({ "rateLimitsByLimitId": { "codex": { "limitId": "codex", "primary": { "usedPercent": 20, "windowDurationMins": 300 } } } }),
    );
    let adapter = CodexAdapter::new(Arc::clone(&rpc) as Arc<dyn CodexRpc>);

    let observed: Arc<Mutex<Vec<f64>>> = Arc::new(Mutex::new(Vec::new()));
    let handler = Arc::clone(&adapter);
    let sink = Arc::clone(&observed);
    adapter.on_rate_limits_updated(Arc::new(move || {
        let handler = Arc::clone(&handler);
        let sink = Arc::clone(&sink);
        tokio::spawn(async move {
            if let Ok(snapshot) = handler.refresh(&context("2026-09-10")).await {
                if let Some(value) = snapshot
                    .metric("codex.primary.used")
                    .and_then(|metric| metric.value.as_number())
                {
                    lock(&sink).push(value);
                }
            }
        });
    }));

    let first = adapter
        .refresh(&context("2026-09-10"))
        .await
        .expect("initial refresh");
    assert_eq!(
        first
            .metric("codex.primary.used")
            .and_then(|metric| metric.value.as_number()),
        Some(20.0)
    );

    // Codex reports that the window moved; the adapter must refresh without the
    // user reopening anything.
    rpc.reply(
        RATE_LIMITS_READ,
        json!({ "rateLimitsByLimitId": { "codex": { "limitId": "codex", "primary": { "usedPercent": 44, "windowDurationMins": 300 } } } }),
    );
    rpc.emit_notification(
        RATE_LIMITS_UPDATED,
        json!({ "rateLimits": { "primary": { "usedPercent": 44 } } }),
    );

    for _ in 0..200 {
        if !lock(&observed).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(*lock(&observed), vec![44.0]);
}

#[tokio::test]
async fn a_signed_out_account_is_an_authentication_failure() {
    let rpc = FakeRpc::new();
    rpc.reply(
        ACCOUNT_READ,
        json!({ "account": null, "requiresOpenaiAuth": true }),
    );
    let adapter = CodexAdapter::new(Arc::clone(&rpc) as Arc<dyn CodexRpc>);

    let error = adapter
        .refresh(&context("2026-09-10"))
        .await
        .expect_err("a signed-out account must fail");
    assert_eq!(error.kind, ErrorKind::Authentication);
    assert!(error.message.contains("Codex is not signed in"));
    assert!(error.message.contains("sign-in"), "{}", error.message);
    assert_eq!(
        rpc.calls(),
        vec![ACCOUNT_READ],
        "nothing else is queried while signed out"
    );

    // The failure is reported for Codex alone.
    let snapshot = codex_unavailable_snapshot(&error, &captured());
    assert_eq!(snapshot.status, ConnectionStatus::Disconnected);
    assert!(snapshot.metrics.is_empty());
}

#[tokio::test]
async fn an_incompatible_rate_limit_payload_never_becomes_zero() {
    let incompatible = fixture("codex-windows")["incompatibleInput"]["value"].clone();
    let error = normalize_codex_rate_limits(&incompatible, &captured())
        .expect_err("the payload must be rejected");
    assert_eq!(error.kind, ErrorKind::Compatibility);

    let rpc = FakeRpc::new();
    rpc.reply(ACCOUNT_READ, account_payload());
    rpc.reply(RATE_LIMITS_READ, incompatible);
    let adapter = CodexAdapter::new(Arc::clone(&rpc) as Arc<dyn CodexRpc>);
    let error = adapter
        .refresh(&context("2026-09-10"))
        .await
        .expect_err("an incompatible payload must not produce a snapshot");
    assert_eq!(error.kind, ErrorKind::Compatibility);
    assert!(error.message.contains("usedPercent"), "{}", error.message);

    // The caller keeps the previous snapshot, values included, instead of zeroes.
    let previous = snapshot_from_windows();
    let stale = codex_stale_snapshot(&previous, &error, &captured());
    assert_eq!(
        stale
            .metric("codex.primary.used")
            .and_then(|metric| metric.value.as_number()),
        Some(15.0)
    );
    assert_eq!(
        stale
            .metric("codex.secondary.used")
            .and_then(|metric| metric.value.as_number()),
        Some(45.0)
    );
    assert_eq!(stale.status, ConnectionStatus::Degraded);
}

#[tokio::test]
async fn unknown_and_out_of_order_windows_are_normalized_from_their_own_metadata() {
    let payload = json!({
        "rateLimitsByLimitId": {
            // No limitId at all: the bucket key becomes the id.
            "team-seat": {
                "limitName": "Team seat",
                "secondary": { "usedPercent": 10, "windowDurationMins": 1440, "resetsAt": 1_789_600_000 }
            },
            // Windows in the unexpected order: the weekly window is `primary`
            // and the five-hour window is `secondary`.
            "upside-down": {
                "limitId": "upside-down",
                "primary": { "usedPercent": 30, "windowDurationMins": 10080, "resetsAt": 1_789_600_000 },
                "secondary": { "usedPercent": 60, "windowDurationMins": 300, "resetsAt": 1_789_000_000 }
            },
            // An empty limitId is as good as absent.
            "future-bucket": {
                "limitId": "   ",
                "limitName": "Future bucket",
                "primary": { "usedPercent": 5, "windowDurationMins": null, "resetsAt": null },
                "tertiary": { "usedPercent": 99, "windowDurationMins": 60 }
            },
            // This bucket must survive whatever happens to the others.
            "codex": {
                "limitId": "codex",
                "primary": { "usedPercent": 15, "windowDurationMins": 300, "resetsAt": 1_789_000_000 }
            }
        }
    });

    let snapshot =
        normalize_codex_rate_limits(&payload, &captured()).expect("every bucket must normalize");

    let seat = snapshot
        .metric("team-seat.secondary.used")
        .expect("key-derived bucket id");
    assert_eq!(seat.value.as_number(), Some(10.0));
    assert_eq!(seat.window_seconds, Some(86_400));
    assert!(snapshot.metric("team-seat.primary.used").is_none());
    assert_eq!(
        seat.details
            .as_ref()
            .and_then(|details| details.get("bucketId")),
        Some(&Value::String("team-seat".to_string()))
    );

    // Each window keeps its own length and reset time, whatever the order.
    let weekly_primary = snapshot
        .metric("upside-down.primary.used")
        .expect("primary window");
    assert_eq!(weekly_primary.window_seconds, Some(604_800));
    assert_eq!(
        weekly_primary.reset_at.as_ref().map(|value| value.as_str()),
        Some("2026-09-16T23:06:40.000Z")
    );
    let short_secondary = snapshot
        .metric("upside-down.secondary.used")
        .expect("secondary window");
    assert_eq!(short_secondary.window_seconds, Some(18_000));
    assert_eq!(
        short_secondary
            .reset_at
            .as_ref()
            .map(|value| value.as_str()),
        Some("2026-09-10T00:26:40.000Z")
    );
    assert_eq!(short_secondary.direction, MetricDirection::Used);

    // An unknown window length and reset time stay missing, and the bucket is
    // still normalized from what it did report.
    let future = snapshot
        .metric("future-bucket.primary.used")
        .expect("bucket id falls back to the key");
    assert_eq!(future.value.as_number(), Some(5.0));
    assert_eq!(future.window_seconds, None);
    assert_eq!(future.reset_at, None);
    assert!(snapshot.metric("future-bucket.tertiary.used").is_none());

    // The healthy bucket is untouched.
    assert_eq!(
        snapshot
            .metric("codex.primary.used")
            .and_then(|metric| metric.value.as_number()),
        Some(15.0)
    );
    assert_eq!(
        snapshot
            .metric("codex.primary.remaining")
            .and_then(|metric| metric.value.as_number()),
        Some(85.0)
    );
}

// ---------------------------------------------------------------------------
// Fixture-driven golden expectations
// ---------------------------------------------------------------------------

#[test]
fn the_codex_windows_fixture_matches_the_shared_expectations() {
    let windows = fixture("codex-windows");
    let expect = &windows["expect"];
    let snapshot = normalize_codex_rate_limits(&windows["input"], &captured())
        .expect("fixture must normalize");

    assert_eq!(snapshot.provider, ProviderId::Codex);
    assert_eq!(
        snapshot.source,
        windows["source"].as_str().unwrap_or(CODEX_SOURCE)
    );
    assert_eq!(snapshot.status, ConnectionStatus::Connected);
    assert_eq!(snapshot.captured_at, captured());

    let mut bucket_ids: Vec<String> = snapshot
        .metrics
        .iter()
        .filter_map(|metric| metric.details.as_ref())
        .filter_map(|details| details.get("bucketId"))
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    bucket_ids.sort();
    bucket_ids.dedup();
    let expected_buckets: Vec<String> = expect["bucketIds"]
        .as_array()
        .expect("bucketIds")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    assert_eq!(bucket_ids, expected_buckets);

    let primary = snapshot
        .metric("codex.primary.used")
        .expect("primary window");
    assert_eq!(
        primary.value.as_number(),
        expect["primaryUsedPercent"].as_f64()
    );
    assert_eq!(
        primary.window_seconds,
        expect["primaryWindowSeconds"].as_u64()
    );
    assert_eq!(
        primary.reset_at.as_ref().map(|value| value.as_str()),
        expect["primaryResetAt"].as_str()
    );
    assert_eq!(
        snapshot
            .metric("codex.primary.remaining")
            .and_then(|metric| metric.value.as_number()),
        expect["primaryRemainingPercent"].as_f64()
    );

    let secondary = snapshot
        .metric("codex.secondary.used")
        .expect("secondary window");
    assert_eq!(
        secondary.window_seconds,
        expect["secondaryWindowSeconds"].as_u64()
    );
    assert_eq!(
        secondary.reset_at.as_ref().map(|value| value.as_str()),
        expect["secondaryResetAt"].as_str()
    );

    // A bucket without a reset time carries no resetAt; a bucket without a window
    // length carries no windowSeconds.
    assert!(expect["bucketWithoutResetTimeHasNoResetAt"]
        .as_bool()
        .unwrap_or(false));
    assert_eq!(
        snapshot
            .metric("review.primary.used")
            .expect("review window")
            .reset_at,
        None
    );
    assert!(expect["bucketWithoutWindowLengthHasNoWindowSeconds"]
        .as_bool()
        .unwrap_or(false));
    let unknown = snapshot
        .metric("unknown-window.primary.used")
        .expect("unknown window");
    assert_eq!(unknown.window_seconds, None);
    assert_eq!(unknown.reset_at, None);
    assert_eq!(unknown.value.as_number(), Some(5.0));

    // Credits keep the documented unit and the platform-reported number.
    let credits = snapshot
        .metric("codex.credits.balance")
        .expect("credits metric");
    assert_eq!(credits.unit, "credits");
    assert_eq!(
        credits.direction,
        usage_core::contracts::MetricDirection::Balance
    );
    assert_eq!(
        credits.value.as_number(),
        expect["creditedBucketBalance"]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
    );
    assert_eq!(
        snapshot
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.get("sharedBucket")),
        Some(&Value::String("codex".to_string()))
    );
    assert!(snapshot.error.is_none());
}

#[test]
fn the_legacy_codex_fixture_still_normalizes() {
    let legacy = crate_fixture("codex-rate-limits-legacy.json");
    let snapshot = normalize_codex_rate_limits(&legacy, &captured())
        .expect("the legacy payload must normalize");
    assert_eq!(
        snapshot.metrics.first().map(|metric| metric.key.as_str()),
        Some("codex.primary.used")
    );
    assert_eq!(
        snapshot
            .metric("codex.primary.used")
            .and_then(|metric| metric.value.as_number()),
        Some(33.0)
    );
    assert_eq!(
        snapshot
            .metric("codex.primary.remaining")
            .and_then(|metric| metric.value.as_number()),
        Some(67.0)
    );
    // `resetsAt: null` means the reset time is unknown, not epoch zero.
    assert_eq!(
        snapshot
            .metric("codex.primary.used")
            .and_then(|metric| metric.reset_at.clone()),
        None
    );
    // `rateLimitsByLimitId: null` falls back to the shared `codex` bucket and
    // produces no credits metric at all.
    assert!(snapshot.metric("codex.credits.balance").is_none());
    assert_eq!(
        snapshot
            .metric("codex.primary.used")
            .and_then(|metric| metric.window_seconds),
        Some(18_000)
    );

    let current = crate_fixture("codex-rate-limits.json");
    let snapshot = normalize_codex_rate_limits(&current, &captured())
        .expect("the current payload must normalize");
    assert_eq!(
        snapshot
            .metric("codex.secondary.used")
            .and_then(|metric| metric.window_seconds),
        Some(604_800)
    );
    assert_eq!(
        snapshot
            .metric("review.primary.used")
            .and_then(|metric| metric.value.as_number()),
        Some(20.0)
    );
    assert_eq!(
        snapshot
            .metric("codex.credits.balance")
            .and_then(|metric| metric.value.as_number()),
        Some(12.5)
    );
    assert_eq!(
        snapshot
            .metric("codex.credits.balance")
            .map(|metric| metric.unit.as_str()),
        Some("credits")
    );
    // The legacy shared bucket is ignored once `rateLimitsByLimitId` is present:
    // 15% (per-limit-id) wins over 10% (shared).
    assert_eq!(
        snapshot
            .metric("codex.primary.used")
            .and_then(|metric| metric.value.as_number()),
        Some(15.0)
    );
}

#[test]
fn the_daily_statistics_fixture_matches_the_codex_bucket_rules() {
    let daily = fixture("daily-statistics");
    let codex_daily = &daily["codexDailyUsage"];
    let expect = &codex_daily["expect"];
    assert_eq!(expect["bucketField"].as_str(), Some("startDate"));

    let payload = json!({ "summary": {}, "dailyUsageBuckets": codex_daily["buckets"].clone() });

    let reliable_zero = &expect["reliableZeroIsDisplayed"];
    let metrics = normalize_codex_usage(
        &payload,
        reliable_zero["localDay"].as_str().expect("localDay"),
        "Asia/Shanghai",
    )
    .expect("usage must normalize");
    let daily_metric = metrics
        .iter()
        .find(|metric| metric.key == "activity.daily.tokens")
        .expect("the matching day yields a metric");
    assert_eq!(
        daily_metric.value.as_number(),
        reliable_zero["value"].as_f64()
    );
    assert!(
        !daily_metric.is_missing(),
        "a reported zero is reliable, not missing"
    );

    let yesterday = &expect["yesterdayBucketIsNotTodaysValue"];
    let metrics = normalize_codex_usage(
        &payload,
        yesterday["localDay"].as_str().expect("localDay"),
        "Asia/Shanghai",
    )
    .expect("usage must normalize");
    assert_eq!(
        metrics
            .iter()
            .find(|metric| metric.key == "activity.daily.tokens")
            .and_then(|metric| metric.value.as_number()),
        yesterday["value"].as_f64()
    );

    let absent = &expect["absentBucketHidesMetric"];
    let metrics = normalize_codex_usage(
        &payload,
        absent["localDay"].as_str().expect("localDay"),
        "Asia/Shanghai",
    )
    .expect("usage must normalize");
    assert!(
        metrics
            .iter()
            .all(|metric| metric.key != "activity.daily.tokens"),
        "a day without a bucket shows no metric at all"
    );
}

#[test]
fn the_provider_errors_fixture_pins_the_failure_behaviour() {
    let errors = fixture("provider-errors");
    for case in errors["cases"].as_array().expect("cases") {
        let kind = case["error"]["kind"].as_str().expect("kind");
        let at = IsoTimestamp::parse(case["error"]["at"].as_str().expect("at")).expect("timestamp");
        let error = CollectorError::new(
            match kind {
                "missing_config" => ErrorKind::MissingConfig,
                "authentication" => ErrorKind::Authentication,
                "compatibility" => ErrorKind::Compatibility,
                "network" => ErrorKind::Network,
                "rate_limit" => ErrorKind::RateLimit,
                "process" => ErrorKind::Process,
                "storage" => ErrorKind::Storage,
                _ => ErrorKind::Unknown,
            },
            case["error"]["message"].as_str().expect("message"),
        );
        let snapshot = codex_unavailable_snapshot(&error, &at);
        let expected_status = match case["expect"]["status"].as_str().expect("status") {
            "disconnected" => ConnectionStatus::Disconnected,
            "degraded" => ConnectionStatus::Degraded,
            _ => ConnectionStatus::Unavailable,
        };
        assert_eq!(snapshot.status, expected_status, "kind {kind}");
        assert!(
            snapshot.metrics.is_empty(),
            "kind {kind} must not invent metrics"
        );

        // A failure keeps the cached snapshot, its times and its values.
        let cached: ProviderSnapshot = serde_json::from_value(errors["cachedSnapshot"].clone())
            .expect("the cached snapshot must parse");
        let stale = codex_stale_snapshot(&cached, &error, &at);
        assert_eq!(stale.status, ConnectionStatus::Degraded);
        assert_eq!(
            stale
                .metric("quota.5h.used")
                .and_then(|metric| metric.value.as_number()),
            Some(28.0)
        );
        assert_eq!(
            stale.captured_at.as_str(),
            errors["expect"]["cachedFailureKeepsCapturedAt"]
                .as_str()
                .expect("capturedAt")
        );
        assert_eq!(
            stale.last_success_at.as_ref().map(|value| value.as_str()),
            errors["expect"]["cachedFailureKeepsLastSuccessAt"].as_str()
        );
        assert!(stale
            .metric("quota.5h.used")
            .expect("cached metric")
            .has_confidence(Confidence::Stale));
    }
}

// ---------------------------------------------------------------------------
// 3.3 CLI discovery
// ---------------------------------------------------------------------------

/// A [`CommandRunner`] that only answers for prepared programs and records the
/// commands it was asked to run.
#[derive(Default)]
struct ScriptedRunner {
    replies: Mutex<HashMap<String, Result<CommandOutput, CollectorError>>>,
    calls: Mutex<Vec<(String, Vec<String>)>>,
}

impl std::fmt::Debug for ScriptedRunner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ScriptedRunner")
            .finish_non_exhaustive()
    }
}

impl ScriptedRunner {
    fn answering(self, program: &Path, stdout: &str) -> Self {
        lock(&self.replies).insert(
            program.to_string_lossy().into_owned(),
            Ok(CommandOutput {
                status: 0,
                stdout: format!("{stdout}\n"),
                stderr: String::new(),
            }),
        );
        self
    }

    fn failing(self, program: &Path, status: i32, stderr: &str) -> Self {
        lock(&self.replies).insert(
            program.to_string_lossy().into_owned(),
            Ok(CommandOutput {
                status,
                stdout: String::new(),
                stderr: stderr.to_string(),
            }),
        );
        self
    }

    fn calls(&self) -> Vec<(String, Vec<String>)> {
        lock(&self.calls).clone()
    }
}

impl CommandRunner for ScriptedRunner {
    async fn run(
        &self,
        program: &str,
        args: &[String],
        _stdin: Option<String>,
    ) -> Result<CommandOutput, CollectorError> {
        lock(&self.calls).push((program.to_string(), args.to_vec()));
        lock(&self.replies)
            .get(program)
            .cloned()
            .unwrap_or_else(|| {
                Err(CollectorError::new(
                    ErrorKind::MissingConfig,
                    format!("{program} was not found"),
                ))
            })
    }
}

fn scratch_dir(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "agents-usage-codex-it-{}-{name}",
        std::process::id()
    ));
    std::fs::create_dir_all(&directory).expect("scratch directory must be creatable");
    directory
}

fn scratch_binary(directory: &Path, name: &str) -> PathBuf {
    let path = directory.join(name);
    std::fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("scratch binary must be writable");
    path
}

#[tokio::test]
async fn discovery_finds_an_absolute_codex_path() {
    let directory = scratch_dir("absolute");
    let cli_path = scratch_binary(&directory, "codex");
    let runner = ScriptedRunner::default().answering(&cli_path, "codex-cli 0.152.0");

    let options = CodexCliDiscoveryOptions::with_candidates(vec![cli_path.clone()]);
    let cli = discover_codex_cli(&runner, &options)
        .await
        .expect("the CLI must be found");

    assert!(cli.path.is_absolute(), "{}", cli.path.display());
    assert_eq!(cli.path, cli_path);
    assert_eq!(cli.origin, CodexCliOrigin::CommonLocation);
    assert!(cli.supported);
    assert_eq!(
        runner.calls(),
        vec![(
            cli_path.to_string_lossy().into_owned(),
            vec!["--version".to_string()]
        )],
        "availability is reported through `codex --version`"
    );
}

#[tokio::test]
async fn the_configured_absolute_path_wins() {
    let directory = scratch_dir("configured");
    let configured = scratch_binary(&directory, "codex-from-settings");
    let other = scratch_binary(&directory, "codex-from-path");
    let runner = ScriptedRunner::default()
        .answering(&configured, "codex-cli 0.152.0")
        .answering(&other, "codex-cli 9.9.9");

    let options = CodexCliDiscoveryOptions {
        configured_path: Some(configured.to_string_lossy().into_owned()),
        candidates: Some(vec![other]),
        ..CodexCliDiscoveryOptions::default()
    };
    let cli = discover_codex_cli(&runner, &options)
        .await
        .expect("the configured CLI must win");
    assert_eq!(cli.path, configured);
    assert_eq!(cli.origin, CodexCliOrigin::ConfiguredPath);
    assert_eq!(
        cli.version.map(|version| version.to_string()).as_deref(),
        Some("0.152.0")
    );

    // A relative setting is refused instead of being resolved against the app's
    // working directory.
    let options = CodexCliDiscoveryOptions {
        configured_path: Some("bin/codex".to_string()),
        ..CodexCliDiscoveryOptions::default()
    };
    let error = discover_codex_cli(&runner, &options)
        .await
        .expect_err("a relative configured path must be rejected");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert!(error.message.contains("absolute"));
}

#[tokio::test]
async fn a_missing_codex_cli_only_affects_codex() {
    let runner = ScriptedRunner::default();
    let options = CodexCliDiscoveryOptions::with_candidates(Vec::new());
    let error = discover_codex_cli(&runner, &options)
        .await
        .expect_err("an empty search must fail");
    assert_eq!(error.kind, ErrorKind::MissingConfig);
    assert!(error.message.contains("Codex CLI was not found"));
    assert!(error.message.contains("absolute path"));
    assert_eq!(
        error.diagnostic.get("provider").map(String::as_str),
        Some("codex")
    );
    assert!(
        runner.calls().is_empty(),
        "nothing is executed when there is nothing to execute"
    );

    // The Codex connection is disconnected while the other providers stay
    // untouched: GLM/DeepSeek keep their own snapshots.
    let snapshot = codex_unavailable_snapshot(&error, &captured());
    assert_eq!(snapshot.status, ConnectionStatus::Disconnected);
    assert!(snapshot.metrics.is_empty());
    let other = other_provider_snapshot();
    assert_eq!(other.status, ConnectionStatus::Connected);
    assert_eq!(other.metrics.len(), 1);

    // A binary that exists but cannot run is a different, also Codex-only,
    // failure.
    let directory = scratch_dir("broken");
    let broken = scratch_binary(&directory, "codex-broken");
    let runner = ScriptedRunner::default().failing(&broken, 127, "codex: not a working install");
    let options = CodexCliDiscoveryOptions::with_candidates(vec![broken]);
    let error = discover_codex_cli(&runner, &options)
        .await
        .expect_err("a broken binary must fail");
    assert_eq!(error.kind, ErrorKind::Process);
    assert!(error.message.contains("127"));
    assert!(error.message.contains("not a working install"));
}

#[test]
fn the_cli_discovery_fixture_pins_the_search_plan() {
    let discovery = fixture("codex-cli-discovery");
    let order: Vec<&str> = discovery["searchOrder"]
        .as_array()
        .expect("searchOrder")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let implementations = [
        CodexCliOrigin::ConfiguredPath.as_str(),
        CodexCliOrigin::CodexHome.as_str(),
        CodexCliOrigin::CommonLocation.as_str(),
        CodexCliOrigin::PathLookup.as_str(),
    ];
    assert_eq!(order, implementations);

    let locations: Vec<&str> = discovery["commonLocations"]
        .as_array()
        .expect("commonLocations")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(locations, COMMON_CODEX_CLI_LOCATIONS.to_vec());

    let expect = &discovery["expect"];
    assert_eq!(
        expect["missingCliErrorKind"].as_str(),
        Some(ErrorKind::MissingConfig.as_str())
    );
    assert_eq!(
        expect["brokenCliErrorKind"].as_str(),
        Some(ErrorKind::Process.as_str())
    );
    assert_eq!(
        expect["appServerCommand"]
            .as_array()
            .map(|args| args.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
        Some(APP_SERVER_ARGS.to_vec())
    );
    assert_eq!(expect["versionCommand"][0].as_str(), Some("--version"));
    assert_eq!(expect["noInteractiveShell"].as_bool(), Some(true));
    assert_eq!(expect["missingCliAffectsOnlyCodex"].as_bool(), Some(true));

    // The plan is absolute-only: a Finder launch has no shell to expand anything.
    let candidates =
        usage_core::adapters::codex::cli::codex_cli_candidates(&CodexCliDiscoveryOptions {
            home_dir: Some(PathBuf::from("/Users/example")),
            path_var: Some("./bin:/usr/bin".to_string()),
            ..CodexCliDiscoveryOptions::default()
        });
    assert!(candidates
        .iter()
        .all(|candidate| candidate.path.is_absolute()));
    let mut rendered: Vec<PathBuf> = candidates
        .iter()
        .map(|candidate| candidate.path.clone())
        .collect();
    rendered.dedup();
    assert_eq!(
        rendered.len(),
        candidates.len(),
        "no location is probed twice"
    );
}

// ---------------------------------------------------------------------------
// Service-layer construction
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_codex_collector_refreshes_through_a_supervised_session() {
    let transport = Arc::new(FakeTransport::default());
    transport.reply("initialize", json!({ "platformOs": "macos" }));
    transport.reply(ACCOUNT_READ, account_payload());
    transport.reply(RATE_LIMITS_READ, codex_windows_input());
    transport.reply(USAGE_READ, json!({ "summary": { "lifetimeTokens": 7 } }));

    let factory: TransportFactory = Arc::new({
        let transport = Arc::clone(&transport);
        move || -> Result<SharedRpcTransport, CollectorError> { Ok(shared(&transport)) }
    });
    let supervisor = CodexAppServerSupervisor::with_transport_factory(
        factory,
        CodexSupervisorOptions::immediate(),
    );
    let collector = CodexCollector::from_supervisor(supervisor);

    let snapshot = collector
        .refresh(&context("2026-09-10"))
        .await
        .expect("refresh must succeed");
    assert_eq!(snapshot.provider, ProviderId::Codex);
    assert!(snapshot.metric("codex.primary.used").is_some());
    assert_eq!(
        snapshot
            .metric("activity.lifetime.tokens")
            .and_then(|metric| metric.value.as_number()),
        Some(7.0)
    );
    assert_eq!(
        transport.sent_methods(),
        vec![
            "initialize",
            "initialized",
            ACCOUNT_READ,
            RATE_LIMITS_READ,
            USAGE_READ
        ]
    );

    // Shutting down closes the session so no child process is left behind.
    collector.shutdown().await;
    assert!(!collector.supervisor().is_connected());
}

#[test]
fn missing_metric_values_stay_missing_in_a_normalized_snapshot() {
    // The contract rule applied to this adapter: a bucket that reports no
    // percentage fails loudly instead of producing a zero, and a bucket that
    // reports a real zero keeps it.
    let payload = json!({
        "rateLimitsByLimitId": {
            "codex": {
                "limitId": "codex",
                "primary": { "usedPercent": 0, "windowDurationMins": null, "resetsAt": null }
            }
        }
    });
    let snapshot =
        normalize_codex_rate_limits(&payload, &captured()).expect("payload must normalize");
    let used = snapshot.metric("codex.primary.used").expect("used metric");
    assert_eq!(used.value, MetricValue::Number(0.0));
    assert!(!used.has_confidence(Confidence::Unavailable));
    assert_eq!(used.window_seconds, None);
    assert_eq!(used.reset_at, None);
    let remaining = snapshot
        .metric("codex.primary.remaining")
        .expect("remaining metric");
    assert_eq!(remaining.value, MetricValue::Number(100.0));
}

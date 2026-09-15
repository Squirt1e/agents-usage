//! Codex `app-server` JSON-RPC session: request correlation, notifications,
//! timeouts, process-exit handling and supervised reconnects.
//!
//! The `codex app-server --stdio` subprocess speaks newline-delimited JSON-RPC
//! over stdin/stdout. This module keeps three layers apart so each one can be
//! tested without the real CLI:
//!
//! - [`RpcTransport`] is the byte-level capability: send one message, report
//!   incoming messages and report closure. [`StdioRpcTransport`] implements it
//!   with a real child process; tests implement it with a scripted fake.
//! - [`JsonRpcClient`] adds protocol semantics on top: unique numeric request
//!   ids, response correlation, dispatch of notifications by method and
//!   per-request timeouts. Closing the transport fails every pending request
//!   instead of leaving a caller hanging.
//! - [`CodexAppServerSupervisor`] owns the session lifetime: at most one live
//!   session, reconnect with exponential backoff bounded by a caller-supplied
//!   maximum, notification handlers re-registered after a reconnect, and a
//!   failure reported to the caller rather than an infinite retry loop.
//!
//! Real runtime children exit for many reasons (no CLI, signed out, a crashed
//! helper). The last ~2000 bytes of stderr are kept so the failure the caller
//! sees carries the reason, and every message built from process output passes
//! through the redaction helpers in [`crate::http::CollectorError::new`].

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use crate::contracts::ErrorKind;
use crate::http::CollectorError;

/// Arguments that put the Codex CLI into its JSON-RPC server mode.
pub const APP_SERVER_ARGS: [&str; 2] = ["app-server", "--stdio"];

/// Default per-request timeout used by [`JsonRpcClient`] and the supervisor.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// First retry delay; doubled for every consecutive failure.
pub const DEFAULT_BASE_BACKOFF: Duration = Duration::from_millis(250);

/// Upper bound for the retry delay when the caller does not supply one.
pub const DEFAULT_MAX_BACKOFF: Duration = Duration::from_secs(30);

/// How much stderr is retained to explain a process exit.
pub const STDERR_TAIL_LIMIT: usize = 2_000;

/// How many attempts one supervised request may take before it fails.
pub const MAX_REQUEST_ATTEMPTS: usize = 2;

/// Identity the client announces in the `initialize` handshake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

impl ClientInfo {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
        }
    }
}

impl Default for ClientInfo {
    fn default() -> Self {
        Self {
            name: "agents-usage".to_string(),
            version: crate::VERSION.to_string(),
        }
    }
}

/// A JSON-RPC error object as sent by the app-server.
///
/// Every field is optional so an unexpected error shape still parses: a
/// protocol we do not control must not be able to turn a clear failure into a
/// deserialization panic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RpcErrorObject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// One JSON-RPC message in either direction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RpcMessage {
    /// Request id. Kept as a [`Value`] so a non-numeric id from a newer build is
    /// tolerated (and simply never correlated) instead of failing to parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcErrorObject>,
}

impl RpcMessage {
    /// A request carrying `params`.
    pub fn request(id: i64, method: impl Into<String>, params: Value) -> Self {
        Self {
            id: Some(Value::from(id)),
            method: Some(method.into()),
            params: Some(params),
            ..Self::default()
        }
    }

    /// A notification, exactly as the TypeScript client sends it (no id, no
    /// params key when there are no parameters).
    pub fn notification(method: impl Into<String>) -> Self {
        Self {
            method: Some(method.into()),
            ..Self::default()
        }
    }

    /// A notification carrying `params`.
    pub fn notification_with_params(method: impl Into<String>, params: Value) -> Self {
        Self {
            method: Some(method.into()),
            params: Some(params),
            ..Self::default()
        }
    }

    /// The numeric request id, when this message is a response to a request.
    pub fn numeric_id(&self) -> Option<i64> {
        match self.id.as_ref()? {
            Value::Number(number) => number.as_i64().or_else(|| {
                number
                    .as_f64()
                    .filter(|value| value.fract() == 0.0)
                    .map(|value| value as i64)
            }),
            _ => None,
        }
    }

    /// True when this message is a notification (a method without an id).
    pub fn is_notification(&self) -> bool {
        self.method.is_some() && self.numeric_id().is_none()
    }

    pub fn params_or_null(&self) -> Value {
        self.params.clone().unwrap_or(Value::Null)
    }
}

/// Handler invoked for every notification of one method.
pub type NotificationHandler = Arc<dyn Fn(Value) + Send + Sync>;

/// Handler invoked for every message the transport receives.
pub type MessageHandler = Arc<dyn Fn(RpcMessage) + Send + Sync>;

/// Handler invoked once when the transport can no longer be used.
pub type CloseHandler = Arc<dyn Fn(CollectorError) + Send + Sync>;

/// The byte-level capability a [`JsonRpcClient`] needs.
///
/// `send` is synchronous because the stdio implementation queues the line for a
/// writer task; a failed send is reported as an [`CollectorError`] and the
/// session's death is reported through the registered close handler, which is
/// what fails the pending requests.
pub trait RpcTransport: Send + Sync + fmt::Debug {
    /// Queue one JSON-RPC message for delivery.
    fn send(&self, message: RpcMessage) -> Result<(), CollectorError>;

    /// Register a message handler. Handlers registered before construction
    /// completes are invoked, in registration order, for every message.
    fn on_message(&self, handler: MessageHandler);

    /// Register a close handler. A handler registered after the transport has
    /// already closed is invoked immediately, so a caller can never wait
    /// forever for a session that is already gone.
    fn on_close(&self, handler: CloseHandler);

    /// Terminate the session. Idempotent.
    fn close(&self);
}

/// Shared transport handle.
pub type SharedRpcTransport = Arc<dyn RpcTransport>;

/// Creates a fresh transport for one session attempt.
pub type TransportFactory =
    Arc<dyn Fn() -> Result<SharedRpcTransport, CollectorError> + Send + Sync>;

/// Maps a JSON-RPC error object onto the shared collector vocabulary.
///
/// Protocol-level codes and messages that clearly name a user-actionable cause
/// get a specific kind; everything else stays `unknown` rather than pretending
/// to be a network or process failure.
fn rpc_error_to_collector_error(error: &RpcErrorObject, method: &str) -> CollectorError {
    let lowered = error.message.to_lowercase();
    let kind = if lowered.contains("rate limit") {
        ErrorKind::RateLimit
    } else if lowered.contains("not signed in")
        || lowered.contains("unauthoriz")
        || lowered.contains("authentication")
    {
        ErrorKind::Authentication
    } else if matches!(error.code, Some(-32601 | -32602 | -32700 | -32600)) {
        ErrorKind::Compatibility
    } else {
        ErrorKind::Unknown
    };
    let code = error
        .code
        .map_or_else(|| "unknown".to_string(), |code| code.to_string());
    let message = format!("Codex app-server error {code}: {}", error.message);
    CollectorError::new(kind, message.trim_end())
        .with_diagnostic("method", method)
        .with_diagnostic("code", code)
}

fn timeout_error(method: &str) -> CollectorError {
    // Matches the message pinned by `fixtures/contracts/provider-errors.json`.
    CollectorError::network("Codex app-server request timed out").with_diagnostic("method", method)
}

/// One in-flight request: what it asked for and where to deliver the outcome.
#[derive(Debug)]
struct PendingRequest {
    method: String,
    sender: oneshot::Sender<Result<Value, CollectorError>>,
}

/// A JSON-RPC client speaking to one session.
///
/// The client is cheap to share behind an `Arc`: it holds the pending request
/// map, the notification registry and the id counter.
pub struct JsonRpcClient {
    transport: SharedRpcTransport,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, PendingRequest>>,
    notifications: RwLock<HashMap<String, Vec<NotificationHandler>>>,
    default_timeout: Option<Duration>,
    closed: Mutex<Option<CollectorError>>,
}

impl fmt::Debug for JsonRpcClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JsonRpcClient")
            .field("transport", &self.transport)
            .field("pending", &self.pending_count())
            .field("default_timeout", &self.default_timeout)
            .field("closed", &self.close_error())
            .finish()
    }
}

impl JsonRpcClient {
    /// Build a client for `transport`.
    ///
    /// `default_timeout` is applied to every request issued through
    /// [`JsonRpcClient::request`]; [`JsonRpcClient::request_with_timeout`] can
    /// override it per call. `None` means "wait for the transport to resolve or
    /// close", which is only appropriate when the caller enforces its own
    /// deadline.
    pub fn new(transport: SharedRpcTransport, default_timeout: Option<Duration>) -> Arc<Self> {
        let client = Arc::new(Self {
            transport,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            notifications: RwLock::new(HashMap::new()),
            default_timeout,
            closed: Mutex::new(None),
        });

        let message_client = Arc::clone(&client);
        client.transport.on_message(Arc::new(move |message| {
            message_client.handle_message(message)
        }));
        let close_client = Arc::clone(&client);
        client
            .transport
            .on_close(Arc::new(move |error| close_client.handle_close(error)));
        client
    }

    /// Send the `initialize` request followed by the `initialized`
    /// notification, exactly as the protocol expects.
    pub async fn initialize(&self, client_info: ClientInfo) -> Result<Value, CollectorError> {
        let result = self
            .request(
                "initialize",
                json!({ "clientInfo": client_info, "capabilities": Value::Null }),
            )
            .await?;
        self.notify(RpcMessage::notification("initialized"))?;
        Ok(result)
    }

    /// Issue a request with the client's default timeout.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, CollectorError> {
        self.request_with_timeout(method, params, self.default_timeout)
            .await
    }

    /// Issue a request, waiting at most `timeout` for the response.
    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, CollectorError> {
        if let Some(error) = self.close_error() {
            return Err(error);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.with_pending(|pending| {
            pending.insert(
                id,
                PendingRequest {
                    method: method.to_string(),
                    sender,
                },
            )
        });

        if let Err(error) = self.transport.send(RpcMessage::request(id, method, params)) {
            self.take_pending(id);
            return Err(error);
        }

        match timeout {
            Some(duration) => match tokio::time::timeout(duration, receiver).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_dropped)) => Err(session_lost_error(method)),
                Err(_elapsed) => {
                    // The response may still arrive later; drop the slot so a
                    // stale id can never resolve a future request.
                    self.take_pending(id);
                    Err(timeout_error(method))
                }
            },
            None => match receiver.await {
                Ok(outcome) => outcome,
                Err(_dropped) => Err(session_lost_error(method)),
            },
        }
    }

    /// Send a notification (fire and forget, no response is expected).
    pub fn notify(&self, message: RpcMessage) -> Result<(), CollectorError> {
        if let Some(error) = self.close_error() {
            return Err(error);
        }
        self.transport.send(message)
    }

    /// Register a notification handler for `method`.
    ///
    /// Handlers are keyed by method so a notification for an unknown method is
    /// dropped instead of failing the session.
    pub fn on_notification(&self, method: &str, handler: NotificationHandler) {
        self.with_notifications(|notifications| {
            notifications
                .entry(method.to_string())
                .or_default()
                .push(handler);
        });
    }

    /// Close the session; pending requests fail with the close reason.
    pub fn close(&self) {
        self.transport.close();
    }

    /// The error that ended the session, if it has ended.
    pub fn close_error(&self) -> Option<CollectorError> {
        lock(&self.closed).clone()
    }

    /// True once the session can no longer serve requests.
    pub fn is_closed(&self) -> bool {
        self.close_error().is_some()
    }

    /// Number of requests currently waiting for a response.
    pub fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }

    fn handle_message(&self, message: RpcMessage) {
        if let Some(id) = message.numeric_id() {
            let pending = self.with_pending(|pending| pending.remove(&id));
            if let Some(pending) = pending {
                let outcome = match &message.error {
                    Some(error) => Err(rpc_error_to_collector_error(error, &pending.method)),
                    None => Ok(message.result.clone().unwrap_or(Value::Null)),
                };
                let _ = pending.sender.send(outcome);
            }
            return;
        }

        let Some(method) = message.method.as_deref() else {
            return;
        };
        let handlers = self
            .with_notifications(|notifications| notifications.get(method).cloned())
            .unwrap_or_default();
        let params = message.params_or_null();
        for handler in handlers {
            handler(params.clone());
        }
    }

    fn handle_close(&self, error: CollectorError) {
        {
            let mut closed = lock(&self.closed);
            if closed.is_some() {
                return;
            }
            *closed = Some(error.clone());
        }
        let pending: Vec<_> = self.with_pending(|pending| {
            pending
                .drain()
                .map(|(_, request)| request.sender)
                .collect::<Vec<_>>()
        });
        for sender in pending {
            let _ = sender.send(Err(error.clone()));
        }
    }

    fn take_pending(&self, id: i64) {
        let _ = self.with_pending(|pending| pending.remove(&id));
    }

    fn with_pending<T>(&self, action: impl FnOnce(&mut HashMap<i64, PendingRequest>) -> T) -> T {
        action(&mut lock(&self.pending))
    }

    fn with_notifications<T>(
        &self,
        action: impl FnOnce(&mut HashMap<String, Vec<NotificationHandler>>) -> T,
    ) -> T {
        action(&mut write_lock(&self.notifications))
    }
}

fn session_lost_error(method: &str) -> CollectorError {
    CollectorError::process("Codex app-server closed before responding")
        .with_diagnostic("method", method)
}

/// Lock helper that survives a poisoned mutex instead of panicking: a poisoned
/// lock means another thread failed while holding it, and the collector must
/// still be able to report an error rather than abort the process.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_lock<T>(lock_value: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock_value
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock_value: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock_value
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Command used to start one app-server session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StdioRpcCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl StdioRpcCommand {
    pub fn new(program: impl Into<PathBuf>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
        }
    }

    /// `codex app-server --stdio` for an absolute CLI path.
    pub fn codex(program: impl Into<PathBuf>) -> Self {
        Self::new(
            program,
            APP_SERVER_ARGS
                .iter()
                .map(|arg| (*arg).to_string())
                .collect(),
        )
    }

    fn to_tokio_command(&self) -> Command {
        let mut command = Command::new(&self.program);
        // The app-server inherits this process's environment on purpose, but a CLI
        // that reached us as an absolute path brings its own runtime: without its
        // directory on `PATH` an npm-installed Codex is found and then dies with
        // `env: node: No such file or directory` (see `cli::path_with_program_dir`).
        if let Some(path) = super::cli::path_with_program_dir(&self.program) {
            command.env("PATH", path);
        }
        command
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }
}

/// Keeps only the last `limit` bytes of `buffer`, cutting on a char boundary.
pub fn keep_tail(buffer: &mut String, limit: usize) {
    if buffer.len() <= limit {
        return;
    }
    let mut cut = buffer.len() - limit;
    while cut < buffer.len() && !buffer.is_char_boundary(cut) {
        cut += 1;
    }
    buffer.replace_range(..cut, "");
}

/// Shared message/close fan-out for a transport.
///
/// The close state is remembered so a handler registered after the session died
/// still learns about it, and so the child's exit and a read error cannot report
/// two different reasons for one session. Messages that arrive before the first
/// handler is registered are buffered: the child can print its greeting line
/// faster than the client is constructed, and dropping that line would lose the
/// handshake response.
#[derive(Default)]
struct Dispatcher {
    handlers: RwLock<Vec<MessageHandler>>,
    close_handlers: RwLock<Vec<CloseHandler>>,
    closed: Mutex<Option<CollectorError>>,
    buffered: Mutex<Vec<RpcMessage>>,
}

/// Cap on messages buffered before a handler is registered.
const DISPATCH_BUFFER_LIMIT: usize = 64;

impl fmt::Debug for Dispatcher {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Dispatcher")
            .field("handlers", &read_lock(&self.handlers).len())
            .field("close_handlers", &read_lock(&self.close_handlers).len())
            .field("buffered", &lock(&self.buffered).len())
            .field("closed", &lock(&self.closed).is_some())
            .finish()
    }
}

impl Dispatcher {
    fn on_message(&self, handler: MessageHandler) {
        if lock(&self.closed).is_some() {
            return;
        }
        let buffered = {
            let mut handlers = write_lock(&self.handlers);
            let was_empty = handlers.is_empty();
            handlers.push(handler);
            if was_empty {
                std::mem::take(&mut *lock(&self.buffered))
            } else {
                Vec::new()
            }
        };
        for message in buffered {
            self.dispatch_message(message);
        }
    }

    fn on_close(&self, handler: CloseHandler) {
        if let Some(error) = lock(&self.closed).clone() {
            handler(error);
            return;
        }
        write_lock(&self.close_handlers).push(handler);
    }

    fn dispatch_message(&self, message: RpcMessage) {
        let handlers: Vec<MessageHandler> = read_lock(&self.handlers).clone();
        if handlers.is_empty() {
            let mut buffered = lock(&self.buffered);
            if buffered.len() < DISPATCH_BUFFER_LIMIT {
                buffered.push(message);
            }
            return;
        }
        for handler in handlers {
            handler(message.clone());
        }
    }

    fn close(&self, error: CollectorError) {
        {
            let mut closed = lock(&self.closed);
            if closed.is_some() {
                return;
            }
            *closed = Some(error.clone());
        }
        let handlers: Vec<CloseHandler> = read_lock(&self.close_handlers).clone();
        for handler in handlers {
            handler(error.clone());
        }
    }
}

/// A [`RpcTransport`] backed by a `codex app-server --stdio` child process.
///
/// stdout is split on newlines, so a partial chunk is buffered until the line is
/// complete and blank lines are ignored. stderr is kept as a limited tail that
/// explains the exit. When the process exits, every pending request receives a
/// failure carrying that tail instead of hanging.
#[derive(Debug)]
pub struct StdioRpcTransport {
    command: StdioRpcCommand,
    messages: mpsc::UnboundedSender<RpcMessage>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    dispatcher: Arc<Dispatcher>,
}

impl StdioRpcTransport {
    /// Spawn the child process and start the reader/writer tasks.
    pub fn spawn(command: StdioRpcCommand) -> Result<Arc<Self>, CollectorError> {
        let mut process: Child = command.to_tokio_command().spawn().map_err(|error| {
            CollectorError::new(
                ErrorKind::Process,
                format!(
                    "cannot start Codex app-server ({}): {error}",
                    command.program.display()
                ),
            )
        })?;

        let mut stdin = process.stdin.take().ok_or_else(|| {
            CollectorError::new(ErrorKind::Process, "Codex app-server stdin is unavailable")
        })?;
        let stdout = process.stdout.take().ok_or_else(|| {
            CollectorError::new(ErrorKind::Process, "Codex app-server stdout is unavailable")
        })?;
        let stderr = process.stderr.take();

        let dispatcher = Arc::new(Dispatcher::default());
        let (message_tx, mut message_rx) = mpsc::unbounded_channel::<RpcMessage>();
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        tokio::spawn(async move {
            while let Some(message) = message_rx.recv().await {
                let line = match serde_json::to_string(&message) {
                    Ok(line) => line,
                    Err(_) => break,
                };
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    // A broken pipe is reported by the waiter, which owns the
                    // child's exit status and the stderr tail.
                    break;
                }
            }
        });

        if let Some(mut stderr) = stderr {
            let tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut buffer = [0_u8; 4_096];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            let chunk = String::from_utf8_lossy(&buffer[..read]);
                            let mut tail = lock(&tail);
                            tail.push_str(&chunk);
                            keep_tail(&mut tail, STDERR_TAIL_LIMIT);
                        }
                    }
                }
            });
        }

        let reader_dispatcher = Arc::clone(&dispatcher);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<RpcMessage>(trimmed) {
                            Ok(message) => reader_dispatcher.dispatch_message(message),
                            Err(_) => reader_dispatcher.close(CollectorError::new(
                                ErrorKind::Compatibility,
                                "Codex app-server emitted invalid JSON",
                            )),
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        reader_dispatcher.close(CollectorError::new(
                            ErrorKind::Process,
                            format!("cannot read from Codex app-server: {error}"),
                        ));
                        break;
                    }
                }
            }
        });

        let waiter_dispatcher = Arc::clone(&dispatcher);
        tokio::spawn(async move {
            let status = tokio::select! {
                status = process.wait() => status,
                _ = shutdown_rx => {
                    let _ = process.start_kill();
                    process.wait().await
                }
            };
            let code = match status {
                Ok(status) => status
                    .code()
                    .map_or_else(|| "signal".to_string(), |code| code.to_string()),
                Err(error) => error.to_string(),
            };
            let tail = lock(&stderr_tail).trim().to_string();
            let message = if tail.is_empty() {
                format!("Codex app-server exited ({code})")
            } else {
                format!("Codex app-server exited ({code}): {tail}")
            };
            waiter_dispatcher.close(CollectorError::new(ErrorKind::Process, message));
        });

        Ok(Arc::new(Self {
            command,
            messages: message_tx,
            shutdown: Mutex::new(Some(shutdown_tx)),
            dispatcher,
        }))
    }

    /// The command this session was started with.
    pub fn command(&self) -> &StdioRpcCommand {
        &self.command
    }

    /// True once the session can no longer be used.
    pub fn is_closed(&self) -> bool {
        lock(&self.dispatcher.closed).is_some()
    }

    /// The error that ended the session, if it has ended.
    pub fn close_error(&self) -> Option<CollectorError> {
        lock(&self.dispatcher.closed).clone()
    }
}

impl RpcTransport for StdioRpcTransport {
    fn send(&self, message: RpcMessage) -> Result<(), CollectorError> {
        self.messages.send(message).map_err(|_| {
            CollectorError::new(ErrorKind::Process, "Codex app-server session is closed")
        })
    }

    fn on_message(&self, handler: MessageHandler) {
        self.dispatcher.on_message(handler);
    }

    fn on_close(&self, handler: CloseHandler) {
        self.dispatcher.on_close(handler);
    }

    fn close(&self) {
        let sender = lock(&self.shutdown).take();
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
    }
}

/// Injectable delay so tests can observe the retry policy without waiting.
pub type SleepFn =
    Arc<dyn Fn(Duration) -> Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;

fn default_sleep(duration: Duration) -> Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(tokio::time::sleep(duration))
}

/// Supervisor policy: handshake identity, timeouts and backoff bounds.
#[derive(Clone)]
pub struct CodexSupervisorOptions {
    pub client_info: ClientInfo,
    pub request_timeout: Option<Duration>,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
    /// Test seam: replaces `tokio::time::sleep`.
    pub sleep: Option<SleepFn>,
}

impl Default for CodexSupervisorOptions {
    fn default() -> Self {
        Self {
            client_info: ClientInfo::default(),
            request_timeout: Some(DEFAULT_REQUEST_TIMEOUT),
            base_backoff: DEFAULT_BASE_BACKOFF,
            max_backoff: DEFAULT_MAX_BACKOFF,
            sleep: None,
        }
    }
}

impl CodexSupervisorOptions {
    /// Options whose backoff never exceeds `max_backoff`.
    pub fn with_max_backoff(max_backoff: Duration) -> Self {
        Self {
            max_backoff,
            ..Self::default()
        }
    }

    /// Options that never wait: used by tests that only assert behaviour.
    pub fn immediate() -> Self {
        Self {
            sleep: Some(Arc::new(|_| Box::pin(std::future::ready(())))),
            ..Self::default()
        }
    }
}

impl fmt::Debug for CodexSupervisorOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexSupervisorOptions")
            .field("client_info", &self.client_info)
            .field("request_timeout", &self.request_timeout)
            .field("base_backoff", &self.base_backoff)
            .field("max_backoff", &self.max_backoff)
            .field("sleep", &self.sleep.is_some())
            .finish()
    }
}

/// Owns the lifetime of at most one Codex app-server session.
///
/// `connect` reuses a live session, reconnects with exponential backoff when the
/// previous one failed, and re-registers every notification handler on the new
/// session. `request` retries once through a reconnect and then reports the
/// failure to the caller, so a dead CLI cannot turn into an unbounded retry
/// loop that also stalls the other providers.
pub struct CodexAppServerSupervisor {
    factory: TransportFactory,
    options: CodexSupervisorOptions,
    state: AsyncMutex<Option<Arc<JsonRpcClient>>>,
    notification_handlers: Mutex<HashMap<String, Vec<NotificationHandler>>>,
    failures: AtomicU32,
}

impl fmt::Debug for CodexAppServerSupervisor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexAppServerSupervisor")
            .field("options", &self.options)
            .field("failures", &self.failures.load(Ordering::SeqCst))
            .field(
                "connected",
                &self
                    .state
                    .try_lock()
                    .map(|guard| guard.is_some())
                    .unwrap_or(false),
            )
            .finish()
    }
}

impl CodexAppServerSupervisor {
    /// Supervise the real CLI at `program` (an absolute path from discovery).
    pub fn for_cli(program: impl Into<PathBuf>, options: CodexSupervisorOptions) -> Arc<Self> {
        let command = StdioRpcCommand::codex(program);
        Self::with_transport_factory(
            Arc::new(move || {
                let transport = StdioRpcTransport::spawn(command.clone())?;
                Ok(transport as SharedRpcTransport)
            }),
            options,
        )
    }

    /// Supervise a caller-supplied transport factory (used by tests and by a
    /// service that owns the process lifecycle itself).
    pub fn with_transport_factory(
        factory: TransportFactory,
        options: CodexSupervisorOptions,
    ) -> Arc<Self> {
        Arc::new(Self {
            factory,
            options,
            state: AsyncMutex::new(None),
            notification_handlers: Mutex::new(HashMap::new()),
            failures: AtomicU32::new(0),
        })
    }

    /// Number of consecutive failures; reset after a successful handshake.
    pub fn failure_count(&self) -> u32 {
        self.failures.load(Ordering::SeqCst)
    }

    /// True while a session is believed to be usable.
    pub fn is_connected(&self) -> bool {
        self.state
            .try_lock()
            .map(|guard| guard.as_ref().is_some_and(|client| !client.is_closed()))
            .unwrap_or(false)
    }

    /// Return the live session, connecting (and running the `initialize`
    /// handshake) when there is none.
    pub async fn connect(&self) -> Result<Arc<JsonRpcClient>, CollectorError> {
        let mut state = self.state.lock().await;
        if let Some(client) = state.as_ref() {
            if !client.is_closed() {
                return Ok(Arc::clone(client));
            }
        }
        // The session died since the last request: replace it instead of handing
        // out a dead client, and make sure the old one is closed.
        if let Some(dead) = state.take() {
            dead.close();
        }

        let transport = match (self.factory)() {
            Ok(transport) => transport,
            Err(error) => {
                let delay = self.next_backoff();
                drop(state);
                self.sleep(delay).await;
                return Err(error);
            }
        };

        let client = JsonRpcClient::new(transport, self.options.request_timeout);
        match client.initialize(self.options.client_info.clone()).await {
            Ok(_) => {
                for (method, handlers) in self.registered_handlers() {
                    for handler in handlers {
                        client.on_notification(&method, handler);
                    }
                }
                *state = Some(Arc::clone(&client));
                self.failures.store(0, Ordering::SeqCst);
                Ok(client)
            }
            Err(error) => {
                client.close();
                let delay = self.next_backoff();
                drop(state);
                self.sleep(delay).await;
                Err(error)
            }
        }
    }

    /// Drop the current session; the next request reconnects.
    pub async fn invalidate(&self) {
        let client = self.state.lock().await.take();
        if let Some(client) = client {
            client.close();
        }
    }

    /// Register a notification handler; it survives reconnects.
    ///
    /// A live session is updated immediately when its lock is free; otherwise
    /// the handler is picked up by the `connect` that is already running, so it
    /// is never lost.
    pub fn on_notification(&self, method: &str, handler: NotificationHandler) {
        let mut handlers = lock(&self.notification_handlers);
        handlers
            .entry(method.to_string())
            .or_default()
            .push(Arc::clone(&handler));
        drop(handlers);

        if let Ok(state) = self.state.try_lock() {
            if let Some(client) = state.as_ref() {
                client.on_notification(method, handler);
            }
        }
    }

    /// Issue a supervised request with the configured timeout.
    ///
    /// One retry is attempted through a fresh handshake; after that the failure
    /// is reported to the caller so the other providers keep their own schedule.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, CollectorError> {
        let mut last_error: Option<CollectorError> = None;
        for attempt in 0..MAX_REQUEST_ATTEMPTS {
            let client = match self.connect().await {
                Ok(client) => client,
                Err(error) => {
                    // `connect` already waited its own backoff for this failure.
                    last_error = Some(error);
                    continue;
                }
            };
            match client.request(method, params.clone()).await {
                Ok(result) => return Ok(result),
                Err(error) => {
                    // The request may have failed because the session died:
                    // drop it so the retry starts from a clean handshake.
                    self.invalidate().await;
                    last_error = Some(error);
                }
            }
            if attempt + 1 < MAX_REQUEST_ATTEMPTS {
                let delay = self.next_backoff();
                self.sleep(delay).await;
            }
        }
        Err(last_error.unwrap_or_else(|| {
            CollectorError::new(ErrorKind::Unknown, "Codex app-server request failed")
        }))
    }

    /// Close the session so no child process is left behind.
    pub async fn shutdown(&self) {
        self.invalidate().await;
    }

    fn registered_handlers(&self) -> Vec<(String, Vec<NotificationHandler>)> {
        lock(&self.notification_handlers)
            .iter()
            .map(|(method, handlers)| (method.clone(), handlers.clone()))
            .collect()
    }

    /// Record one failure and return the delay that must precede the retry:
    /// `base * 2^(n-1)` capped by the caller-supplied maximum.
    fn next_backoff(&self) -> Duration {
        let failures = self
            .failures
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        let exponent = failures.saturating_sub(1).min(16);
        let base = self.options.base_backoff.as_millis().max(1) as u64;
        let cap = self.options.max_backoff.as_millis().max(1) as u64;
        let delay = base.saturating_mul(1_u64 << exponent);
        Duration::from_millis(delay.min(cap))
    }

    async fn sleep(&self, duration: Duration) {
        match self.options.sleep.as_ref() {
            Some(sleep) => sleep(duration).await,
            None => default_sleep(duration).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn script(source: &str) -> StdioRpcCommand {
        StdioRpcCommand::new("/bin/sh", vec!["-c".to_string(), source.to_string()])
    }

    async fn recv_message(receiver: &mut mpsc::UnboundedReceiver<RpcMessage>) -> RpcMessage {
        tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .expect("a message must arrive within the test timeout")
            .expect("the channel must stay open")
    }

    async fn recv_close(receiver: &mut mpsc::UnboundedReceiver<CollectorError>) -> CollectorError {
        tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .expect("the transport must report closure within the test timeout")
            .expect("the channel must stay open")
    }

    #[test]
    fn message_ids_are_numeric_and_notifications_are_recognised() {
        let request = RpcMessage::request(7, "account/read", json!({}));
        assert_eq!(request.numeric_id(), Some(7));
        assert!(!request.is_notification());

        let notification = RpcMessage::notification("initialized");
        assert_eq!(notification.numeric_id(), None);
        assert!(notification.is_notification());
        assert_eq!(
            serde_json::to_string(&notification).unwrap(),
            r#"{"method":"initialized"}"#
        );

        let text_id = RpcMessage {
            id: Some(Value::String("7".into())),
            ..RpcMessage::default()
        };
        assert_eq!(text_id.numeric_id(), None);
    }

    #[test]
    fn stderr_tails_keep_the_last_bytes_on_a_char_boundary() {
        let mut tail = String::from("prefix-");
        tail.push_str(&"x".repeat(20));
        keep_tail(&mut tail, 10);
        assert_eq!(tail.len(), 10);

        let mut unicode = String::from("使用量");
        keep_tail(&mut unicode, 4);
        assert!(unicode.is_char_boundary(0));
        assert!(unicode.len() <= 4);
    }

    #[tokio::test]
    async fn stdio_transport_splits_lines_and_tolerates_partial_chunks_and_blank_lines() {
        let transport = StdioRpcTransport::spawn(script(
            "printf '{\"method\":\"one\",\"params\":{\"a\":1}}\\n\\n'; sleep 0.2; printf '{\"method\":\"two\",\"params\":{\"b\":2}}\\n'; sleep 0.2",
        ))
        .expect("the script must start");

        let (tx, mut rx) = mpsc::unbounded_channel();
        transport.on_message(Arc::new(move |message| {
            let _ = tx.send(message);
        }));

        let first = recv_message(&mut rx).await;
        assert_eq!(first.method.as_deref(), Some("one"));
        assert_eq!(first.params_or_null(), json!({ "a": 1 }));

        // The second line is emitted in its own write, proving the reader
        // buffers until a newline arrives rather than parsing chunks.
        let second = recv_message(&mut rx).await;
        assert_eq!(second.method.as_deref(), Some("two"));
        assert_eq!(second.params_or_null(), json!({ "b": 2 }));
    }

    #[tokio::test]
    async fn stdio_transport_reports_a_process_exit_with_the_stderr_tail() {
        let transport = StdioRpcTransport::spawn(script(
            "printf '%s' \"$(printf 'x%.0s' $(seq 1 3000))\" >&2; printf 'no-login ' >&2; exit 3",
        ))
        .expect("the script must start");

        let (tx, mut rx) = mpsc::unbounded_channel();
        transport.on_close(Arc::new(move |error| {
            let _ = tx.send(error);
        }));

        let error = recv_close(&mut rx).await;
        assert_eq!(error.kind, ErrorKind::Process);
        assert!(error.message.contains("exited (3)"), "{}", error.message);
        assert!(error.message.ends_with("no-login"), "{}", error.message);
        assert!(error.message.len() < 2_100, "stderr tail must be bounded");
        assert!(transport.is_closed());
    }

    #[tokio::test]
    async fn stdio_transport_rejects_invalid_json_without_panicking() {
        let transport = StdioRpcTransport::spawn(script("printf 'not json\\n'; sleep 0.2"))
            .expect("the script must start");

        let (tx, mut rx) = mpsc::unbounded_channel();
        transport.on_close(Arc::new(move |error| {
            let _ = tx.send(error);
        }));

        let error = recv_close(&mut rx).await;
        assert_eq!(error.kind, ErrorKind::Compatibility);
        assert!(error.message.contains("invalid JSON"));
    }

    #[tokio::test]
    async fn stdio_transport_fails_a_send_after_the_session_closed() {
        let transport = StdioRpcTransport::spawn(script("exit 0")).expect("the script must start");

        let (tx, mut rx) = mpsc::unbounded_channel();
        transport.on_close(Arc::new(move |error| {
            let _ = tx.send(error);
        }));
        let _ = recv_close(&mut rx).await;

        // Closing is idempotent and the waiter task has already finished.
        transport.close();
        transport.close();
    }

    #[tokio::test]
    async fn a_refused_spawn_is_a_process_error() {
        let command = StdioRpcCommand::new(
            "/nonexistent/codex-does-not-exist",
            vec!["--version".to_string()],
        );
        let error =
            StdioRpcTransport::spawn(command).expect_err("spawning a missing program must fail");
        assert_eq!(error.kind, ErrorKind::Process);
        assert!(error.message.contains("cannot start Codex app-server"));
    }

    #[tokio::test]
    async fn json_rpc_errors_map_onto_the_shared_vocabulary() {
        let compatibility = rpc_error_to_collector_error(
            &RpcErrorObject {
                code: Some(-32601),
                message: "method not found".into(),
                data: None,
            },
            "account/read",
        );
        assert_eq!(compatibility.kind, ErrorKind::Compatibility);
        assert!(compatibility.message.contains("method not found"));

        let authentication = rpc_error_to_collector_error(
            &RpcErrorObject {
                code: Some(-32000),
                message: "user is not signed in".into(),
                data: None,
            },
            "account/read",
        );
        assert_eq!(authentication.kind, ErrorKind::Authentication);

        let rate_limit = rpc_error_to_collector_error(
            &RpcErrorObject {
                code: None,
                message: "rate limit exceeded token=not-a-real-token".into(),
                data: None,
            },
            "account/rateLimits/read",
        );
        assert_eq!(rate_limit.kind, ErrorKind::RateLimit);
        assert!(!rate_limit.message.contains("not-a-real-token"));
    }

    #[test]
    fn the_backoff_doubles_and_stops_at_the_caller_maximum() {
        let supervisor = CodexAppServerSupervisor::with_transport_factory(
            Arc::new(|| Err(CollectorError::new(ErrorKind::Process, "unused"))),
            CodexSupervisorOptions {
                base_backoff: Duration::from_millis(250),
                max_backoff: Duration::from_millis(1_000),
                ..CodexSupervisorOptions::immediate()
            },
        );
        let delays: Vec<u64> = (0..5)
            .map(|_| supervisor.next_backoff().as_millis() as u64)
            .collect();
        assert_eq!(delays, vec![250, 500, 1_000, 1_000, 1_000]);
    }

    #[tokio::test]
    async fn a_closed_transport_resolves_registered_handlers_immediately() {
        let transport: SharedRpcTransport =
            StdioRpcTransport::spawn(script("exit 0")).expect("the script must start");
        let (tx, mut rx) = mpsc::unbounded_channel();
        transport.on_close(Arc::new(move |error| {
            let _ = tx.send(error);
        }));
        let _ = recv_close(&mut rx).await;

        // A handler registered after the exit must still fire: otherwise a
        // request issued in that window would wait forever.
        let (late_tx, mut late_rx) = mpsc::unbounded_channel();
        let started = Instant::now();
        transport.on_close(Arc::new(move |error| {
            let _ = late_tx.send(error);
        }));
        let error = recv_close(&mut late_rx).await;
        assert_eq!(error.kind, ErrorKind::Process);
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}

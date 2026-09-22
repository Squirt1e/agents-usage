//! The standalone loopback usage service.
//!
//! One service owns one desktop data directory: it takes the exclusive lock,
//! publishes private discovery information (loopback address, protocol version,
//! instance id and a high-entropy session token), runs the read-only collectors
//! on a shared schedule, and serves the authenticated loopback API that both the
//! desktop panel and the companion web page consume.
//!
//! Lifecycle guarantees (tasks 4.3–4.6):
//!
//! - **one owner**: a second launch cannot take the data-directory lock and must
//!   connect to the recorded service or report a recoverable error;
//! - **no credential leakage**: every response is redacted, the session token is
//!   never printed or persisted in a URL, and mutations require the token plus a
//!   loopback Host/Origin;
//! - **ordered shutdown**: stop the schedule, stop the Codex child process, then
//!   release the lock and close the database — never leaving a stray child.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use std::sync::RwLock;
use tokio::sync::broadcast;

use futures::future::BoxFuture;

use usage_core::adapters::codex::{
    codex_collector_from_discovery, CodexCliDiscoveryOptions, CodexCollector,
    CodexCollectorOptions, SystemCommandRunner,
};
use usage_core::adapters::deepseek::DeepSeekCollector;
use usage_core::adapters::deepseek_web::DeepSeekWebCollector;
use usage_core::adapters::glm::{glm_wallet_allowed_hosts, GlmQuotaCollector, GlmWalletCollector};
use usage_core::contracts::{
    ConnectionId, DesktopSettings, IsoTimestamp, ProviderId, ProviderSnapshot,
};
use usage_core::credentials::{keychain_get_sync, CredentialTarget};
use usage_core::estimate::Timezone;
use usage_core::transport::{CollectorError, SharedHttpTransport};
use usage_core::reqwest_transport::ReqwestTransport;
use usage_core::scheduler::{RefreshPolicy, RefreshScheduler};
use usage_core::storage::data_dir::{
    random_token, DataDirectory, ServiceDiscovery, StorageError, PROTOCOL_VERSION,
};
use usage_core::storage::Store;

pub mod api;

/// Re-exported so the API layer can build scheduler tasks with the same type.
pub use usage_core::scheduler::{RefreshOutcome, RefreshTask};

/// Configuration the service is started with.
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub data_dir: PathBuf,
    pub host: String,
    pub port: u16,
    pub timezone: String,
    /// Operator override for the Codex CLI. It wins over the path stored in
    /// settings, which is the one a user can change while the service runs.
    pub codex_cli_path: Option<String>,
    pub client_dir: Option<PathBuf>,
    /// Whether the service schedules its own periodic refresh on start. Tests
    /// disable this so collectors (and any Keychain/Codex subprocess) stay out
    /// of the way of the HTTP API checks.
    pub auto_refresh: bool,
}

fn default_system_timezone() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(target) = std::fs::read_link("/etc/localtime") {
        let target = target.to_string_lossy();
        if let Some((_, timezone)) = target.split_once("/zoneinfo/") {
            if timezone.parse::<chrono_tz::Tz>().is_ok() {
                return timezone.to_string();
            }
        }
    }
    "UTC".to_string()
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            data_dir: DataDirectory::default_root(),
            host: "127.0.0.1".to_string(),
            port: 47_160,
            timezone: default_system_timezone(),
            codex_cli_path: None,
            client_dir: None,
            auto_refresh: true,
        }
    }
}

impl ServiceConfig {
    fn glm_wallet_endpoint(&self) -> Option<String> {
        std::env::var("AGENTS_USAGE_GLM_WALLET_ENDPOINT")
            .ok()
            .filter(|value| !value.trim().is_empty())
    }
}

#[cfg(test)]
mod service_config_tests {
    use super::ServiceConfig;

    #[cfg(target_os = "macos")]
    #[test]
    fn default_config_uses_the_macos_system_timezone() {
        let target = std::fs::read_link("/etc/localtime").expect("macOS localtime link");
        let target = target.to_string_lossy();
        let expected = target
            .split("/zoneinfo/")
            .nth(1)
            .expect("IANA timezone in macOS localtime link");

        assert_eq!(ServiceConfig::default().timezone, expected);
    }
}

/// Collectors assembled for the service.
pub struct Collectors {
    /// The Codex collector is the one that can be replaced while the service
    /// runs (the CLI path is a setting), so it is a slot rather than a value.
    pub codex: Arc<CodexSlot>,
    pub glm_quota: Arc<GlmQuotaCollector>,
    pub glm_wallet: Arc<GlmWalletCollector>,
    pub deepseek: Arc<DeepSeekCollector>,
    pub deepseek_web: Arc<DeepSeekWebCollector>,
}

impl Collectors {
    async fn codex_shutdown(&self) {
        self.codex.shutdown().await;
    }
}

/// How a Codex CLI path becomes a collector.
///
/// Injected so the resolution rules — when a path change is looked up again, when
/// a user's refresh looks again — are testable without a Codex CLI on the machine.
pub type CodexDiscovery = Arc<
    dyn Fn(Option<String>) -> BoxFuture<'static, Result<Arc<CodexCollector>, CollectorError>>
        + Send
        + Sync,
>;

/// Discovery as a real service runs it: the configured path first, then
/// `$CODEX_HOME`, then the known absolute locations, then the inherited `PATH` —
/// never a login shell (see `usage_core::adapters::codex::cli`).
pub fn system_codex_discovery() -> CodexDiscovery {
    Arc::new(|configured: Option<String>| {
        Box::pin(async move {
            let options = CodexCliDiscoveryOptions::from_env(configured);
            let (_cli, collector) = codex_collector_from_discovery(
                &SystemCommandRunner::default(),
                &options,
                CodexCollectorOptions::default(),
            )
            .await?;
            Ok(Arc::new(collector))
        })
    })
}

/// Which path the slot has already resolved.
///
/// `Never` is a state of its own: "resolved for no configured path at all" is a
/// real answer (auto-discovery ran and found nothing) and must not be read as
/// "nobody has looked yet", or the first look would never happen.
enum CodexResolved {
    Never,
    At(Option<String>),
}

/// What asking the slot for the collector of the path in effect produced.
pub enum CodexResolution {
    /// That path was already resolved; the collector is there or it is not.
    Reused(Option<Arc<CodexCollector>>),
    /// Resolved just now: the collector is new, so its rate-limit notification
    /// has to be wired before it is used.
    Fresh(Arc<CodexCollector>),
    /// Discovery failed just now for the path in effect; the caller records it.
    Failed(CollectorError),
}

/// The Codex collector for the CLI path in effect.
///
/// One `CodexCollector` is one `codex app-server` session, and a session is bound
/// to the program that started it: a new path is a new collector, not a new
/// argument to the old one. The slot owns that replacement, and remembers which
/// path the current answer belongs to so no lookup is repeated for nothing.
///
/// The path has to be re-read at all because it is a setting the user can change
/// while the service runs. Resolving it once at startup is what made a saved path
/// take effect only after the whole app was restarted: the service had no
/// collector to collect with, and every refresh skipped Codex in silence.
pub struct CodexSlot {
    /// The operator's override from the command line; wins over the stored setting.
    cli_override: Option<String>,
    discovery: CodexDiscovery,
    state: tokio::sync::Mutex<CodexSlotState>,
}

struct CodexSlotState {
    resolved: CodexResolved,
    collector: Option<Arc<CodexCollector>>,
}

impl CodexSlot {
    /// A slot that has not looked for a CLI yet.
    pub fn new(cli_override: Option<String>, discovery: CodexDiscovery) -> Arc<Self> {
        Arc::new(Self {
            cli_override,
            discovery,
            state: tokio::sync::Mutex::new(CodexSlotState {
                resolved: CodexResolved::Never,
                collector: None,
            }),
        })
    }

    /// The path in effect: the operator's override, else the stored setting.
    fn effective_path(&self, stored: Option<&str>) -> Option<String> {
        self.cli_override
            .clone()
            .or_else(|| stored.map(str::to_owned))
    }

    /// The collector for the path in effect, looking the CLI up when it has to.
    ///
    /// `force` is what a user action means: someone who just installed the CLI
    /// and pressed refresh expects that press to find it. It only counts while
    /// there is nothing to use — a working collector already answers the path in
    /// effect, and rebuilding it would kill a live session to learn the same
    /// thing, once per click.
    pub async fn resolve(&self, stored: Option<&str>, force: bool) -> CodexResolution {
        let effective = self.effective_path(stored);
        let mut state = self.state.lock().await;
        let look_again = match &state.resolved {
            CodexResolved::Never => true,
            CodexResolved::At(path) => {
                path.as_deref() != effective.as_deref() || (force && state.collector.is_none())
            }
        };
        if !look_again {
            return CodexResolution::Reused(state.collector.clone());
        }
        // The old session belongs to the old path: close it before the new
        // collector can open a second one.
        if let Some(previous) = state.collector.take() {
            previous.shutdown().await;
        }
        state.resolved = CodexResolved::At(effective.clone());
        match (self.discovery)(effective).await {
            Ok(collector) => {
                state.collector = Some(Arc::clone(&collector));
                CodexResolution::Fresh(collector)
            }
            Err(error) => CodexResolution::Failed(error),
        }
    }

    /// Drop the session so no Codex child process is left behind.
    pub async fn shutdown(&self) {
        let mut state = self.state.lock().await;
        if let Some(collector) = state.collector.take() {
            collector.shutdown().await;
        }
    }
}

/// A running service: the owner of the data directory, the schedule and the
/// Codex child process.
pub struct RunningService {
    config: ServiceConfig,
    data_dir: DataDirectory,
    collectors: Arc<Collectors>,
    http_port: u16,
    http: Option<HttpServer>,
}

/// The HTTP half of a running service, moved onto a spawned task while the
/// [`RunningService`] keeps ownership of the data directory for shutdown.
pub struct HttpServer {
    listener: tokio::net::TcpListener,
    app: axum::Router,
}

impl HttpServer {
    /// Run the HTTP server until it stops.
    pub async fn serve(self) -> Result<(), ServiceError> {
        axum::serve(self.listener, self.app)
            .await
            .map_err(|error| ServiceError::Serve(error.to_string()))
    }
}

impl RunningService {
    pub fn origin(&self) -> String {
        let host = if self.config.host.contains(':') {
            format!("[{}]", self.config.host)
        } else {
            self.config.host.clone()
        };
        format!("http://{host}:{}", self.http_port)
    }

    pub fn port(&self) -> u16 {
        self.http_port
    }

    /// Take the HTTP server out so it can be served on its own task.
    pub fn take_http_server(&mut self) -> Option<HttpServer> {
        self.http.take()
    }

    /// Ordered shutdown: stop the Codex child, then release the lock.
    pub async fn shutdown(&mut self) {
        self.collectors.codex_shutdown().await;
        let mut data_dir = std::mem::replace(
            &mut self.data_dir,
            DataDirectory::open(&self.config.data_dir).expect("data directory must reopen"),
        );
        data_dir.release();
        drop(data_dir);
    }
}

/// Build the service without starting it, so tests can inject transports.
pub struct ServiceBuilder {
    config: ServiceConfig,
    transport: SharedHttpTransport,
}

impl ServiceBuilder {
    pub fn new(config: ServiceConfig) -> Result<Self, ServiceError> {
        let transport: SharedHttpTransport =
            Arc::new(ReqwestTransport::new("agents-usage-desktop")?);
        Ok(Self { config, transport })
    }

    pub fn with_transport(config: ServiceConfig, transport: SharedHttpTransport) -> Self {
        Self { config, transport }
    }

    pub async fn start(self) -> Result<RunningService, ServiceError> {
        start_service(self.config, self.transport).await
    }
}

async fn start_service(
    config: ServiceConfig,
    transport: SharedHttpTransport,
) -> Result<RunningService, ServiceError> {
    let mut data_dir = DataDirectory::open(&config.data_dir)?;
    if !data_dir.try_acquire()? {
        return match data_dir.read_discovery()? {
            Some(discovery) if discovery.protocol_version == PROTOCOL_VERSION => {
                Err(ServiceError::AlreadyRunning {
                    origin: discovery.origin(),
                    instance_id: discovery.instance_id,
                })
            }
            _ => Err(ServiceError::DirectoryInUse {
                path: data_dir.discovery_path().to_path_buf(),
            }),
        };
    }

    let instance_id = random_token(16);
    let session_token = random_token(32);
    let store = Arc::new(std::sync::Mutex::new(Store::open(
        data_dir.database_path(),
    )?));
    let settings = {
        let store = store.lock().expect("store lock");
        store.desktop_settings(&config.timezone)?
    };
    let settings = Arc::new(RwLock::new(settings));

    let (event_tx, _) = broadcast::channel::<api::ServiceEvent>(256);
    let scheduler = Arc::new(RefreshScheduler::new(RefreshPolicy::provider_defaults()));

    // Where the Codex CLI is: the command line wins (an operator's override), and
    // after that the path the user set in the panel. That setting is the only
    // remedy a Finder launch has — such an app inherits a minimal `PATH` and an
    // npm-installed Codex lives under a version manager the built-in candidate
    // list does not cover — so a value the user typed has to reach the collector.
    // It is handed to the slot as the starting path: the slot re-reads what is in
    // effect on every resolution, because the setting can change while the
    // service runs.
    let collectors = build_collectors(
        Arc::clone(&transport),
        Arc::clone(&settings),
        Arc::clone(&store),
        config.timezone.clone(),
        config.codex_cli_path.clone(),
        config.glm_wallet_endpoint(),
    )
    .await?;

    let listener = bind_loopback(&config.host, config.port).await?;
    let http_port = listener
        .local_addr()
        .map_err(|error: std::io::Error| ServiceError::Bind(error.to_string()))?
        .port();

    let owned_by_desktop = std::env::var_os("AGENTS_USAGE_DESKTOP_OWNED").is_some();
    data_dir.write_discovery(&ServiceDiscovery {
        protocol_version: PROTOCOL_VERSION,
        instance_id: instance_id.clone(),
        session_token: session_token.clone(),
        host: config.host.clone(),
        port: http_port,
        pid: std::process::id(),
        started_at: IsoTimestamp::now(),
        owned_by_desktop,
    })?;

    // When the desktop host owns this service, exit with it: watch the host's
    // process and shut down the moment it disappears, so a crashed or
    // AppleScript-quit host never leaves a stray service (or Codex child)
    // behind. This is more reliable than relying on the host to reap us.
    if owned_by_desktop {
        spawn_parent_watchdog();
    }

    let state = Arc::new(api::AppState {
        store: Arc::clone(&store),
        settings: Arc::clone(&settings),
        scheduler: Arc::clone(&scheduler),
        collectors: Arc::clone(&collectors),
        transport: Arc::clone(&transport),
        session_token: session_token.clone(),
        instance_id: instance_id.clone(),
        timezone: config.timezone.clone(),
        events: event_tx.clone(),
    });

    let app = api::router(Arc::clone(&state), config.client_dir.clone());

    // Resolve the Codex CLI once before serving: a miss has to be in the stored
    // state — and on the card — from the first snapshot, not only once something
    // has been collected. This is also what wires the rate-limit notification for
    // the collector it finds, and for every collector that replaces it later.
    let _ = state.codex_collector(false).await;

    let auto_refresh = config.auto_refresh;
    let running = RunningService {
        config,
        data_dir,
        collectors,
        http_port,
        http: Some(HttpServer { listener, app }),
    };

    if auto_refresh {
        spawn_schedule(Arc::clone(&state));
    }
    Ok(running)
}

fn spawn_schedule(state: Arc<api::AppState>) {
    tokio::spawn(async move {
        let _ = state.refresh_all().await;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let _ = state.refresh_all().await;
        }
    });
}

/// Exit when the desktop host that owns this service disappears.
///
/// The host is the service's parent at startup; when it dies, macOS reparents the
/// service to launchd, so we capture the original parent PID and poll it with a
/// no-op `kill(pid, 0)`. `ESRCH` means the host is gone and the service exits,
/// which also closes the Codex stdio session (no stray child).
fn spawn_parent_watchdog() {
    let parent = std::os::unix::process::parent_id();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            // SAFETY: `kill` with signal 0 performs an existence check only and
            // never delivers a signal.
            let alive = unsafe { libc::kill(parent as libc::pid_t, 0) } == 0;
            if !alive {
                tracing::info!("owning desktop host exited; stopping the service");
                std::process::exit(0);
            }
        }
    });
}

async fn build_collectors(
    transport: SharedHttpTransport,
    settings: Arc<RwLock<DesktopSettings>>,
    store: Arc<std::sync::Mutex<Store>>,
    timezone: String,
    codex_cli_path: Option<String>,
    glm_wallet_endpoint: Option<String>,
) -> Result<Arc<Collectors>, ServiceError> {
    let timezone_parsed = Timezone::parse(&timezone)?;

    // A slot rather than a collector: the Codex CLI path is a setting the user can
    // change while the service runs, and a CLI that was missing at startup has to
    // stay recoverable without restarting anything. `start_service` resolves it
    // once before serving, which is where a miss gets recorded.
    let codex = CodexSlot::new(codex_cli_path, system_codex_discovery());

    let glm_quota = Arc::new(
        GlmQuotaCollector::new(Arc::clone(&transport))
            .with_region_resolver(Arc::new({
                let settings = Arc::clone(&settings);
                move || settings.read().unwrap().glm_region
            }))
            .with_credential(Arc::new(|| {
                keychain_get_sync(CredentialTarget::GlmQuota).ok().flatten()
            })),
    );

    let glm_wallet = Arc::new(
        GlmWalletCollector::new(Arc::clone(&transport))
            .with_enabled(Arc::new({
                let settings = Arc::clone(&settings);
                move || settings.read().unwrap().glm_wallet_enabled
            }))
            .with_allowed_hosts(glm_wallet_allowed_hosts())
            .with_endpoint(glm_wallet_endpoint.unwrap_or_default())
            .with_credential(Arc::new(|| {
                keychain_get_sync(CredentialTarget::GlmWallet)
                    .ok()
                    .flatten()
            }))
            .with_balance_store(Arc::clone(&store), timezone_parsed.clone()),
    );

    let deepseek = Arc::new(
        DeepSeekCollector::new(Arc::clone(&transport), move || {
            keychain_get_sync(CredentialTarget::DeepSeek)
        })
        .with_balance_store(Arc::clone(&store), timezone_parsed.clone()),
    );

    let deepseek_web = Arc::new(
        DeepSeekWebCollector::new(Arc::clone(&transport), timezone.clone())
            .with_enabled(Arc::new({
                let settings = Arc::clone(&settings);
                move || settings.read().unwrap().deepseek_web_enabled
            }))
            .with_credential(Arc::new(|| {
                keychain_get_sync(CredentialTarget::DeepSeekWeb)
                    .ok()
                    .flatten()
            })),
    );

    Ok(Arc::new(Collectors {
        codex,
        glm_quota,
        glm_wallet,
        deepseek,
        deepseek_web,
    }))
}

async fn bind_loopback(host: &str, port: u16) -> Result<tokio::net::TcpListener, ServiceError> {
    let preferred: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|error: std::net::AddrParseError| ServiceError::Bind(error.to_string()))?;
    match tokio::net::TcpListener::bind(preferred).await {
        Ok(listener) => Ok(listener),
        Err(_) => {
            let fallback: SocketAddr = format!("{host}:0")
                .parse()
                .map_err(|error: std::net::AddrParseError| ServiceError::Bind(error.to_string()))?;
            tokio::net::TcpListener::bind(fallback)
                .await
                .map_err(|error| ServiceError::Bind(error.to_string()))
        }
    }
}

/// Run one connection's refresh through the scheduler and persist the outcome.
pub async fn run_connection(
    scheduler: &Arc<RefreshScheduler>,
    store: &Arc<std::sync::Mutex<Store>>,
    key: &str,
    provider: ProviderId,
    connection: &ConnectionId,
    task: RefreshTask<ProviderSnapshot>,
) {
    run_connection_forced(scheduler, store, key, provider, connection, task, false).await;
}

/// Run one connection's refresh, optionally bypassing the cooldown, and persist
/// the outcome.
pub async fn run_connection_forced(
    scheduler: &Arc<RefreshScheduler>,
    store: &Arc<std::sync::Mutex<Store>>,
    key: &str,
    provider: ProviderId,
    connection: &ConnectionId,
    task: RefreshTask<ProviderSnapshot>,
    force: bool,
) {
    let outcome = scheduler.refresh(key, force, task).await;
    let connection = connection.clone();
    match outcome {
        RefreshOutcome::Success(snapshot) => {
            if let Ok(mut store) = store.lock() {
                let _ = store.save_success(&snapshot);
            }
        }
        RefreshOutcome::Failure(error) => {
            let consecutive = scheduler.consecutive_failures(key).await;
            let contract = error.to_contract(IsoTimestamp::now());
            if let Ok(mut store) = store.lock() {
                let _ = store.save_failure(provider, Some(&connection), &contract, consecutive);
            }
        }
        RefreshOutcome::Cooldown { .. } => {}
    }
}

/// Convert a collector error to the serializable contract error.
pub fn contract_error(
    error: &CollectorError,
    at: IsoTimestamp,
) -> usage_core::contracts::CollectorError {
    error.to_contract(at)
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("the data directory could not be used: {0}")]
    Storage(#[from] StorageError),
    #[error("another service already owns this data directory: {origin} ({instance_id})")]
    AlreadyRunning { origin: String, instance_id: String },
    #[error("the data directory discovery file is in use by an incompatible process: {path}")]
    DirectoryInUse { path: PathBuf },
    #[error("cannot bind the loopback address: {0}")]
    Bind(String),
    #[error("cannot serve requests: {0}")]
    Serve(String),
    #[error("the HTTP client could not start: {0}")]
    Transport(#[from] CollectorError),
    #[error("the configured timezone is invalid: {0}")]
    Timezone(#[from] usage_core::estimate::TimezoneError),
    #[error("{0}")]
    Other(String),
}

/// The rules that decide **when** the Codex CLI is looked up again.
///
/// These are the whole point of the slot: the path is a setting the user changes
/// while the service runs, and the service used to resolve it once at startup.
/// A stand-in discovery and a collector that never starts a process keep the test
/// about the bookkeeping rather than about the app-server protocol.
#[cfg(test)]
mod codex_slot_tests {
    use super::*;
    use usage_core::adapters::codex::{CodexAppServerSupervisor, TransportFactory};
    use usage_core::contracts::ErrorKind;

    /// A collector that spawns nothing: the transport factory fails, so there is
    /// no child process to start or to close.
    fn idle_collector() -> Arc<CodexCollector> {
        let factory: TransportFactory =
            Arc::new(|| Err(CollectorError::new(ErrorKind::Process, "test double")));
        let supervisor = CodexAppServerSupervisor::with_transport_factory(
            factory,
            CodexCollectorOptions::default().supervisor_options(),
        );
        Arc::new(CodexCollector::from_supervisor(supervisor))
    }

    /// Discovery that records the path it was asked for and fails for the paths
    /// listed as missing.
    fn scripted_discovery(
        asked: Arc<std::sync::Mutex<Vec<Option<String>>>>,
        missing: Vec<&'static str>,
    ) -> CodexDiscovery {
        Arc::new(move |path: Option<String>| {
            let asked = Arc::clone(&asked);
            let missing = missing.clone();
            Box::pin(async move {
                let absent = path
                    .as_deref()
                    .is_some_and(|path| missing.contains(&path));
                asked.lock().expect("discovery log").push(path);
                if absent {
                    Err(CollectorError::new(
                        ErrorKind::MissingConfig,
                        "Codex CLI was not found; install the Codex CLI or set its absolute path in Codex settings",
                    ))
                } else {
                    Ok(idle_collector())
                }
            })
        })
    }

    /// The first look must happen even when nothing is configured at all, and a
    /// verdict must not be re-probed on every scheduled pass.
    #[tokio::test]
    async fn a_verdict_is_reached_once_and_then_reused() {
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let slot = CodexSlot::new(None, scripted_discovery(Arc::clone(&asked), vec!["/nope/codex"]));

        // "Not looked yet" and "looked for no configured path" are different
        // states, or auto-discovery would never run at all.
        assert!(matches!(
            slot.resolve(Some("/nope/codex"), false).await,
            CodexResolution::Failed(_)
        ));
        assert!(matches!(
            slot.resolve(Some("/nope/codex"), false).await,
            CodexResolution::Reused(None)
        ));
        assert_eq!(
            asked.lock().expect("log").len(),
            1,
            "a scheduled pass must not run the version probe again"
        );
    }

    /// Saving a path is a new question, and the old session belongs to the old path.
    #[tokio::test]
    async fn a_changed_path_is_looked_up_again() {
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let slot = CodexSlot::new(None, scripted_discovery(Arc::clone(&asked), vec!["/nope/codex"]));

        assert!(matches!(
            slot.resolve(Some("/nope/codex"), false).await,
            CodexResolution::Failed(_)
        ));
        let saved = "/Users/someone/.nvm/versions/node/v24.19.0/bin/codex";
        let CodexResolution::Fresh(fresh) = slot.resolve(Some(saved), false).await else {
            panic!("a saved path must be looked up, not served from the previous verdict");
        };
        assert_eq!(
            asked.lock().expect("log").last().cloned().flatten().as_deref(),
            Some(saved),
            "the new path is the one discovery has to be asked about"
        );

        // Same path, no user action: no second lookup, and the same session.
        let CodexResolution::Reused(Some(reused)) = slot.resolve(Some(saved), false).await else {
            panic!("an unchanged path must reuse its collector");
        };
        assert!(Arc::ptr_eq(&fresh, &reused), "the session must survive");
        assert_eq!(asked.lock().expect("log").len(), 2);
    }

    /// A user action looks again only while there is nothing to use: rebuilding a
    /// working collector would kill a live session to learn the same thing, once
    /// per click.
    #[tokio::test]
    async fn a_refresh_only_looks_again_when_there_is_no_collector() {
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let slot = CodexSlot::new(None, scripted_discovery(Arc::clone(&asked), vec!["/nope/codex"]));

        assert!(matches!(
            slot.resolve(Some("/nope/codex"), false).await,
            CodexResolution::Failed(_)
        ));
        // Nothing was found before, so pressing refresh is a reason to look again.
        assert!(matches!(
            slot.resolve(Some("/nope/codex"), true).await,
            CodexResolution::Failed(_)
        ));
        assert_eq!(asked.lock().expect("log").len(), 2);

        let CodexResolution::Fresh(fresh) = slot.resolve(Some("/usr/bin/true"), false).await else {
            panic!("a path that resolves must produce a collector");
        };
        let CodexResolution::Reused(Some(reused)) = slot.resolve(Some("/usr/bin/true"), true).await
        else {
            panic!("a working collector already answers the path in effect");
        };
        assert!(Arc::ptr_eq(&fresh, &reused));
        assert_eq!(
            asked.lock().expect("log").len(),
            3,
            "a refresh must not probe again while a collector is in use"
        );
    }

    /// The command line is an operator's override: it decides the path, not the
    /// stored setting the user edits.
    #[tokio::test]
    async fn the_operator_override_wins_over_the_stored_path() {
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let slot = CodexSlot::new(
            Some("/opt/homebrew/bin/codex".to_string()),
            scripted_discovery(Arc::clone(&asked), vec![]),
        );

        assert!(matches!(
            slot.resolve(Some("/somewhere/else/codex"), false).await,
            CodexResolution::Fresh(_)
        ));
        assert_eq!(
            asked.lock().expect("log").as_slice(),
            [Some("/opt/homebrew/bin/codex".to_string())]
        );
    }
}


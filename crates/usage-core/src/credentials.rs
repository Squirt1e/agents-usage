//! macOS Keychain credential access.
//!
//! The Rust runtime reads and writes the **same** Keychain items the legacy Node
//! dashboard uses, so a credential configured in either version is visible to
//! the other and no secret is ever copied between stores:
//!
//! ```text
//! service  agents-usage.codex     account default
//! service  agents-usage.glm       account default              (Coding Plan quota)
//! service  agents-usage.glm       account wallet-experimental  (experimental wallet)
//! service  agents-usage.deepseek  account default
//! service  agents-usage.deepseek  account web-experimental     (experimental web usage)
//! ```
//!
//! Access goes through `CredentialStore`, a narrow trait so tests never touch the
//! real Keychain. `MacOsKeychainStore` shells out to `/usr/bin/security`, which
//! keeps the permission decision with macOS: if the user denies access, the
//! failure surfaces as an authentication error and nothing is bypassed.
//!
//! Replacing a credential is validate-then-write: the new secret is checked by a
//! caller-supplied validator first, and only a valid secret overwrites the stored
//! one. Status reads return a masked suffix, never the secret.

use std::collections::BTreeMap;

use crate::contracts::ProviderId;
use crate::http::{CollectorError, CommandOutput, CommandRunner};
use crate::redaction::redact_str;

/// Base service name shared with the legacy runtime.
pub const SERVICE_PREFIX: &str = "agents-usage";
/// Account name used by the quota/primary connection of a provider.
pub const DEFAULT_ACCOUNT: &str = "default";
/// Account name used by the experimental GLM wallet connection.
pub const GLM_WALLET_ACCOUNT: &str = "wallet-experimental";
/// Account name used by the experimental DeepSeek web usage connection.
pub const DEEPSEEK_WEB_ACCOUNT: &str = "web-experimental";
/// Exit code the `security` tool uses for "item not found".
const ITEM_NOT_FOUND: i32 = 44;

/// Which provider connection a credential belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CredentialTarget {
    /// Codex is delegated to the local Codex CLI; the dashboard never stores a
    /// Codex secret.
    CodexDelegated,
    /// GLM Coding Plan quota connection.
    GlmQuota,
    /// GLM experimental wallet connection.
    GlmWallet,
    /// DeepSeek balance connection.
    DeepSeek,
    /// DeepSeek experimental web usage connection (platform session token).
    DeepSeekWeb,
}

impl CredentialTarget {
    /// Every target the desktop can manage.
    pub const MANAGED: [CredentialTarget; 4] = [
        CredentialTarget::GlmQuota,
        CredentialTarget::GlmWallet,
        CredentialTarget::DeepSeek,
        CredentialTarget::DeepSeekWeb,
    ];

    pub fn provider(self) -> ProviderId {
        match self {
            CredentialTarget::CodexDelegated => ProviderId::Codex,
            CredentialTarget::GlmQuota | CredentialTarget::GlmWallet => ProviderId::Glm,
            CredentialTarget::DeepSeek | CredentialTarget::DeepSeekWeb => ProviderId::Deepseek,
        }
    }

    pub fn account(self) -> &'static str {
        match self {
            CredentialTarget::GlmWallet => GLM_WALLET_ACCOUNT,
            CredentialTarget::DeepSeekWeb => DEEPSEEK_WEB_ACCOUNT,
            _ => DEFAULT_ACCOUNT,
        }
    }

    /// Keychain service name, identical to the legacy runtime's.
    pub fn service(self) -> String {
        format!("{SERVICE_PREFIX}.{}", self.provider().as_str())
    }

    /// Stable machine name used by the settings API.
    pub fn key(self) -> &'static str {
        match self {
            CredentialTarget::CodexDelegated => "codex",
            CredentialTarget::GlmQuota => "glm",
            CredentialTarget::GlmWallet => "glm-wallet",
            CredentialTarget::DeepSeek => "deepseek",
            CredentialTarget::DeepSeekWeb => "deepseek-web",
        }
    }

    /// Parse the machine name used by the HTTP API.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "glm" => Some(CredentialTarget::GlmQuota),
            "glm-wallet" => Some(CredentialTarget::GlmWallet),
            "deepseek" => Some(CredentialTarget::DeepSeek),
            "deepseek-web" => Some(CredentialTarget::DeepSeekWeb),
            "codex" => Some(CredentialTarget::CodexDelegated),
            _ => None,
        }
    }

    /// True when the desktop manages this credential itself.
    pub fn is_managed(self) -> bool {
        self != CredentialTarget::CodexDelegated
    }

    pub fn label(self) -> &'static str {
        match self {
            CredentialTarget::CodexDelegated => "Codex 登录",
            CredentialTarget::GlmQuota => "GLM 套餐",
            CredentialTarget::GlmWallet => "GLM 实验钱包",
            CredentialTarget::DeepSeek => "DeepSeek",
            CredentialTarget::DeepSeekWeb => "DeepSeek 网页用量",
        }
    }
}

/// Masked state of a stored credential.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub target: String,
    pub configured: bool,
    /// Last four characters of the stored secret, for display only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    /// True for targets the desktop does not store itself.
    pub delegated: bool,
    /// Whether the connection that uses this credential is enabled.
    pub enabled: bool,
}

impl CredentialStatus {
    pub fn missing(target: CredentialTarget, enabled: bool) -> Self {
        Self {
            target: target.key().to_string(),
            configured: false,
            suffix: None,
            delegated: !target.is_managed(),
            enabled,
        }
    }

    pub fn configured(target: CredentialTarget, secret: &str, enabled: bool) -> Self {
        Self {
            target: target.key().to_string(),
            configured: true,
            suffix: mask_suffix(secret),
            delegated: !target.is_managed(),
            enabled,
        }
    }
}

/// Mask a secret for display: the last four characters only.
pub fn mask_suffix(secret: &str) -> Option<String> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return None;
    }
    let characters: Vec<char> = trimmed.chars().collect();
    let start = characters.len().saturating_sub(4);
    Some(characters[start..].iter().collect())
}

/// Synchronous Keychain reads for the collectors' sync credential resolvers.
///
/// The collectors resolve a credential with a plain `Fn() -> Option<String>` (or
/// `Result<Option<String>, _>`), so they cannot await the async
/// [`CredentialStore`]. These helpers run `/usr/bin/security` directly and are
/// only used on the collector hot path, where a local, short-lived subprocess is
/// acceptable. The settings API keeps using the async store so a long-running
/// prompt never blocks a request handler.
pub fn keychain_get_sync(target: CredentialTarget) -> Result<Option<String>, CollectorError> {
    let output = run_security_sync(target, &["find-generic-password", "-w"], &[], None)?;
    if output.success() {
        let secret = output.stdout.trim_end_matches(['\n', '\r']).to_string();
        return Ok(if secret.is_empty() {
            None
        } else {
            Some(secret)
        });
    }
    if output.status == ITEM_NOT_FOUND
        || output
            .stderr
            .to_ascii_lowercase()
            .contains("could not be found")
    {
        return Ok(None);
    }
    Err(CollectorError::authentication(format!(
        "macOS refused to read the {} credential: {}",
        target.label(),
        redact_str(output.stderr.trim())
    )))
}

/// Synchronous Keychain write/delete used by the credential lifecycle API.
pub fn keychain_set_sync(target: CredentialTarget, secret: &str) -> Result<(), CollectorError> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err(CollectorError::missing_config("凭据不能为空"));
    }
    // `-w` follows the account and service, which is the order `security`'s own
    // usage prints: with it earlier the option swallows the next argument as the
    // password, the account goes missing, and `security` answers with its usage
    // text instead of storing anything — the wall of help the panel used to show.
    // In this order it prompts and reads the password from stdin, so the secret
    // never reaches the argument list.
    let output = run_security_sync(
        target,
        &["add-generic-password", "-U"],
        &["-w"],
        Some(format!("{trimmed}\n{trimmed}\n")),
    )?;
    if output.success() {
        return Ok(());
    }
    Err(CollectorError::new(
        crate::contracts::ErrorKind::Storage,
        format!(
            "cannot store the {} credential: {}",
            target.label(),
            redact_str(output.stderr.trim())
        ),
    ))
}

/// Synchronous Keychain delete; deleting a missing item is not an error.
pub fn keychain_delete_sync(target: CredentialTarget) -> Result<(), CollectorError> {
    let output = run_security_sync(target, &["delete-generic-password"], &[], None)?;
    if output.success()
        || output.status == ITEM_NOT_FOUND
        || output
            .stderr
            .to_ascii_lowercase()
            .contains("could not be found")
    {
        return Ok(());
    }
    Err(CollectorError::new(
        crate::contracts::ErrorKind::Storage,
        format!(
            "cannot delete the {} credential: {}",
            target.label(),
            redact_str(output.stderr.trim())
        ),
    ))
}

fn run_security_sync(
    target: CredentialTarget,
    extra: &[&str],
    trailing: &[&str],
    stdin: Option<String>,
) -> Result<CommandOutput, CollectorError> {
    let mut command = std::process::Command::new("/usr/bin/security");
    command.args(extra);
    command.arg("-a").arg(target.account());
    command.arg("-s").arg(target.service());
    // Options whose position matters go after the account and service: `security`
    // parses them in the order its own usage prints, and `-w` before `-a` swallows
    // the account as the password.
    command.args(trailing);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        CollectorError::process(format!("cannot run /usr/bin/security: {error}"))
    })?;

    if let Some(stdin) = stdin {
        use std::io::Write as _;
        if let Some(mut input) = child.stdin.take() {
            let _ = input.write_all(stdin.as_bytes());
        }
    }

    // The collectors resolve credentials through a synchronous closure, so this
    // runs on a tokio worker. Park the worker with `block_in_place` rather than
    // blocking it, letting `security` (and any macOS Keychain prompt) finish off
    // the executor. Outside a runtime it is called as a plain blocking wait.
    let output = match tokio::runtime::Handle::try_current() {
        Ok(_) => tokio::task::block_in_place(|| child.wait_with_output()),
        Err(_) => child.wait_with_output(),
    }
    .map_err(|error| CollectorError::process(format!("security command failed: {error}")))?;
    Ok(CommandOutput {
        status: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Narrow credential access used by the collectors and the settings API.
pub trait CredentialStore: Send + Sync + std::fmt::Debug {
    /// Read a secret. `Ok(None)` means "not configured", not "failed".
    fn get(
        &self,
        target: CredentialTarget,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<String>, CollectorError>> + Send + '_>,
    >;

    /// Store or replace a secret.
    fn set(
        &self,
        target: CredentialTarget,
        secret: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), CollectorError>> + Send + '_>>;

    /// Delete a secret. Deleting a missing item is not an error.
    fn delete(
        &self,
        target: CredentialTarget,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), CollectorError>> + Send + '_>>;
}

/// `/usr/bin/security` backed store.
#[derive(Debug)]
pub struct MacOsKeychainStore<R: CommandRunner> {
    runner: R,
    security_binary: String,
}

impl<R: CommandRunner> MacOsKeychainStore<R> {
    pub fn new(runner: R) -> Self {
        Self {
            runner,
            security_binary: "/usr/bin/security".to_string(),
        }
    }

    /// Override the `security` binary path (used by tests).
    pub fn with_binary(runner: R, binary: impl Into<String>) -> Self {
        Self {
            runner,
            security_binary: binary.into(),
        }
    }

    fn args(target: CredentialTarget, extra: &[&str]) -> Vec<String> {
        let mut args: Vec<String> = extra.iter().map(|value| (*value).to_string()).collect();
        args.push("-a".to_string());
        args.push(target.account().to_string());
        args.push("-s".to_string());
        args.push(target.service());
        args
    }

    async fn run(
        &self,
        args: Vec<String>,
        stdin: Option<String>,
    ) -> Result<CommandOutput, CollectorError> {
        self.runner
            .run(&self.security_binary, &args, stdin)
            .await
            .map_err(|error| {
                CollectorError::new(
                    error.kind,
                    format!("Keychain access failed: {}", redact_str(&error.message)),
                )
            })
    }
}

fn not_found(output: &CommandOutput) -> bool {
    output.status == ITEM_NOT_FOUND
        || output
            .stderr
            .to_ascii_lowercase()
            .contains("could not be found")
}

impl<R: CommandRunner + 'static> CredentialStore for MacOsKeychainStore<R> {
    fn get(
        &self,
        target: CredentialTarget,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<String>, CollectorError>> + Send + '_>,
    > {
        Box::pin(async move {
            let args = Self::args(target, &["find-generic-password", "-w"]);
            let output = self.run(args, None).await?;
            if output.success() {
                let secret = output.stdout.trim_end_matches(['\n', '\r']).to_string();
                return Ok(if secret.is_empty() {
                    None
                } else {
                    Some(secret)
                });
            }
            if not_found(&output) {
                return Ok(None);
            }
            Err(CollectorError::authentication(format!(
                "macOS refused to read the {} credential: {}",
                target.label(),
                redact_str(output.stderr.trim())
            ))
            .with_diagnostic("target", target.key()))
        })
    }

    fn set(
        &self,
        target: CredentialTarget,
        secret: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), CollectorError>> + Send + '_>>
    {
        Box::pin(async move {
            let trimmed = secret.trim();
            if trimmed.is_empty() {
                return Err(CollectorError::missing_config("凭据不能为空"));
            }
            // `-U` updates an existing item in place, so the account identity and
            // access control list stay the same as the legacy runtime's. `-w` goes
            // after the account and service and takes its password from stdin: with
            // it earlier it swallows the next option and `security` answers with its
            // usage text instead of storing anything (see `keychain_set_sync`).
            let mut args = Self::args(target, &["add-generic-password", "-U"]);
            args.push("-w".to_string());
            let output = self
                .run(args, Some(format!("{trimmed}\n{trimmed}\n")))
                .await?;
            if output.success() {
                return Ok(());
            }
            Err(CollectorError::new(
                crate::contracts::ErrorKind::Storage,
                format!(
                    "cannot store the {} credential: {}",
                    target.label(),
                    redact_str(output.stderr.trim())
                ),
            )
            .with_diagnostic("target", target.key()))
        })
    }

    fn delete(
        &self,
        target: CredentialTarget,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), CollectorError>> + Send + '_>>
    {
        Box::pin(async move {
            let args = Self::args(target, &["delete-generic-password"]);
            let output = self.run(args, None).await?;
            if output.success() || not_found(&output) {
                return Ok(());
            }
            Err(CollectorError::new(
                crate::contracts::ErrorKind::Storage,
                format!(
                    "cannot delete the {} credential: {}",
                    target.label(),
                    redact_str(output.stderr.trim())
                ),
            )
            .with_diagnostic("target", target.key()))
        })
    }
}

/// In-memory store used by tests and by a run that must not touch the Keychain.
#[derive(Debug, Default)]
pub struct MemoryCredentialStore {
    values: std::sync::Mutex<BTreeMap<(String, String), String>>,
    /// When set, `get` fails for these targets, simulating a denied Keychain read.
    denials: std::sync::Mutex<Vec<CredentialTarget>>,
    /// Reads recorded per target, so tests can prove a cached secret was re-read.
    reads: std::sync::Mutex<Vec<CredentialTarget>>,
}

impl MemoryCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_secret(target: CredentialTarget, secret: &str) -> Self {
        let store = Self::new();
        store.values.lock().expect("lock").insert(
            (target.service(), target.account().to_string()),
            secret.to_string(),
        );
        store
    }

    /// Make reads fail, as macOS does when the user denies access.
    pub fn deny(&self, target: CredentialTarget) {
        self.denials.lock().expect("lock").push(target);
    }

    pub fn read_count(&self, target: CredentialTarget) -> usize {
        self.reads
            .lock()
            .expect("lock")
            .iter()
            .filter(|entry| **entry == target)
            .count()
    }

    pub fn contains(&self, target: CredentialTarget) -> bool {
        self.values
            .lock()
            .expect("lock")
            .contains_key(&(target.service(), target.account().to_string()))
    }

    fn key(target: CredentialTarget) -> (String, String) {
        (target.service(), target.account().to_string())
    }
}

impl CredentialStore for MemoryCredentialStore {
    fn get(
        &self,
        target: CredentialTarget,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<String>, CollectorError>> + Send + '_>,
    > {
        Box::pin(async move {
            self.reads.lock().expect("lock").push(target);
            if self.denials.lock().expect("lock").contains(&target) {
                return Err(CollectorError::authentication(format!(
                    "macOS refused to read the {} credential",
                    target.label()
                )));
            }
            Ok(self
                .values
                .lock()
                .expect("lock")
                .get(&Self::key(target))
                .cloned())
        })
    }

    fn set(
        &self,
        target: CredentialTarget,
        secret: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), CollectorError>> + Send + '_>>
    {
        Box::pin(async move {
            self.values
                .lock()
                .expect("lock")
                .insert(Self::key(target), secret);
            Ok(())
        })
    }

    fn delete(
        &self,
        target: CredentialTarget,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), CollectorError>> + Send + '_>>
    {
        Box::pin(async move {
            self.values.lock().expect("lock").remove(&Self::key(target));
            Ok(())
        })
    }
}

/// Outcome of validating a candidate secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationOutcome {
    pub valid: bool,
    pub message: Option<String>,
}

impl ValidationOutcome {
    pub fn valid() -> Self {
        Self {
            valid: true,
            message: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            valid: false,
            message: Some(message.into()),
        }
    }
}

/// Credential lifecycle shared by every provider.
///
/// Validation runs **before** the write, so an invalid secret never destroys the
/// working one. `resolve` always reads through to the store: a deleted or
/// replaced credential takes effect on the next request instead of being served
/// from a stale cache.
#[derive(Debug)]
pub struct CredentialManager<S: CredentialStore> {
    store: S,
}

impl<S: CredentialStore> CredentialManager<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// Read a secret for a request.
    pub async fn resolve(
        &self,
        target: CredentialTarget,
    ) -> Result<Option<String>, CollectorError> {
        self.store.get(target).await
    }

    /// Masked status for the settings view.
    pub async fn status(
        &self,
        target: CredentialTarget,
        enabled: bool,
    ) -> Result<CredentialStatus, CollectorError> {
        if !target.is_managed() {
            return Ok(CredentialStatus::missing(target, enabled));
        }
        match self.store.get(target).await? {
            Some(secret) => Ok(CredentialStatus::configured(target, &secret, enabled)),
            None => Ok(CredentialStatus::missing(target, enabled)),
        }
    }

    /// Validate then store. On rejection nothing is written.
    pub async fn replace<F, Fut>(
        &self,
        target: CredentialTarget,
        secret: &str,
        validate: F,
    ) -> Result<CredentialStatus, CollectorError>
    where
        F: FnOnce(String) -> Fut,
        Fut: std::future::Future<Output = ValidationOutcome>,
    {
        if !target.is_managed() {
            return Err(CollectorError::missing_config(format!(
                "{} 由 Codex 自身管理，面板不保存其凭据",
                target.label()
            )));
        }
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            return Err(CollectorError::missing_config("凭据不能为空"));
        }

        let outcome = validate(trimmed.to_string()).await;
        if !outcome.valid {
            return Err(CollectorError::authentication(
                outcome
                    .message
                    .unwrap_or_else(|| "凭据验证失败，已保留原有凭据".to_string()),
            ));
        }

        self.store.set(target, trimmed.to_string()).await?;
        self.status(target, true).await
    }

    /// Delete a stored secret. Deleting nothing is fine.
    pub async fn delete(&self, target: CredentialTarget) -> Result<(), CollectorError> {
        if !target.is_managed() {
            return Err(CollectorError::missing_config(format!(
                "{} 的凭据不由面板管理",
                target.label()
            )));
        }
        self.store.delete(target).await
    }

    /// Masked status of every managed target, for the settings bootstrap.
    pub async fn all_statuses(
        &self,
        glm_wallet_enabled: bool,
        deepseek_web_enabled: bool,
    ) -> Result<Vec<CredentialStatus>, CollectorError> {
        let mut statuses = Vec::new();
        for target in CredentialTarget::MANAGED {
            let enabled = match target {
                CredentialTarget::GlmWallet => glm_wallet_enabled,
                CredentialTarget::DeepSeekWeb => deepseek_web_enabled,
                _ => true,
            };
            statuses.push(self.status(target, enabled).await?);
        }
        Ok(statuses)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records every `security` call so a test can pin the shape of its arguments.
    #[derive(Debug, Default)]
    struct RecordingRunner {
        calls: std::sync::Mutex<Vec<(Vec<String>, Option<String>)>>,
    }

    impl CommandRunner for RecordingRunner {
        async fn run(
            &self,
            _program: &str,
            args: &[String],
            stdin: Option<String>,
        ) -> Result<CommandOutput, CollectorError> {
            self.calls
                .lock()
                .expect("calls lock")
                .push((args.to_vec(), stdin));
            Ok(CommandOutput {
                status: 0,
                stdout: String::new(),
                stderr: String::new(),
            })
        }
    }

    #[tokio::test]
    async fn the_password_option_follows_the_account_and_takes_the_secret_from_stdin() {
        // `security` parses its options in the order its own usage prints, and `-w`
        // before `-a` swallows the account as the password: the account goes missing
        // and it answers with its usage text instead of storing anything — the wall
        // of help the panel used to show for the web usage token. In the right order
        // it prompts, and the secret stays out of the argument list.
        let store = MacOsKeychainStore::new(RecordingRunner::default());
        store
            .set(CredentialTarget::DeepSeekWeb, "  sekret-web  ".to_string())
            .await
            .expect("store");

        let calls = store.runner.calls.lock().expect("calls lock");
        let (args, stdin) = calls.last().expect("one security call");
        assert_eq!(
            args.first().map(String::as_str),
            Some("add-generic-password")
        );
        let account = args.iter().position(|arg| arg == "-a").expect("-a");
        let service = args.iter().position(|arg| arg == "-s").expect("-s");
        let password = args.iter().position(|arg| arg == "-w").expect("-w");
        assert!(
            password > account && password > service,
            "-w must come after the account and service: {args:?}"
        );
        assert_eq!(args.last().map(String::as_str), Some("-w"));
        assert!(
            !args.iter().any(|arg| arg.contains("sekret-web")),
            "the secret must not reach the argument list: {args:?}"
        );
        assert_eq!(
            stdin.as_deref(),
            Some("sekret-web\nsekret-web\n"),
            "the prompt reads the trimmed secret twice from stdin"
        );
    }

    #[test]
    fn keeps_the_legacy_service_and_account_identifiers() {
        assert_eq!(CredentialTarget::GlmQuota.service(), "agents-usage.glm");
        assert_eq!(CredentialTarget::GlmQuota.account(), "default");
        assert_eq!(CredentialTarget::GlmWallet.service(), "agents-usage.glm");
        assert_eq!(CredentialTarget::GlmWallet.account(), "wallet-experimental");
        assert_eq!(
            CredentialTarget::DeepSeek.service(),
            "agents-usage.deepseek"
        );
        assert_eq!(CredentialTarget::DeepSeek.account(), "default");
        // The web usage token reuses the DeepSeek service with its own account,
        // so it never collides with the API key.
        assert_eq!(
            CredentialTarget::DeepSeekWeb.service(),
            "agents-usage.deepseek"
        );
        assert_eq!(CredentialTarget::DeepSeekWeb.account(), "web-experimental");
        assert_eq!(
            CredentialTarget::CodexDelegated.service(),
            "agents-usage.codex"
        );
    }

    #[test]
    fn masking_never_reveals_more_than_the_last_four_characters() {
        assert_eq!(mask_suffix("sk-abcdefgh1234"), Some("1234".to_string()));
        assert_eq!(mask_suffix("abc"), Some("abc".to_string()));
        assert_eq!(mask_suffix("   "), None);
        assert!(!mask_suffix("sk-live-secret-value")
            .unwrap()
            .contains("secret"));
    }

    #[test]
    fn parses_the_api_target_names() {
        assert_eq!(
            CredentialTarget::parse("glm"),
            Some(CredentialTarget::GlmQuota)
        );
        assert_eq!(
            CredentialTarget::parse("glm-wallet"),
            Some(CredentialTarget::GlmWallet)
        );
        assert_eq!(
            CredentialTarget::parse("deepseek"),
            Some(CredentialTarget::DeepSeek)
        );
        assert_eq!(
            CredentialTarget::parse("deepseek-web"),
            Some(CredentialTarget::DeepSeekWeb)
        );
        assert_eq!(CredentialTarget::parse("nope"), None);
    }

    #[tokio::test]
    async fn invalid_replacement_keeps_the_stored_secret() {
        let manager = CredentialManager::new(MemoryCredentialStore::with_secret(
            CredentialTarget::DeepSeek,
            "sk-old-value-1234",
        ));

        let error = manager
            .replace(
                CredentialTarget::DeepSeek,
                "sk-new-but-bad",
                |_secret| async { ValidationOutcome::invalid("DeepSeek rejected the API key") },
            )
            .await
            .expect_err("invalid replacement must fail");

        assert_eq!(error.kind, crate::contracts::ErrorKind::Authentication);
        assert_eq!(
            manager
                .resolve(CredentialTarget::DeepSeek)
                .await
                .expect("read"),
            Some("sk-old-value-1234".to_string())
        );
    }

    #[tokio::test]
    async fn valid_replacement_is_stored_and_status_is_masked() {
        let manager = CredentialManager::new(MemoryCredentialStore::new());
        let status = manager
            .replace(
                CredentialTarget::GlmQuota,
                "  glm-key-value-9876  ",
                |secret| async move {
                    assert_eq!(secret, "glm-key-value-9876");
                    ValidationOutcome::valid()
                },
            )
            .await
            .expect("replacement");

        assert!(status.configured);
        assert_eq!(status.suffix, Some("9876".to_string()));
        assert!(!status.delegated);
        let stored = manager
            .resolve(CredentialTarget::GlmQuota)
            .await
            .expect("read");
        assert_eq!(stored, Some("glm-key-value-9876".to_string()));
    }

    #[tokio::test]
    async fn resolution_reads_through_so_a_deletion_takes_effect() {
        let store = MemoryCredentialStore::with_secret(CredentialTarget::GlmWallet, "wallet-key");
        let manager = CredentialManager::new(store);
        let before = manager
            .status(CredentialTarget::GlmWallet, true)
            .await
            .expect("status");
        assert!(before.configured);
        assert!(manager
            .resolve(CredentialTarget::GlmWallet)
            .await
            .expect("read")
            .is_some());

        manager
            .delete(CredentialTarget::GlmWallet)
            .await
            .expect("delete");
        assert!(manager
            .resolve(CredentialTarget::GlmWallet)
            .await
            .expect("read")
            .is_none());
        let status = manager
            .status(CredentialTarget::GlmWallet, true)
            .await
            .expect("status");
        assert!(!status.configured);
        // Every status/resolve call reads through to the store: one status, one
        // resolve, one resolve after deletion, one final status.
        assert_eq!(manager.store().read_count(CredentialTarget::GlmWallet), 4);
    }

    #[tokio::test]
    async fn denied_keychain_access_is_reported_not_ignored() {
        let store = MemoryCredentialStore::with_secret(CredentialTarget::GlmQuota, "glm-key");
        store.deny(CredentialTarget::GlmQuota);
        let manager = CredentialManager::new(store);
        let error = manager
            .resolve(CredentialTarget::GlmQuota)
            .await
            .expect_err("denied read must fail");
        assert_eq!(error.kind, crate::contracts::ErrorKind::Authentication);
        assert!(error.message.contains("GLM 套餐"));
    }

    #[tokio::test]
    async fn codex_credentials_are_delegated() {
        let manager = CredentialManager::new(MemoryCredentialStore::new());
        assert!(manager
            .replace(CredentialTarget::CodexDelegated, "anything", |_| async {
                ValidationOutcome::valid()
            })
            .await
            .is_err());
        let status = manager
            .status(CredentialTarget::CodexDelegated, true)
            .await
            .expect("status");
        assert!(!status.configured);
        assert!(status.delegated);
    }

    #[tokio::test]
    async fn empty_secret_is_rejected_before_any_write() {
        let store = MemoryCredentialStore::new();
        let manager = CredentialManager::new(store);
        let error = manager
            .replace(CredentialTarget::GlmQuota, "   ", |_| async {
                ValidationOutcome::valid()
            })
            .await
            .expect_err("empty secret must fail");
        assert_eq!(error.kind, crate::contracts::ErrorKind::MissingConfig);
        assert!(!manager.store().contains(CredentialTarget::GlmQuota));
    }

    #[tokio::test]
    async fn all_statuses_cover_the_managed_targets_only() {
        let store = MemoryCredentialStore::with_secret(CredentialTarget::GlmQuota, "glm-key");
        let manager = CredentialManager::new(store);
        let statuses = manager.all_statuses(false, true).await.expect("statuses");
        let targets: Vec<&str> = statuses
            .iter()
            .map(|status| status.target.as_str())
            .collect();
        assert_eq!(
            targets,
            vec!["glm", "glm-wallet", "deepseek", "deepseek-web"]
        );
        assert!(statuses[0].configured);
        assert!(!statuses[1].configured);
        assert!(!statuses[1].enabled);
        assert!(!statuses[2].configured);
        // The web usage target follows its own settings flag, not the wallet's.
        assert!(!statuses[3].configured);
        assert!(statuses[3].enabled);
    }
}

//! Codex CLI discovery that never depends on an interactive shell.
//!
//! A macOS app launched from Finder inherits a minimal environment: `PATH` is
//! whatever `launchd` provided, `~/.zshrc` was never sourced and no login shell
//! ran. Discovery therefore looks for **absolute** locations in a fixed order and
//! only then consults the inherited `PATH` variable itself (never `sh -lc`, which
//! would spawn a shell, block on a profile and pick up arbitrary aliases):
//!
//! 1. the absolute path configured in settings;
//! 2. installs next to `$CODEX_HOME`, when the variable is set;
//! 3. common absolute locations (`/opt/homebrew/bin/codex`, `/usr/local/bin/codex`,
//!    `~/.local/bin/codex`, `~/.cargo/bin/codex`, `~/.bun/bin/codex`);
//! 4. a `PATH` lookup over the entries that are absolute, in order.
//!
//! `codex --version` reports availability. A binary that cannot be found produces
//! a [`ErrorKind::MissingConfig`] error and a binary that exists but fails to run
//! produces a [`ErrorKind::Process`] error; both only concern Codex, so GLM and
//! DeepSeek keep collecting.

use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

use crate::adapters::codex::json_rpc::keep_tail;
use crate::contracts::ErrorKind;
use crate::http::{CollectorError, CommandOutput, CommandRunner};

/// Absolute locations probed after the configured path and `$CODEX_HOME`, in
/// order. `~/` is expanded with the user's home directory.
pub const COMMON_CODEX_CLI_LOCATIONS: [&str; 5] = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "~/.local/bin/codex",
    "~/.cargo/bin/codex",
    "~/.bun/bin/codex",
];

/// Argument used to ask the CLI for its version.
pub const VERSION_ARGS: [&str; 1] = ["--version"];

/// Default timeout for one `codex --version` invocation.
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

/// Where a discovered binary came from, for diagnostics and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodexCliOrigin {
    /// The absolute path configured in settings.
    ConfiguredPath,
    /// A location next to `$CODEX_HOME`.
    CodexHome,
    /// One of [`COMMON_CODEX_CLI_LOCATIONS`] (or a caller-provided extra).
    CommonLocation,
    /// An absolute entry of the inherited `PATH`.
    PathLookup,
}

impl CodexCliOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexCliOrigin::ConfiguredPath => "configured_path",
            CodexCliOrigin::CodexHome => "codex_home",
            CodexCliOrigin::CommonLocation => "common_location",
            CodexCliOrigin::PathLookup => "path_lookup",
        }
    }
}

/// A parsed `major.minor.patch` CLI version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CodexVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

/// The version pattern, matching the TypeScript `\b(\d+)\.(\d+)\.(\d+)\b`.
///
/// A pattern that failed to compile yields `None` instead of panicking: the
/// collector degrades to "version unknown" rather than aborting.
fn version_regex() -> Option<&'static Regex> {
    static REGEX: OnceLock<Option<Regex>> = OnceLock::new();
    REGEX
        .get_or_init(|| Regex::new(r"\b(\d+)\.(\d+)\.(\d+)\b").ok())
        .as_ref()
}

/// Parse the first `major.minor.patch` in `text` (`codex-cli 0.152.0`).
pub fn parse_codex_version(text: &str) -> Option<CodexVersion> {
    let captures = version_regex()?.captures(text)?;
    Some(CodexVersion {
        major: captures.get(1)?.as_str().parse().ok()?,
        minor: captures.get(2)?.as_str().parse().ok()?,
        patch: captures.get(3)?.as_str().parse().ok()?,
    })
}

/// Whether a version line looks like a build the app-server protocol supports.
///
/// Purely diagnostic: discovery still reports an older CLI as available, because
/// "installed but old" and "not installed" need different guidance.
pub fn is_supported_codex_version(text: &str) -> bool {
    parse_codex_version(text).is_some_and(|version| version.major > 0 || version.minor >= 100)
}

impl fmt::Display for CodexVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// A Codex CLI that answered `--version`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCli {
    /// Absolute path that can be handed to [`crate::adapters::codex::json_rpc::StdioRpcCommand::codex`].
    pub path: PathBuf,
    /// Parsed version, absent when the CLI printed something unexpected.
    pub version: Option<CodexVersion>,
    /// Raw first line of `--version`, redacted.
    pub version_text: String,
    /// Whether the version looks compatible with the app-server protocol.
    pub supported: bool,
    /// Where the binary was found.
    pub origin: CodexCliOrigin,
}

/// One location to probe, in search order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCliCandidate {
    pub path: PathBuf,
    pub origin: CodexCliOrigin,
}

/// Inputs of the search.
///
/// The struct exists so discovery can be tested without touching the process
/// environment and so a service can inject the settings it owns.
#[derive(Debug, Clone, Default)]
pub struct CodexCliDiscoveryOptions {
    /// Absolute path configured in settings; tried first.
    pub configured_path: Option<String>,
    /// Home directory used to expand `~/...` locations.
    pub home_dir: Option<PathBuf>,
    /// `$CODEX_HOME`, when set.
    pub codex_home: Option<PathBuf>,
    /// The inherited `PATH` value, consulted last and without a shell.
    pub path_var: Option<String>,
    /// Extra absolute locations, probed with the common ones.
    pub extra_candidates: Vec<PathBuf>,
    /// Replace the whole search list. Used by tests and by a service with its own
    /// policy; `None` means the default order described in the module docs.
    pub candidates: Option<Vec<PathBuf>>,
}

impl CodexCliDiscoveryOptions {
    /// Read the process environment (`HOME`, `CODEX_HOME`, `PATH`).
    ///
    /// This reads inherited variables only: no shell runs, so a Finder launch
    /// behaves exactly like a terminal launch minus the shell profile.
    pub fn from_env(configured_path: Option<String>) -> Self {
        Self {
            configured_path,
            home_dir: std::env::var_os("HOME").map(PathBuf::from),
            codex_home: std::env::var_os("CODEX_HOME").map(PathBuf::from),
            path_var: std::env::var_os("PATH").map(|value| value.to_string_lossy().into_owned()),
            extra_candidates: Vec::new(),
            candidates: None,
        }
    }

    /// Search exactly these paths, in this order.
    pub fn with_candidates(candidates: Vec<PathBuf>) -> Self {
        Self {
            candidates: Some(candidates),
            ..Self::default()
        }
    }
}

fn expand_location(location: &str, home_dir: Option<&Path>) -> Option<PathBuf> {
    match location.strip_prefix("~/") {
        Some(rest) => home_dir.map(|home| home.join(rest)),
        None => Some(PathBuf::from(location)),
    }
}

/// The ordered list of locations to probe.
///
/// Pure function: it reads the supplied options and nothing else, so a test can
/// pin the whole search plan.
pub fn codex_cli_candidates(options: &CodexCliDiscoveryOptions) -> Vec<CodexCliCandidate> {
    let mut candidates: Vec<CodexCliCandidate> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut push = |path: PathBuf, origin: CodexCliOrigin| {
        if seen.insert(path.clone()) {
            candidates.push(CodexCliCandidate { path, origin });
        }
    };

    if let Some(configured) = options
        .configured_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        push(PathBuf::from(configured), CodexCliOrigin::ConfiguredPath);
    }

    if let Some(candidates_override) = options.candidates.as_ref() {
        // An explicit list replaces the default search entirely, including the
        // configured path: the caller has already decided what to look at.
        let mut overridden: Vec<CodexCliCandidate> = Vec::new();
        let mut overridden_seen: HashSet<PathBuf> = HashSet::new();
        for path in candidates_override {
            if overridden_seen.insert(path.clone()) {
                overridden.push(CodexCliCandidate {
                    path: path.clone(),
                    origin: CodexCliOrigin::CommonLocation,
                });
            }
        }
        return overridden;
    }

    if let Some(codex_home) = options
        .codex_home
        .as_ref()
        .filter(|home| home.is_absolute())
    {
        push(
            codex_home.join("bin").join("codex"),
            CodexCliOrigin::CodexHome,
        );
        if let Some(parent) = codex_home.parent() {
            push(parent.join("bin").join("codex"), CodexCliOrigin::CodexHome);
        }
    }

    for location in COMMON_CODEX_CLI_LOCATIONS {
        if let Some(path) = expand_location(location, options.home_dir.as_deref()) {
            push(path, CodexCliOrigin::CommonLocation);
        }
    }
    for extra in &options.extra_candidates {
        push(extra.clone(), CodexCliOrigin::CommonLocation);
    }

    if let Some(path_var) = options.path_var.as_deref() {
        for entry in path_var.split(':') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let directory = PathBuf::from(entry);
            if !directory.is_absolute() {
                // A relative PATH entry would resolve against the app's working
                // directory, which is not the user's shell directory. Skip it
                // rather than executing something unexpected.
                continue;
            }
            push(directory.join("codex"), CodexCliOrigin::PathLookup);
        }
    }

    candidates
}

/// Outcome of probing one candidate.
enum Probe {
    Available(Box<CodexCli>),
    /// The binary exists but did not answer `--version` successfully.
    Broken(CollectorError),
    /// No file at that location.
    Missing,
}

async fn probe<R: CommandRunner>(runner: &R, path: &Path) -> Probe {
    if !path.is_file() {
        return Probe::Missing;
    }
    let program = path.to_string_lossy().into_owned();
    let args: Vec<String> = VERSION_ARGS.iter().map(|arg| (*arg).to_string()).collect();
    match runner.run(&program, &args, None).await {
        Ok(output) if output.success() => {
            let text = if output.stdout.trim().is_empty() {
                output.stderr.trim().to_string()
            } else {
                output.stdout.trim().to_string()
            };
            let version = parse_codex_version(&text);
            Probe::Available(Box::new(CodexCli {
                path: path.to_path_buf(),
                version,
                version_text: crate::redaction::redact_str(&text),
                supported: is_supported_codex_version(&text),
                origin: CodexCliOrigin::CommonLocation,
            }))
        }
        Ok(output) => {
            let mut detail = if output.stderr.trim().is_empty() {
                output.stdout.trim().to_string()
            } else {
                output.stderr.trim().to_string()
            };
            keep_tail(&mut detail, 500);
            Probe::Broken(CollectorError::new(
                ErrorKind::Process,
                format!(
                    "Codex CLI version check failed ({}): {detail}",
                    output.status
                ),
            ))
        }
        Err(error) => Probe::Broken(error),
    }
}

fn missing_cli_error(searched: &[CodexCliCandidate]) -> CollectorError {
    let listing = searched
        .iter()
        .map(|candidate| candidate.path.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(", ");
    CollectorError::new(
        ErrorKind::MissingConfig,
        "Codex CLI was not found; install the Codex CLI or set its absolute path in Codex settings",
    )
    .with_diagnostic("provider", "codex")
    .with_diagnostic("shell", "none: discovery never runs an interactive shell")
    .with_diagnostic("searched", listing)
}

fn invalid_configured_path(configured: &str) -> CollectorError {
    CollectorError::new(
        ErrorKind::MissingConfig,
        format!("the configured Codex CLI path must be absolute: {configured}"),
    )
    .with_diagnostic("provider", "codex")
}

fn configured_path_missing(path: &Path) -> CollectorError {
    CollectorError::new(
        ErrorKind::MissingConfig,
        format!(
            "the configured Codex CLI path does not exist: {}",
            path.display()
        ),
    )
    .with_diagnostic("provider", "codex")
}

/// Find the Codex CLI, reporting availability through `codex --version`.
///
/// Only Codex is affected by the outcome: the error kind is `missing_config` for
/// an absent CLI and `process` for a binary that runs but fails.
pub async fn discover_codex_cli<R: CommandRunner>(
    runner: &R,
    options: &CodexCliDiscoveryOptions,
) -> Result<CodexCli, CollectorError> {
    let configured = options
        .configured_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut configured_path: Option<PathBuf> = None;
    if let Some(configured) = configured {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err(invalid_configured_path(configured));
        }
        configured_path = Some(path);
    }

    if let Some(path) = configured_path.as_ref() {
        match probe(runner, path).await {
            Probe::Available(mut cli) => {
                cli.origin = CodexCliOrigin::ConfiguredPath;
                return Ok(*cli);
            }
            // An explicit setting that does not work is reported as-is instead of
            // silently falling back to another binary the user did not choose.
            Probe::Broken(error) => return Err(error),
            Probe::Missing => return Err(configured_path_missing(path)),
        }
    }

    let candidates = codex_cli_candidates(options);
    let mut failure: Option<CollectorError> = None;
    for candidate in &candidates {
        if candidate.origin == CodexCliOrigin::ConfiguredPath {
            continue;
        }
        match probe(runner, &candidate.path).await {
            Probe::Available(mut cli) => {
                cli.origin = candidate.origin;
                return Ok(*cli);
            }
            Probe::Broken(error) => {
                if failure.is_none() {
                    failure = Some(
                        error.with_diagnostic("path", candidate.path.to_string_lossy().as_ref()),
                    );
                }
            }
            Probe::Missing => {}
        }
    }

    match failure {
        Some(error) => Err(error),
        None => Err(missing_cli_error(&candidates)),
    }
}

/// [`CommandRunner`] backed by `tokio::process`, used for `codex --version`.
#[derive(Debug, Clone)]
pub struct SystemCommandRunner {
    /// How long one command may take; `None` waits indefinitely.
    pub timeout: Option<Duration>,
}

impl Default for SystemCommandRunner {
    fn default() -> Self {
        Self {
            timeout: Some(DEFAULT_COMMAND_TIMEOUT),
        }
    }
}

impl SystemCommandRunner {
    pub fn new(timeout: Option<Duration>) -> Self {
        Self { timeout }
    }
}

/// Put an absolute program's own directory first on the child's `PATH`.
///
/// A Codex CLI installed by a package manager is a thin script whose shebang
/// resolves a runtime (`node`) through `PATH`, and an app launched from Finder
/// inherits a minimal one: the CLI is found, starts, and immediately dies with
/// `env: node: No such file or directory` — which reads exactly like a missing
/// CLI. An absolute path is a statement about where the tool lives, so the
/// directory holding it has to be reachable for the runtime it launches.
pub fn path_with_program_dir(program: &std::path::Path) -> Option<std::ffi::OsString> {
    if !program.is_absolute() {
        return None;
    }
    let dir = program.parent().filter(|dir| !dir.as_os_str().is_empty())?;
    Some(match std::env::var_os("PATH") {
        Some(existing) if !existing.is_empty() => {
            let mut value = dir.as_os_str().to_os_string();
            value.push(":");
            value.push(existing);
            value
        }
        _ => dir.as_os_str().to_os_string(),
    })
}

fn command_failure(program: &str, message: impl fmt::Display) -> CollectorError {
    CollectorError::new(
        ErrorKind::Process,
        format!("cannot run {program}: {message}"),
    )
}

impl CommandRunner for SystemCommandRunner {
    async fn run(
        &self,
        program: &str,
        args: &[String],
        stdin: Option<String>,
    ) -> Result<CommandOutput, CollectorError> {
        let mut command = Command::new(program);
        if let Some(path) = path_with_program_dir(std::path::Path::new(program)) {
            command.env("PATH", path);
        }
        command
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child: Child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CollectorError::new(ErrorKind::MissingConfig, format!("{program} was not found"))
            } else {
                command_failure(program, error)
            }
        })?;

        if let Some(input) = stdin {
            if let Some(mut child_stdin) = child.stdin.take() {
                // A closed stdin is not fatal: the caller inspects the exit
                // status and stderr instead.
                let _ = child_stdin.write_all(input.as_bytes()).await;
                let _ = child_stdin.shutdown().await;
            }
        }

        let output = match self.timeout {
            Some(timeout) => match tokio::time::timeout(timeout, child.wait_with_output()).await {
                Ok(result) => result.map_err(|error| command_failure(program, error))?,
                Err(_) => {
                    // Dropping the child (kill_on_drop) terminates the process so
                    // discovery cannot leave a hung binary behind.
                    return Err(CollectorError::new(
                        ErrorKind::Process,
                        format!("{program} timed out after {} ms", timeout.as_millis()),
                    ));
                }
            },
            None => child
                .wait_with_output()
                .await
                .map_err(|error| command_failure(program, error))?,
        };

        Ok(CommandOutput {
            status: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[test]
    fn an_absolute_cli_brings_its_own_directory_to_path() {
        // A package-managed Codex is a script whose shebang resolves its runtime
        // through PATH; an app launched from Finder inherits a minimal one, so the
        // directory holding the CLI has to come first for the CLI to start at all.
        let path = path_with_program_dir(std::path::Path::new("/opt/tools/bin/codex"))
            .expect("an absolute program gets a PATH");
        let text = path.to_string_lossy();
        assert!(
            text.starts_with("/opt/tools/bin:"),
            "the CLI's own directory must lead: {text}"
        );
        assert!(
            text.len() > "/opt/tools/bin:".len(),
            "the inherited PATH follows it: {text}"
        );
    }

    #[test]
    fn a_relative_cli_keeps_the_inherited_path() {
        // Nothing to point at: a bare name is resolved by the inherited PATH itself.
        assert_eq!(path_with_program_dir(std::path::Path::new("codex")), None);
    }

    /// Scripted [`CommandRunner`]: answers only for known programs and records
    /// what it was asked, so a test can prove a missing file is never executed.
    #[derive(Debug, Default)]
    struct FakeRunner {
        replies: Mutex<HashMap<String, Result<CommandOutput, CollectorError>>>,
        calls: Mutex<Vec<(String, Vec<String>)>>,
    }

    impl FakeRunner {
        fn with_reply(self, program: &Path, output: CommandOutput) -> Self {
            lock(&self.replies).insert(program.to_string_lossy().into_owned(), Ok(output));
            self
        }

        fn with_failure(self, program: &Path, error: CollectorError) -> Self {
            lock(&self.replies).insert(program.to_string_lossy().into_owned(), Err(error));
            self
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            lock(&self.calls).clone()
        }
    }

    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    impl CommandRunner for FakeRunner {
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
            "agents-usage-codex-cli-{}-{name}",
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

    fn version_output(text: &str) -> CommandOutput {
        CommandOutput {
            status: 0,
            stdout: format!("{text}\n"),
            stderr: String::new(),
        }
    }

    #[test]
    fn versions_parse_like_the_typescript_implementation() {
        assert_eq!(
            parse_codex_version("codex-cli 0.152.0"),
            Some(CodexVersion {
                major: 0,
                minor: 152,
                patch: 0
            })
        );
        assert_eq!(parse_codex_version("unexpected"), None);
        assert!(is_supported_codex_version("codex-cli 0.152.0"));
        assert!(!is_supported_codex_version("codex-cli 0.42.0"));
        assert!(!is_supported_codex_version("unexpected"));
    }

    #[test]
    fn the_default_search_plan_is_absolute_and_ordered() {
        let options = CodexCliDiscoveryOptions {
            home_dir: Some(PathBuf::from("/Users/example")),
            codex_home: Some(PathBuf::from("/Users/example/.codex")),
            path_var: Some("/usr/bin:/opt/homebrew/bin:bin:./local:".to_string()),
            ..CodexCliDiscoveryOptions::default()
        };
        let candidates = codex_cli_candidates(&options);

        assert_eq!(
            candidates.first().map(|candidate| candidate.origin),
            Some(CodexCliOrigin::CodexHome)
        );
        for candidate in &candidates {
            assert!(
                candidate.path.is_absolute(),
                "{} is not absolute",
                candidate.path.display()
            );
        }
        let rendered: Vec<String> = candidates
            .iter()
            .map(|candidate| candidate.path.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            rendered,
            vec![
                "/Users/example/.codex/bin/codex",
                "/Users/example/bin/codex",
                "/opt/homebrew/bin/codex",
                "/usr/local/bin/codex",
                "/Users/example/.local/bin/codex",
                "/Users/example/.cargo/bin/codex",
                "/Users/example/.bun/bin/codex",
                "/usr/bin/codex",
            ]
        );
        // The relative PATH entry is dropped and the duplicate homebrew entry is
        // not probed twice: no shell, no cwd guessing.
        assert_eq!(
            candidates.last().map(|candidate| candidate.origin),
            Some(CodexCliOrigin::PathLookup)
        );
    }

    #[tokio::test]
    async fn a_configured_path_wins_over_every_other_location() {
        let directory = scratch_dir("configured");
        let configured = scratch_binary(&directory, "codex-configured");
        let other = scratch_binary(&directory, "codex-other");
        let runner = FakeRunner::default()
            .with_reply(&configured, version_output("codex-cli 0.152.0"))
            .with_reply(&other, version_output("codex-cli 9.9.9"));

        let options = CodexCliDiscoveryOptions {
            configured_path: Some(configured.to_string_lossy().into_owned()),
            candidates: Some(vec![other.clone()]),
            ..CodexCliDiscoveryOptions::default()
        };

        let cli = discover_codex_cli(&runner, &options)
            .await
            .expect("the configured CLI must be used");
        assert_eq!(cli.path, configured);
        assert_eq!(cli.origin, CodexCliOrigin::ConfiguredPath);
        assert_eq!(
            cli.version.map(|version| version.to_string()).as_deref(),
            Some("0.152.0")
        );
        assert!(cli.supported);
        assert_eq!(
            runner.calls(),
            vec![(
                configured.to_string_lossy().into_owned(),
                vec!["--version".to_string()]
            )]
        );
    }

    #[tokio::test]
    async fn a_relative_configured_path_is_rejected() {
        let options = CodexCliDiscoveryOptions {
            configured_path: Some("bin/codex".to_string()),
            ..CodexCliDiscoveryOptions::default()
        };
        let error = discover_codex_cli(&FakeRunner::default(), &options)
            .await
            .expect_err("a relative path must not be accepted");
        assert_eq!(error.kind, ErrorKind::MissingConfig);
        assert!(error.message.contains("absolute"));
    }

    #[tokio::test]
    async fn a_missing_configured_path_is_reported_as_missing_config() {
        let directory = scratch_dir("configured-missing");
        let configured = directory.join("codex-absent");
        let options = CodexCliDiscoveryOptions {
            configured_path: Some(configured.to_string_lossy().into_owned()),
            ..CodexCliDiscoveryOptions::default()
        };
        let error = discover_codex_cli(&FakeRunner::default(), &options)
            .await
            .expect_err("a missing configured path must fail");
        assert_eq!(error.kind, ErrorKind::MissingConfig);
        assert!(error.message.contains("does not exist"));
    }

    #[tokio::test]
    async fn a_broken_configured_binary_is_a_process_error() {
        let directory = scratch_dir("configured-broken");
        let configured = scratch_binary(&directory, "codex-broken");
        let runner = FakeRunner::default().with_reply(
            &configured,
            CommandOutput {
                status: 127,
                stdout: String::new(),
                stderr: "codex: unexpected app-server build api_key=not-a-real-key".to_string(),
            },
        );
        let options = CodexCliDiscoveryOptions {
            configured_path: Some(configured.to_string_lossy().into_owned()),
            ..CodexCliDiscoveryOptions::default()
        };
        let error = discover_codex_cli(&runner, &options)
            .await
            .expect_err("a broken CLI must fail");
        assert_eq!(error.kind, ErrorKind::Process);
        assert!(error.message.contains("127"));
        assert!(!error.message.contains("not-a-real-key"));
    }

    #[tokio::test]
    async fn a_binary_is_never_executed_when_the_file_does_not_exist() {
        let directory = scratch_dir("not-executed");
        let absent = directory.join("codex-absent");
        let runner = FakeRunner::default();
        let options = CodexCliDiscoveryOptions::with_candidates(vec![absent]);
        let error = discover_codex_cli(&runner, &options)
            .await
            .expect_err("nothing can be found");
        assert_eq!(error.kind, ErrorKind::MissingConfig);
        assert!(runner.calls().is_empty());
        assert_eq!(
            error.diagnostic.get("provider").map(String::as_str),
            Some("codex")
        );
    }

    #[tokio::test]
    async fn a_missing_cli_reports_missing_config_only_for_codex() {
        let options = CodexCliDiscoveryOptions::with_candidates(Vec::new());
        let error = discover_codex_cli(&FakeRunner::default(), &options)
            .await
            .expect_err("an empty search must fail");
        assert_eq!(error.kind, ErrorKind::MissingConfig);
        assert_ne!(error.kind, ErrorKind::Authentication);
        assert!(error.message.contains("Codex CLI was not found"));
        assert!(error.message.contains("absolute path"));
        assert_eq!(
            error.diagnostic.get("shell").map(String::as_str),
            Some("none: discovery never runs an interactive shell")
        );
    }

    #[tokio::test]
    async fn a_broken_binary_elsewhere_yields_to_a_working_later_one() {
        let directory = scratch_dir("fallthrough");
        let broken = scratch_binary(&directory, "codex-broken");
        let working = scratch_binary(&directory, "codex-working");
        let runner = FakeRunner::default()
            .with_failure(
                &broken,
                CollectorError::new(ErrorKind::Process, "no such app-server"),
            )
            .with_reply(&working, version_output("codex-cli 0.153.1"));

        let options = CodexCliDiscoveryOptions::with_candidates(vec![broken, working.clone()]);
        let cli = discover_codex_cli(&runner, &options)
            .await
            .expect("the working CLI must be found");
        assert_eq!(cli.path, working);
        assert_eq!(cli.origin, CodexCliOrigin::CommonLocation);
        assert_eq!(cli.version_text, "codex-cli 0.153.1");
    }

    #[tokio::test]
    async fn the_system_runner_reports_status_and_output() {
        let runner = SystemCommandRunner::new(Some(Duration::from_secs(5)));
        let output = runner
            .run(
                "/bin/sh",
                &[
                    "-c".to_string(),
                    "printf 'codex-cli 0.152.0\\n'".to_string(),
                ],
                None,
            )
            .await
            .expect("sh must run");
        assert!(output.success());
        assert_eq!(output.stdout.trim(), "codex-cli 0.152.0");
        assert_eq!(
            parse_codex_version(&output.stdout)
                .map(|version| version.to_string())
                .as_deref(),
            Some("0.152.0")
        );

        let failing = runner
            .run("/bin/sh", &["-c".to_string(), "exit 4".to_string()], None)
            .await
            .expect("sh must run");
        assert_eq!(failing.status, 4);
        assert!(!failing.success());
    }

    #[tokio::test]
    async fn the_system_runner_maps_a_missing_program_to_missing_config() {
        let runner = SystemCommandRunner::new(Some(Duration::from_secs(5)));
        let error = runner
            .run("/nonexistent/codex-does-not-exist", &[], None)
            .await
            .expect_err("a missing program must fail");
        assert_eq!(error.kind, ErrorKind::MissingConfig);
    }
}

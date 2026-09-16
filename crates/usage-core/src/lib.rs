//! Read-only usage collection core.
//!
//! Module layout mirrors the responsibilities described in
//! `openspec/changes/archive/2026-09-15-add-macos-menubar-usage-panel/design.md`:
//!
//! - [`contracts`]: serializable snapshot/metric/error contracts shared with the
//!   TypeScript client.
//! - `redaction`: secret scrubbing for requests, process output, logs, errors
//!   and persisted records.
//! - `storage`: the desktop-only data directory and SQLite store.
//! - `credentials`: macOS Keychain access behind a narrow trait.
//! - `estimate`: daily spend estimation from balance observations.
//! - `adapters`: Codex / GLM / DeepSeek collectors.
//! - `orchestrator` / `scheduler`: refresh policy, coalescing and backoff.

pub mod adapters;
pub mod contracts;
pub mod credentials;
pub mod estimate;
pub mod fixtures;
pub mod http;
pub mod http_client;
pub mod logging;
pub mod redaction;
pub mod scheduler;
pub mod storage;

/// Crate version as recorded in `Cargo.toml`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Truthful, side-effect free readiness probe used by build/verification
/// entry points before the collectors exist.
pub fn core_ready() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_ready() {
        assert!(core_ready());
        assert!(!VERSION.is_empty());
    }
}

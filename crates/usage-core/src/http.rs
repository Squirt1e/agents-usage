//! Transport abstractions shared by the collectors.
//!
//! Collectors never talk to `reqwest` or `tokio::process` directly. They depend
//! on the small traits in this module so tests can inject scripted responses and
//! so the service can supply one HTTP/process configuration for every provider.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::contracts::{ErrorKind, IsoTimestamp};
use crate::redaction::redact_str;

/// One HTTP response the collectors care about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    /// Final URL after redirects, when the transport can report it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

impl HttpResponse {
    pub fn new(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            final_url: None,
            body: body.into(),
            retry_after_seconds: None,
        }
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> Result<serde_json::Value, CollectorError> {
        serde_json::from_str(&self.body).map_err(|error| {
            CollectorError::new(
                ErrorKind::Compatibility,
                format!(
                    "response is not valid JSON: {}",
                    redact_str(&error.to_string())
                ),
            )
        })
    }
}

/// A read-only HTTP request issued by a collector.
///
/// Only `GET` is representable: the collectors must not call models, buy credit
/// or mutate subscriptions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpGet {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub timeout_ms: u64,
}

impl HttpGet {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            headers: BTreeMap::new(),
            timeout_ms: 15_000,
        }
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(name.into(), value.into());
        self
    }

    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = timeout_ms;
        self
    }
}

/// The HTTP capability a collector needs.
///
/// Returns a boxed future so the trait stays object safe and one transport can be
/// shared behind an `Arc` by every collector.
pub trait HttpTransport: Send + Sync + std::fmt::Debug {
    fn get(
        &self,
        request: HttpGet,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, CollectorError>> + Send + '_>,
    >;
}

/// Shared handle to the process-wide HTTP transport.
pub type SharedHttpTransport = Arc<dyn HttpTransport>;

/// Run one local command and capture its output.
pub trait CommandRunner: Send + Sync + std::fmt::Debug {
    fn run(
        &self,
        program: &str,
        args: &[String],
        stdin: Option<String>,
    ) -> impl std::future::Future<Output = Result<CommandOutput, CollectorError>> + Send;
}

/// Result of a finished local command.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CommandOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    pub fn success(&self) -> bool {
        self.status == 0
    }
}

/// A collector failure.
///
/// The message is redacted before it is constructed so a raw key can never reach
/// a log line, an error response or the persisted health record.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct CollectorError {
    pub kind: ErrorKind,
    pub message: String,
    pub diagnostic: BTreeMap<String, String>,
}

impl CollectorError {
    pub fn new(kind: ErrorKind, message: impl AsRef<str>) -> Self {
        Self {
            kind,
            message: redact_str(message.as_ref()),
            diagnostic: BTreeMap::new(),
        }
    }

    pub fn missing_config(message: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::MissingConfig, message)
    }

    pub fn authentication(message: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::Authentication, message)
    }

    pub fn compatibility(message: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::Compatibility, message)
    }

    pub fn network(message: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::Network, message)
    }

    pub fn rate_limit(message: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::RateLimit, message)
    }

    pub fn process(message: impl AsRef<str>) -> Self {
        Self::new(ErrorKind::Process, message)
    }

    pub fn with_diagnostic(mut self, key: impl Into<String>, value: impl AsRef<str>) -> Self {
        self.diagnostic
            .insert(key.into(), redact_str(value.as_ref()));
        self
    }

    /// Convert to the serializable contract type.
    pub fn to_contract(&self, at: IsoTimestamp) -> crate::contracts::CollectorError {
        let diagnostic = if self.diagnostic.is_empty() {
            None
        } else {
            let map = self
                .diagnostic
                .iter()
                .map(|(key, value)| (key.clone(), serde_json::Value::String(value.clone())))
                .collect();
            Some(map)
        };
        crate::contracts::CollectorError {
            kind: self.kind,
            message: self.message.clone(),
            at,
            retry_at: None,
            diagnostic,
            extra: serde_json::Map::new(),
        }
    }
}

/// Test/default transport behaviour used when a caller has no HTTP capability:
/// every request fails as a network error instead of silently succeeding.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnavailableHttpTransport;

impl HttpTransport for UnavailableHttpTransport {
    fn get(
        &self,
        _request: HttpGet,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, CollectorError>> + Send + '_>,
    > {
        Box::pin(async { Err(CollectorError::network("no HTTP transport configured")) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_errors_are_redacted_when_constructed() {
        let error = CollectorError::new(
            ErrorKind::Authentication,
            "rejected key api_key=not-a-real-key",
        );
        assert_eq!(error.message, "rejected key api_key=[REDACTED]");
        assert!(!error.message.contains("not-a-real-key"));
    }

    #[test]
    fn contract_conversion_keeps_the_error_kind_and_time() {
        let error =
            CollectorError::network("timed out").with_diagnostic("endpoint", "https://api.z.ai");
        let at = IsoTimestamp::parse("2026-09-10T08:00:00.000Z").unwrap();
        let contract = error.to_contract(at.clone());
        assert_eq!(contract.kind, ErrorKind::Network);
        assert_eq!(contract.at, at);
        assert_eq!(
            contract
                .diagnostic
                .as_ref()
                .and_then(|map| map.get("endpoint")),
            Some(&serde_json::Value::String("https://api.z.ai".into()))
        );
    }
}

//! Logging that cannot leak a credential.
//!
//! Redaction is applied in three places, deliberately overlapping:
//!
//! 1. collectors redact before building an error message or diagnostic;
//! 2. storage redacts before persisting a snapshot, health record or error;
//! 3. this module redacts **every event**, including ones produced by third-party
//!    crates, before a single byte reaches a file, stderr or the diagnostics API.
//!
//! The third layer is the backstop: a provider SDK that logs a request header, or
//! a panic message that echoes a token, still cannot print a secret.

use std::fmt;
use std::io;
use std::sync::{Arc, Mutex};

use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::redaction::redact_str;

/// Environment variable controlling log verbosity (`AGENTS_USAGE_LOG`).
pub const LOG_FILTER_ENV: &str = "AGENTS_USAGE_LOG";

/// Adapt an `io::Write` (like `Stderr`) to the `fmt::Write` the redacting layer
/// expects. `fmt::Write` is infallible, so I/O errors are turned into a silent
/// drop rather than panicking inside a log path.
struct FmtWriterAdapter<W: io::Write> {
    inner: W,
}

impl<W: io::Write> FmtWriterAdapter<W> {
    fn new(inner: W) -> Self {
        Self { inner }
    }
}

impl<W: io::Write> fmt::Write for FmtWriterAdapter<W> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        self.inner
            .write_all(value.as_bytes())
            .map_err(|_| fmt::Error)
    }
}

/// A writer that redacts every line before it is emitted.
#[derive(Debug, Clone)]
pub struct RedactingWriter<W: fmt::Write + Send + 'static> {
    inner: Arc<Mutex<W>>,
}

impl<W: fmt::Write + Send + 'static> RedactingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
    }
}

impl<W: fmt::Write + Send + 'static> fmt::Write for RedactingWriter<W> {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let redacted = redact_str(value);
        let mut guard = self.inner.lock().map_err(|_| fmt::Error)?;
        guard.write_str(&redacted)
    }
}

/// A `fmt::Write` that collects lines in memory, used by tests and the
/// diagnostics endpoint.
#[derive(Debug, Default, Clone)]
pub struct BufferWriter {
    lines: Arc<Mutex<Vec<String>>>,
    current: Arc<Mutex<String>>,
}

impl BufferWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines
            .lock()
            .map(|lines| lines.clone())
            .unwrap_or_default()
    }

    pub fn joined(&self) -> String {
        self.lines().join("\n")
    }
}

impl fmt::Write for BufferWriter {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let mut current = self.current.lock().map_err(|_| fmt::Error)?;
        current.push_str(value);
        while let Some(position) = current.find('\n') {
            let line: String = current.drain(..=position).collect();
            let line = line.trim_end_matches('\n').to_string();
            if let Ok(mut lines) = self.lines.lock() {
                lines.push(line);
            }
        }
        Ok(())
    }
}

/// Redacting layer for `tracing`.
///
/// Keeps the event's message and fields but scrubs the rendered representation,
/// so nothing sensitive survives even when a field name is not on the sensitive
/// list but its value is a credential.
struct RedactingLayer {
    writer: Arc<Mutex<dyn fmt::Write + Send>>,
}

impl<S: Subscriber> Layer<S> for RedactingLayer {
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let metadata = event.metadata();
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let line = format!(
            "{} {} {}",
            metadata.level(),
            metadata.target(),
            visitor.finish()
        );
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writeln!(writer, "{}", redact_str(&line));
        }
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: Vec<String>,
}

impl FieldVisitor {
    fn finish(self) -> String {
        if self.fields.is_empty() {
            self.message
        } else {
            format!("{} {}", self.message, self.fields.join(" "))
        }
    }
}

impl tracing::field::Visit for FieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}").trim_matches('"').to_string();
        } else {
            self.fields.push(format!("{}={value:?}", field.name()));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields.push(format!("{}={value}", field.name()));
        }
    }
}

/// Install the redacting subscriber.
///
/// `filter` defaults to `AGENTS_USAGE_LOG` and then `info`, matching the legacy
/// dashboard's behaviour of staying quiet unless asked.
pub fn init(filter: Option<&str>) {
    let filter = filter
        .map(str::to_string)
        .or_else(|| std::env::var(LOG_FILTER_ENV).ok())
        .unwrap_or_else(|| "info".to_string());
    let env_filter = EnvFilter::try_new(filter).unwrap_or_else(|_| EnvFilter::new("info"));
    let writer: Arc<Mutex<dyn fmt::Write + Send>> =
        Arc::new(Mutex::new(FmtWriterAdapter::new(io::stderr())));
    let layer = RedactingLayer { writer };
    let _ = tracing_subscriber::registry()
        .with(env_filter)
        .with(layer)
        .try_init();
}

/// Capture logs into memory for tests and for the diagnostics endpoint.
///
/// Returns the in-memory buffer and a `Dispatch` the caller installs with
/// [`tracing::subscriber::set_default`].
pub fn capture(filter: &str) -> (BufferWriter, tracing::Dispatch) {
    let buffer = BufferWriter::new();
    let writer: Arc<Mutex<dyn fmt::Write + Send>> = Arc::new(Mutex::new(buffer.clone()));
    let env_filter = EnvFilter::try_new(filter).unwrap_or_else(|_| EnvFilter::new("info"));
    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(RedactingLayer { writer });
    (buffer, tracing::Dispatch::new(subscriber))
}

/// Convenience for emitting a redacted diagnostic line at `info` level.
pub fn info(location: &str, message: &str) {
    if tracing::enabled!(Level::INFO) {
        tracing::info!(location, "{}", redact_str(message));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_redacts_embedded_credentials() {
        let mut writer = RedactingWriter::new(String::new());
        use fmt::Write as _;
        write!(writer, "request failed with token=not-a-real-token").expect("write");
        let rendered = {
            let guard = writer.inner.lock().expect("lock");
            guard.clone()
        };
        assert_eq!(rendered, "request failed with token=[REDACTED]");
    }

    #[test]
    fn captured_events_never_contain_a_secret() {
        let (buffer, dispatch) = capture("info");
        let _guard = dispatch.set_default();
        tracing::info!(
            authorization = "Bearer sk-live-not-a-real-key",
            api_key = "not-a-real-key",
            "collector failed"
        );
        tracing::warn!("token=not-a-real-token rejected");
        drop(_guard);

        let text = buffer.joined();
        assert!(text.contains("collector failed") || text.contains("rejected"));
        assert!(!text.contains("sk-live-not-a-real-key"));
        assert!(!text.contains("not-a-real-token"));
    }
}

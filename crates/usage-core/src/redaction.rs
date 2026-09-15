//! Secret scrubbing shared by every output path.
//!
//! Request headers, process output, log lines, error messages and persisted
//! records all pass through [`redact`] before they can reach the panel, the
//! companion web page or the database. The behaviour is pinned by
//! `fixtures/contracts/redaction.json`, which the TypeScript implementation
//! (`src/shared/redaction.ts`) is checked against as well, so both runtimes
//! produce byte-identical output for the same input.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

/// Field names whose value is replaced wholesale, matching the TypeScript
/// pattern `/(authorization|cookie|api[-_]?key|token|secret|password|session)/i`.
fn sensitive_key_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)(authorization|cookie|api[-_]?key|token|secret|password|session)")
            .expect("sensitive key pattern must compile")
    })
}

/// `Bearer <credential>` inside free-form text.
fn bearer_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"(?i)Bearer\s+[^\s,;]+").expect("bearer pattern must compile"))
}

/// `token=…`, `api_key=…`, `secret=…`, `password=…`, `session=…` inside
/// free-form text.
fn key_value_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)\b(token|api[-_]?key|secret|password|session)=([^\s,;&]+)")
            .expect("key/value pattern must compile")
    })
}

/// Redact a single string: bearer credentials and `key=value` pairs.
pub fn redact_str(value: &str) -> String {
    let bearer = bearer_regex().replace_all(value, "Bearer [REDACTED]");
    key_value_regex()
        .replace_all(&bearer, "$1=[REDACTED]")
        .into_owned()
}

/// Recursively redact a JSON value.
///
/// Objects whose key looks sensitive have their whole value replaced, matching
/// the TypeScript implementation. Arrays and nested objects are walked.
pub fn redact(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_str(text)),
        Value::Array(entries) => Value::Array(entries.iter().map(redact).collect()),
        Value::Object(entries) => {
            let mut output = Map::with_capacity(entries.len());
            for (key, entry) in entries {
                let redacted = if sensitive_key_regex().is_match(key) {
                    Value::String("[REDACTED]".to_string())
                } else {
                    redact(entry)
                };
                output.insert(key.clone(), redacted);
            }
            Value::Object(output)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn redacts_sensitive_keys_at_any_depth() {
        let redacted = redact(&json!({
            "authorization": "Bearer sk-live-value",
            "nested": { "glmApiKey": "value", "safe": "keep me" }
        }));
        assert_eq!(redacted["authorization"], json!("[REDACTED]"));
        assert_eq!(redacted["nested"]["glmApiKey"], json!("[REDACTED]"));
        assert_eq!(redacted["nested"]["safe"], json!("keep me"));
    }

    #[test]
    fn redacts_embedded_credentials_in_text() {
        assert_eq!(redact_str("token=abc123"), "token=[REDACTED]");
        assert_eq!(
            redact_str("failed with Bearer abc.def"),
            "failed with Bearer [REDACTED]"
        );
    }
}

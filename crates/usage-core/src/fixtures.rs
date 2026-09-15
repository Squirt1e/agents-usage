//! Contract vocabulary and the conformance suite that pins it.
//!
//! The canonical fixtures live in `fixtures/contracts/` at the repository root
//! and are shared with the TypeScript runtime, so a semantic change must be made
//! on both sides at once. [`fixtures_dir`] resolves that directory at compile
//! time (via the `AGENTS_USAGE_FIXTURES_DIR` environment variable that
//! `build.rs` sets) and at run time (via the same variable, then a walk up from
//! the manifest directory).

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Directory holding the shared sanitized contract fixtures.
pub fn fixtures_dir() -> Option<PathBuf> {
    if let Some(configured) = option_env!("AGENTS_USAGE_FIXTURES_DIR") {
        let path = PathBuf::from(configured);
        if path.is_dir() {
            return Some(path);
        }
    }
    let mut candidate = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    for _ in 0..4 {
        candidate.pop();
        let fixtures = candidate.join("fixtures").join("contracts");
        if fixtures.is_dir() {
            return Some(fixtures);
        }
    }
    None
}

/// Load one fixture as JSON.
///
/// # Panics
///
/// Panics when the fixture is missing or malformed: every fixture is a required
/// part of the contract, so a missing file must fail the test rather than be
/// skipped.
pub fn load_fixture(name: &str) -> Value {
    let dir = fixtures_dir().expect("fixtures/contracts must be present");
    let path = dir.join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

/// Render a JSON value with sorted object keys so two runtimes can be compared
/// byte for byte.
pub fn canonical_json(value: &Value) -> String {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Array(entries) => Value::Array(entries.iter().map(sort).collect()),
            Value::Object(entries) => {
                let mut sorted: Vec<(&String, &Value)> = entries.iter().collect();
                sorted.sort_by(|left, right| left.0.cmp(right.0));
                let mut output = Map::new();
                for (key, entry) in sorted {
                    output.insert(key.clone(), sort(entry));
                }
                Value::Object(output)
            }
            other => other.clone(),
        }
    }
    serde_json::to_string(&sort(value)).expect("JSON value must serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_the_shared_fixture_directory() {
        let dir = fixtures_dir().expect("fixtures/contracts must be resolvable");
        assert!(dir.join("redaction.json").is_file(), "{}", dir.display());
    }
}

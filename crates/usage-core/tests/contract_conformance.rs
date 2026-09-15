//! Conformance checks against the shared sanitized fixtures.
//!
//! These tests are the Rust half of `npm run test:contracts`: the same JSON
//! files under `fixtures/contracts/` are read by
//! `tests/contracts-fixtures.test.ts`, so any divergence between the two
//! runtimes fails one of the two suites.

use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Value};
use usage_core::contracts::{MetricValue, ProviderId};
use usage_core::fixtures::{canonical_json, load_fixture};
use usage_core::redaction::redact;

fn cases(fixture: &Value) -> &Vec<Value> {
    fixture["cases"]
        .as_array()
        .expect("fixture must contain a cases array")
}

#[test]
fn provider_identifiers_match_the_typescript_spelling() {
    let expected = ["codex", "glm", "deepseek"];
    let actual: Vec<&str> = ProviderId::ALL
        .iter()
        .map(|provider| provider.as_str())
        .collect();
    assert_eq!(actual, expected);
    for provider in ProviderId::ALL {
        let encoded = serde_json::to_value(provider).expect("provider must serialize");
        assert_eq!(encoded, json!(provider.as_str()));
    }
}

#[test]
fn absent_values_stay_absent_and_reliable_zero_stays_zero() {
    let fixture = load_fixture("new-old-semantics");
    for case in cases(&fixture) {
        let name = case["name"].as_str().expect("case name");
        let encoded = serde_json::to_string(&case["input"]).expect("metric must serialize");
        let metric: Value = serde_json::from_str(&encoded).expect("metric must parse");
        let value: MetricValue =
            serde_json::from_value(metric["value"].clone()).expect("value must deserialize");

        let expect_absent = case["expect"]["valueIsAbsent"].as_bool().unwrap_or(false);
        assert_eq!(value.is_missing(), expect_absent, "case {name}");

        if let Some(expect_zero) = case["expect"]["valueIsNotZero"].as_bool() {
            let is_zero = matches!(value, MetricValue::Number(number) if number == 0.0);
            assert_eq!(is_zero, !expect_zero, "case {name}");
        }
        if case["expect"]["valueIsText"].as_bool() == Some(true) {
            assert!(matches!(value, MetricValue::Text(_)), "case {name}");
        }
    }
}

#[test]
fn error_kind_vocabulary_is_unchanged() {
    let fixture = load_fixture("new-old-semantics");
    let kinds: Vec<&str> = fixture["errorKinds"]
        .as_array()
        .expect("errorKinds array")
        .iter()
        .map(|kind| kind.as_str().expect("error kind string"))
        .collect();
    assert_eq!(
        kinds,
        vec![
            "missing_config",
            "authentication",
            "compatibility",
            "network",
            "rate_limit",
            "process",
            "storage",
            "unknown"
        ]
    );

    let errors = load_fixture("provider-errors");
    for case in cases(&errors) {
        let kind = case["error"]["kind"].as_str().expect("error kind");
        assert!(
            kinds.contains(&kind),
            "{kind} must stay in the shared vocabulary"
        );
    }
}

#[test]
fn external_timestamp_units_convert_once() {
    let fixture = load_fixture("new-old-semantics");
    for conversion in fixture["timestampConversions"]
        .as_array()
        .expect("conversions")
    {
        let raw = conversion["input"].as_i64().expect("epoch value");
        let expected = conversion["expect"]
            .as_str()
            .expect("expected ISO timestamp");
        let instant = match conversion["unit"].as_str().expect("unit") {
            "seconds" => Utc.timestamp_opt(raw, 0).single(),
            "milliseconds" => Utc.timestamp_millis_opt(raw).single(),
            other => panic!("unsupported unit {other}"),
        }
        .expect("epoch must be representable");
        let rendered: DateTime<Utc> = instant;
        assert_eq!(
            rendered.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            expected
        );
    }
}

#[test]
fn redaction_matches_the_shared_expectations() {
    let fixture = load_fixture("redaction");
    for case in cases(&fixture) {
        let name = case["name"].as_str().expect("case name");
        let redacted = redact(&case["input"]);
        assert_eq!(
            canonical_json(&redacted),
            canonical_json(&case["expect"]),
            "redaction case {name}"
        );
    }
}

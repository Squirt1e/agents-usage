//! Daily spend estimator tests.
//!
//! The golden expectations come from `fixtures/contracts/daily-statistics.json`
//! (the full-day case, the midday case, the timezone boundaries) and from the
//! estimator rules this project has always applied: only positive decreases between
//! adjacent samples count, a top-up is an adjustment boundary and never negative
//! spend, an incomplete day is marked partial, and a restart continues the
//! stored day instead of starting a new one.

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde_json::Value;
use usage_core::contracts::{ConnectionId, ErrorKind, IsoTimestamp, ProviderId};
use usage_core::estimate::{
    summarize_day, BalanceKey, BalanceObservation, BalanceStore, DailySpendEstimator,
    DailySpendRecorder, DailySummary, EstimateError, MemoryBalanceStore, Money, StoreError,
    Timezone,
};
use usage_core::fixtures::load_fixture;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn at(raw: &str) -> IsoTimestamp {
    IsoTimestamp::parse(raw).expect("timestamp must parse")
}

fn instant(raw: &str) -> DateTime<Utc> {
    at(raw).to_datetime()
}

fn money(raw: &str) -> Money {
    Money::parse(raw).expect("money must parse")
}

fn timezone(name: &str) -> Timezone {
    Timezone::parse(name).expect("timezone must resolve")
}

fn shanghai() -> Timezone {
    timezone("Asia/Shanghai")
}

fn deepseek_key(currency: &str) -> BalanceKey {
    BalanceKey {
        provider: ProviderId::Deepseek,
        connection: ConnectionId::new(ProviderId::Deepseek, "wallet"),
        currency: currency.to_string(),
    }
}

/// Estimator over a store shared with the test so writes can be inspected.
fn new_estimator(
    store: MemoryBalanceStore,
    zone: Timezone,
) -> DailySpendEstimator<MemoryBalanceStore> {
    DailySpendEstimator::deepseek_wallet(store, zone)
}

fn record<S: BalanceStore>(
    estimator: &mut DailySpendEstimator<S>,
    currency: &str,
    total: &str,
    observed_at: &str,
) -> DailySummary {
    estimator
        .record(currency, money(total), &at(observed_at))
        .expect("recording must succeed")
}

/// Store that counts `save_summary` calls so "settled exactly once" is
/// observable, and keeps the summaries for inspection.
#[derive(Debug, Clone, Default)]
struct CountingStore {
    inner: MemoryBalanceStore,
    saves: Arc<Mutex<Vec<DailySummary>>>,
}

impl CountingStore {
    fn saved(&self) -> Vec<DailySummary> {
        self.saves.lock().expect("save log").clone()
    }
}

impl BalanceStore for CountingStore {
    fn latest(&self, key: &BalanceKey) -> Result<Option<BalanceObservation>, StoreError> {
        self.inner.latest(key)
    }

    fn list_day(
        &self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Vec<BalanceObservation>, StoreError> {
        self.inner.list_day(key, local_day)
    }

    fn insert(&mut self, observation: BalanceObservation) -> Result<(), StoreError> {
        self.inner.insert(observation)
    }

    fn save_summary(&mut self, summary: DailySummary) -> Result<(), StoreError> {
        self.saves
            .lock()
            .map_err(|_| StoreError::new("save log is poisoned"))?
            .push(summary.clone());
        self.inner.save_summary(summary)
    }
}

/// Store whose reads fail, to prove a storage failure is never mistaken for an
/// empty day.
#[derive(Debug, Default, Clone)]
struct FailingStore;

impl BalanceStore for FailingStore {
    fn latest(&self, _key: &BalanceKey) -> Result<Option<BalanceObservation>, StoreError> {
        Err(StoreError::new(
            "sqlite: cannot read samples secret=super-secret-value",
        ))
    }

    fn list_day(
        &self,
        _key: &BalanceKey,
        _local_day: &str,
    ) -> Result<Vec<BalanceObservation>, StoreError> {
        Err(StoreError::new(
            "sqlite: cannot read samples secret=super-secret-value",
        ))
    }

    fn insert(&mut self, _observation: BalanceObservation) -> Result<(), StoreError> {
        Err(StoreError::new(
            "sqlite: cannot read samples secret=super-secret-value",
        ))
    }

    fn save_summary(&mut self, _summary: DailySummary) -> Result<(), StoreError> {
        Err(StoreError::new(
            "sqlite: cannot read samples secret=super-secret-value",
        ))
    }
}

// ---------------------------------------------------------------------------
// Golden fixture
// ---------------------------------------------------------------------------

#[test]
fn local_days_match_the_shared_daily_statistics_fixture() {
    let fixture = load_fixture("daily-statistics");
    let zone = timezone(fixture["timezone"].as_str().expect("timezone"));

    for case in fixture["cases"].as_array().expect("cases") {
        let observed = case["instant"].as_str().expect("instant");
        let expected = case["expect"]["localDay"].as_str().expect("local day");
        assert_eq!(
            zone.local_day(instant(observed)),
            expected,
            "case {observed}"
        );
    }

    let midnight = &fixture["localMidnightUtc"];
    assert_eq!(
        zone.local_midnight(midnight["localDay"].as_str().expect("local day"))
            .expect("midnight must resolve")
            .as_str(),
        midnight["expect"].as_str().expect("expected instant")
    );
}

#[test]
fn full_day_estimate_matches_the_fixture() {
    let fixture = load_fixture("daily-statistics");
    let case = &fixture["balanceEstimator"]["fullDay"];
    let expect = &case["expect"];
    let zone = timezone(fixture["timezone"].as_str().expect("timezone"));
    let store = MemoryBalanceStore::new();
    let mut estimator = new_estimator(store.clone(), zone);

    let mut summary = None;
    for observation in case["observations"].as_array().expect("observations") {
        summary = Some(record(
            &mut estimator,
            "USD",
            &observation["total"].to_string(),
            observation["observedAt"].as_str().expect("observedAt"),
        ));
    }
    let summary = summary.expect("at least one observation");

    assert_eq!(
        summary.estimated_spend_f64(),
        expect["estimatedSpend"].as_f64().expect("estimated spend")
    );
    assert_eq!(
        summary.adjustment_count as u64,
        expect["adjustmentCount"]
            .as_u64()
            .expect("adjustment count")
    );
    assert_eq!(
        summary.partial,
        expect["partial"].as_bool().expect("partial")
    );
    assert_eq!(summary.local_day, "2026-09-10");

    // A top-up between two purchases never produces negative spend.
    assert!(expect["topUpDoesNotProduceNegativeSpend"]
        .as_bool()
        .expect("flag"));
    assert!(summary.estimated_spend.is_positive());
    assert_eq!(summary.estimated_spend, money("9"));

    // Every sample of the day is stored, exactly, with its own instant.
    let stored = store.day(&deepseek_key("USD"), "2026-09-10");
    assert_eq!(stored.len(), 4);
    assert_eq!(stored[0].total, money("100"));
    assert!(stored[2].adjustment, "the 96 -> 120 top-up is a boundary");
}

#[test]
fn midday_start_is_partial_and_is_not_extrapolated() {
    let fixture = load_fixture("daily-statistics");
    let case = &fixture["balanceEstimator"]["middayStart"];
    let expect = &case["expect"];
    let zone = timezone(fixture["timezone"].as_str().expect("timezone"));
    let store = MemoryBalanceStore::new();
    let mut estimator = new_estimator(store.clone(), zone);

    let mut summary = None;
    for observation in case["observations"].as_array().expect("observations") {
        summary = Some(record(
            &mut estimator,
            "CNY",
            &observation["total"].to_string(),
            observation["observedAt"].as_str().expect("observedAt"),
        ));
    }
    let summary = summary.expect("at least one observation");

    assert_eq!(
        summary.estimated_spend_f64(),
        expect["estimatedSpend"].as_f64().expect("estimated spend")
    );
    assert_eq!(
        summary.partial,
        expect["partial"].as_bool().expect("partial")
    );
    assert!(expect["unobservedHoursAreNotExtrapolated"]
        .as_bool()
        .expect("flag"));
    // One hour observed, twenty-three unobserved: the estimate stays at the one
    // decrease that was really seen.
    assert_eq!(summary.estimated_spend, money("1.5"));
    assert_eq!(summary.local_day, "2026-09-10");
}

// ---------------------------------------------------------------------------
// Estimation rules
// ---------------------------------------------------------------------------

#[test]
fn a_top_up_between_two_purchases_is_a_boundary_and_not_negative_spend() {
    let store = MemoryBalanceStore::new();
    let mut estimator = new_estimator(store.clone(), timezone("UTC"));

    record(&mut estimator, "USD", "10.00", "2026-09-10T00:00:00.000Z");
    let spent = record(&mut estimator, "USD", "8.00", "2026-09-10T02:00:00.000Z");
    assert_eq!(spent.estimated_spend, money("2"));
    assert_eq!(spent.adjustment_count, 0);

    let topped_up = record(&mut estimator, "USD", "12.00", "2026-09-10T03:00:00.000Z");
    assert_eq!(
        topped_up.estimated_spend,
        money("2"),
        "a top-up adds no spend"
    );
    assert_eq!(topped_up.adjustment_count, 1);

    let final_day = record(&mut estimator, "USD", "10.00", "2026-09-10T04:00:00.000Z");
    assert_eq!(final_day.estimated_spend, money("4"));
    assert_eq!(final_day.adjustment_count, 1);
    assert!(!final_day.partial, "the day started at local midnight");

    // The increase is flagged on the stored sample so the boundary survives a
    // restart and is never read as spend.
    let stored = store.day(&deepseek_key("USD"), "2026-09-10");
    let flagged: Vec<&BalanceObservation> =
        stored.iter().filter(|sample| sample.adjustment).collect();
    assert_eq!(flagged.len(), 1);
    assert_eq!(flagged[0].total, money("12"));
    assert_eq!(flagged[0].observed_at.as_str(), "2026-09-10T03:00:00.000Z");
}

#[test]
fn a_gap_of_unobserved_hours_adds_no_spend() {
    let store = MemoryBalanceStore::new();
    let mut estimator = new_estimator(store.clone(), timezone("UTC"));

    record(&mut estimator, "USD", "200.00", "2026-09-10T00:00:00.000Z");
    let summary = record(&mut estimator, "USD", "150.00", "2026-09-10T06:00:00.000Z");

    assert_eq!(
        summary.estimated_spend,
        money("50"),
        "only the observed decrease"
    );
    assert_eq!(summary.adjustment_count, 0);
    assert!(!summary.partial, "day started at local midnight");
}

#[test]
fn crossing_midnight_settles_the_previous_day_exactly_once() {
    let store = CountingStore::default();
    let mut estimator = DailySpendEstimator::deepseek_wallet(store.clone(), shanghai());

    record(&mut estimator, "CNY", "100.00", "2026-09-09T16:00:00.000Z");
    let finished = record(&mut estimator, "CNY", "95.00", "2026-09-09T20:00:00.000Z");
    assert_eq!(finished.local_day, "2026-09-10");
    assert_eq!(finished.estimated_spend, money("5"));
    assert!(!finished.partial);
    assert!(
        store.saved().is_empty(),
        "the running day is not settled yet"
    );

    // 16:30Z is 00:30 local on the next day.
    let rollover = record(&mut estimator, "CNY", "90.00", "2026-09-10T16:30:00.000Z");
    assert_eq!(rollover.local_day, "2026-09-11");
    assert_eq!(rollover.estimated_spend, money("0"));
    assert!(rollover.partial, "the new day starts at 00:30 local");

    let saved = store.saved();
    assert_eq!(saved.len(), 1, "the finished day is settled exactly once");
    assert_eq!(saved[0].local_day, "2026-09-10");
    assert_eq!(saved[0].estimated_spend, money("5"));
    assert_eq!(saved[0].adjustment_count, 0);
    assert!(!saved[0].partial, "the day started at local midnight");
    assert_eq!(saved[0].provider, ProviderId::Deepseek);
    assert_eq!(saved[0].connection.key(), "deepseek:wallet");
    assert_eq!(saved[0].currency, "CNY");

    // Later samples of the new day must not settle the previous one again.
    record(&mut estimator, "CNY", "88.00", "2026-09-10T17:00:00.000Z");
    record(&mut estimator, "CNY", "86.00", "2026-09-10T18:00:00.000Z");
    assert_eq!(store.saved().len(), 1, "a day is settled once");

    // The stored summary matches an explicit settle of the same day.
    let again = estimator
        .settle("CNY", "2026-09-10")
        .expect("settle must succeed")
        .expect("the day has samples");
    assert_eq!(again.estimated_spend, money("5"));
    assert_eq!(again.adjustment_count, 0);
    assert_eq!(
        store.saved().len(),
        2,
        "an explicit settle writes again (upsert)"
    );
    assert_eq!(store.inner.summaries().len(), 1, "…onto the same row");

    let current = estimator
        .current("CNY")
        .expect("current estimate")
        .expect("sample");
    assert_eq!(current.local_day, "2026-09-11");
    assert_eq!(
        current.estimated_spend,
        money("4"),
        "90 -> 88 -> 86 of the new day"
    );
}

#[test]
fn a_restart_re_reads_stored_samples_and_keeps_their_original_times() {
    let store = MemoryBalanceStore::new();
    let mut first = new_estimator(store.clone(), shanghai());

    record(&mut first, "CNY", "100.00", "2026-09-09T16:00:00.000Z");
    let before = record(&mut first, "CNY", "96.00", "2026-09-09T18:00:00.000Z");
    assert_eq!(before.estimated_spend, money("4"));
    let carried = first.into_store();

    // A new estimator (as after a process restart) reads the same store back.
    let mut restarted = DailySpendEstimator::deepseek_wallet(carried, shanghai());
    let current = restarted
        .current("CNY")
        .expect("current")
        .expect("stored day");
    assert_eq!(current.local_day, "2026-09-10");
    assert_eq!(
        current.estimated_spend,
        money("4"),
        "the stored day continues"
    );

    let latest = store
        .latest(&deepseek_key("CNY"))
        .expect("latest must read")
        .expect("a sample is stored");
    assert_eq!(
        latest.observed_at.as_str(),
        "2026-09-09T18:00:00.000Z",
        "a restart must not rewrite the last success time"
    );

    let after = record(&mut restarted, "CNY", "90.00", "2026-09-09T19:00:00.000Z");
    assert_eq!(
        after.estimated_spend,
        money("10"),
        "4 + 6, still the same day"
    );
    assert!(!after.partial);

    let samples = store.observations();
    let observed: Vec<&str> = samples
        .iter()
        .map(|sample| sample.observed_at.as_str())
        .collect();
    assert_eq!(
        observed,
        vec![
            "2026-09-09T16:00:00.000Z",
            "2026-09-09T18:00:00.000Z",
            "2026-09-09T19:00:00.000Z"
        ]
    );
    assert!(
        store.summaries().is_empty(),
        "the running day is not settled"
    );
}

#[test]
fn estimates_are_isolated_by_timezone_platform_connection_currency_and_day() {
    // The same instant belongs to different local days in different timezones.
    let boundary = "2026-09-10T16:30:00.000Z";
    assert_eq!(timezone("UTC").local_day(instant(boundary)), "2026-09-10");
    assert_eq!(shanghai().local_day(instant(boundary)), "2026-09-11");
    assert_eq!(
        timezone("America/New_York").local_day(instant(boundary)),
        "2026-09-10"
    );

    let store = MemoryBalanceStore::new();
    let mut utc = new_estimator(store.clone(), timezone("UTC"));
    let mut shanghai_estimator = new_estimator(store.clone(), shanghai());
    let utc_day = record(&mut utc, "CNY", "100.00", boundary);
    let shanghai_day = record(&mut shanghai_estimator, "CNY", "100.00", boundary);
    assert_eq!(utc_day.local_day, "2026-09-10");
    assert_eq!(
        shanghai_day.local_day, "2026-09-11",
        "same instant, other day"
    );

    // Currencies of one wallet are separate series.
    let store = MemoryBalanceStore::new();
    let mut wallet = new_estimator(store.clone(), timezone("UTC"));
    record(&mut wallet, "USD", "10.00", "2026-09-10T00:00:00.000Z");
    record(&mut wallet, "CNY", "100.00", "2026-09-10T00:00:00.000Z");
    let usd = record(&mut wallet, "USD", "8.00", "2026-09-10T01:00:00.000Z");
    let cny = record(&mut wallet, "CNY", "97.00", "2026-09-10T01:00:00.000Z");
    assert_eq!(usd.estimated_spend, money("2"));
    assert_eq!(cny.estimated_spend, money("3"));

    // Another connection of the same provider stays separate.
    let mut glm_wallet =
        DailySpendEstimator::wallet(store.clone(), ProviderId::Glm, timezone("UTC"));
    record(&mut glm_wallet, "USD", "50.00", "2026-09-10T00:00:00.000Z");
    let glm = record(&mut glm_wallet, "USD", "45.00", "2026-09-10T01:00:00.000Z");
    assert_eq!(
        glm.estimated_spend,
        money("5"),
        "GLM spend does not join DeepSeek"
    );
    assert_eq!(glm.connection.key(), "glm:wallet");
    assert_eq!(
        store.day(&deepseek_key("USD"), "2026-09-10").len(),
        2,
        "the DeepSeek wallet kept its own two samples"
    );

    // Another day is never folded into today.
    let other_day = record(&mut wallet, "USD", "1.00", "2026-09-11T00:00:00.000Z");
    assert_eq!(other_day.local_day, "2026-09-11");
    assert_eq!(
        other_day.estimated_spend,
        money("0"),
        "the new day starts empty"
    );
}

#[test]
fn summarize_day_is_pure_and_ignores_rows_of_other_keys_and_days() {
    let zone = timezone("UTC");
    let key = deepseek_key("CNY");
    let other_currency = BalanceKey {
        currency: "USD".to_string(),
        ..key.clone()
    };
    let sample =
        |currency: &str, local_day: &str, total: &str, observed_at: &str| BalanceObservation {
            provider: ProviderId::Deepseek,
            connection: key.connection.clone(),
            currency: currency.to_string(),
            total: money(total),
            observed_at: at(observed_at),
            local_day: local_day.to_string(),
            adjustment: false,
        };

    // Deliberately out of order, with an extra currency and an extra day: the
    // summary must only see the matching rows, in time order.
    let observations = vec![
        sample("CNY", "2026-09-11", "5.00", "2026-09-11T00:00:00.000Z"),
        sample("CNY", "2026-09-10", "90.00", "2026-09-10T02:00:00.000Z"),
        sample("USD", "2026-09-10", "1.00", "2026-09-10T00:00:00.000Z"),
        sample("CNY", "2026-09-10", "100.00", "2026-09-10T00:00:00.000Z"),
    ];

    let summary = summarize_day(&zone, &key, "2026-09-10", &observations)
        .expect("summarize must succeed")
        .expect("the day has samples");
    assert_eq!(summary.local_day, "2026-09-10");
    assert_eq!(summary.estimated_spend, money("10"), "100 - 90");
    assert_eq!(summary.adjustment_count, 0);
    assert!(!summary.partial);

    assert!(summarize_day(&zone, &key, "2026-09-12", &observations)
        .expect("summarize must succeed")
        .is_none());
    assert!(summarize_day(&zone, &key, "2026-09-10", &[])
        .expect("summarize must succeed")
        .is_none());

    // The USD row is summarized on its own: the CNY rows, which are three times
    // its size, are not part of that series.
    let usd_summary = summarize_day(&zone, &other_currency, "2026-09-10", &observations)
        .expect("summarize must succeed")
        .expect("the USD row matches");
    assert_eq!(usd_summary.currency, "USD");
    assert_eq!(usd_summary.estimated_spend, Money::ZERO);
    assert!(
        !usd_summary.partial,
        "the single USD sample sits at local midnight, so coverage starts at the day boundary"
    );

    let eur = BalanceKey {
        currency: "EUR".to_string(),
        ..key.clone()
    };
    assert!(summarize_day(&zone, &eur, "2026-09-10", &observations)
        .expect("summarize must succeed")
        .is_none());
}

#[test]
fn an_unobserved_day_is_missing_rather_than_a_zero() {
    let store = CountingStore::default();
    let mut estimator = DailySpendEstimator::deepseek_wallet(store.clone(), timezone("UTC"));

    assert!(estimator
        .settle("USD", "2026-09-09")
        .expect("settle")
        .is_none());
    assert!(estimator.settle_latest("USD").expect("settle").is_none());
    assert!(estimator.current("USD").expect("current").is_none());
    assert!(
        store.saved().is_empty(),
        "nothing is written for a day with no sample"
    );

    record(&mut estimator, "USD", "10.00", "2026-09-10T00:00:00.000Z");
    let settled = estimator
        .settle_latest("USD")
        .expect("settle")
        .expect("summary");
    assert_eq!(settled.local_day, "2026-09-10");
    assert_eq!(settled.estimated_spend, Money::ZERO);
    assert_eq!(store.saved().len(), 1);
}

#[test]
fn invalid_inputs_are_rejected_instead_of_estimated() {
    let mut estimator = new_estimator(MemoryBalanceStore::new(), timezone("UTC"));

    assert_eq!(
        estimator.record("  ", money("1"), &at("2026-09-10T00:00:00.000Z")),
        Err(EstimateError::EmptyCurrency)
    );
    assert_eq!(
        estimator.record(
            "USD",
            Money::from_micro_units(-1),
            &at("2026-09-10T00:00:00.000Z")
        ),
        Err(EstimateError::NegativeTotal)
    );
    assert_eq!(
        EstimateError::NegativeTotal.kind(),
        ErrorKind::Compatibility
    );
    // Money itself cannot even carry a negative from a provider string.
    assert!(Money::parse("-1.00").is_err());
}

#[test]
fn storage_failures_are_reported_as_storage_and_redacted() {
    let mut estimator = DailySpendEstimator::deepseek_wallet(FailingStore, timezone("UTC"));
    let error = estimator
        .record("USD", money("1"), &at("2026-09-10T00:00:00.000Z"))
        .expect_err("a store failure must surface");

    assert_eq!(error.kind(), ErrorKind::Storage);
    let message = error.to_string();
    assert!(message.contains("[REDACTED]"), "{message}");
    assert!(!message.contains("super-secret-value"));
}

#[test]
fn the_recorder_seam_exposes_the_timezone_and_the_current_day() {
    let store = MemoryBalanceStore::new();
    let mut recorder: Box<dyn DailySpendRecorder> =
        Box::new(DailySpendEstimator::deepseek_wallet(store, shanghai()));

    assert_eq!(recorder.timezone_name(), "Asia/Shanghai");
    let summary = recorder
        .record("CNY", money("80.00"), &at("2026-09-10T04:00:00.000Z"))
        .expect("record");
    assert_eq!(summary.local_day, "2026-09-10");
    assert!(summary.partial, "a midday start is incomplete coverage");
    let current = recorder
        .current("CNY")
        .expect("current")
        .expect("stored day");
    assert_eq!(current.estimated_spend, Money::ZERO);
    assert!(recorder.current("USD").expect("current").is_none());
}

#[test]
fn the_fixture_is_shared_with_the_typescript_runtime() {
    // Guard against a fixture edit that only makes sense for one runtime: the
    // expectations this suite relies on must still be present.
    let fixture = load_fixture("daily-statistics");
    let estimator_cases: &Value = &fixture["balanceEstimator"];
    assert_eq!(
        estimator_cases["fullDay"]["expect"]["estimatedSpend"].as_f64(),
        Some(9.0)
    );
    assert_eq!(
        estimator_cases["fullDay"]["expect"]["adjustmentCount"].as_u64(),
        Some(1)
    );
    assert_eq!(
        estimator_cases["fullDay"]["expect"]["partial"].as_bool(),
        Some(false)
    );
    assert_eq!(
        estimator_cases["middayStart"]["expect"]["estimatedSpend"].as_f64(),
        Some(1.5)
    );
    assert_eq!(
        estimator_cases["middayStart"]["expect"]["partial"].as_bool(),
        Some(true)
    );
}

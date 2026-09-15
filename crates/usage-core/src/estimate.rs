//! Balance-based daily spend estimation.
//!
//! One wallet's spend is estimated from the balance totals the provider
//! actually reported: whenever the balance drops between two observations of the
//! same local day the drop is spend, and whenever it rises that is a top-up (an
//! *adjustment* boundary) which never becomes a negative spend. Nothing is
//! extrapolated: hours without an observation contribute nothing, and a day
//! whose first observation is not local midnight is marked `partial`.
//!
//! The module is deliberately storage agnostic. It needs only a
//! [`BalanceStore`] (SQLite in the desktop service, [`MemoryBalanceStore`] in
//! tests and previews) and every estimate is isolated by **platform,
//! connection, currency and local day**, so a GLM wallet balance can never be
//! folded into a DeepSeek one, and two currencies of the same wallet can never
//! be summed together.
//!
//! Local days are computed with `chrono_tz` so they match
//! `Intl.DateTimeFormat('en-CA', { timeZone })` in the TypeScript runtime: the
//! same instant must land on the same `YYYY-MM-DD` in both runtimes
//! (`fixtures/contracts/daily-statistics.json` pins the boundary cases).
//!
//! Money is never routed through `f64` on the way in: see [`Money`].

use std::fmt;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, LocalResult, NaiveDate, TimeZone as _, Timelike as _, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::contracts::{ConnectionId, ErrorKind, IsoTimestamp, ProviderId};
use crate::redaction::redact_str;

/// Machine name of the balance connection every wallet estimator runs on.
///
/// DeepSeek has a single wallet connection; the GLM wallet reuses the same name
/// so a day summary is always attributable to one connection.
pub const WALLET_CONNECTION: &str = "wallet";

// ---------------------------------------------------------------------------
// Exact money
// ---------------------------------------------------------------------------

/// An exact money amount, stored as a fixed-scale integer with six fractional
/// digits (micro-units): `"86.42"` becomes `86_420_000`.
///
/// Why fixed-scale integers instead of `f64` or a decimal crate: the providers
/// report money as a decimal *string* (`"86.42"`, `"0.00"`), and a day's spend is
/// a sum of many small differences. Adding micro-units is exact, so
/// `0.1 + 0.2` is `0.3` and a long day of two-decimal samples cannot drift. Six
/// digits hold everything DeepSeek and GLM report; more precision than the store
/// can represent makes a response *incompatible* rather than silently rounded,
/// because rounding money would invent a value the provider never reported.
///
/// Conversion to `f64` happens only at the contract boundary
/// ([`MetricValue::Number`](crate::contracts::MetricValue)), where the shared
/// contract requires a number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Money(i64);

impl Money {
    /// Fraction digits kept by the fixed-scale representation.
    pub const SCALE_DIGITS: u32 = 6;
    /// Micro-units per whole currency unit.
    pub const SCALE: i64 = 1_000_000;
    /// A reliable zero.
    pub const ZERO: Money = Money(0);

    /// Parse a provider money string exactly.
    ///
    /// Accepts exactly the shape the providers document — `^\d+(\.\d+)?$` —
    /// matching the TypeScript `money` schema: no sign, no exponent, no
    /// surrounding whitespace, at most [`Money::SCALE_DIGITS`] fraction digits.
    pub fn parse(raw: &str) -> Result<Self, MoneyError> {
        let bytes = raw.as_bytes();
        let mut index = 0usize;
        let mut whole: i64 = 0;
        let mut whole_digits = 0usize;
        while let Some(byte) = bytes.get(index) {
            if !byte.is_ascii_digit() {
                break;
            }
            whole = whole
                .checked_mul(10)
                .and_then(|value| value.checked_add(i64::from(byte - b'0')))
                .ok_or(MoneyError::OutOfRange)?;
            whole_digits += 1;
            index += 1;
        }
        if whole_digits == 0 {
            return Err(MoneyError::InvalidFormat);
        }

        let mut fraction: i64 = 0;
        let mut fraction_digits = 0usize;
        if index < bytes.len() {
            if bytes[index] != b'.' {
                return Err(MoneyError::InvalidFormat);
            }
            index += 1;
            while let Some(byte) = bytes.get(index) {
                if !byte.is_ascii_digit() {
                    return Err(MoneyError::InvalidFormat);
                }
                if fraction_digits >= Self::SCALE_DIGITS as usize {
                    return Err(MoneyError::TooManyFractionDigits);
                }
                fraction = fraction * 10 + i64::from(byte - b'0');
                fraction_digits += 1;
                index += 1;
            }
            if fraction_digits == 0 {
                return Err(MoneyError::InvalidFormat);
            }
        }

        let padding = 10i64.pow(Self::SCALE_DIGITS - fraction_digits as u32);
        whole
            .checked_mul(Self::SCALE)
            .and_then(|scaled| scaled.checked_add(fraction * padding))
            .map(Money)
            .ok_or(MoneyError::OutOfRange)
    }

    /// Exact constructor for a value already expressed in micro-units.
    ///
    /// Used when a store reads an integer column back; never convert from
    /// `f64`, which would reintroduce rounding.
    pub fn from_micro_units(micro_units: i64) -> Self {
        Self(micro_units)
    }

    /// The exact micro-unit value, suitable for an integer column.
    pub fn micro_units(self) -> i64 {
        self.0
    }

    /// Lossy conversion for the shared contract, which carries numbers.
    ///
    /// The arithmetic that produced this value stayed exact; only the final
    /// rendering to `f64` rounds.
    pub fn to_f64(self) -> f64 {
        self.0 as f64 / Self::SCALE as f64
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn is_positive(self) -> bool {
        self.0 > 0
    }

    pub fn is_negative(self) -> bool {
        self.0 < 0
    }

    pub fn checked_add(self, other: Money) -> Option<Money> {
        self.0.checked_add(other.0).map(Money)
    }

    pub fn checked_sub(self, other: Money) -> Option<Money> {
        self.0.checked_sub(other.0).map(Money)
    }
}

impl fmt::Display for Money {
    /// Canonical exact decimal string with trailing zeros trimmed: `"86.42"`,
    /// `"9"`, `"0"`, `"-1.5"`.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let magnitude = self.0.unsigned_abs();
        let whole = magnitude / Self::SCALE as u64;
        let fraction = magnitude % Self::SCALE as u64;
        if self.0 < 0 {
            formatter.write_str("-")?;
        }
        if fraction == 0 {
            return write!(formatter, "{whole}");
        }
        let mut digits = format!("{fraction:0width$}", width = Self::SCALE_DIGITS as usize);
        while digits.ends_with('0') {
            digits.pop();
        }
        write!(formatter, "{whole}.{digits}")
    }
}

impl Serialize for Money {
    /// Serializes as an exact decimal string so a stored summary keeps the
    /// provider's precision across a JSON or SQLite text column.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Money {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Money::parse(&raw).map_err(serde::de::Error::custom)
    }
}

/// Why a money string could not be represented exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum MoneyError {
    #[error("money must be a plain decimal string such as 86.42")]
    InvalidFormat,
    #[error("money carries more than 6 fraction digits and cannot be stored exactly")]
    TooManyFractionDigits,
    #[error("money is outside the representable range")]
    OutOfRange,
}

// ---------------------------------------------------------------------------
// Local days
// ---------------------------------------------------------------------------

/// Civil time in one configured timezone.
///
/// `day` is the local date (`YYYY-MM-DD`) and the remaining fields are the local
/// wall-clock time, computed exactly like `Intl.DateTimeFormat('en-CA',
/// { timeZone })` does in the TypeScript runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalParts {
    pub day: String,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl LocalParts {
    /// True when this instant is local midnight to the second, which is the
    /// coverage start a complete day needs. Sub-second precision is ignored, as
    /// in the TypeScript implementation.
    pub fn is_midnight(&self) -> bool {
        self.hour == 0 && self.minute == 0 && self.second == 0
    }
}

/// A validated IANA timezone, kept together with its canonical name.
///
/// The name is what the `StatisticScope` of every daily metric reports, so the
/// panel knows which day boundary a value belongs to. `chrono_tz` is used
/// instead of a fixed offset because a DST transition changes the day boundary.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Timezone {
    name: String,
    zone: Tz,
}

impl Timezone {
    /// Minutes walked forward when a DST transition skips local midnight.
    const MIDNIGHT_SEARCH_STEP_MINUTES: i64 = 15;
    /// Upper bound of that search (6 hours).
    const MIDNIGHT_SEARCH_STEPS: i32 = 24;

    /// Resolve a configured IANA name such as `Asia/Shanghai`.
    ///
    /// Matching is case-insensitive so a value coming from the environment or
    /// the settings file (`asia/shanghai`) behaves like the TypeScript runtime,
    /// where `Intl` accepts any casing. The canonical spelling of the resolved
    /// zone is what [`Timezone::name`] reports.
    pub fn parse(name: &str) -> Result<Self, TimezoneError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(TimezoneError::Empty);
        }
        if let Ok(zone) = Tz::from_str(trimmed) {
            return Ok(Self::from_zone(zone));
        }
        for candidate in chrono_tz::TZ_VARIANTS {
            if candidate.name().eq_ignore_ascii_case(trimmed) {
                return Ok(Self::from_zone(candidate));
            }
        }
        Err(TimezoneError::Unknown(redact_str(trimmed)))
    }

    /// UTC, the default when nothing is configured.
    pub fn utc() -> Self {
        Self::from_zone(Tz::UTC)
    }

    fn from_zone(zone: Tz) -> Self {
        Self {
            name: zone.name().to_string(),
            zone,
        }
    }

    /// Canonical IANA name, e.g. `Asia/Shanghai`.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The underlying zone, for callers that need `chrono` conversions.
    pub fn zone(&self) -> Tz {
        self.zone
    }

    /// Local wall-clock time of one instant.
    pub fn local_parts(&self, instant: DateTime<Utc>) -> LocalParts {
        let local = instant.with_timezone(&self.zone);
        LocalParts {
            day: local.format("%Y-%m-%d").to_string(),
            hour: local.hour(),
            minute: local.minute(),
            second: local.second(),
        }
    }

    /// Local date (`YYYY-MM-DD`) of one instant.
    pub fn local_day(&self, instant: DateTime<Utc>) -> String {
        instant
            .with_timezone(&self.zone)
            .format("%Y-%m-%d")
            .to_string()
    }

    /// True when the instant is local midnight, i.e. a day is fully covered
    /// from its start.
    pub fn is_local_midnight(&self, instant: DateTime<Utc>) -> bool {
        self.local_parts(instant).is_midnight()
    }

    /// The UTC instant of local midnight of one `YYYY-MM-DD` day.
    ///
    /// `None` when the day is malformed or, in the pathological case of a DST
    /// transition that removes the whole searched window, has no midnight at all.
    pub fn local_midnight(&self, local_day: &str) -> Option<IsoTimestamp> {
        let date = NaiveDate::parse_from_str(local_day, "%Y-%m-%d").ok()?;
        if date.format("%Y-%m-%d").to_string() != local_day {
            return None;
        }
        let mut candidate = date.and_hms_opt(0, 0, 0)?;
        for _ in 0..=Self::MIDNIGHT_SEARCH_STEPS {
            match self.zone.from_local_datetime(&candidate) {
                LocalResult::Single(instant) => {
                    return Some(IsoTimestamp::from_datetime(instant.with_timezone(&Utc)))
                }
                // A fall-back transition makes midnight happen twice; the day
                // starts at the earliest occurrence.
                LocalResult::Ambiguous(earliest, _) => {
                    return Some(IsoTimestamp::from_datetime(earliest.with_timezone(&Utc)))
                }
                LocalResult::None => {
                    candidate += chrono::Duration::minutes(Self::MIDNIGHT_SEARCH_STEP_MINUTES);
                }
            }
        }
        None
    }

    /// The UTC instant of local midnight of the day the instant falls in.
    pub fn local_midnight_at(&self, instant: DateTime<Utc>) -> Option<IsoTimestamp> {
        self.local_midnight(&self.local_day(instant))
    }
}

impl fmt::Display for Timezone {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.name)
    }
}

impl FromStr for Timezone {
    type Err = TimezoneError;

    fn from_str(name: &str) -> Result<Self, Self::Err> {
        Self::parse(name)
    }
}

/// Why a configured timezone name was rejected.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TimezoneError {
    #[error("timezone must not be empty")]
    Empty,
    #[error("unknown IANA timezone: {0}")]
    Unknown(String),
}

// ---------------------------------------------------------------------------
// Observations and summaries
// ---------------------------------------------------------------------------

/// The key that isolates one running balance.
///
/// Platform, connection and currency: the same currency on two wallets, or two
/// currencies on one wallet, are different series and are never mixed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceKey {
    pub provider: ProviderId,
    pub connection: ConnectionId,
    pub currency: String,
}

/// One stored balance sample.
///
/// This is exactly what the persistence layer has to keep for the estimator:
/// nothing else is needed to reproduce a day's estimate after a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceObservation {
    pub provider: ProviderId,
    pub connection: ConnectionId,
    pub currency: String,
    /// The exact balance total the provider reported for this sample.
    pub total: Money,
    /// When the *provider value* was observed.
    ///
    /// This is never rewritten to the process start or restart time: a stored
    /// sample keeps the moment its own successful collection happened.
    pub observed_at: IsoTimestamp,
    /// Local date in the estimator's configured timezone, `YYYY-MM-DD`.
    pub local_day: String,
    /// True when this sample sits *above* the previous sample of the same day,
    /// i.e. a top-up or refund boundary. Such a boundary is never negative spend.
    pub adjustment: bool,
}

impl BalanceObservation {
    /// The key this sample belongs to.
    pub fn key(&self) -> BalanceKey {
        BalanceKey {
            provider: self.provider,
            connection: self.connection.clone(),
            currency: self.currency.clone(),
        }
    }
}

/// The persisted summary of one settled local day.
///
/// This is the shape the estimator writes through
/// [`BalanceStore::save_summary`], so the panel can show a finished day without
/// keeping every sample forever.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySummary {
    pub provider: ProviderId,
    pub connection: ConnectionId,
    pub currency: String,
    pub local_day: String,
    /// Exact sum of the day's positive balance decreases.
    pub estimated_spend: Money,
    /// Number of adjustment boundaries (top-ups) plus out-of-order decreases
    /// seen that day.
    pub adjustment_count: u32,
    /// True when coverage is incomplete because the first observation of the day
    /// is not at local midnight. Unobserved hours are never extrapolated.
    pub partial: bool,
}

impl DailySummary {
    /// The key this summary belongs to.
    pub fn key(&self) -> BalanceKey {
        BalanceKey {
            provider: self.provider,
            connection: self.connection.clone(),
            currency: self.currency.clone(),
        }
    }

    /// The estimated spend as the contract's number type.
    pub fn estimated_spend_f64(&self) -> f64 {
        self.estimated_spend.to_f64()
    }
}

// ---------------------------------------------------------------------------
// Storage seam
// ---------------------------------------------------------------------------

/// A storage failure reported by a [`BalanceStore`] implementation.
///
/// The message is redacted on construction, so a store may safely forward a
/// driver error that embeds a path or a connection string.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct StoreError {
    pub message: String,
}

impl StoreError {
    pub fn new(message: impl AsRef<str>) -> Self {
        Self {
            message: redact_str(message.as_ref()),
        }
    }
}

/// Why an estimate could not be produced.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EstimateError {
    #[error("the currency of a balance observation must not be empty")]
    EmptyCurrency,
    #[error("a balance total must not be negative")]
    NegativeTotal,
    #[error("the balance store did not return the observation that was just stored")]
    ObservationMissing,
    #[error("the estimated spend is outside the representable range")]
    OutOfRange,
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl EstimateError {
    /// The shared error vocabulary kind for this failure.
    pub fn kind(&self) -> ErrorKind {
        match self {
            EstimateError::Store(_) => ErrorKind::Storage,
            _ => ErrorKind::Compatibility,
        }
    }
}

/// The persistence seam the estimator needs.
///
/// Deliberately small: four methods, all fallible so a driver failure can never
/// be mistaken for "no data", and all keyed by [`BalanceKey`] plus a local day so
/// the estimator stays isolated by platform, connection, currency and day.
///
/// The desktop service implements this on its SQLite store; tests and previews
/// use [`MemoryBalanceStore`].
pub trait BalanceStore {
    /// The most recent stored sample for the key, by `observed_at` (the last
    /// inserted one wins a tie). `Ok(None)` means nothing is stored yet.
    fn latest(&self, key: &BalanceKey) -> Result<Option<BalanceObservation>, StoreError>;

    /// Every stored sample for one key and local day, oldest first.
    ///
    /// Implementations should order by `observed_at` already; the estimator
    /// re-sorts defensively, so a different order cannot change an estimate.
    fn list_day(
        &self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Vec<BalanceObservation>, StoreError>;

    /// Append one sample. Must not overwrite or drop an existing sample.
    fn insert(&mut self, observation: BalanceObservation) -> Result<(), StoreError>;

    /// Store one day summary.
    ///
    /// Implementations must upsert on `(provider, connection, currency,
    /// local_day)`: settling the same day twice (for instance after a restart)
    /// must not create a second row.
    fn save_summary(&mut self, summary: DailySummary) -> Result<(), StoreError>;
}

impl<T: BalanceStore + ?Sized> BalanceStore for Box<T> {
    fn latest(&self, key: &BalanceKey) -> Result<Option<BalanceObservation>, StoreError> {
        (**self).latest(key)
    }

    fn list_day(
        &self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Vec<BalanceObservation>, StoreError> {
        (**self).list_day(key, local_day)
    }

    fn insert(&mut self, observation: BalanceObservation) -> Result<(), StoreError> {
        (**self).insert(observation)
    }

    fn save_summary(&mut self, summary: DailySummary) -> Result<(), StoreError> {
        (**self).save_summary(summary)
    }
}

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

/// The estimation capability the collectors depend on.
///
/// Implemented for every [`DailySpendEstimator`], so a collector can hold a
/// `Box<dyn DailySpendRecorder>` and stay independent of the concrete store the
/// service plugs in.
pub trait DailySpendRecorder: Send {
    /// Record one balance observation and return the estimate of its local day.
    fn record(
        &mut self,
        currency: &str,
        total: Money,
        observed_at: &IsoTimestamp,
    ) -> Result<DailySummary, EstimateError>;

    /// The stored estimate of the most recent local day, without recording
    /// anything. `None` means no sample is stored for that currency.
    fn current(&self, currency: &str) -> Result<Option<DailySummary>, EstimateError>;

    /// IANA timezone name the local days are computed in.
    fn timezone_name(&self) -> &str;
}

/// Balance-observation based daily spend estimator.
///
/// One instance stands for one platform and one connection; each call names a
/// currency, so every estimate is isolated by platform, connection, currency and
/// local day. The estimator holds no in-memory history of its own: it always
/// reads the day's samples back from the store, which is what makes a restart
/// continue the same day instead of starting a new one.
#[derive(Debug, Clone)]
pub struct DailySpendEstimator<S: BalanceStore> {
    store: S,
    provider: ProviderId,
    connection: ConnectionId,
    timezone: Timezone,
}

impl<S: BalanceStore> DailySpendEstimator<S> {
    /// Build an estimator for one provider and connection.
    pub fn new(
        store: S,
        provider: ProviderId,
        connection: ConnectionId,
        timezone: Timezone,
    ) -> Self {
        Self {
            store,
            provider,
            connection,
            timezone,
        }
    }

    /// Build an estimator for the `wallet` connection of a provider.
    ///
    /// DeepSeek uses it directly and the GLM wallet is expected to reuse it, so
    /// both wallets keep separate sample series even inside one store.
    pub fn wallet(store: S, provider: ProviderId, timezone: Timezone) -> Self {
        Self::new(
            store,
            provider,
            ConnectionId::new(provider, WALLET_CONNECTION),
            timezone,
        )
    }

    /// Build the DeepSeek wallet estimator.
    pub fn deepseek_wallet(store: S, timezone: Timezone) -> Self {
        Self::wallet(store, ProviderId::Deepseek, timezone)
    }

    pub fn provider(&self) -> ProviderId {
        self.provider
    }

    pub fn connection(&self) -> &ConnectionId {
        &self.connection
    }

    pub fn timezone(&self) -> &Timezone {
        &self.timezone
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    /// Give the store back, e.g. to hand it to a restarted estimator.
    pub fn into_store(self) -> S {
        self.store
    }

    /// The isolation key for one currency of this provider connection.
    pub fn key(&self, currency: &str) -> BalanceKey {
        BalanceKey {
            provider: self.provider,
            connection: self.connection.clone(),
            currency: currency.to_string(),
        }
    }

    /// Record one observation and return the estimate of its local day.
    ///
    /// The first observation of a new local day settles the previous day exactly
    /// once before the new sample is stored; observations of the same day simply
    /// extend it.
    pub fn record(
        &mut self,
        currency: &str,
        total: Money,
        observed_at: &IsoTimestamp,
    ) -> Result<DailySummary, EstimateError> {
        let currency = currency.trim();
        if currency.is_empty() {
            return Err(EstimateError::EmptyCurrency);
        }
        if total.is_negative() {
            return Err(EstimateError::NegativeTotal);
        }
        let key = self.key(currency);
        let local_day = self.timezone.local_day(observed_at.to_datetime());

        // A new local day closes the previous one before the new sample lands,
        // so the summary can never contain the new day's balance.
        if let Some(latest) = self.store.latest(&key)? {
            if latest.local_day != local_day {
                self.settle_key(&key, &latest.local_day)?;
            }
        }

        let previous = self.store.list_day(&key, &local_day)?.pop();
        let adjustment = previous.map(|sample| total > sample.total).unwrap_or(false);
        self.store.insert(BalanceObservation {
            provider: self.provider,
            connection: self.connection.clone(),
            currency: key.currency.clone(),
            total,
            observed_at: observed_at.clone(),
            local_day: local_day.clone(),
            adjustment,
        })?;

        let samples = self.store.list_day(&key, &local_day)?;
        summarize_day(&self.timezone, &key, &local_day, &samples)?
            .ok_or(EstimateError::ObservationMissing)
    }

    /// Settle one stored local day and return the summary that was written.
    ///
    /// `OK(None)` means the day has no stored sample, so nothing is written: an
    /// unobserved day is missing, never a zero estimate.
    pub fn settle(
        &mut self,
        currency: &str,
        local_day: &str,
    ) -> Result<Option<DailySummary>, EstimateError> {
        if local_day.trim().is_empty() {
            return Ok(None);
        }
        let key = self.key(currency.trim());
        self.settle_key(&key, local_day)
    }

    /// Settle the most recent stored day of one currency.
    ///
    /// The day-rollover path uses the same call internally; the service can use
    /// it on shutdown or after a wake-up so the finished day is durable.
    pub fn settle_latest(&mut self, currency: &str) -> Result<Option<DailySummary>, EstimateError> {
        let key = self.key(currency.trim());
        let Some(latest) = self.store.latest(&key)? else {
            return Ok(None);
        };
        let local_day = latest.local_day.clone();
        self.settle_key(&key, &local_day)
    }

    /// The stored estimate of the most recent local day, without recording.
    pub fn current(&self, currency: &str) -> Result<Option<DailySummary>, EstimateError> {
        let currency = currency.trim();
        if currency.is_empty() {
            return Ok(None);
        }
        let key = self.key(currency);
        let Some(latest) = self.store.latest(&key)? else {
            return Ok(None);
        };
        let samples = self.store.list_day(&key, &latest.local_day)?;
        summarize_day(&self.timezone, &key, &latest.local_day, &samples)
    }

    fn settle_key(
        &mut self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Option<DailySummary>, EstimateError> {
        let samples = self.store.list_day(key, local_day)?;
        let Some(summary) = summarize_day(&self.timezone, key, local_day, &samples)? else {
            return Ok(None);
        };
        self.store.save_summary(summary.clone())?;
        Ok(Some(summary))
    }
}

impl<S: BalanceStore + Send> DailySpendRecorder for DailySpendEstimator<S> {
    fn record(
        &mut self,
        currency: &str,
        total: Money,
        observed_at: &IsoTimestamp,
    ) -> Result<DailySummary, EstimateError> {
        DailySpendEstimator::record(self, currency, total, observed_at)
    }

    fn current(&self, currency: &str) -> Result<Option<DailySummary>, EstimateError> {
        DailySpendEstimator::current(self, currency)
    }

    fn timezone_name(&self) -> &str {
        self.timezone.name()
    }
}

/// Summarize samples that belong to one platform, connection, currency and day.
///
/// Pure: it takes observations and returns the day's estimate without touching
/// any store, which is what the fixtures and the restart path are checked
/// against. Samples that do not match the key or the day are ignored, so a store
/// returning extra rows cannot leak another currency, connection or day into the
/// estimate.
///
/// Only positive decreases between adjacent samples count as spend; an increase
/// is an adjustment boundary and never a negative spend. `None` means no sample
/// matched, i.e. there is nothing to estimate — never a zero estimate.
pub fn summarize_day(
    timezone: &Timezone,
    key: &BalanceKey,
    local_day: &str,
    observations: &[BalanceObservation],
) -> Result<Option<DailySummary>, EstimateError> {
    let mut matching: Vec<&BalanceObservation> = observations
        .iter()
        .filter(|sample| {
            sample.provider == key.provider
                && sample.connection == key.connection
                && sample.currency == key.currency
                && sample.local_day == local_day
        })
        .collect();
    // Stable sort: samples sharing an instant keep their stored order.
    matching.sort_by(|left, right| left.observed_at.cmp(&right.observed_at));

    let Some(first) = matching.first() else {
        return Ok(None);
    };

    let mut estimated_spend = Money::ZERO;
    let mut adjustment_count: u32 = 0;
    for pair in matching.windows(2) {
        let Some([previous, current]) = pair.first_chunk::<2>() else {
            continue;
        };
        let decrease = previous
            .total
            .checked_sub(current.total)
            .ok_or(EstimateError::OutOfRange)?;
        if decrease.is_positive() {
            estimated_spend = estimated_spend
                .checked_add(decrease)
                .ok_or(EstimateError::OutOfRange)?;
        }
        if decrease.is_negative() || current.adjustment {
            adjustment_count = adjustment_count.saturating_add(1);
        }
    }

    Ok(Some(DailySummary {
        provider: key.provider,
        connection: key.connection.clone(),
        currency: key.currency.clone(),
        local_day: local_day.to_string(),
        estimated_spend,
        adjustment_count,
        partial: !timezone.is_local_midnight(first.observed_at.to_datetime()),
    }))
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct MemoryState {
    observations: Vec<BalanceObservation>,
    summaries: Vec<DailySummary>,
}

/// In-memory [`BalanceStore`] for tests and previews.
///
/// Cloning a handle shares the same data, so a test can hand one store to two
/// estimators (two connections, two currencies, a restart) and still inspect
/// what was written. The desktop service uses its SQLite store instead.
///
/// The `BalanceStore` methods report a poisoned lock as a [`StoreError`]; the
/// inspection helpers ([`MemoryBalanceStore::observations`],
/// [`MemoryBalanceStore::summaries`], [`MemoryBalanceStore::summary`],
/// [`MemoryBalanceStore::day`]) return an empty result instead, since a poisoned
/// lock means a test already panicked while holding it.
#[derive(Debug, Clone, Default)]
pub struct MemoryBalanceStore {
    state: Arc<Mutex<MemoryState>>,
}

impl MemoryBalanceStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn with_state<T>(&self, read: impl FnOnce(&MemoryState) -> T) -> Result<T, StoreError> {
        let state = self
            .state
            .lock()
            .map_err(|_| StoreError::new("the in-memory balance store lock is poisoned"))?;
        Ok(read(&state))
    }

    fn with_state_mut<T>(
        &self,
        write: impl FnOnce(&mut MemoryState) -> T,
    ) -> Result<T, StoreError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| StoreError::new("the in-memory balance store lock is poisoned"))?;
        Ok(write(&mut state))
    }

    /// Every stored sample, in insertion order.
    pub fn observations(&self) -> Vec<BalanceObservation> {
        self.with_state(|state| state.observations.clone())
            .unwrap_or_default()
    }

    /// Every stored summary, in insertion order.
    pub fn summaries(&self) -> Vec<DailySummary> {
        self.with_state(|state| state.summaries.clone())
            .unwrap_or_default()
    }

    /// The stored summary of one day, if it was settled.
    pub fn summary(&self, key: &BalanceKey, local_day: &str) -> Option<DailySummary> {
        self.with_state(|state| {
            state
                .summaries
                .iter()
                .find(|summary| {
                    summary.provider == key.provider
                        && summary.connection == key.connection
                        && summary.currency == key.currency
                        && summary.local_day == local_day
                })
                .cloned()
        })
        .ok()
        .flatten()
    }

    /// The stored samples of one day, oldest first.
    pub fn day(&self, key: &BalanceKey, local_day: &str) -> Vec<BalanceObservation> {
        let mut samples: Vec<BalanceObservation> = self
            .with_state(|state| {
                state
                    .observations
                    .iter()
                    .filter(|sample| {
                        sample.provider == key.provider
                            && sample.connection == key.connection
                            && sample.currency == key.currency
                            && sample.local_day == local_day
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        samples.sort_by(|left, right| left.observed_at.cmp(&right.observed_at));
        samples
    }
}

impl BalanceStore for MemoryBalanceStore {
    fn latest(&self, key: &BalanceKey) -> Result<Option<BalanceObservation>, StoreError> {
        self.with_state(|state| {
            let mut latest: Option<&BalanceObservation> = None;
            for sample in &state.observations {
                if sample.provider != key.provider
                    || sample.connection != key.connection
                    || sample.currency != key.currency
                {
                    continue;
                }
                let newer = latest
                    .map(|current| sample.observed_at >= current.observed_at)
                    .unwrap_or(true);
                if newer {
                    latest = Some(sample);
                }
            }
            latest.cloned()
        })
    }

    fn list_day(
        &self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Vec<BalanceObservation>, StoreError> {
        Ok(self.day(key, local_day))
    }

    fn insert(&mut self, observation: BalanceObservation) -> Result<(), StoreError> {
        self.with_state_mut(|state| state.observations.push(observation))
    }

    fn save_summary(&mut self, summary: DailySummary) -> Result<(), StoreError> {
        self.with_state_mut(|state| {
            let existing = state.summaries.iter_mut().find(|stored| {
                stored.provider == summary.provider
                    && stored.connection == summary.connection
                    && stored.currency == summary.currency
                    && stored.local_day == summary.local_day
            });
            match existing {
                Some(stored) => *stored = summary,
                None => state.summaries.push(summary),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instant(raw: &str) -> IsoTimestamp {
        IsoTimestamp::parse(raw).expect("timestamp must parse")
    }

    #[test]
    fn money_parses_exactly_and_round_trips() {
        assert_eq!(
            Money::parse("86.42").expect("money").micro_units(),
            86_420_000
        );
        assert_eq!(Money::parse("0.00").expect("money"), Money::ZERO);
        assert_eq!(Money::parse("86.42").expect("money").to_string(), "86.42");
        assert_eq!(Money::parse("007").expect("money").to_string(), "7");
        assert_eq!(Money::parse("1.0").expect("money").to_string(), "1");
        assert_eq!(Money::parse("12").expect("money").to_f64(), 12.0);
        assert_eq!(
            serde_json::to_value(Money::parse("86.42").expect("money")).expect("serialize"),
            serde_json::json!("86.42")
        );
        assert_eq!(
            serde_json::from_value::<Money>(serde_json::json!("86.42")).expect("deserialize"),
            Money::parse("86.42").expect("money")
        );
    }

    #[test]
    fn money_rejects_anything_it_cannot_hold_exactly() {
        for invalid in [
            "", "-1", "+1", "1.2.3", ".5", "1e3", " 1", "1 ", "abc", "1.",
        ] {
            assert!(
                Money::parse(invalid).is_err(),
                "{invalid:?} must be rejected"
            );
        }
        assert_eq!(
            Money::parse("1.1234567"),
            Err(MoneyError::TooManyFractionDigits)
        );
        assert_eq!(
            Money::parse("99999999999999999999"),
            Err(MoneyError::OutOfRange)
        );
    }

    #[test]
    fn money_addition_has_no_binary_rounding_error() {
        let sum = Money::parse("0.1")
            .expect("money")
            .checked_add(Money::parse("0.2").expect("money"))
            .expect("no overflow");
        assert_eq!(sum.to_string(), "0.3");
        assert_eq!(sum.to_f64(), 0.3);
        assert_eq!(Money::ZERO.to_string(), "0");
        assert_eq!(Money::from_micro_units(-1_500_000).to_string(), "-1.5");
    }

    #[test]
    fn timezone_resolves_the_configured_name() {
        assert_eq!(
            Timezone::parse("Asia/Shanghai").expect("zone").name(),
            "Asia/Shanghai"
        );
        assert_eq!(Timezone::parse("utc").expect("zone").name(), "UTC");
        assert_eq!(Timezone::parse("utc").expect("zone"), Timezone::utc());
        assert_eq!(Timezone::parse("  "), Err(TimezoneError::Empty));
        assert!(matches!(
            Timezone::parse("Mars/Olympus"),
            Err(TimezoneError::Unknown(_))
        ));
    }

    #[test]
    fn local_days_match_the_shared_timezone_boundaries() {
        let shanghai = Timezone::parse("Asia/Shanghai").expect("zone");
        assert_eq!(
            shanghai.local_day(instant("2026-09-10T15:59:00.000Z").to_datetime()),
            "2026-09-10"
        );
        assert_eq!(
            shanghai.local_day(instant("2026-09-10T16:01:00.000Z").to_datetime()),
            "2026-09-11"
        );
        assert_eq!(
            shanghai
                .local_midnight("2026-09-10")
                .expect("midnight")
                .as_str(),
            "2026-09-09T16:00:00.000Z"
        );
        // UTC keeps its own day boundary for the very same instant.
        assert_eq!(
            Timezone::utc().local_day(instant("2026-09-10T16:01:00.000Z").to_datetime()),
            "2026-09-10"
        );
        assert!(shanghai.local_midnight("2026-9-10").is_none());
        assert!(shanghai.local_midnight("not-a-day").is_none());
    }

    #[test]
    fn local_midnight_is_recognized_to_the_second() {
        let shanghai = Timezone::parse("Asia/Shanghai").expect("zone");
        assert!(shanghai.is_local_midnight(instant("2026-09-09T16:00:00.000Z").to_datetime()));
        assert!(!shanghai.is_local_midnight(instant("2026-09-09T16:00:01.000Z").to_datetime()));
        assert!(!shanghai.is_local_midnight(instant("2026-09-10T04:00:00.000Z").to_datetime()));
        let noon = shanghai.local_parts(instant("2026-09-10T04:00:00.000Z").to_datetime());
        assert_eq!(noon.day, "2026-09-10");
        assert_eq!((noon.hour, noon.minute, noon.second), (12, 0, 0));
        assert!(!noon.is_midnight());
    }
}

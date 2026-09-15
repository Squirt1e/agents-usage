//! Serializable contracts shared with the TypeScript client.
//!
//! The canonical TypeScript definitions live in `src/shared/contracts.ts`. The
//! Rust side must serialize to the same field names, enum spellings and optional
//! value semantics; `docs/desktop/semantic-map.md` records the mapping and the
//! fixtures under `fixtures/contracts/` pin it for both runtimes.
//!
//! One rule matters more than the rest: **a missing value stays missing**. An
//! absent percentage, balance or token count is [`MetricValue::Null`] with the
//! `unavailable` confidence, never a zero. Only values the platform actually
//! reported as zero are rendered as zero.

use std::collections::BTreeMap;
use std::fmt;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Provider identifiers supported by the collectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Codex,
    Glm,
    Deepseek,
}

impl ProviderId {
    pub const ALL: [ProviderId; 3] = [ProviderId::Codex, ProviderId::Glm, ProviderId::Deepseek];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Codex => "codex",
            ProviderId::Glm => "glm",
            ProviderId::Deepseek => "deepseek",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ProviderId::Codex => "Codex",
            ProviderId::Glm => "GLM",
            ProviderId::Deepseek => "DeepSeek",
        }
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// How much trust a value deserves. Spelled exactly as in the TypeScript enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Authoritative,
    Experimental,
    Estimated,
    Partial,
    Stale,
    Unavailable,
}

/// What a metric measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricDirection {
    #[default]
    Used,
    Remaining,
    Balance,
    Spend,
    Activity,
}

/// Health of one connection or provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    Connected,
    Degraded,
    Disconnected,
    Unavailable,
}

/// Failure vocabulary shared with the old runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    MissingConfig,
    Authentication,
    Compatibility,
    Network,
    RateLimit,
    Process,
    Storage,
    Unknown,
}

impl ErrorKind {
    /// Stable spelling used by the fixtures and the shared vocabulary test.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::MissingConfig => "missing_config",
            ErrorKind::Authentication => "authentication",
            ErrorKind::Compatibility => "compatibility",
            ErrorKind::Network => "network",
            ErrorKind::RateLimit => "rate_limit",
            ErrorKind::Process => "process",
            ErrorKind::Storage => "storage",
            ErrorKind::Unknown => "unknown",
        }
    }
}

/// One collection channel. The GLM wallet is the only experimental channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectorChannel {
    Stable,
    Experimental,
}

/// Which connection inside a provider produced a value.
///
/// GLM runs a Coding Plan quota connection and a separate experimental wallet
/// connection. They are validated, cached and reported independently, so the
/// connection identity travels with every snapshot and metric instead of being
/// encoded in a `source` string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionId {
    pub provider: ProviderId,
    /// Stable machine identifier, e.g. `quota`, `wallet`, `account`.
    pub connection: String,
    /// Human readable label used by the panel when a provider has more than one
    /// connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl ConnectionId {
    pub fn new(provider: ProviderId, connection: impl Into<String>) -> Self {
        Self {
            provider,
            connection: connection.into(),
            label: None,
        }
    }

    pub fn with_label(
        provider: ProviderId,
        connection: impl Into<String>,
        label: impl Into<String>,
    ) -> Self {
        Self {
            provider,
            connection: connection.into(),
            label: Some(label.into()),
        }
    }

    pub fn key(&self) -> String {
        format!("{}:{}", self.provider.as_str(), self.connection)
    }
}

/// An ISO-8601 timestamp carrying milliseconds and a UTC designator.
///
/// Serializes to the same shape as the TypeScript implementation
/// (`2026-09-10T00:26:40.000Z`) so a stored snapshot can be compared across
/// runtimes, and validates on the way in so an unparsable timestamp fails
/// loudly instead of silently becoming "now".
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IsoTimestamp(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid ISO-8601 timestamp: {0}")]
pub struct TimestampError(String);

impl IsoTimestamp {
    pub fn parse(value: &str) -> Result<Self, TimestampError> {
        let parsed = DateTime::parse_from_rfc3339(value)
            .map_err(|error| TimestampError(error.to_string()))?;
        Ok(Self(format_utc(parsed.with_timezone(&Utc))))
    }

    pub fn from_datetime(value: DateTime<Utc>) -> Self {
        Self(format_utc(value))
    }

    pub fn from_unix_seconds(seconds: i64) -> Self {
        Self::from_unix_millis(seconds.saturating_mul(1_000))
    }

    pub fn from_unix_millis(millis: i64) -> Self {
        let instant = DateTime::<Utc>::from_timestamp_millis(millis).unwrap_or_else(Utc::now);
        Self::from_datetime(instant)
    }

    pub fn now() -> Self {
        Self::from_datetime(Utc::now())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn to_datetime(&self) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(&self.0)
            .expect("IsoTimestamp always holds a validated timestamp")
            .with_timezone(&Utc)
    }
}

fn format_utc(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl fmt::Display for IsoTimestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for IsoTimestamp {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for IsoTimestamp {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        IsoTimestamp::parse(&raw).map_err(serde::de::Error::custom)
    }
}

/// A metric value is a finite number, a short display string, or absent.
///
/// Absence is deliberately distinct from zero.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MetricValue {
    Number(f64),
    Text(String),
    Null,
}

impl MetricValue {
    pub fn is_missing(&self) -> bool {
        matches!(self, MetricValue::Null)
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            MetricValue::Number(number) => Some(*number),
            _ => None,
        }
    }

    /// Render the value the way the panel does, without inventing data.
    pub fn display(&self) -> String {
        match self {
            MetricValue::Number(number) => number.to_string(),
            MetricValue::Text(text) => text.clone(),
            MetricValue::Null => String::new(),
        }
    }
}

impl From<Option<f64>> for MetricValue {
    fn from(value: Option<f64>) -> Self {
        value.map_or(MetricValue::Null, MetricValue::Number)
    }
}

/// Whether a metric is backed by a real source.
///
/// The panel uses this to decide whether to render the metric at all: metrics
/// whose capability is [`MetricCapability::Unsupported`] or
/// [`MetricCapability::Unknown`] are hidden rather than shown as unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricCapability {
    Supported,
    Unsupported,
    Unknown,
}

/// Which statistics window a metric belongs to.
///
/// Carries the local date, the timezone it was computed in and the range the
/// source confirmed, so "today" is never inferred from a rolling window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticScope {
    /// Local date in the configured timezone, `YYYY-MM-DD`.
    pub local_day: String,
    /// IANA timezone the local day was computed in.
    pub timezone: String,
    /// Inclusive start of the queried range.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_start: Option<IsoTimestamp>,
    /// Exclusive or inclusive end of the queried range, as confirmed by source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_end: Option<IsoTimestamp>,
    /// True only when the source confirmed that the range matches `local_day`.
    pub range_confirmed: bool,
}

/// A single reported value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageMetric {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub value: MetricValue,
    pub unit: String,
    pub direction: MetricDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<IsoTimestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_seconds: Option<u64>,
    pub confidence: Vec<Confidence>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
    /// Which connection produced the value, when more than one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionId>,
    /// Whether the source can provide this metric at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<MetricCapability>,
    /// Date and range the metric was computed for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<StatisticScope>,
}

/// Input for [`UsageMetric::normalize`].
#[derive(Debug, Clone, Default)]
pub struct MetricInput {
    pub key: String,
    pub label: Option<String>,
    pub value: Option<MetricValue>,
    pub unit: String,
    pub direction: MetricDirection,
    pub limit: Option<f64>,
    pub reset_at: Option<IsoTimestamp>,
    pub window_seconds: Option<u64>,
    pub confidence: Option<Vec<Confidence>>,
    pub source: String,
    pub details: Option<Map<String, Value>>,
    pub connection: Option<ConnectionId>,
    pub capability: Option<MetricCapability>,
    pub scope: Option<StatisticScope>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ContractError {
    #[error("metric key must not be empty")]
    EmptyKey,
    #[error("metric unit must not be empty")]
    EmptyUnit,
    #[error("metric source must not be empty")]
    EmptySource,
    #[error("percentage must be between 0 and 100")]
    PercentageOutOfRange,
    #[error("metric value must be finite")]
    NonFiniteValue,
    #[error("confidence must contain at least one entry")]
    EmptyConfidence,
}

impl UsageMetric {
    /// Build a metric, applying the same rules as the TypeScript
    /// `normalizeMetric`: an absent value becomes `null` plus the `unavailable`
    /// confidence, and the default confidence is `authoritative`.
    pub fn normalize(input: MetricInput) -> Result<Self, ContractError> {
        let mut confidence = input
            .confidence
            .unwrap_or_else(|| vec![Confidence::Authoritative]);
        if confidence.is_empty() {
            return Err(ContractError::EmptyConfidence);
        }
        let value = input.value.unwrap_or(MetricValue::Null);
        if value.is_missing() && !confidence.contains(&Confidence::Unavailable) {
            confidence.push(Confidence::Unavailable);
        }

        let metric = Self {
            key: input.key,
            label: input.label,
            value,
            unit: input.unit,
            direction: input.direction,
            limit: input.limit,
            reset_at: input.reset_at,
            window_seconds: input.window_seconds,
            confidence,
            source: input.source,
            details: input.details,
            connection: input.connection,
            capability: input.capability,
            scope: input.scope,
        };
        metric.validate()?;
        Ok(metric)
    }

    /// Reject values the contract does not allow.
    ///
    /// Mirrors the TypeScript schema: non-empty key/unit/source, finite numbers,
    /// and percentages inside `0..=100`.
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.key.trim().is_empty() {
            return Err(ContractError::EmptyKey);
        }
        if self.unit.trim().is_empty() {
            return Err(ContractError::EmptyUnit);
        }
        if self.source.trim().is_empty() {
            return Err(ContractError::EmptySource);
        }
        if self.confidence.is_empty() {
            return Err(ContractError::EmptyConfidence);
        }
        if let MetricValue::Number(number) = self.value {
            if !number.is_finite() {
                return Err(ContractError::NonFiniteValue);
            }
            if self.unit == "percent" && !(0.0..=100.0).contains(&number) {
                return Err(ContractError::PercentageOutOfRange);
            }
        }
        Ok(())
    }

    /// True when the value is absent and must not be rendered as a number.
    pub fn is_missing(&self) -> bool {
        self.value.is_missing()
    }

    pub fn has_confidence(&self, confidence: Confidence) -> bool {
        self.confidence.contains(&confidence)
    }

    /// Rebuild the metric with an extra confidence flag, used when marking
    /// cached values stale.
    pub fn with_confidence(mut self, confidence: Confidence) -> Self {
        if !self.confidence.contains(&confidence) {
            self.confidence.push(confidence);
        }
        self
    }
}

/// A failure reported by a collector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorError {
    pub kind: ErrorKind,
    pub message: String,
    pub at: IsoTimestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<IsoTimestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<Map<String, Value>>,
    /// Field-preserving escape hatch so a newer producer cannot break parsing.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl CollectorError {
    pub fn new(kind: ErrorKind, message: impl Into<String>, at: IsoTimestamp) -> Self {
        Self {
            kind,
            message: message.into(),
            at,
            retry_at: None,
            diagnostic: None,
            extra: Map::new(),
        }
    }

    pub fn with_retry_at(mut self, retry_at: IsoTimestamp) -> Self {
        self.retry_at = Some(retry_at);
        self
    }

    pub fn with_diagnostic(mut self, diagnostic: Map<String, Value>) -> Self {
        self.diagnostic = Some(diagnostic);
        self
    }
}

/// The latest normalized state of one connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub provider: ProviderId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionId>,
    pub status: ConnectionStatus,
    pub captured_at: IsoTimestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<IsoTimestamp>,
    pub source: String,
    pub metrics: Vec<UsageMetric>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CollectorError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ProviderSnapshot {
    /// A snapshot for a provider/connection that has no usable data yet.
    ///
    /// Missing configuration and rejected credentials mean the connection is not
    /// established (`disconnected`); everything else is `unavailable`. Both keep
    /// an empty metric list instead of fabricating zeros.
    pub fn unavailable(
        provider: ProviderId,
        source: impl Into<String>,
        error: CollectorError,
    ) -> Self {
        let status = match error.kind {
            ErrorKind::MissingConfig | ErrorKind::Authentication => ConnectionStatus::Disconnected,
            _ => ConnectionStatus::Unavailable,
        };
        Self {
            provider,
            connection: None,
            status,
            captured_at: error.at.clone(),
            last_success_at: None,
            source: source.into(),
            metrics: Vec::new(),
            error: Some(error),
            diagnostic: None,
            extra: Map::new(),
        }
    }

    /// Mark a cached snapshot as stale after a failure, preserving the original
    /// capture and last-success times.
    pub fn mark_stale(&self, error: CollectorError) -> Self {
        Self {
            status: ConnectionStatus::Degraded,
            error: Some(error),
            metrics: self
                .metrics
                .iter()
                .cloned()
                .map(|metric| metric.with_confidence(Confidence::Stale))
                .collect(),
            ..self.clone()
        }
    }

    pub fn metric(&self, key: &str) -> Option<&UsageMetric> {
        self.metrics.iter().find(|metric| metric.key == key)
    }

    /// True when the snapshot carries usable data.
    pub fn has_data(&self) -> bool {
        !self.metrics.is_empty() && self.error.is_none()
    }
}

/// Provider state as returned to the front end: the cache plus the last error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderState {
    pub provider: ProviderId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<ProviderSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CollectorError>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub connections: Vec<ConnectionId>,
}

/// Non-sensitive settings persisted by the service.
///
/// Secrets never appear here: they live in the macOS Keychain.
///
/// Deserialization is field-tolerant (`default`): a settings record written by
/// an older build stays loadable when a new field is added, and a partially
/// written record falls back to the documented defaults instead of failing the
/// whole service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSettings {
    pub theme: ThemePreference,
    pub timezone: String,
    pub glm_region: GlmRegion,
    /// Whether the GLM wallet connection is enabled at all. One switch: on means
    /// the connection collects *and* its module shows on the card, off means both
    /// stop. Revoking the stored credential is an explicit deletion, never a side
    /// effect of this flag.
    pub glm_wallet_enabled: bool,
    /// Whether the experimental DeepSeek web usage connection is enabled at
    /// all. Off by default: the collector must never touch the console
    /// endpoints without an explicit opt-in.
    pub deepseek_web_enabled: bool,
    /// Platform visibility, independent from connection state.
    pub platform_visibility: BTreeMap<ProviderId, bool>,
    /// Absolute path to the Codex CLI, needed when launched from Finder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_cli_path: Option<String>,
    /// Display order of the platform cards.
    pub platform_order: Vec<ProviderId>,
    /// How each provider card's reset lines are rendered. Clicking a card's
    /// reset line flips the whole card; cards never affect each other.
    pub codex_reset_format: ResetTimeFormat,
    pub glm_reset_format: ResetTimeFormat,
    /// Quota visualization selected independently for Codex and GLM.
    pub codex_quota_display: QuotaDisplayMode,
    pub glm_quota_display: QuotaDisplayMode,
    /// Whether every quota card presents remaining or used percentage.
    pub quota_value_mode: QuotaValueMode,
    /// Per-provider peak/off-peak reminder settings. Absent means "use the
    /// builtin table if one exists"; the builtin tables and the period
    /// judgement live in the panel, this only persists the choice. A stored
    /// value that cannot be trusted degrades to absent instead of failing the
    /// record, matching how the panel's own parser treats it.
    #[serde(default, deserialize_with = "deserialize_peak_reminder", skip_serializing_if = "Option::is_none")]
    pub peak_reminder: Option<BTreeMap<ProviderId, PeakReminderSetting>>,
}

/// Panel appearance. Older settings retain the original dark appearance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    Light,
    #[default]
    Dark,
    System,
}

/// Visual treatment used for quota windows in the compact panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuotaDisplayMode {
    #[default]
    Ring,
    Bar,
}

/// Percentage meaning shown by a quota card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuotaValueMode {
    #[default]
    Remaining,
    Used,
}

/// Reset-time presentation chosen by the user.
///
/// `Countdown` counts down in the units of the window (hours/minutes for a
/// five-hour window, days/hours for a weekly one); `Absolute` shows the reset
/// clock (`HH:mm`) or date (`MM月DD日`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetTimeFormat {
    #[default]
    Countdown,
    Absolute,
}

/// How one provider's period reminder is sourced: the shipped official table,
/// a user schedule, or off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeakReminderMode {
    Builtin,
    Custom,
    Off,
}

/// One weekly period window. `weekdays` are ISO (1 = Monday … 7 = Sunday);
/// `start` is inclusive, `end` exclusive, and `start >= end` wraps past
/// midnight into the next day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakWindow {
    pub weekdays: Vec<u8>,
    pub start: String,
    pub end: String,
}

/// The user's reminder choice for one provider, mirroring the panel contract
/// field for field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakReminderSetting {
    pub mode: PeakReminderMode,
    /// The custom schedule; kept while `Off` so switching back restores it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<PeakWindow>,
    /// IANA timezone the windows are evaluated in; required while `Custom`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

fn peak_window_is_valid(window: &PeakWindow) -> bool {
    let weekdays_ok = !window.weekdays.is_empty()
        && window.weekdays.iter().all(|day| (1..=7).contains(day));
    let times_ok = is_hh_mm(&window.start) && is_hh_mm(&window.end) && window.start != window.end;
    weekdays_ok && times_ok
}

fn is_hh_mm(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let (hours, minutes) = value.split_at(2);
    let minutes = &minutes[1..];
    let hours: u8 = match hours.parse() {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    let minutes: u8 = match minutes.parse() {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    hours <= 23 && minutes <= 59
}

/// Parse the reminder map the way the panel parses it. A provider entry whose
/// shape or values cannot be trusted is dropped whole — the panel falls back to
/// its builtin table for it — and the rest of the settings record is never
/// failed by this field. Windows and timezone ride along on `Builtin`/`Off`
/// entries when valid: they are inert there, but dropping them would erase the
/// user's schedule on a later save.
pub fn peak_reminder_from_value(
    raw: &serde_json::Value,
) -> Option<BTreeMap<ProviderId, PeakReminderSetting>> {
    let map = raw.as_object()?;
    let mut parsed = BTreeMap::new();
    for (key, entry) in map {
        let Some(provider) = ProviderId::ALL.iter().find(|id| id.as_str() == key) else {
            continue;
        };
        let Some(setting) = entry.as_object() else {
            continue;
        };
        let Some(mode) = setting.get("mode").and_then(|mode| mode.as_str()) else {
            continue;
        };
        let Some(mode) = (match mode {
            "builtin" => Some(PeakReminderMode::Builtin),
            "custom" => Some(PeakReminderMode::Custom),
            "off" => Some(PeakReminderMode::Off),
            _ => None,
        }) else {
            continue;
        };
        let windows: Vec<PeakWindow> = setting
            .get("windows")
            .and_then(|windows| windows.as_array())
            .map(|windows| {
                windows
                    .iter()
                    .filter_map(|window| {
                        let weekdays: Vec<u8> = window
                            .get("weekdays")
                            .and_then(|days| days.as_array())
                            .map(|days| {
                                days.iter()
                                    .filter_map(|day| day.as_u64().map(|day| day as u8))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let start = window.get("start").and_then(|value| value.as_str());
                        let end = window.get("end").and_then(|value| value.as_str());
                        let window = PeakWindow {
                            weekdays,
                            start: start.unwrap_or_default().to_string(),
                            end: end.unwrap_or_default().to_string(),
                        };
                        peak_window_is_valid(&window).then_some(window)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let timezone = setting
            .get("timezone")
            .and_then(|value| value.as_str())
            .filter(|value| crate::estimate::Timezone::parse(value).is_ok())
            .map(|value| value.to_string());
        if mode == PeakReminderMode::Custom && (windows.is_empty() || timezone.is_none()) {
            continue;
        }
        parsed.insert(*provider, PeakReminderSetting { mode, windows, timezone });
    }
    (!parsed.is_empty()).then_some(parsed)
}

/// Field-level deserializer: any unparsable stored value becomes `None`
/// ("not customized") instead of failing the whole settings record.
fn deserialize_peak_reminder<'de, D>(deserializer: D) -> Result<Option<BTreeMap<ProviderId, PeakReminderSetting>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw.as_ref().and_then(peak_reminder_from_value))
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::Dark,
            timezone: "UTC".to_string(),
            glm_region: GlmRegion::China,
            glm_wallet_enabled: false,
            deepseek_web_enabled: false,
            platform_visibility: ProviderId::ALL
                .iter()
                .map(|provider| (*provider, true))
                .collect(),
            codex_cli_path: None,
            platform_order: ProviderId::ALL.to_vec(),
            codex_reset_format: ResetTimeFormat::Countdown,
            glm_reset_format: ResetTimeFormat::Countdown,
            codex_quota_display: QuotaDisplayMode::Ring,
            glm_quota_display: QuotaDisplayMode::Ring,
            quota_value_mode: QuotaValueMode::Remaining,
            peak_reminder: None,
        }
    }
}

/// GLM deployment region selects the provider-owned base domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlmRegion {
    China,
    International,
}

impl GlmRegion {
    pub fn base_domain(self) -> &'static str {
        match self {
            GlmRegion::China => "https://open.bigmodel.cn",
            GlmRegion::International => "https://api.z.ai",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_value_is_not_zero() {
        let metric = UsageMetric::normalize(MetricInput {
            key: "quota.5h.used".into(),
            unit: "percent".into(),
            direction: MetricDirection::Used,
            value: None,
            source: "glm-monitor".into(),
            ..MetricInput::default()
        })
        .expect("metric must normalize");

        assert!(metric.value.is_missing());
        // Matches the TypeScript behaviour: the default confidence stays and
        // `unavailable` is appended, so the panel can tell a missing value from
        // a real zero while still knowing which source failed to supply it.
        assert!(metric.has_confidence(Confidence::Unavailable));
        assert!(metric.has_confidence(Confidence::Authoritative));
        assert_eq!(serde_json::to_string(&metric.value).unwrap(), "null");
    }

    #[test]
    fn reliable_zero_is_kept() {
        let metric = UsageMetric::normalize(MetricInput {
            key: "wallet.CNY.granted".into(),
            unit: "CNY".into(),
            direction: MetricDirection::Balance,
            value: Some(MetricValue::Number(0.0)),
            source: "deepseek-balance".into(),
            ..MetricInput::default()
        })
        .expect("metric must normalize");

        assert!(!metric.is_missing());
        assert_eq!(metric.value.as_number(), Some(0.0));
        assert!(!metric.has_confidence(Confidence::Unavailable));
    }

    #[test]
    fn percentages_outside_the_range_are_rejected() {
        let error = UsageMetric::normalize(MetricInput {
            key: "quota.5h.used".into(),
            unit: "percent".into(),
            direction: MetricDirection::Used,
            value: Some(MetricValue::Number(120.0)),
            source: "glm-monitor".into(),
            ..MetricInput::default()
        })
        .expect_err("out-of-range percentage must fail");
        assert_eq!(error, ContractError::PercentageOutOfRange);
        assert!(error.to_string().contains("percentage"));
    }

    #[test]
    fn timestamps_normalize_to_utc_milliseconds() {
        let parsed = IsoTimestamp::parse("2026-09-10T08:00:00+08:00").unwrap();
        assert_eq!(parsed.as_str(), "2026-09-10T00:00:00.000Z");
        assert_eq!(
            IsoTimestamp::from_unix_seconds(1_789_000_000).as_str(),
            "2026-09-10T00:26:40.000Z"
        );
        assert_eq!(
            IsoTimestamp::from_unix_millis(1_789_000_000_000).as_str(),
            "2026-09-10T00:26:40.000Z"
        );
        assert!(IsoTimestamp::parse("yesterday").is_err());
    }

    #[test]
    fn stale_snapshot_keeps_original_times_and_values() {
        let captured = IsoTimestamp::parse("2026-09-10T07:30:00.000Z").unwrap();
        let snapshot = ProviderSnapshot {
            provider: ProviderId::Glm,
            connection: Some(ConnectionId::with_label(ProviderId::Glm, "quota", "套餐")),
            status: ConnectionStatus::Connected,
            captured_at: captured.clone(),
            last_success_at: Some(captured.clone()),
            source: "glm-monitor".into(),
            metrics: vec![UsageMetric::normalize(MetricInput {
                key: "quota.5h.used".into(),
                unit: "percent".into(),
                direction: MetricDirection::Used,
                value: Some(MetricValue::Number(28.0)),
                source: "glm-monitor".into(),
                ..MetricInput::default()
            })
            .unwrap()],
            error: None,
            diagnostic: None,
            extra: Map::new(),
        };

        let stale = snapshot.mark_stale(CollectorError::new(
            ErrorKind::Network,
            "refresh failed",
            IsoTimestamp::parse("2026-09-10T08:05:00.000Z").unwrap(),
        ));

        assert_eq!(stale.status, ConnectionStatus::Degraded);
        assert_eq!(stale.captured_at, captured);
        assert_eq!(stale.last_success_at, Some(captured));
        assert_eq!(stale.metrics[0].value.as_number(), Some(28.0));
        assert!(stale.metrics[0].has_confidence(Confidence::Stale));
        assert!(stale.metrics[0].has_confidence(Confidence::Authoritative));
    }

    #[test]
    fn snapshot_round_trips_without_inventing_fields() {
        let json = serde_json::json!({
            "provider": "codex",
            "status": "connected",
            "capturedAt": "2026-09-10T00:26:40.000Z",
            "source": "codex-app-server",
            "metrics": [],
            "futureField": "kept"
        });
        let snapshot: ProviderSnapshot = serde_json::from_value(json).expect("snapshot must parse");
        assert_eq!(
            snapshot.extra.get("futureField"),
            Some(&Value::String("kept".into()))
        );
        let encoded = serde_json::to_value(&snapshot).expect("snapshot must serialize");
        assert_eq!(
            encoded["capturedAt"],
            serde_json::json!("2026-09-10T00:26:40.000Z")
        );
        assert_eq!(encoded["futureField"], serde_json::json!("kept"));
        assert!(encoded.get("connection").is_none());
    }

    #[test]
    fn connection_identity_is_stable() {
        let quota = ConnectionId::with_label(ProviderId::Glm, "quota", "Coding Plan");
        let wallet = ConnectionId::with_label(ProviderId::Glm, "wallet", "钱包");
        assert_eq!(quota.key(), "glm:quota");
        assert_eq!(wallet.key(), "glm:wallet");
        assert_ne!(quota.key(), wallet.key());
    }

    #[test]
    fn settings_written_by_an_older_build_still_load() {
        // A record from before the per-window reset formats and quota display
        // modes existed must keep loading with their documented defaults, and the
        // retired `glmWalletVisible` flag of the two-switch wallet model must load
        // as the ignored key it now is rather than failing the whole record.
        let legacy = serde_json::json!({
            "timezone": "Asia/Shanghai",
            "glmRegion": "international",
            "glmWalletEnabled": true,
            "glmWalletVisible": false,
            "platformVisibility": { "codex": true, "glm": false, "deepseek": true },
            "platformOrder": ["codex", "glm", "deepseek"],
            "resetTimeFormat": "absolute"
        });
        let settings: DesktopSettings =
            serde_json::from_value(legacy).expect("legacy settings must load");
        assert_eq!(settings.timezone, "Asia/Shanghai");
        assert_eq!(settings.glm_region, GlmRegion::International);
        assert!(settings.glm_wallet_enabled);
        assert_eq!(settings.codex_cli_path, None);
        assert_eq!(settings.codex_reset_format, ResetTimeFormat::Countdown);
        assert_eq!(settings.glm_reset_format, ResetTimeFormat::Countdown);
        assert_eq!(settings.codex_quota_display, QuotaDisplayMode::Ring);
        assert_eq!(settings.glm_quota_display, QuotaDisplayMode::Ring);
        assert_eq!(settings.quota_value_mode, QuotaValueMode::Remaining);

        // The new values round-trip as the lowercase wire spelling the panel
        // uses, with one setting shared by every quota card.
        let updated = DesktopSettings {
            codex_reset_format: ResetTimeFormat::Absolute,
            glm_quota_display: QuotaDisplayMode::Bar,
            quota_value_mode: QuotaValueMode::Used,
            ..settings
        };
        let encoded = serde_json::to_value(&updated).expect("settings must serialize");
        assert_eq!(
            encoded["codexResetFormat"],
            serde_json::json!("absolute")
        );
        assert_eq!(encoded["glmResetFormat"], serde_json::json!("countdown"));
        assert_eq!(encoded["codexQuotaDisplay"], serde_json::json!("ring"));
        assert_eq!(encoded["glmQuotaDisplay"], serde_json::json!("bar"));
        assert_eq!(encoded["quotaValueMode"], serde_json::json!("used"));
    }

    #[test]
    fn settings_without_peak_reminder_stay_unset() {
        // A record written before the reminder existed must not gain one.
        let legacy = serde_json::json!({ "timezone": "Asia/Shanghai" });
        let settings: DesktopSettings =
            serde_json::from_value(legacy).expect("legacy settings must load");
        assert_eq!(settings.peak_reminder, None);
        let encoded = serde_json::to_value(&settings).expect("settings must serialize");
        assert!(encoded.get("peakReminder").is_none());
    }

    #[test]
    fn peak_reminder_round_trips_as_the_panel_spelling() {
        let mut peak_reminder = BTreeMap::new();
        peak_reminder.insert(
            ProviderId::Codex,
            PeakReminderSetting {
                mode: PeakReminderMode::Custom,
                windows: vec![PeakWindow {
                    weekdays: vec![1, 2, 3, 4, 5],
                    start: "09:00".to_string(),
                    end: "12:00".to_string(),
                }],
                timezone: Some("UTC".to_string()),
            },
        );
        peak_reminder.insert(
            ProviderId::Deepseek,
            PeakReminderSetting {
                mode: PeakReminderMode::Off,
                windows: Vec::new(),
                timezone: None,
            },
        );
        let settings = DesktopSettings {
            peak_reminder: Some(peak_reminder.clone()),
            ..DesktopSettings::default()
        };
        let encoded = serde_json::to_value(&settings).expect("settings must serialize");
        assert_eq!(encoded["peakReminder"]["codex"]["mode"], serde_json::json!("custom"));
        assert_eq!(
            encoded["peakReminder"]["codex"]["windows"][0]["weekdays"],
            serde_json::json!([1, 2, 3, 4, 5])
        );
        assert_eq!(encoded["peakReminder"]["codex"]["windows"][0]["start"], serde_json::json!("09:00"));
        // The provider the user switched off carries no windows on the wire.
        assert!(encoded["peakReminder"]["deepseek"].get("windows").is_none());

        let decoded: DesktopSettings =
            serde_json::from_value(encoded).expect("settings must load");
        assert_eq!(decoded.peak_reminder, Some(peak_reminder));
    }

    #[test]
    fn peak_reminder_with_unusable_values_degrades_without_failing_the_record() {
        // A broken reminder entry is dropped whole; a well-shaped one survives
        // beside it, and the rest of the record never hears about the problem.
        let raw = serde_json::json!({
            "timezone": "UTC",
            "peakReminder": {
                "codex": { "mode": "sometimes" },
                "glm": { "mode": "custom", "windows": [{ "weekdays": [12], "start": "aa:bb", "end": "11:00" }] },
                "deepseek": { "mode": "off", "windows": [{ "weekdays": [1], "start": "22:00", "end": "01:00" }] }
            }
        });
        let settings: DesktopSettings =
            serde_json::from_value(raw).expect("settings must load");
        let peak_reminder = settings.peak_reminder.expect("valid entries must survive");
        assert_eq!(peak_reminder.len(), 1);
        assert_eq!(peak_reminder[&ProviderId::Deepseek].mode, PeakReminderMode::Off);
        assert_eq!(settings.timezone, "UTC");
    }
}

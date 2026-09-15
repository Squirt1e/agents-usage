//! Transactional SQLite store for the desktop runtime.
//!
//! Only normalized snapshots, connection health, non-sensitive settings and the
//! balance observations needed for daily estimation are persisted. Failed
//! refreshes never overwrite the last successful snapshot: they update the
//! health row, and reads re-attach the error while keeping the original capture
//! and last-success times.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

pub mod data_dir;

use self::data_dir::StorageError;
use crate::contracts::{
    CollectorError, ConnectionId, DesktopSettings, IsoTimestamp, ProviderId, ProviderSnapshot,
    ProviderState,
};
use crate::estimate::{BalanceKey, BalanceObservation, DailySummary, Money};

/// Schema version of the desktop database.
pub const SCHEMA_VERSION: i64 = 1;

/// Recorded health of one connection.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionHealth {
    pub connection: ConnectionId,
    pub last_success_at: Option<IsoTimestamp>,
    pub last_failure_at: Option<IsoTimestamp>,
    pub error: Option<CollectorError>,
    pub consecutive_failures: u32,
}

/// SQLite-backed store.
pub struct Store {
    connection: Connection,
    location: String,
}

impl Store {
    /// Open or create the database at `path` (`:memory:` is supported for tests).
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref();
        let location = path.display().to_string();
        let connection = Connection::open(path)?;
        Self::from_connection(connection, location)
    }

    fn from_connection(connection: Connection, location: String) -> Result<Self, StorageError> {
        // WAL keeps readers (both front ends) off the writer's back and the
        // busy timeout absorbs short write bursts from the scheduler.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let store = Self {
            connection,
            location,
        };
        store.migrate()?;
        Ok(store)
    }

    /// In-memory store for tests and for a deliberately unpersisted run.
    pub fn in_memory() -> Result<Self, StorageError> {
        Self::open(":memory:")
    }

    pub fn location(&self) -> &str {
        &self.location
    }

    fn migrate(&self) -> Result<(), StorageError> {
        self.connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snapshots (
              provider TEXT NOT NULL,
              connection TEXT NOT NULL,
              captured_at TEXT NOT NULL,
              last_success_at TEXT,
              payload TEXT NOT NULL,
              PRIMARY KEY (provider, connection)
            );
            CREATE TABLE IF NOT EXISTS connection_health (
              provider TEXT NOT NULL,
              connection TEXT NOT NULL,
              last_success_at TEXT,
              last_failure_at TEXT,
              error_payload TEXT,
              consecutive_failures INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (provider, connection)
            );
            CREATE TABLE IF NOT EXISTS balance_observations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              provider TEXT NOT NULL,
              connection TEXT NOT NULL,
              currency TEXT NOT NULL,
              total TEXT NOT NULL,
              observed_at TEXT NOT NULL,
              local_day TEXT NOT NULL,
              adjustment INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS balance_observations_lookup
              ON balance_observations(provider, connection, currency, local_day, observed_at);
            CREATE TABLE IF NOT EXISTS daily_summaries (
              provider TEXT NOT NULL,
              connection TEXT NOT NULL,
              currency TEXT NOT NULL,
              local_day TEXT NOT NULL,
              estimated_spend TEXT NOT NULL,
              adjustment_count INTEGER NOT NULL DEFAULT 0,
              partial INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (provider, connection, currency, local_day)
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            "#,
        )?;
        self.connection.execute(
            "INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }

    fn transaction(&mut self) -> Result<rusqlite::Transaction<'_>, StorageError> {
        Ok(self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?)
    }

    /// Persist a successful snapshot and clear the recorded failure.
    ///
    /// The stored `last_success_at` is the collector's value, never "now": a
    /// restart must not disguise itself as a successful collection.
    pub fn save_success(&mut self, snapshot: &ProviderSnapshot) -> Result<(), StorageError> {
        let connection_id = connection_key(snapshot.connection.as_ref(), snapshot.provider);
        let payload = serde_json::to_string(snapshot)
            .map_err(|error| StorageError::Record(error.to_string()))?;
        let last_success = snapshot
            .last_success_at
            .clone()
            .unwrap_or_else(|| snapshot.captured_at.clone());

        let transaction = self.transaction()?;
        transaction.execute(
            "INSERT INTO snapshots(provider, connection, captured_at, last_success_at, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(provider, connection) DO UPDATE SET
               captured_at = excluded.captured_at,
               last_success_at = excluded.last_success_at,
               payload = excluded.payload",
            params![
                snapshot.provider.as_str(),
                connection_id,
                snapshot.captured_at.as_str(),
                last_success.as_str(),
                payload
            ],
        )?;
        transaction.execute(
            "INSERT INTO connection_health(provider, connection, last_success_at, last_failure_at, error_payload, consecutive_failures)
             VALUES (?1, ?2, ?3, NULL, NULL, 0)
             ON CONFLICT(provider, connection) DO UPDATE SET
               last_success_at = excluded.last_success_at,
               last_failure_at = NULL,
               error_payload = NULL,
               consecutive_failures = 0",
            params![snapshot.provider.as_str(), connection_id, last_success.as_str()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Record a failure without touching the cached snapshot.
    pub fn save_failure(
        &mut self,
        provider: ProviderId,
        connection: Option<&ConnectionId>,
        error: &CollectorError,
        consecutive_failures: u32,
    ) -> Result<(), StorageError> {
        let connection_id = connection_key(connection, provider);
        let payload = serde_json::to_string(error)
            .map_err(|error| StorageError::Record(error.to_string()))?;
        let transaction = self.transaction()?;
        transaction.execute(
            "INSERT INTO connection_health(provider, connection, last_success_at, last_failure_at, error_payload, consecutive_failures)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5)
             ON CONFLICT(provider, connection) DO UPDATE SET
               last_failure_at = excluded.last_failure_at,
               error_payload = excluded.error_payload,
               consecutive_failures = excluded.consecutive_failures",
            params![
                provider.as_str(),
                connection_id,
                error.at.as_str(),
                payload,
                i64::from(consecutive_failures)
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Stored snapshot for one provider/connection pair, without health.
    pub fn snapshot(
        &self,
        provider: ProviderId,
        connection: Option<&ConnectionId>,
    ) -> Result<Option<ProviderSnapshot>, StorageError> {
        let connection_id = connection_key(connection, provider);
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT payload FROM snapshots WHERE provider = ?1 AND connection = ?2",
                params![provider.as_str(), connection_id],
                |row| row.get(0),
            )
            .optional()?;
        match payload {
            Some(payload) => {
                let snapshot: ProviderSnapshot = serde_json::from_str(&payload)
                    .map_err(|error| StorageError::Record(error.to_string()))?;
                Ok(Some(snapshot))
            }
            None => Ok(None),
        }
    }

    /// Recorded health for one provider/connection pair.
    pub fn health(
        &self,
        provider: ProviderId,
        connection: Option<&ConnectionId>,
    ) -> Result<Option<ConnectionHealth>, StorageError> {
        let connection_id = connection_key(connection, provider);
        let row = self
            .connection
            .query_row(
                "SELECT last_success_at, last_failure_at, error_payload, consecutive_failures
                 FROM connection_health WHERE provider = ?1 AND connection = ?2",
                params![provider.as_str(), connection_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;

        let Some((last_success, last_failure, error_payload, failures)) = row else {
            return Ok(None);
        };
        let error = match error_payload {
            Some(payload) => Some(
                serde_json::from_str(&payload)
                    .map_err(|error| StorageError::Record(error.to_string()))?,
            ),
            None => None,
        };
        Ok(Some(ConnectionHealth {
            connection: connection
                .cloned()
                .unwrap_or_else(|| ConnectionId::new(provider, connection_id)),
            last_success_at: last_success
                .map(|value| IsoTimestamp::parse(&value))
                .transpose()
                .map_err(|error| StorageError::Record(error.to_string()))?,
            last_failure_at: last_failure
                .map(|value| IsoTimestamp::parse(&value))
                .transpose()
                .map_err(|error| StorageError::Record(error.to_string()))?,
            error,
            consecutive_failures: u32::try_from(failures.max(0)).unwrap_or(u32::MAX),
        }))
    }

    /// Cache plus health for one connection, ready for the API layer.
    ///
    /// A cached snapshot with a recorded failure is returned marked stale, so
    /// the panel shows the last good data with its real timestamp.
    pub fn provider_state(
        &self,
        provider: ProviderId,
        connection: Option<&ConnectionId>,
    ) -> Result<ProviderState, StorageError> {
        let snapshot = self.snapshot(provider, connection)?;
        let health = self.health(provider, connection)?;
        let error = health.as_ref().and_then(|health| health.error.clone());
        let snapshot = match (snapshot, error.clone()) {
            (Some(snapshot), Some(error)) => Some(snapshot.mark_stale(error)),
            (snapshot, _) => snapshot,
        };
        Ok(ProviderState {
            provider,
            snapshot,
            error,
            connections: connection.cloned().into_iter().collect(),
        })
    }

    /// All stored provider states, one per recorded connection.
    pub fn provider_states(&self) -> Result<Vec<ProviderState>, StorageError> {
        let rows: Vec<(String, String)> = {
            let mut statement = self.connection.prepare(
                "SELECT provider, connection FROM connection_health
                 UNION
                 SELECT provider, connection FROM snapshots",
            )?;
            let mapped = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            mapped.collect::<Result<_, _>>()?
        };

        let mut states = Vec::new();
        for (provider, connection) in rows {
            let Some(provider) = parse_provider(&provider) else {
                continue;
            };
            let label = if connection == "default" {
                None
            } else {
                Some(ConnectionId::new(provider, connection))
            };
            states.push(self.provider_state(provider, label.as_ref())?);
        }
        states.sort_by(|left, right| {
            left.provider
                .as_str()
                .cmp(right.provider.as_str())
                .then_with(|| left.connections.cmp(&right.connections))
        });
        Ok(states)
    }

    /// True when at least one successful snapshot exists for a connection.
    pub fn has_success(
        &self,
        provider: ProviderId,
        connection: Option<&ConnectionId>,
    ) -> Result<bool, StorageError> {
        let health = self.health(provider, connection)?;
        Ok(health.and_then(|health| health.last_success_at).is_some())
    }

    /// The most recent balance sample for a platform/connection/currency.
    pub fn latest_observation(
        &self,
        key: &BalanceKey,
    ) -> Result<Option<BalanceObservation>, StorageError> {
        let row = self
            .connection
            .query_row(
                "SELECT provider, connection, currency, total, observed_at, local_day, adjustment
                 FROM balance_observations
                 WHERE provider = ?1 AND connection = ?2 AND currency = ?3
                 ORDER BY observed_at DESC, id DESC LIMIT 1",
                params![
                    key.provider.as_str(),
                    connection_name(&key.connection),
                    key.currency
                ],
                map_observation,
            )
            .optional()?;
        Ok(row)
    }

    /// Balance samples of one local day, oldest first.
    pub fn observations_for_day(
        &self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Vec<BalanceObservation>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT provider, connection, currency, total, observed_at, local_day, adjustment
             FROM balance_observations
             WHERE provider = ?1 AND connection = ?2 AND currency = ?3 AND local_day = ?4
             ORDER BY observed_at ASC, id ASC",
        )?;
        let rows = statement.query_map(
            params![
                key.provider.as_str(),
                connection_name(&key.connection),
                key.currency,
                local_day
            ],
            map_observation,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Append a sample. Samples are immutable: observation history is never
    /// rewritten, only compacted.
    pub fn add_observation(
        &mut self,
        observation: &BalanceObservation,
    ) -> Result<(), StorageError> {
        let transaction = self.transaction()?;
        transaction.execute(
            "INSERT INTO balance_observations(provider, connection, currency, total, observed_at, local_day, adjustment)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                observation.provider.as_str(),
                connection_name(&observation.connection),
                observation.currency,
                observation.total.to_string(),
                observation.observed_at.as_str(),
                observation.local_day,
                if observation.adjustment { 1 } else { 0 }
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Write or update the settled estimate for one local day.
    pub fn save_daily_summary(&mut self, summary: &DailySummary) -> Result<(), StorageError> {
        let transaction = self.transaction()?;
        transaction.execute(
            "INSERT INTO daily_summaries(provider, connection, currency, local_day, estimated_spend, adjustment_count, partial)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(provider, connection, currency, local_day) DO UPDATE SET
               estimated_spend = excluded.estimated_spend,
               adjustment_count = excluded.adjustment_count,
               partial = excluded.partial",
            params![
                summary.provider.as_str(),
                connection_name(&summary.connection),
                summary.currency,
                summary.local_day,
                summary.estimated_spend.to_string(),
                i64::from(summary.adjustment_count),
                if summary.partial { 1 } else { 0 }
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Read a settled estimate.
    pub fn daily_summary(
        &self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Option<DailySummary>, StorageError> {
        let row = self
            .connection
            .query_row(
                "SELECT estimated_spend, adjustment_count, partial FROM daily_summaries
                 WHERE provider = ?1 AND connection = ?2 AND currency = ?3 AND local_day = ?4",
                params![
                    key.provider.as_str(),
                    connection_name(&key.connection),
                    key.currency,
                    local_day
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        row.map(|(estimated_spend, adjustment_count, partial)| {
            let estimated_spend = Money::parse(&estimated_spend).map_err(|error| {
                StorageError::Record(format!("stored summary is not valid money: {error}"))
            })?;
            Ok(DailySummary {
                provider: key.provider,
                connection: key.connection.clone(),
                currency: key.currency.clone(),
                local_day: local_day.to_string(),
                estimated_spend,
                adjustment_count: u32::try_from(adjustment_count).map_err(|_| {
                    StorageError::Record(
                        "stored summary adjustment count is out of range".to_string(),
                    )
                })?,
                partial: partial != 0,
            })
        })
        .transpose()
    }

    /// Observation scopes that still hold samples older than `before`.
    pub fn observation_scopes_before(
        &self,
        before: &IsoTimestamp,
    ) -> Result<Vec<(ProviderId, String, String, String)>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT provider, connection, currency, local_day
             FROM balance_observations WHERE observed_at < ?1",
        )?;
        let rows = statement.query_map(params![before.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut scopes = Vec::new();
        for row in rows {
            let (provider, connection, currency, local_day) = row?;
            if let Some(provider) = parse_provider(&provider) {
                scopes.push((provider, connection, currency, local_day));
            }
        }
        Ok(scopes)
    }

    /// Samples of one scope at or after `from`.
    pub fn observations_since(
        &self,
        key: &BalanceKey,
        local_day: &str,
        from: &IsoTimestamp,
    ) -> Result<Vec<BalanceObservation>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT provider, connection, currency, total, observed_at, local_day, adjustment
             FROM balance_observations
             WHERE provider = ?1 AND connection = ?2 AND currency = ?3 AND local_day = ?4 AND observed_at >= ?5
             ORDER BY observed_at ASC, id ASC",
        )?;
        let rows = statement.query_map(
            params![
                key.provider.as_str(),
                connection_name(&key.connection),
                key.currency,
                local_day,
                from.as_str()
            ],
            map_observation,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Delete compacted samples.
    pub fn delete_observations_before(
        &mut self,
        key: &BalanceKey,
        local_day: &str,
        before: &IsoTimestamp,
    ) -> Result<usize, StorageError> {
        let transaction = self.transaction()?;
        let removed = transaction.execute(
            "DELETE FROM balance_observations
             WHERE provider = ?1 AND connection = ?2 AND currency = ?3 AND local_day = ?4 AND observed_at < ?5",
            params![
                key.provider.as_str(),
                connection_name(&key.connection),
                key.currency,
                local_day,
                before.as_str()
            ],
        )?;
        transaction.commit()?;
        Ok(removed)
    }

    /// Persist a non-sensitive setting.
    ///
    /// Secret-looking keys are rejected rather than redacted: credentials belong
    /// in the Keychain, and silently storing `"[REDACTED]"` would look like a
    /// configured setting that is actually useless.
    pub fn set_setting(
        &mut self,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), StorageError> {
        if looks_sensitive(key) {
            return Err(StorageError::Record(format!(
                "setting {key} looks like a credential; use the Keychain"
            )));
        }
        let transaction = self.transaction()?;
        transaction.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value.to_string()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Read a non-sensitive setting.
    pub fn get_setting<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Option<T>, StorageError> {
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        match payload {
            Some(payload) => serde_json::from_str(&payload)
                .map(Some)
                .map_err(|error| StorageError::Record(error.to_string())),
            None => Ok(None),
        }
    }

    /// All settings as a raw map, for diagnostics that must stay redacted anyway.
    pub fn settings(&self) -> Result<BTreeMap<String, serde_json::Value>, StorageError> {
        let mut statement = self.connection.prepare("SELECT key, value FROM settings")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut settings = BTreeMap::new();
        for row in rows {
            let (key, value) = row?;
            let parsed: serde_json::Value = serde_json::from_str(&value)
                .map_err(|error| StorageError::Record(error.to_string()))?;
            settings.insert(key, parsed);
        }
        Ok(settings)
    }

    /// Load the whole settings object, falling back to defaults.
    pub fn desktop_settings(
        &self,
        default_timezone: &str,
    ) -> Result<DesktopSettings, StorageError> {
        let stored: Option<DesktopSettings> = self.get_setting("desktop.settings")?;
        let mut settings = stored.unwrap_or_default();
        if settings.timezone == "UTC" && default_timezone != "UTC" {
            settings.timezone = default_timezone.to_string();
        }
        Ok(settings)
    }

    /// Store the whole settings object.
    pub fn save_desktop_settings(
        &mut self,
        settings: &DesktopSettings,
    ) -> Result<(), StorageError> {
        let value = serde_json::to_value(settings)
            .map_err(|error| StorageError::Record(error.to_string()))?;
        self.set_setting("desktop.settings", &value)
    }

    /// Size of the database file in bytes, for the diagnostics panel.
    pub fn size_bytes(&self) -> u64 {
        if self.location == ":memory:" {
            return 0;
        }
        std::fs::metadata(&self.location).map_or(0, |metadata| metadata.len())
    }

    /// Replace old observation samples with one settled daily summary.
    ///
    /// Retention never deletes the most recent sample of each scope, and it
    /// never touches snapshots or health rows: only the raw observation history
    /// that the estimate no longer needs is compacted.
    pub fn compact_day(
        &mut self,
        key: &BalanceKey,
        local_day: &str,
        before: &IsoTimestamp,
        summary: &DailySummary,
    ) -> Result<usize, StorageError> {
        let transaction = self.transaction()?;
        let removed = transaction.execute(
            "DELETE FROM balance_observations
             WHERE provider = ?1 AND connection = ?2 AND currency = ?3 AND local_day = ?4
               AND observed_at < ?5
               AND id NOT IN (
                 SELECT MAX(id) FROM balance_observations
                 WHERE provider = ?1 AND connection = ?2 AND currency = ?3
               )",
            params![
                key.provider.as_str(),
                connection_name(&key.connection),
                key.currency,
                local_day,
                before.as_str()
            ],
        )?;
        transaction.execute(
            "INSERT INTO daily_summaries(provider, connection, currency, local_day, estimated_spend, adjustment_count, partial)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(provider, connection, currency, local_day) DO UPDATE SET
               estimated_spend = excluded.estimated_spend,
               adjustment_count = excluded.adjustment_count,
               partial = excluded.partial",
            params![
                key.provider.as_str(),
                connection_name(&key.connection),
                key.currency,
                local_day,
                summary.estimated_spend.to_string(),
                i64::from(summary.adjustment_count),
                if summary.partial { 1 } else { 0 }
            ],
        )?;
        transaction.commit()?;
        Ok(removed)
    }

    /// Number of stored snapshots, used by tests and diagnostics.
    pub fn snapshot_count(&self) -> Result<i64, StorageError> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))?)
    }

    /// Number of stored balance samples.
    pub fn observation_count(&self) -> Result<i64, StorageError> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM balance_observations", [], |row| {
                row.get(0)
            })?)
    }

    pub fn schema_version(&self) -> Result<i64, StorageError> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(raw.and_then(|value| value.parse().ok()).unwrap_or(0))
    }
}

/// The persistence seam the estimator uses. The desktop service plugs its SQLite
/// store in here, so estimation survives a restart and stays isolated by
/// platform, connection, currency and day.
impl crate::estimate::BalanceStore for Store {
    fn latest(
        &self,
        key: &BalanceKey,
    ) -> Result<Option<BalanceObservation>, crate::estimate::StoreError> {
        self.latest_observation(key)
            .map_err(|error| crate::estimate::StoreError::new(error.to_string()))
    }

    fn list_day(
        &self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Vec<BalanceObservation>, crate::estimate::StoreError> {
        self.observations_for_day(key, local_day)
            .map_err(|error| crate::estimate::StoreError::new(error.to_string()))
    }

    fn insert(
        &mut self,
        observation: BalanceObservation,
    ) -> Result<(), crate::estimate::StoreError> {
        self.add_observation(&observation)
            .map_err(|error| crate::estimate::StoreError::new(error.to_string()))
    }

    fn save_summary(&mut self, summary: DailySummary) -> Result<(), crate::estimate::StoreError> {
        self.save_daily_summary(&summary)
            .map_err(|error| crate::estimate::StoreError::new(error.to_string()))
    }
}

/// A shared SQLite store for the collectors, which need `BalanceStore` behind an
/// `Arc` so one database can serve the Codex/GLM/DeepSeek estimators concurrently
/// while the scheduler owns the only mutable handle.
impl crate::estimate::BalanceStore for std::sync::Arc<std::sync::Mutex<Store>> {
    fn latest(
        &self,
        key: &BalanceKey,
    ) -> Result<Option<BalanceObservation>, crate::estimate::StoreError> {
        let store = self
            .lock()
            .map_err(|_| crate::estimate::StoreError::new("balance store lock poisoned"))?;
        store
            .latest_observation(key)
            .map_err(|error| crate::estimate::StoreError::new(error.to_string()))
    }

    fn list_day(
        &self,
        key: &BalanceKey,
        local_day: &str,
    ) -> Result<Vec<BalanceObservation>, crate::estimate::StoreError> {
        let store = self
            .lock()
            .map_err(|_| crate::estimate::StoreError::new("balance store lock poisoned"))?;
        store
            .observations_for_day(key, local_day)
            .map_err(|error| crate::estimate::StoreError::new(error.to_string()))
    }

    fn insert(
        &mut self,
        observation: BalanceObservation,
    ) -> Result<(), crate::estimate::StoreError> {
        let mut store = self
            .lock()
            .map_err(|_| crate::estimate::StoreError::new("balance store lock poisoned"))?;
        store
            .add_observation(&observation)
            .map_err(|error| crate::estimate::StoreError::new(error.to_string()))
    }

    fn save_summary(&mut self, summary: DailySummary) -> Result<(), crate::estimate::StoreError> {
        let mut store = self
            .lock()
            .map_err(|_| crate::estimate::StoreError::new("balance store lock poisoned"))?;
        store
            .save_daily_summary(&summary)
            .map_err(|error| crate::estimate::StoreError::new(error.to_string()))
    }
}

fn map_observation(row: &rusqlite::Row<'_>) -> rusqlite::Result<BalanceObservation> {
    let provider: String = row.get(0)?;
    let connection: String = row.get(1)?;
    let total: String = row.get(3)?;
    let observed_at: String = row.get(4)?;
    let provider = parse_provider(&provider).unwrap_or(ProviderId::Codex);
    let total = Money::parse(&total).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(BalanceObservation {
        provider,
        connection: ConnectionId::new(provider, connection),
        currency: row.get(2)?,
        total,
        observed_at: IsoTimestamp::parse(&observed_at).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        local_day: row.get(5)?,
        adjustment: row.get::<_, i64>(6)? != 0,
    })
}

/// The machine name of a connection, used as the storage key.
fn connection_name(connection: &ConnectionId) -> &str {
    connection.connection.trim()
}

fn connection_key(connection: Option<&ConnectionId>, provider: ProviderId) -> String {
    connection
        .map(connection_name)
        .filter(|name| !name.is_empty())
        .unwrap_or("default")
        .rsplit(':')
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(provider.as_str())
        .to_string()
}

fn parse_provider(value: &str) -> Option<ProviderId> {
    match value {
        "codex" => Some(ProviderId::Codex),
        "glm" => Some(ProviderId::Glm),
        "deepseek" => Some(ProviderId::Deepseek),
        _ => None,
    }
}

fn looks_sensitive(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    [
        "apikey",
        "api_key",
        "token",
        "secret",
        "password",
        "cookie",
        "authorization",
        "session",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{
        ConnectionStatus, ErrorKind, MetricDirection, MetricInput, MetricValue, UsageMetric,
    };
    use serde_json::json;

    fn snapshot(provider: ProviderId, captured: &str, value: f64) -> ProviderSnapshot {
        ProviderSnapshot {
            provider,
            connection: None,
            status: ConnectionStatus::Connected,
            captured_at: IsoTimestamp::parse(captured).unwrap(),
            last_success_at: Some(IsoTimestamp::parse(captured).unwrap()),
            source: "test".into(),
            metrics: vec![UsageMetric::normalize(MetricInput {
                key: "quota.5h.used".into(),
                unit: "percent".into(),
                direction: MetricDirection::Used,
                value: Some(MetricValue::Number(value)),
                source: "test".into(),
                ..MetricInput::default()
            })
            .unwrap()],
            error: None,
            diagnostic: None,
            extra: serde_json::Map::new(),
        }
    }

    fn observation(
        local_day: &str,
        observed_at: &str,
        total: &str,
        adjustment: bool,
    ) -> BalanceObservation {
        BalanceObservation {
            provider: ProviderId::Deepseek,
            connection: ConnectionId::new(ProviderId::Deepseek, "wallet"),
            currency: "CNY".into(),
            total: Money::parse(total).unwrap(),
            observed_at: IsoTimestamp::parse(observed_at).unwrap(),
            local_day: local_day.into(),
            adjustment,
        }
    }

    fn balance_key(currency: &str) -> BalanceKey {
        BalanceKey {
            provider: ProviderId::Deepseek,
            connection: ConnectionId::new(ProviderId::Deepseek, "wallet"),
            currency: currency.to_string(),
        }
    }

    #[test]
    fn migrates_and_reports_the_schema_version() {
        let store = Store::in_memory().expect("store");
        assert_eq!(store.schema_version().expect("version"), SCHEMA_VERSION);
        assert_eq!(store.snapshot_count().expect("count"), 0);
    }

    #[test]
    fn successful_snapshot_round_trips_with_its_original_time() {
        let mut store = Store::in_memory().expect("store");
        let saved = snapshot(ProviderId::Glm, "2026-09-10T07:30:00.000Z", 28.0);
        store.save_success(&saved).expect("save");

        let state = store.provider_state(ProviderId::Glm, None).expect("state");
        let cached = state.snapshot.expect("cached snapshot");
        assert_eq!(cached.captured_at, saved.captured_at);
        assert_eq!(cached.last_success_at, saved.last_success_at);
        assert_eq!(cached.metrics[0].value.as_number(), Some(28.0));
        assert_eq!(cached.status, ConnectionStatus::Connected);
        assert!(state.error.is_none());
    }

    #[test]
    fn failure_does_not_overwrite_the_last_successful_snapshot() {
        let mut store = Store::in_memory().expect("store");
        store
            .save_success(&snapshot(ProviderId::Glm, "2026-09-10T07:30:00.000Z", 28.0))
            .expect("save success");
        let error = CollectorError::new(
            ErrorKind::Network,
            "refresh failed",
            IsoTimestamp::parse("2026-09-10T08:05:00.000Z").unwrap(),
        );
        store
            .save_failure(ProviderId::Glm, None, &error, 2)
            .expect("save failure");

        let state = store.provider_state(ProviderId::Glm, None).expect("state");
        let cached = state.snapshot.expect("cached snapshot");
        assert_eq!(cached.captured_at.as_str(), "2026-09-10T07:30:00.000Z");
        assert_eq!(
            cached.last_success_at.unwrap().as_str(),
            "2026-09-10T07:30:00.000Z"
        );
        assert_eq!(cached.status, ConnectionStatus::Degraded);
        assert!(cached.metrics[0].has_confidence(crate::contracts::Confidence::Stale));
        assert_eq!(cached.metrics[0].value.as_number(), Some(28.0));
        assert_eq!(state.error.expect("error").kind, ErrorKind::Network);

        let health = store
            .health(ProviderId::Glm, None)
            .expect("health")
            .expect("present");
        assert_eq!(health.consecutive_failures, 2);
        assert_eq!(
            health.last_success_at.expect("success time").as_str(),
            "2026-09-10T07:30:00.000Z"
        );
    }

    #[test]
    fn connections_are_stored_independently() {
        let mut store = Store::in_memory().expect("store");
        let quota = ConnectionId::with_label(ProviderId::Glm, "quota", "套餐");
        let wallet = ConnectionId::with_label(ProviderId::Glm, "wallet", "钱包");

        let mut quota_snapshot = snapshot(ProviderId::Glm, "2026-09-10T07:30:00.000Z", 28.0);
        quota_snapshot.connection = Some(quota.clone());
        let mut wallet_snapshot = snapshot(ProviderId::Glm, "2026-09-10T07:31:00.000Z", 42.6);
        wallet_snapshot.connection = Some(wallet.clone());
        store.save_success(&quota_snapshot).expect("quota");
        store.save_success(&wallet_snapshot).expect("wallet");

        store
            .save_failure(
                ProviderId::Glm,
                Some(&wallet),
                &CollectorError::new(
                    ErrorKind::Compatibility,
                    "wallet schema changed",
                    IsoTimestamp::parse("2026-09-10T08:00:00.000Z").unwrap(),
                ),
                1,
            )
            .expect("wallet failure");

        let quota_state = store
            .provider_state(ProviderId::Glm, Some(&quota))
            .expect("quota state");
        let wallet_state = store
            .provider_state(ProviderId::Glm, Some(&wallet))
            .expect("wallet state");
        assert!(quota_state.error.is_none());
        assert_eq!(
            quota_state.snapshot.expect("quota snapshot").status,
            ConnectionStatus::Connected
        );
        let wallet_snapshot = wallet_state.snapshot.expect("wallet snapshot");
        assert_eq!(wallet_snapshot.status, ConnectionStatus::Degraded);
        assert_eq!(wallet_snapshot.metrics[0].value.as_number(), Some(42.6));
        assert_eq!(store.snapshot_count().expect("count"), 2);
    }

    #[test]
    fn settings_round_trip_and_credentials_are_refused() {
        let mut store = Store::in_memory().expect("store");
        store
            .set_setting("glm.region", &json!("international"))
            .expect("setting");
        assert_eq!(
            store.get_setting::<String>("glm.region").expect("read"),
            Some("international".to_string())
        );

        let error = store
            .set_setting("deepseek.apiKey", &json!("not-a-real-key"))
            .expect_err("credentials must be refused");
        assert!(error.to_string().contains("Keychain"));

        let settings = DesktopSettings {
            timezone: "Asia/Shanghai".into(),
            glm_region: crate::contracts::GlmRegion::International,
            glm_wallet_enabled: true,
            ..DesktopSettings::default()
        };
        store.save_desktop_settings(&settings).expect("settings");
        let loaded = store.desktop_settings("Asia/Shanghai").expect("load");
        assert_eq!(loaded, settings);
    }

    #[test]
    fn balance_samples_are_isolated_by_scope_and_survive_a_restart() {
        let path = std::env::temp_dir().join(format!(
            "agents-usage-store-{}.sqlite3",
            crate::storage::data_dir::random_token(6)
        ));
        {
            let mut store = Store::open(&path).expect("store");
            store
                .add_observation(&observation(
                    "2026-09-10",
                    "2026-09-09T16:00:00.000Z",
                    "100.00",
                    false,
                ))
                .expect("first");
            store
                .add_observation(&observation(
                    "2026-09-10",
                    "2026-09-09T17:00:00.000Z",
                    "96.00",
                    false,
                ))
                .expect("second");
            store
                .add_observation(&observation(
                    "2026-09-11",
                    "2026-09-10T16:00:00.000Z",
                    "90.00",
                    false,
                ))
                .expect("next day");
            store
                .save_daily_summary(&DailySummary {
                    provider: ProviderId::Deepseek,
                    connection: ConnectionId::new(ProviderId::Deepseek, "wallet"),
                    currency: "CNY".into(),
                    local_day: "2026-09-10".into(),
                    estimated_spend: Money::parse("4").unwrap(),
                    adjustment_count: 0,
                    partial: false,
                })
                .expect("summary");
        }

        let store = Store::open(&path).expect("reopen");
        let day = store
            .observations_for_day(&balance_key("CNY"), "2026-09-10")
            .expect("day");
        assert_eq!(day.len(), 2);
        assert_eq!(day[0].total, Money::parse("100.00").unwrap());
        assert_eq!(
            store
                .latest_observation(&balance_key("CNY"))
                .expect("latest")
                .expect("present")
                .local_day,
            "2026-09-11"
        );
        assert_eq!(
            store
                .observations_for_day(&balance_key("USD"), "2026-09-10")
                .expect("other currency"),
            Vec::new()
        );
        let summary = store
            .daily_summary(&balance_key("CNY"), "2026-09-10")
            .expect("summary")
            .expect("present");
        assert_eq!(summary.estimated_spend, Money::parse("4").unwrap());
        assert!(!summary.partial);

        std::fs::remove_file(&path).ok();
        std::fs::remove_file(path.with_extension("sqlite3-wal")).ok();
        std::fs::remove_file(path.with_extension("sqlite3-shm")).ok();
    }

    #[test]
    fn compaction_deletes_only_old_samples_and_keeps_the_latest() {
        let mut store = Store::in_memory().expect("store");
        store
            .add_observation(&observation(
                "2026-09-01",
                "2026-09-01T00:00:00.000Z",
                "100",
                false,
            ))
            .unwrap();
        store
            .add_observation(&observation(
                "2026-09-01",
                "2026-09-01T01:00:00.000Z",
                "95",
                false,
            ))
            .unwrap();
        store
            .add_observation(&observation(
                "2026-09-02",
                "2026-09-02T00:00:00.000Z",
                "90",
                false,
            ))
            .unwrap();

        let cutoff = IsoTimestamp::parse("2026-09-02T00:00:00.000Z").unwrap();
        let scopes = store.observation_scopes_before(&cutoff).expect("scopes");
        assert_eq!(scopes.len(), 1);
        let (provider, connection, currency, local_day) = scopes[0].clone();
        let key = BalanceKey {
            provider,
            connection: ConnectionId::new(provider, connection),
            currency,
        };
        let recent = store
            .observations_since(&key, &local_day, &cutoff)
            .expect("recent");
        assert!(recent.is_empty());
        let removed = store
            .delete_observations_before(&key, &local_day, &cutoff)
            .expect("delete");
        assert_eq!(removed, 2);
        assert_eq!(store.observation_count().expect("count"), 1);
        assert_eq!(
            store
                .latest_observation(&balance_key("CNY"))
                .expect("latest")
                .expect("present")
                .total,
            Money::parse("90").unwrap()
        );
    }

    #[test]
    fn provider_states_lists_every_recorded_connection() {
        let mut store = Store::in_memory().expect("store");
        let mut quota = snapshot(ProviderId::Glm, "2026-09-10T07:30:00.000Z", 28.0);
        quota.connection = Some(ConnectionId::new(ProviderId::Glm, "quota"));
        store.save_success(&quota).expect("quota");
        store
            .save_success(&snapshot(
                ProviderId::Deepseek,
                "2026-09-10T07:30:00.000Z",
                86.42,
            ))
            .expect("deepseek");
        store
            .save_failure(
                ProviderId::Codex,
                None,
                &CollectorError::new(
                    ErrorKind::Authentication,
                    "not signed in",
                    IsoTimestamp::parse("2026-09-10T08:00:00.000Z").unwrap(),
                ),
                1,
            )
            .expect("codex failure");

        let states = store.provider_states().expect("states");
        let providers: Vec<&str> = states.iter().map(|state| state.provider.as_str()).collect();
        assert_eq!(providers, vec!["codex", "deepseek", "glm"]);
        let codex = states
            .iter()
            .find(|state| state.provider == ProviderId::Codex)
            .unwrap();
        assert!(codex.snapshot.is_none());
        assert_eq!(
            codex.error.as_ref().unwrap().kind,
            ErrorKind::Authentication
        );
        assert!(!store
            .has_success(ProviderId::Codex, None)
            .expect("has success"));
        assert!(store
            .has_success(ProviderId::Deepseek, None)
            .expect("has success"));
    }

    #[test]
    fn compact_day_keeps_the_latest_sample_and_writes_the_summary() {
        let mut store = Store::in_memory().expect("store");
        store
            .add_observation(&observation(
                "2026-09-01",
                "2026-09-01T00:00:00.000Z",
                "100",
                false,
            ))
            .unwrap();
        store
            .add_observation(&observation(
                "2026-09-01",
                "2026-09-01T01:00:00.000Z",
                "96",
                false,
            ))
            .unwrap();
        store
            .add_observation(&observation(
                "2026-09-01",
                "2026-09-01T02:00:00.000Z",
                "90",
                false,
            ))
            .unwrap();

        let cutoff = IsoTimestamp::parse("2026-09-02T00:00:00.000Z").unwrap();
        let summary = DailySummary {
            provider: ProviderId::Deepseek,
            connection: ConnectionId::new(ProviderId::Deepseek, "wallet"),
            currency: "CNY".into(),
            local_day: "2026-09-01".into(),
            estimated_spend: Money::parse("10").unwrap(),
            adjustment_count: 0,
            partial: true,
        };
        let removed = store
            .compact_day(&balance_key("CNY"), "2026-09-01", &cutoff, &summary)
            .expect("compact");

        assert_eq!(removed, 2);
        assert_eq!(store.observation_count().expect("count"), 1);
        let latest = store
            .latest_observation(&balance_key("CNY"))
            .expect("latest")
            .expect("present");
        assert_eq!(latest.total, Money::parse("90").unwrap());
        // The retained sample keeps its true observation time, not "now".
        assert_eq!(latest.observed_at.as_str(), "2026-09-01T02:00:00.000Z");
        let stored_summary = store
            .daily_summary(&balance_key("CNY"), "2026-09-01")
            .expect("summary")
            .expect("present");
        assert_eq!(stored_summary.estimated_spend, Money::parse("10").unwrap());
        assert!(stored_summary.partial);
    }
}

//! Connection-level refresh scheduling.
//!
//! Every connection refreshes on its own schedule. The scheduler enforces the
//! shared rules:
//!
//! - **coalescing**: one in-flight refresh per connection; concurrent callers
//!   await the same future instead of triggering extra upstream calls;
//! - **cooldown**: a manual or automatic refresh cannot fire again until the
//!   connection's cooldown elapses, unless forced;
//! - **backoff**: consecutive failures grow the wait between attempts up to a
//!   cap, and one success resets the counter;
//! - **timeout**: a refresh that runs past its budget fails with a timeout while
//!   the underlying task is abandoned;
//! - **date change**: after sleep or a local-date rollover the scheduler marks
//!   every connection eligible for one coalesced refresh, so a value from
//!   yesterday is never served as today's.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::contracts::ErrorKind;
use crate::http::CollectorError;

/// Timing knobs for one connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshPolicy {
    pub refresh_interval: Duration,
    pub cooldown: Duration,
    pub timeout: Duration,
    pub max_backoff: Duration,
}

impl RefreshPolicy {
    pub fn provider_defaults() -> Self {
        Self {
            refresh_interval: Duration::from_secs(300),
            cooldown: Duration::from_secs(30),
            timeout: Duration::from_secs(15),
            max_backoff: Duration::from_secs(900),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshOutcome<T> {
    /// A refresh ran and produced a result.
    Success(T),
    /// A refresh ran and failed.
    Failure(CollectorError),
    /// The connection is cooling down; no upstream call was made.
    Cooldown { next_eligible_at_ms: u64 },
}

impl<T> RefreshOutcome<T> {
    pub fn is_cooldown(&self) -> bool {
        matches!(self, RefreshOutcome::Cooldown { .. })
    }

    pub fn error(&self) -> Option<&CollectorError> {
        match self {
            RefreshOutcome::Failure(error) => Some(error),
            _ => None,
        }
    }

    pub fn succeeded(&self) -> bool {
        matches!(self, RefreshOutcome::Success(_))
    }
}

#[derive(Debug, Default)]
struct ConnectionState {
    last_attempt_at_ms: u64,
    consecutive_failures: u32,
}

/// A refresh task factory: each call returns a fresh future so a connection can
/// be refreshed repeatedly.
pub type RefreshTask<T> =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<T, CollectorError>> + Send>> + Send + Sync>;

/// Connection-level refresh scheduler.
pub struct RefreshScheduler {
    policy: RefreshPolicy,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    in_flight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    state: Mutex<HashMap<String, ConnectionState>>,
}

impl RefreshScheduler {
    pub fn new(policy: RefreshPolicy) -> Self {
        Self::with_clock(policy, || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |duration| duration.as_millis() as u64)
        })
    }

    pub fn with_clock(
        policy: RefreshPolicy,
        now: impl Fn() -> u64 + Send + Sync + 'static,
    ) -> Self {
        Self {
            policy,
            now: Arc::new(now),
            in_flight: Mutex::new(HashMap::new()),
            state: Mutex::new(HashMap::new()),
        }
    }

    pub fn policy(&self) -> &RefreshPolicy {
        &self.policy
    }

    /// The backoff wait for `consecutive_failures` failures.
    fn backoff(&self, consecutive_failures: u32) -> Duration {
        if consecutive_failures == 0 {
            return Duration::ZERO;
        }
        let exponent = consecutive_failures.saturating_sub(1).min(10);
        let growth = Duration::from_secs(1_u64.saturating_mul(1_u64 << exponent));
        growth.min(self.policy.max_backoff)
    }

    async fn wait_required(&self, key: &str, force: bool) -> Result<Duration, Duration> {
        if force {
            return Ok(Duration::ZERO);
        }
        let now_ms = (self.now)();
        let state = self.state.lock().await;
        let Some(connection) = state.get(key) else {
            return Ok(Duration::ZERO);
        };
        let wait = if connection.consecutive_failures > 0 {
            self.backoff(connection.consecutive_failures)
                .max(self.policy.cooldown)
        } else {
            self.policy.cooldown
        };
        let next_eligible_at_ms = connection
            .last_attempt_at_ms
            .saturating_add(wait.as_millis() as u64);
        if now_ms < next_eligible_at_ms {
            Err(Duration::from_millis(next_eligible_at_ms - now_ms))
        } else {
            Ok(Duration::ZERO)
        }
    }

    /// Run `task` for `key`, coalescing in-flight work and enforcing cooldown.
    ///
    /// Concurrent callers for the same key share the in-flight run: the task
    /// factory is invoked exactly once, and every caller observes the same
    /// outcome. A task that exceeds the policy timeout fails with a timeout.
    pub async fn refresh<T>(
        &self,
        key: &str,
        force: bool,
        task: RefreshTask<T>,
    ) -> RefreshOutcome<T>
    where
        T: Clone + Send + Sync + 'static,
    {
        // Fast path: cooldown without touching the in-flight map.
        match self.wait_required(key, force).await {
            Ok(_) => {}
            Err(remaining) => {
                let next_eligible_at_ms = (self.now)().saturating_add(remaining.as_millis() as u64);
                return RefreshOutcome::Cooldown {
                    next_eligible_at_ms,
                };
            }
        }

        // Acquire (or join) the in-flight slot for this connection. The slot is
        // a completion gate: only the first caller runs the task; later callers
        // wait for it, then re-check the cooldown clock instead of running again.
        let slot = {
            let mut in_flight = self.in_flight.lock().await;
            Arc::clone(
                in_flight
                    .entry(key.to_string())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _gate = slot.lock().await;

        // Re-check after acquiring the gate: a previous run may have just
        // finished, leaving us in the cooldown window.
        if let Err(remaining) = self.wait_required(key, force).await {
            let next_eligible_at_ms = (self.now)().saturating_add(remaining.as_millis() as u64);
            return RefreshOutcome::Cooldown {
                next_eligible_at_ms,
            };
        }

        {
            let now_ms = (self.now)();
            let mut state = self.state.lock().await;
            state.entry(key.to_string()).or_default().last_attempt_at_ms = now_ms;
        }

        let timeout = self.policy.timeout;
        let result = tokio::time::timeout(timeout, task()).await;

        let outcome = match result {
            Ok(Ok(value)) => {
                let mut state = self.state.lock().await;
                state
                    .entry(key.to_string())
                    .or_default()
                    .consecutive_failures = 0;
                RefreshOutcome::Success(value)
            }
            Ok(Err(error)) => {
                let mut state = self.state.lock().await;
                state
                    .entry(key.to_string())
                    .or_default()
                    .consecutive_failures += 1;
                RefreshOutcome::Failure(error)
            }
            Err(_elapsed) => {
                let mut state = self.state.lock().await;
                state
                    .entry(key.to_string())
                    .or_default()
                    .consecutive_failures += 1;
                RefreshOutcome::Failure(CollectorError::new(
                    ErrorKind::Network,
                    format!("refresh timed out after {} ms", timeout.as_millis()),
                ))
            }
        };

        // The gate drops here, releasing the next caller.
        outcome
    }

    /// Consecutive failures currently recorded for a connection.
    pub async fn consecutive_failures(&self, key: &str) -> u32 {
        self.state
            .lock()
            .await
            .get(key)
            .map_or(0, |state| state.consecutive_failures)
    }

    /// Reset the failure counter (used when a stale cache is repaired).
    pub async fn reset_failures(&self, key: &str) {
        if let Some(state) = self.state.lock().await.get_mut(key) {
            state.consecutive_failures = 0;
        }
    }

    /// Signal a local-date change (or wake from sleep).
    ///
    /// Clears the backoff and cooldown clocks so every connection is eligible
    /// for one coalesced refresh; callers then run their refresh tasks.
    /// Day-scoped caches are not cleared here because the storage layer owns
    /// them.
    pub async fn on_date_change(&self) {
        self.state.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn task<T: Clone + Send + Sync + 'static>(value: T) -> RefreshTask<T> {
        Arc::new(move || Box::pin(std::future::ready(Ok::<T, CollectorError>(value.clone()))))
    }

    fn failing_task() -> RefreshTask<serde_json::Value> {
        Arc::new(|| {
            Box::pin(std::future::ready(
                Err::<serde_json::Value, CollectorError>(CollectorError::network("refresh failed")),
            ))
        })
    }

    #[tokio::test]
    async fn consecutive_refreshes_respect_cooldown() {
        let clock = Arc::new(AtomicU64::new(0));
        let scheduler = RefreshScheduler::with_clock(
            RefreshPolicy {
                refresh_interval: Duration::from_secs(300),
                cooldown: Duration::from_secs(30),
                timeout: Duration::from_secs(5),
                max_backoff: Duration::from_secs(900),
            },
            {
                let clock = Arc::clone(&clock);
                move || clock.load(Ordering::SeqCst)
            },
        );

        let first = scheduler.refresh("glm:quota", false, task(1_u32)).await;
        assert!(matches!(first, RefreshOutcome::Success(1)));

        let second = scheduler.refresh("glm:quota", false, task(2_u32)).await;
        assert!(matches!(second, RefreshOutcome::Cooldown { .. }));

        let forced = scheduler.refresh("glm:quota", true, task(3_u32)).await;
        assert!(matches!(forced, RefreshOutcome::Success(3)));
    }

    #[tokio::test]
    async fn failures_back_off_and_success_resets() {
        let clock = Arc::new(AtomicU64::new(0));
        let scheduler = RefreshScheduler::with_clock(
            RefreshPolicy {
                cooldown: Duration::from_secs(1),
                max_backoff: Duration::from_secs(64),
                refresh_interval: Duration::from_secs(300),
                timeout: Duration::from_secs(5),
            },
            {
                let clock = Arc::clone(&clock);
                move || clock.load(Ordering::SeqCst)
            },
        );

        let first = scheduler
            .refresh("codex:account", false, failing_task())
            .await;
        assert!(matches!(first, RefreshOutcome::Failure(_)));
        assert_eq!(scheduler.consecutive_failures("codex:account").await, 1);

        clock.fetch_add(2_000, Ordering::SeqCst);
        let second = scheduler
            .refresh("codex:account", false, failing_task())
            .await;
        assert!(matches!(second, RefreshOutcome::Failure(_)));
        assert_eq!(scheduler.consecutive_failures("codex:account").await, 2);

        clock.fetch_add(2_000, Ordering::SeqCst);
        let success = scheduler
            .refresh(
                "codex:account",
                false,
                task(serde_json::json!({"ok": true})),
            )
            .await;
        assert!(matches!(success, RefreshOutcome::Success(_)));
        assert_eq!(scheduler.consecutive_failures("codex:account").await, 0);
    }

    #[tokio::test]
    async fn date_change_makes_every_connection_eligible_again() {
        let clock = Arc::new(AtomicU64::new(0));
        let scheduler = RefreshScheduler::with_clock(
            RefreshPolicy {
                cooldown: Duration::from_secs(30),
                refresh_interval: Duration::from_secs(300),
                timeout: Duration::from_secs(5),
                max_backoff: Duration::from_secs(900),
            },
            {
                let clock = Arc::clone(&clock);
                move || clock.load(Ordering::SeqCst)
            },
        );

        assert!(matches!(
            scheduler.refresh("glm:quota", false, task(1_u32)).await,
            RefreshOutcome::Success(1)
        ));
        assert!(scheduler
            .refresh("glm:quota", false, task(2_u32))
            .await
            .is_cooldown());

        scheduler.on_date_change().await;
        assert!(matches!(
            scheduler.refresh("glm:quota", false, task(3_u32)).await,
            RefreshOutcome::Success(3)
        ));
    }

    #[tokio::test]
    async fn a_silent_task_times_out_instead_of_hanging() {
        let clock = Arc::new(AtomicU64::new(0));
        let scheduler = RefreshScheduler::with_clock(
            RefreshPolicy {
                cooldown: Duration::ZERO,
                refresh_interval: Duration::from_secs(300),
                timeout: Duration::from_millis(20),
                max_backoff: Duration::from_secs(900),
            },
            {
                let clock = Arc::clone(&clock);
                move || clock.load(Ordering::SeqCst)
            },
        );
        let slow: RefreshTask<u32> = Arc::new(|| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(1_u32)
            })
        });

        let outcome = scheduler.refresh("glm:wallet", false, slow).await;
        assert!(matches!(outcome, RefreshOutcome::Failure(_)));
        assert!(outcome
            .error()
            .expect("error")
            .message
            .contains("timed out"));
        assert_eq!(scheduler.consecutive_failures("glm:wallet").await, 1);
    }

    #[tokio::test]
    async fn concurrent_refreshes_for_one_connection_share_a_slot() {
        let clock = Arc::new(AtomicU64::new(0));
        let runs = Arc::new(AtomicU64::new(0));
        let scheduler = RefreshScheduler::with_clock(
            RefreshPolicy {
                cooldown: Duration::from_millis(50),
                refresh_interval: Duration::from_secs(300),
                timeout: Duration::from_secs(5),
                max_backoff: Duration::from_secs(900),
            },
            {
                let clock = Arc::clone(&clock);
                move || clock.load(Ordering::SeqCst)
            },
        );
        let task: RefreshTask<u32> = {
            let runs = Arc::clone(&runs);
            Arc::new(move || {
                let runs = Arc::clone(&runs);
                Box::pin(async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    Ok(7_u32)
                })
            })
        };

        let (left, right) = tokio::join!(
            scheduler.refresh("deepseek:wallet", false, Arc::clone(&task)),
            scheduler.refresh("deepseek:wallet", false, task)
        );
        assert!(matches!(left, RefreshOutcome::Success(7)));
        // The second caller joined the in-flight gate and then observed the
        // cooldown, without starting a second task.
        assert!(
            right.is_cooldown(),
            "second caller must be a cooldown, got {right:?}"
        );
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }
}

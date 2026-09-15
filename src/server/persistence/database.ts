import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import {
  collectorErrorSchema,
  markSnapshotStale,
  providerSnapshotSchema,
  type CollectorError,
  type ProviderId,
  type ProviderSnapshot
} from '../../shared/contracts';
import { redactSecrets } from '../../shared/redaction';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface BalanceObservation {
  provider: ProviderId;
  currency: string;
  total: number;
  observedAt: string;
  localDay: string;
  adjustment: boolean;
}

export class UsageDatabase {
  private readonly db: DatabaseSyncType;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        provider TEXT PRIMARY KEY,
        captured_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collector_health (
        provider TEXT PRIMARY KEY,
        last_success_at TEXT,
        last_failure_at TEXT,
        error_payload TEXT
      );
      CREATE TABLE IF NOT EXISTS balance_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        currency TEXT NOT NULL,
        total REAL NOT NULL,
        observed_at TEXT NOT NULL,
        local_day TEXT NOT NULL,
        adjustment INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS balance_observations_lookup
        ON balance_observations(provider, currency, local_day, observed_at);
      CREATE TABLE IF NOT EXISTS daily_summaries (
        provider TEXT NOT NULL,
        currency TEXT NOT NULL,
        local_day TEXT NOT NULL,
        estimated_spend REAL NOT NULL,
        partial INTEGER NOT NULL,
        adjustment_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(provider, currency, local_day)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  saveSuccessfulSnapshot(snapshot: ProviderSnapshot): void {
    const safe = providerSnapshotSchema.parse(redactSecrets(snapshot));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO snapshots(provider, captured_at, payload) VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET captured_at=excluded.captured_at, payload=excluded.payload
      `).run(safe.provider, safe.capturedAt, JSON.stringify(safe));
      this.db.prepare(`
        INSERT INTO collector_health(provider, last_success_at, last_failure_at, error_payload)
        VALUES (?, ?, NULL, NULL)
        ON CONFLICT(provider) DO UPDATE SET last_success_at=excluded.last_success_at, last_failure_at=NULL, error_payload=NULL
      `).run(safe.provider, safe.lastSuccessAt ?? safe.capturedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveFailure(provider: ProviderId, error: CollectorError): void {
    const safe = collectorErrorSchema.parse(redactSecrets(error));
    this.db.prepare(`
      INSERT INTO collector_health(provider, last_failure_at, error_payload) VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET last_failure_at=excluded.last_failure_at, error_payload=excluded.error_payload
    `).run(provider, safe.at, JSON.stringify(safe));
  }

  getProviderState(provider: ProviderId): { snapshot?: ProviderSnapshot; error?: CollectorError } {
    const snapshotRow = this.db.prepare('SELECT payload FROM snapshots WHERE provider = ?').get(provider) as { payload: string } | undefined;
    const healthRow = this.db.prepare('SELECT error_payload FROM collector_health WHERE provider = ?').get(provider) as { error_payload: string | null } | undefined;
    const snapshot = snapshotRow ? providerSnapshotSchema.parse(JSON.parse(snapshotRow.payload)) : undefined;
    const error = healthRow?.error_payload ? collectorErrorSchema.parse(JSON.parse(healthRow.error_payload)) : undefined;
    return { snapshot: snapshot && error ? markSnapshotStale(snapshot, error) : snapshot, error };
  }

  listProviderStates(): Array<{ provider: ProviderId; snapshot?: ProviderSnapshot; error?: CollectorError }> {
    const rows = this.db.prepare('SELECT provider FROM collector_health UNION SELECT provider FROM snapshots').all() as Array<{ provider: ProviderId }>;
    return rows.map(({ provider }) => ({ provider, ...this.getProviderState(provider) }));
  }

  addBalanceObservation(observation: BalanceObservation): void {
    this.db.prepare(`
      INSERT INTO balance_observations(provider, currency, total, observed_at, local_day, adjustment)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(observation.provider, observation.currency, observation.total, observation.observedAt, observation.localDay, observation.adjustment ? 1 : 0);
  }

  listBalanceObservations(provider: ProviderId, currency: string, localDay: string): BalanceObservation[] {
    const rows = this.db.prepare(`
      SELECT provider, currency, total, observed_at, local_day, adjustment
      FROM balance_observations
      WHERE provider = ? AND currency = ? AND local_day = ?
      ORDER BY observed_at ASC, id ASC
    `).all(provider, currency, localDay) as Array<{
      provider: ProviderId; currency: string; total: number; observed_at: string; local_day: string; adjustment: number;
    }>;
    return rows.map((row) => ({
      provider: row.provider,
      currency: row.currency,
      total: row.total,
      observedAt: row.observed_at,
      localDay: row.local_day,
      adjustment: row.adjustment === 1
    }));
  }

  getLatestBalanceObservation(provider: ProviderId, currency: string): BalanceObservation | undefined {
    const row = this.db.prepare(`
      SELECT provider, currency, total, observed_at, local_day, adjustment
      FROM balance_observations WHERE provider = ? AND currency = ?
      ORDER BY observed_at DESC, id DESC LIMIT 1
    `).get(provider, currency) as {
      provider: ProviderId; currency: string; total: number; observed_at: string; local_day: string; adjustment: number;
    } | undefined;
    return row ? {
      provider: row.provider, currency: row.currency, total: row.total,
      observedAt: row.observed_at, localDay: row.local_day, adjustment: row.adjustment === 1
    } : undefined;
  }

  saveDailySummary(provider: ProviderId, currency: string, localDay: string, estimatedSpend: number, partial: boolean, adjustmentCount: number): void {
    this.db.prepare(`
      INSERT INTO daily_summaries(provider, currency, local_day, estimated_spend, partial, adjustment_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, currency, local_day) DO UPDATE SET
        estimated_spend=excluded.estimated_spend,
        partial=excluded.partial,
        adjustment_count=excluded.adjustment_count
    `).run(provider, currency, localDay, estimatedSpend, partial ? 1 : 0, adjustmentCount);
  }

  compactObservations(before: string): void {
    const groups = this.db.prepare(`
      SELECT DISTINCT provider, currency, local_day
      FROM balance_observations WHERE observed_at < ?
    `).all(before) as Array<{ provider: ProviderId; currency: string; local_day: string }>;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const group of groups) {
        const samples = this.listBalanceObservations(group.provider, group.currency, group.local_day)
          .filter((sample) => sample.observedAt < before);
        let estimatedSpend = 0;
        let adjustmentCount = 0;
        for (let index = 1; index < samples.length; index += 1) {
          const difference = samples[index - 1].total - samples[index].total;
          if (difference > 0) estimatedSpend += difference;
          if (difference < 0 || samples[index].adjustment) adjustmentCount += 1;
        }
        this.saveDailySummary(group.provider, group.currency, group.local_day, estimatedSpend, true, adjustmentCount);
      }
      this.db.prepare(`
        DELETE FROM balance_observations
        WHERE observed_at < ?
          AND id NOT IN (SELECT MAX(id) FROM balance_observations GROUP BY provider, currency)
      `).run(before);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getDailySummary(provider: ProviderId, currency: string, localDay: string): { estimatedSpend: number; partial: boolean; adjustmentCount: number } | undefined {
    const row = this.db.prepare(`
      SELECT estimated_spend, partial, adjustment_count FROM daily_summaries
      WHERE provider = ? AND currency = ? AND local_day = ?
    `).get(provider, currency, localDay) as { estimated_spend: number; partial: number; adjustment_count: number } | undefined;
    return row ? { estimatedSpend: row.estimated_spend, partial: row.partial === 1, adjustmentCount: row.adjustment_count } : undefined;
  }

  setSetting(key: string, value: unknown): void {
    if (/(api.?key|token|secret|password|cookie|authorization|session)/i.test(key)) {
      throw new Error('Secret settings must use the operating-system credential store');
    }
    this.db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, JSON.stringify(redactSecrets(value)));
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }

  getDiagnostics(): { location: string; sizeBytes: number } {
    if (this.path === ':memory:') return { location: this.path, sizeBytes: 0 };
    try { return { location: this.path, sizeBytes: statSync(this.path).size }; }
    catch { return { location: this.path, sizeBytes: 0 }; }
  }

  close(): void {
    this.db.close();
  }
}

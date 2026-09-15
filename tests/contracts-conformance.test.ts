import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectorErrorSchema,
  markSnapshotStale,
  normalizeMetric,
  providerSnapshotSchema,
  unavailableSnapshot,
  type CollectorError,
  type Confidence,
  type ProviderSnapshot
} from '../src/shared/contracts';
import { redactSecrets } from '../src/shared/redaction';
import { normalizeCodexRateLimits, normalizeCodexUsage } from '../src/server/adapters/codex/adapter';
import { GlmWalletAdapter, normalizeGlmPayloads, type FetchLike } from '../src/server/adapters/glm';
import { normalizeDeepSeekBalance } from '../src/server/adapters/deepseek';

const fixtureRoot = resolve(__dirname, '..', 'fixtures', 'contracts');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, `${name}.json`), 'utf8')) as T;
}

function localDayIn(timeZone: string, instant: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(instant));
}

function metricByKey(snapshot: ProviderSnapshot, key: string) {
  const metric = snapshot.metrics.find((candidate) => candidate.key === key);
  if (!metric) throw new Error(`metric ${key} is missing from the snapshot`);
  return metric;
}

describe('codex window fixture', () => {
  const parsed = fixture<{
    input: unknown;
    incompatibleInput: { description: string; value: unknown };
    expect: {
      status: string;
      bucketIds: string[];
      primaryWindowSeconds: number;
      secondaryWindowSeconds: number;
      primaryUsedPercent: number;
      primaryRemainingPercent: number;
      primaryResetAt: string;
      secondaryResetAt: string;
      creditedBucketBalance: string;
    };
  }>('codex-windows');

  const snapshot = normalizeCodexRateLimits(parsed.input, new Date('2026-09-10T00:00:00.000Z'));

  it('normalizes every bucket without inventing values for absent ones', () => {
    expect(snapshot.status).toBe(parsed.expect.status);
    const bucketIds = [...new Set(snapshot.metrics
      .map((metric) => (metric.details as { bucketId?: string }).bucketId)
      .filter((bucketId): bucketId is string => typeof bucketId === 'string'))];
    expect(bucketIds.sort()).toEqual([...parsed.expect.bucketIds].sort());
    const noReset = metricByKey(snapshot, 'review.primary.used');
    expect(noReset.resetAt).toBeUndefined();
    const noWindowLength = metricByKey(snapshot, 'unknown-window.primary.used');
    expect(noWindowLength.windowSeconds).toBeUndefined();
    expect(noWindowLength.value).toBe(5);
  });

  it('keeps window length, percentages and the fixed epoch conversion', () => {
    const used = metricByKey(snapshot, 'codex.primary.used');
    expect(used.value).toBe(parsed.expect.primaryUsedPercent);
    expect(used.windowSeconds).toBe(parsed.expect.primaryWindowSeconds);
    expect(used.resetAt).toBe(parsed.expect.primaryResetAt);
    expect(metricByKey(snapshot, 'codex.primary.remaining').value).toBe(parsed.expect.primaryRemainingPercent);
    expect(metricByKey(snapshot, 'codex.secondary.used').windowSeconds).toBe(parsed.expect.secondaryWindowSeconds);
    expect(metricByKey(snapshot, 'codex.secondary.used').resetAt).toBe(parsed.expect.secondaryResetAt);
    expect(maround(metricByKey(snapshot, 'codex.credits.balance').value)).toBe(Number(parsed.expect.creditedBucketBalance));
  });

  it('rejects a payload with an absent percentage instead of zero-filling it', () => {
    expect(parsed.incompatibleInput.description).toMatch(/zero/);
    expect(() => normalizeCodexRateLimits(parsed.incompatibleInput.value, new Date('2026-09-10T00:00:00.000Z'))).toThrow();
  });
});

function maround(value: unknown) {
  return typeof value === 'number' ? Number(value.toFixed(2)) : value;
}

describe('glm connection fixture', () => {
  const parsed = fixture<{
    input: { quota: unknown; modelUsage: unknown; toolUsage: unknown; wallet: unknown };
    expect: {
      connections: string[];
      quotaMetricKeys: string[];
      quotaHealthIndependentOfWallet: boolean;
      walletMetricKeys: string[];
      walletDirection: string;
      walletConfidence: string;
      walletCurrency: string;
      unknownLimitIsDiagnosticOnly: string;
      emptyActivityProducesNoMetric: boolean;
      timeLimitIsNotWeekly: boolean;
    };
  }>('glm-connections');

  const quota = normalizeGlmPayloads(parsed.input.quota, parsed.input.modelUsage, parsed.input.toolUsage, new Date('2026-09-10T08:00:00.000Z'));

  it('keeps quota and wallet as separate connections', () => {
    expect(parsed.expect.connections).toEqual(['glm-quota', 'glm-wallet']);
    expect(quota.source).toBe('glm-monitor');
  });

  it('emits the quota metrics in the confirmed key convention', () => {
    const keys = quota.metrics.map((metric) => metric.key);
    expect(keys).toEqual(parsed.expect.quotaMetricKeys);
    expect(keys).not.toContain('quota.weekly.used.weekly');
  });

  it('keeps an unknown limit as a redacted diagnostic instead of a metric', () => {
    expect(quota.metrics.some((metric) => metric.key.includes('future'))).toBe(false);
    expect(JSON.stringify(quota.diagnostic)).toContain(parsed.expect.unknownLimitIsDiagnosticOnly);
    expect(quota.metrics).toHaveLength(parsed.expect.quotaMetricKeys.length);
  });

  it('reads the wallet connection with its own currency and experimental confidence', async () => {
    let requested = '';
    const fetcher: FetchLike = async (url) => {
      requested = String(url);
      return new Response(JSON.stringify(parsed.input.wallet), { status: 200 });
    };
    const wallet = new GlmWalletAdapter({
      enabled: true,
      endpoint: 'https://example.invalid/user/balance',
      getCredential: async () => 'wallet-key',
      fetcher,
      now: () => new Date('2026-09-10T08:00:00.000Z')
    });
    const snapshot = await wallet.refresh();
    expect(requested).toBe('https://example.invalid/user/balance');
    expect(snapshot.metrics.map((metric) => metric.key)).toEqual(parsed.expect.walletMetricKeys);
    expect(snapshot.metrics[0].direction).toBe(parsed.expect.walletDirection);
    expect(snapshot.metrics[0].confidence).toContain(parsed.expect.walletConfidence);
    expect(snapshot.metrics[0].unit).toBe(parsed.expect.walletCurrency);
    expect(snapshot.source).toBe('glm-wallet-experimental');
  });

  it('keeps quota data when the wallet connection is unavailable', async () => {
    const wallet = new GlmWalletAdapter({
      enabled: false,
      endpoint: '',
      getCredential: async () => undefined,
      fetcher: async () => { throw new Error('must not be called'); }
    });
    await expect(wallet.refresh()).rejects.toThrow(/disabled/i);
    expect(quota.metrics).toHaveLength(parsed.expect.quotaMetricKeys.length);
  });
});

describe('deepseek currency fixture', () => {
  const parsed = fixture<{
    input: unknown;
    expect: {
      status: string;
      currencies: string[];
      totalMetricKeys: string[];
      balanceDirection: string;
      zeroIsReliable: { metricKey: string; value: number };
      spendMetric: { key: string; direction: string; confidence: Confidence[]; partialConfidence: Confidence[] };
      noQuotaOrTokenMetrics: boolean;
    };
  }>('deepseek-currencies');

  const snapshot = normalizeDeepSeekBalance(parsed.input, new Date('2026-09-10T08:00:00.000Z'));

  it('keeps one metric group per currency', () => {
    expect(snapshot.status).toBe(parsed.expect.status);
    expect((snapshot.diagnostic as { currencies: string[] }).currencies).toEqual(parsed.expect.currencies);
    expect(snapshot.metrics.filter((metric) => metric.key.endsWith('.total')).map((metric) => metric.key)).toEqual(parsed.expect.totalMetricKeys);
    expect(snapshot.metrics.every((metric) => metric.direction === parsed.expect.balanceDirection)).toBe(true);
  });

  it('shows a reliable zero instead of treating it as missing', () => {
    const zero = metricByKey(snapshot, parsed.expect.zeroIsReliable.metricKey);
    expect(zero.value).toBe(parsed.expect.zeroIsReliable.value);
    expect(zero.confidence).not.toContain('unavailable');
  });

  it('adds no quota or token metrics that have no verified source', () => {
    const keys = snapshot.metrics.map((metric) => metric.key);
    expect(keys.some((key) => key.includes('quota') || key.includes('tokens'))).toBe(false);
    expect(keys.some((key) => key.includes('plan'))).toBe(false);
  });

  it('marks the daily spend estimate and its partial coverage', () => {
    const estimate = normalizeMetric({
      provider: 'deepseek',
      key: parsed.expect.spendMetric.key,
      unit: 'CNY',
      direction: 'spend',
      value: 1.28,
      confidence: parsed.expect.spendMetric.partialConfidence,
      source: 'balance-delta-estimator'
    });
    expect(estimate.direction).toBe(parsed.expect.spendMetric.direction);
    expect(estimate.confidence).toEqual(expect.arrayContaining(parsed.expect.spendMetric.confidence));
    expect(estimate.confidence).toContain('partial');
  });
});

describe('provider error fixture', () => {
  const parsed = fixture<{
    cases: Array<{ name: string; error: CollectorError; expect: { status: string; metrics: number } }>;
    cachedSnapshot: ProviderSnapshot;
    expect: {
      kinds: string[];
      cachedFailureKeepsLastSuccessAt: string;
      cachedFailureKeepsCapturedAt: string;
      cachedFailureKeepsMetricValue: number;
      cachedFailureMarksStale: boolean;
      failureDoesNotZeroMetrics: boolean;
    };
  }>('provider-errors');

  it.each(parsed.cases.map((entry) => [entry.name, entry] as const))('maps the %s error to a snapshot status', (_name, entry) => {
    const snapshot = unavailableSnapshot('glm', 'glm-monitor', entry.error);
    expect(entry.error.kind).toBe(entry.name);
    expect(snapshot.status).toBe(entry.expect.status);
    expect(snapshot.metrics).toHaveLength(entry.expect.metrics);
  });

  it('covers exactly the shared error vocabulary', () => {
    const covered = parsed.cases.map((entry) => entry.name).sort();
    expect(covered).toEqual(parsed.expect.kinds.filter((kind) => kind !== 'process' && kind !== 'storage').sort());
    for (const entry of parsed.cases) expect(() => collectorErrorSchema.parse(entry.error)).not.toThrow();
  });

  it('keeps the last successful snapshot and its original time after a failure', () => {
    const cached = providerSnapshotSchema.parse(parsed.cachedSnapshot);
    const stale = markSnapshotStale(cached, { kind: 'network', message: 'refresh failed', at: '2026-09-10T08:05:00.000Z' });
    expect(stale.capturedAt).toBe(parsed.expect.cachedFailureKeepsCapturedAt);
    expect(stale.lastSuccessAt).toBe(parsed.expect.cachedFailureKeepsLastSuccessAt);
    expect(stale.metrics[0].confidence).toContain('stale');
    expect(stale.metrics[0].value).toBe(parsed.expect.cachedFailureKeepsMetricValue);
  });
});

describe('daily statistics fixture', () => {
  const parsed = fixture<{
    timezone: string;
    cases: Array<{ name: string; instant: string; expect: { localDay: string } }>;
    localMidnightUtc: { localDay: string; expect: string };
    codexDailyUsage: {
      buckets: Array<{ startDate: string; tokens: number }>;
      expect: {
        reliableZeroIsDisplayed: { localDay: string; value: number };
        yesterdayBucketIsNotTodaysValue: { localDay: string; value: number };
        absentBucketHidesMetric: { localDay: string };
      };
    };
    balanceEstimator: {
      fullDay: { observations: Array<{ total: number }>; expect: { estimatedSpend: number; adjustmentCount: number; partial: boolean } };
      middayStart: { observations: Array<{ total: number }>; expect: { estimatedSpend: number; partial: boolean } };
    };
  }>('daily-statistics');

  it.each(parsed.cases.map((entry) => [entry.name, entry] as const))('resolves %s with the configured timezone', (_name, entry) => {
    expect(localDayIn(parsed.timezone, entry.instant)).toBe(entry.expect.localDay);
  });

  it('resolves the local day boundary to the same instant in both runtimes', () => {
    const startOfDayUtc = new Date(`${parsed.localMidnightUtc.localDay}T00:00:00+08:00`);
    expect(startOfDayUtc.toISOString()).toBe(parsed.localMidnightUtc.expect);
    expect(localDayIn(parsed.timezone, startOfDayUtc.toISOString())).toBe(parsed.localMidnightUtc.localDay);
  });

  it('returns a reliable zero but hides an absent bucket', () => {
    const zero = normalizeCodexUsage({ summary: {}, dailyUsageBuckets: parsed.codexDailyUsage.buckets }, parsed.codexDailyUsage.expect.reliableZeroIsDisplayed.localDay);
    expect(metricByKey({ metrics: zero } as unknown as ProviderSnapshot, 'activity.daily.tokens').value).toBe(parsed.codexDailyUsage.expect.reliableZeroIsDisplayed.value);

    const nextDay = normalizeCodexUsage({ summary: {}, dailyUsageBuckets: parsed.codexDailyUsage.buckets }, parsed.codexDailyUsage.expect.yesterdayBucketIsNotTodaysValue.localDay);
    expect(metricByKey({ metrics: nextDay } as unknown as ProviderSnapshot, 'activity.daily.tokens').value).toBe(parsed.codexDailyUsage.expect.yesterdayBucketIsNotTodaysValue.value);

    const absent = normalizeCodexUsage({ summary: {}, dailyUsageBuckets: parsed.codexDailyUsage.buckets }, parsed.codexDailyUsage.expect.absentBucketHidesMetric.localDay);
    expect(absent.some((metric) => metric.key === 'activity.daily.tokens')).toBe(false);
  });

  it('counts only same-day decreases and never turns a top-up into negative spend', () => {
    for (const scenario of [parsed.balanceEstimator.fullDay, parsed.balanceEstimator.middayStart]) {
      let spend = 0;
      let adjustments = 0;
      for (let index = 1; index < scenario.observations.length; index += 1) {
        const difference = scenario.observations[index - 1].total - scenario.observations[index].total;
        if (difference > 0) spend += difference;
        if (difference < 0) adjustments += 1;
      }
      expect(Number(spend.toFixed(6))).toBe(scenario.expect.estimatedSpend);
      expect(spend).toBeGreaterThanOrEqual(0);
      expect(adjustments).toBe('adjustmentCount' in scenario.expect ? scenario.expect.adjustmentCount : 0);
    }
  });
});

describe('redaction fixture', () => {
  const parsed = fixture<{ cases: Array<{ name: string; input: unknown; expect: unknown }> }>('redaction');

  it.each(parsed.cases.map((entry) => [entry.name, entry] as const))('redacts the %s case', (_name, entry) => {
    expect(redactSecrets(entry.input)).toEqual(entry.expect);
  });

  it('keeps the raw key out of every persisted or rendered payload', () => {
    for (const entry of parsed.cases) {
      const serialized = JSON.stringify(redactSecrets(entry.input));
      expect(serialized).not.toContain('sk-live-not-a-real-key');
      expect(serialized).not.toContain('not-a-real-token');
      expect(serialized).not.toContain('not-a-real-session');
    }
  });
});

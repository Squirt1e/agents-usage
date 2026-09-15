import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeepSeekAdapter, normalizeDeepSeekBalance, type FetchLike } from '../src/server/adapters/deepseek';
import { DailySpendEstimator } from '../src/server/adapters/deepseek-estimator';
import { UsageDatabase } from '../src/server/persistence/database';

const directories: string[] = [];
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'agents-usage-deepseek-'));
  directories.push(directory);
  return new UsageDatabase(join(directory, 'usage.db'));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const balancePayload = {
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' },
    { currency: 'CNY', total_balance: '88.00', granted_balance: '8.00', topped_up_balance: '80.00' }
  ]
};

describe('DeepSeek balance collector', () => {
  it('reads the documented balance endpoint and preserves every currency component', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify(balancePayload), { status: 200 });
    };
    const adapter = new DeepSeekAdapter({
      getCredential: async () => 'deepseek-key', fetcher,
      now: () => new Date('2026-09-10T08:00:00.000Z')
    });

    const snapshot = await adapter.refresh();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.deepseek.com/user/balance');
    expect(requests[0].init?.method).toBe('GET');
    expect((requests[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer deepseek-key');
    expect(snapshot.metrics.find((metric) => metric.key === 'wallet.USD.total')?.value).toBe(12.5);
    expect(snapshot.metrics.find((metric) => metric.key === 'wallet.CNY.granted')?.value).toBe(8);
    expect(snapshot.metrics.find((metric) => metric.key === 'wallet.CNY.topped-up')?.value).toBe(80);
  });

  it('classifies missing keys, authentication failures, and malformed balances', async () => {
    await expect(new DeepSeekAdapter({ getCredential: async () => undefined }).refresh()).rejects.toMatchObject({ kind: 'missing_config' });
    await expect(new DeepSeekAdapter({
      getCredential: async () => 'bad', fetcher: async () => new Response('{}', { status: 401 })
    }).refresh()).rejects.toMatchObject({ kind: 'authentication' });
    expect(() => normalizeDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: 'not-money' }] }, new Date())).toThrow();
  });
});

describe('DeepSeek daily spend estimator', () => {
  it('sums only positive balance decreases and records increase boundaries', () => {
    const db = database();
    const estimator = new DailySpendEstimator(db, 'UTC');
    estimator.record('USD', 10, new Date('2026-09-10T00:00:00.000Z'));
    estimator.record('USD', 8, new Date('2026-09-10T02:00:00.000Z'));
    estimator.record('USD', 12, new Date('2026-09-10T03:00:00.000Z'));
    const result = estimator.record('USD', 10, new Date('2026-09-10T04:00:00.000Z'));

    expect(result).toEqual({ currency: 'USD', localDay: '2026-09-10', estimatedSpend: 4, adjustmentCount: 1, partial: false });
    expect(db.listBalanceObservations('deepseek', 'USD', '2026-09-10').find((sample) => sample.adjustment)).toBeTruthy();
    db.close();
  });

  it('marks late starts partial and never mixes observations across local days', () => {
    const db = database();
    const estimator = new DailySpendEstimator(db, 'Asia/Shanghai');
    const first = estimator.record('CNY', 100, new Date('2026-09-09T23:30:00.000Z'));
    const nextDay = estimator.record('CNY', 90, new Date('2026-09-10T01:00:00.000Z'));

    expect(first).toMatchObject({ localDay: '2026-09-10', estimatedSpend: 0, partial: true });
    expect(nextDay).toMatchObject({ localDay: '2026-09-10', estimatedSpend: 10, partial: true });

    const restartedEstimator = new DailySpendEstimator(db, 'Asia/Shanghai');
    const rollover = restartedEstimator.record('CNY', 80, new Date('2026-09-10T16:30:00.000Z'));
    expect(rollover).toMatchObject({ localDay: '2026-09-11', estimatedSpend: 0, partial: true });
    expect(db.getDailySummary('deepseek', 'CNY', '2026-09-10')).toMatchObject({ estimatedSpend: 10, partial: true });
    db.close();
  });
});

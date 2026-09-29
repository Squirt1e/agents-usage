import { describe, expect, it } from 'vitest';
import { defaultPanelSettings, metricOf, providerStateOf, snapshotOf } from '../../src/desktop/lib/fake-client';
import { minimalSummaries } from '../../src/desktop/panel/minimal-summary';

const now = new Date('2026-09-10T08:00:00.000Z');

describe('minimal summaries', () => {
  it('uses the first trusted quota window and follows remaining or used mode', () => {
    const snapshot = snapshotOf([
      providerStateOf('codex', [
        metricOf({ key: 'quota.5h.used', unit: 'percent', direction: 'used', value: 24, windowSeconds: 18000 }),
        metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 76, windowSeconds: 18000 }),
        metricOf({ key: 'quota.weekly.used', unit: 'percent', direction: 'used', value: 50, windowSeconds: 604800 })
      ]),
      providerStateOf('glm', [
        metricOf({ key: 'quota.weekly.remaining', unit: 'percent', direction: 'remaining', value: 67, connection: { provider: 'glm', connection: 'quota' } }),
        metricOf({ key: 'quota.weekly.used', unit: 'percent', direction: 'used', value: 33, connection: { provider: 'glm', connection: 'quota' } })
      ])
    ]);
    const remaining = minimalSummaries(snapshot, defaultPanelSettings(), now);
    expect(remaining[0]).toMatchObject({ provider: 'codex', kind: 'quota', window: '5h', value: 76 });
    expect(remaining[1]).toMatchObject({ provider: 'glm', kind: 'quota', window: '7d', value: 67 });
    const used = minimalSummaries(snapshot, defaultPanelSettings({ quotaValueMode: 'used' }), now);
    expect(used[0]).toMatchObject({ provider: 'codex', kind: 'quota', window: '5h', value: 24 });
    expect(used[1]).toMatchObject({ provider: 'glm', kind: 'quota', window: '7d', value: 33 });
  });

  it('falls back to wallet, preserves real zero, and never sums currencies', () => {
    const snapshot = snapshotOf([
      providerStateOf('glm', [metricOf({ key: 'wallet.CNY.balance', unit: 'CNY', direction: 'balance', value: 0, connection: { provider: 'glm', connection: 'wallet' } })]),
      providerStateOf('deepseek', [
        metricOf({ key: 'wallet.CNY.total', unit: 'CNY', direction: 'balance', value: 9 }),
        metricOf({ key: 'wallet.USD.total', unit: 'USD', direction: 'balance', value: 3 })
      ])
    ]);
    const summaries = minimalSummaries(snapshot, defaultPanelSettings(), now);
    expect(summaries[1]).toMatchObject({ provider: 'glm', kind: 'balance', value: 0, currency: 'CNY' });
    expect(summaries[2]).toMatchObject({ provider: 'deepseek', kind: 'multi-currency' });
  });

  it('does not reveal hidden providers, disabled wallets, or readings from deleted credentials', () => {
    const snapshot = snapshotOf([
      providerStateOf('glm', [metricOf({ key: 'wallet.CNY.balance', unit: 'CNY', direction: 'balance', value: 42, connection: { provider: 'glm', connection: 'wallet' } })]),
      providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', unit: 'CNY', direction: 'balance', value: 88 })])
    ]);
    const settings = defaultPanelSettings({ glmWalletEnabled: false, platformVisibility: { deepseek: false } });
    expect(minimalSummaries(snapshot, settings, now).map((entry) => [entry.provider, entry.kind])).toEqual([
      ['codex', 'missing'], ['glm', 'missing']
    ]);
    const noKey = defaultPanelSettings({ credentials: { ...settings.credentials, glm: { configured: false }, 'glm-wallet': { configured: false } } });
    expect(minimalSummaries(snapshot, noKey, now)[1]?.kind).toBe('missing');
  });

  it('keeps selected value direction honest and labels stale and low values', () => {
    const snapshot = snapshotOf([
      providerStateOf('glm', [
        metricOf({ key: 'quota.5h.used', unit: 'percent', direction: 'used', value: 99, connection: { provider: 'glm', connection: 'quota' } }),
        metricOf({ key: 'quota.weekly.remaining', unit: 'percent', direction: 'remaining', value: 0, confidence: ['authoritative', 'stale'], connection: { provider: 'glm', connection: 'quota' } }),
        metricOf({ key: 'quota.tools.monthly.remaining', unit: 'percent', direction: 'remaining', value: 80, connection: { provider: 'glm', connection: 'quota' } })
      ])
    ]);
    expect(minimalSummaries(snapshot, defaultPanelSettings(), now)[1]).toMatchObject({ kind: 'quota', window: '7d', value: 0, stale: true, warning: true });
    expect(minimalSummaries(snapshot, defaultPanelSettings({ quotaValueMode: 'used' }), now)[1]).toMatchObject({ kind: 'quota', window: '5h', value: 99 });
  });
});

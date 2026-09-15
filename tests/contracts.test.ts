import { describe, expect, it } from 'vitest';
import {
  markSnapshotStale,
  normalizeMetric,
  providerSnapshotSchema
} from '../src/shared/contracts';
import { redactSecrets } from '../src/shared/redaction';

describe('normalized usage contracts', () => {
  it('represents an omitted value as unavailable instead of zero', () => {
    const metric = normalizeMetric({
      provider: 'glm',
      key: 'weekly-quota',
      unit: 'percent',
      direction: 'used',
      value: undefined,
      source: 'glm-monitor'
    });

    expect(metric.value).toBeNull();
    expect(metric.confidence).toContain('unavailable');
  });

  it('preserves multiple quota windows and currencies', () => {
    const parsed = providerSnapshotSchema.parse({
      provider: 'deepseek',
      status: 'connected',
      capturedAt: '2026-09-10T08:00:00.000Z',
      lastSuccessAt: '2026-09-10T08:00:00.000Z',
      source: 'deepseek-balance',
      metrics: [
        { key: 'usd-total', value: 12.5, unit: 'USD', direction: 'balance', confidence: ['authoritative'], source: 'deepseek-balance' },
        { key: 'cny-total', value: 88, unit: 'CNY', direction: 'balance', confidence: ['authoritative'], source: 'deepseek-balance' },
        { key: 'five-hour', value: 20, unit: 'percent', direction: 'used', windowSeconds: 18_000, confidence: ['authoritative'], source: 'fixture' },
        { key: 'weekly', value: 40, unit: 'percent', direction: 'used', windowSeconds: 604_800, confidence: ['authoritative'], source: 'fixture' }
      ]
    });

    expect(parsed.metrics.map((metric) => metric.unit)).toEqual(['USD', 'CNY', 'percent', 'percent']);
    expect(parsed.metrics).toHaveLength(4);
  });

  it('rejects malformed percentages and timestamps', () => {
    expect(() => normalizeMetric({
      provider: 'codex',
      key: 'primary',
      value: 120,
      unit: 'percent',
      direction: 'used',
      source: 'codex-app-server'
    })).toThrow(/percentage/i);

    expect(() => providerSnapshotSchema.parse({
      provider: 'codex',
      status: 'connected',
      capturedAt: 'yesterday',
      source: 'fixture',
      metrics: []
    })).toThrow();
  });

  it('marks cached values stale while retaining the original capture time', () => {
    const snapshot = providerSnapshotSchema.parse({
      provider: 'codex',
      status: 'connected',
      capturedAt: '2026-09-10T08:00:00.000Z',
      lastSuccessAt: '2026-09-10T08:00:00.000Z',
      source: 'codex-app-server',
      metrics: [{ key: 'primary', value: 15, unit: 'percent', direction: 'used', confidence: ['authoritative'], source: 'codex-app-server' }]
    });

    const stale = markSnapshotStale(snapshot, {
      kind: 'network',
      message: 'Provider timed out',
      at: '2026-09-10T08:05:00.000Z'
    });

    expect(stale.capturedAt).toBe('2026-09-10T08:00:00.000Z');
    expect(stale.metrics[0].confidence).toEqual(['authoritative', 'stale']);
    expect(stale.error?.at).toBe('2026-09-10T08:05:00.000Z');
  });
});

describe('secret redaction', () => {
  it('redacts sensitive keys and embedded bearer credentials recursively', () => {
    const redacted = redactSecrets({
      authorization: 'Bearer sk-secret-value',
      nested: {
        apiKey: 'glm-secret-value',
        message: 'request failed: token=deepseek-secret-value',
        safe: 'keep me'
      },
      cookie: 'session=top-secret'
    });

    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        message: 'request failed: token=[REDACTED]',
        safe: 'keep me'
      },
      cookie: '[REDACTED]'
    });
  });
});

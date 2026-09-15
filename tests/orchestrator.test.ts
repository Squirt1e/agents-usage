import { describe, expect, it } from 'vitest';
import type { ProviderSnapshot } from '../src/shared/contracts';
import { UsageOrchestrator } from '../src/server/orchestrator';
import type { ProviderAdapter } from '../src/server/adapters/types';
import { CollectorFailure } from '../src/server/adapters/types';
import { UsageDatabase } from '../src/server/persistence/database';

function snapshot(provider: 'codex' | 'glm' | 'deepseek', source = 'stable'): ProviderSnapshot {
  return {
    provider,
    status: 'connected',
    capturedAt: '2026-09-10T08:00:00.000Z',
    lastSuccessAt: '2026-09-10T08:00:00.000Z',
    source,
    metrics: [{ key: `${source}.metric`, value: 20, unit: 'percent', direction: 'used', confidence: source === 'experimental' ? ['experimental'] : ['authoritative'], source }]
  };
}

function adapter(provider: 'codex' | 'glm' | 'deepseek', refresh: ProviderAdapter['refresh'], channel: 'stable' | 'experimental' = 'stable'): ProviderAdapter {
  return { provider, channel, refresh };
}

const timing = { refreshMs: 300_000, timeoutMs: 1_000, cooldownMs: 30_000, maxBackoffMs: 900_000 };

describe('collection orchestration', () => {
  it('deduplicates concurrent refreshes and reports cooldown without another upstream call', async () => {
    const db = new UsageDatabase(':memory:');
    let calls = 0;
    let resolve!: (snapshot: ProviderSnapshot) => void;
    const pending = new Promise<ProviderSnapshot>((done) => { resolve = done; });
    const orchestrator = new UsageOrchestrator([adapter('codex', async () => { calls += 1; return pending; })], db, { codex: timing, glm: timing, deepseek: timing }, () => new Date('2026-09-10T08:00:00.000Z'));

    const first = orchestrator.refreshProvider('codex');
    const second = orchestrator.refreshProvider('codex');
    resolve(snapshot('codex'));
    await expect(first).resolves.toMatchObject({ status: 'success' });
    await expect(second).resolves.toMatchObject({ status: 'success' });
    expect(calls).toBe(1);

    await expect(orchestrator.refreshProvider('codex')).resolves.toMatchObject({ status: 'cooldown' });
    expect(calls).toBe(1);
    db.close();
  });

  it('keeps a stale last-known snapshot on stable failure and reports unavailable on first failure', async () => {
    const db = new UsageDatabase(':memory:');
    let fail = false;
    const stable = adapter('deepseek', async () => {
      if (fail) throw new CollectorFailure('network', 'timed out');
      return snapshot('deepseek');
    });
    let now = new Date('2026-09-10T08:00:00.000Z');
    const orchestrator = new UsageOrchestrator([stable], db, { codex: timing, glm: timing, deepseek: { ...timing, cooldownMs: 1 } }, () => now);
    await orchestrator.refreshProvider('deepseek');
    fail = true;
    now = new Date('2026-09-10T08:01:00.000Z');
    const failed = await orchestrator.refreshProvider('deepseek');
    expect(failed.snapshot?.metrics[0].confidence).toContain('stale');
    expect(failed.snapshot?.error?.kind).toBe('network');

    const emptyDb = new UsageDatabase(':memory:');
    const neverWorked = new UsageOrchestrator([adapter('glm', async () => { throw new CollectorFailure('authentication', 'bad key'); })], emptyDb, { codex: timing, glm: timing, deepseek: timing }, () => now);
    const unavailable = await neverWorked.refreshProvider('glm');
    expect(unavailable.snapshot).toMatchObject({ status: 'disconnected', metrics: [], error: { kind: 'authentication' } });
    db.close();
    emptyDb.close();
  });

  it('merges experimental metrics without allowing their failure to suppress stable metrics', async () => {
    const db = new UsageDatabase(':memory:');
    let experimentalFails = false;
    const orchestrator = new UsageOrchestrator([
      adapter('glm', async () => snapshot('glm', 'stable')),
      adapter('glm', async () => {
        if (experimentalFails) throw new CollectorFailure('compatibility', 'wallet changed');
        return snapshot('glm', 'experimental');
      }, 'experimental')
    ], db, { codex: timing, glm: { ...timing, cooldownMs: 1 }, deepseek: timing }, () => new Date('2026-09-10T08:00:00.000Z'));

    const merged = await orchestrator.refreshProvider('glm');
    expect(merged.snapshot?.metrics.map((metric) => metric.source)).toEqual(['stable', 'experimental']);
    experimentalFails = true;
    const second = await orchestrator.refreshProvider('glm', { force: true });
    expect(second.snapshot?.status).toBe('connected');
    expect(second.snapshot?.metrics.some((metric) => metric.source === 'stable')).toBe(true);
    expect(second.snapshot?.diagnostic?.experimentalError).toMatchObject({ kind: 'compatibility' });
    db.close();
  });

  it('does not invoke an experimental adapter before explicit opt-in', async () => {
    const db = new UsageDatabase(':memory:');
    let experimentalCalls = 0;
    const experimental: ProviderAdapter = {
      provider: 'glm', channel: 'experimental', enabled: () => false,
      async refresh() { experimentalCalls += 1; return snapshot('glm', 'experimental'); }
    };
    const orchestrator = new UsageOrchestrator([
      adapter('glm', async () => snapshot('glm', 'stable')), experimental
    ], db, { codex: timing, glm: timing, deepseek: timing });

    const result = await orchestrator.refreshProvider('glm');

    expect(result.snapshot?.metrics).toHaveLength(1);
    expect(experimentalCalls).toBe(0);
    db.close();
  });
});

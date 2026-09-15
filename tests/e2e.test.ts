import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '../src/server/adapters/types';
import { CredentialManager, MemoryCredentialStore } from '../src/server/credentials/store';
import { createRuntime } from '../src/server/index';

describe('fixture-backed local service', () => {
  it('launches and serves all provider states without credentials or model calls', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agents-usage-e2e-'));
    writeFileSync(join(directory, 'index.html'), '<!doctype html><main>agents-usage dashboard</main>');
    const calls: string[] = [];
    const adapters = (['codex', 'glm', 'deepseek'] as const).map((provider): ProviderAdapter => ({
      provider, channel: 'stable', async refresh() {
        calls.push(provider);
        return {
          provider, status: 'connected', capturedAt: '2026-09-10T08:00:00.000Z',
          lastSuccessAt: '2026-09-10T08:00:00.000Z', source: 'fixture', metrics: []
        };
      }
    }));
    const credentials = new CredentialManager(new MemoryCredentialStore(), async () => ({ valid: true }));
    const runtime = createRuntime({ AGENTS_USAGE_DATA_DIR: join(directory, 'data') }, {
      adapters, credentials, clientDir: directory, collectorVersions: { dashboard: 'fixture' }
    });

    try {
      const address = await runtime.start({ port: 0, schedule: false });
      await Promise.all((['codex', 'glm', 'deepseek'] as const).map((provider) => runtime.orchestrator.refreshProvider(provider, { force: true })));
      const providers = (await fetch(`${address.url}/api/snapshots`).then((response) => response.json()) as {
        providers: Array<{ provider: string; snapshot?: { status: string } }>;
      }).providers;
      const html = await fetch(address.url).then((response) => response.text());

      expect(providers.map((entry) => entry.provider)).toEqual(['codex', 'glm', 'deepseek']);
      expect(providers.every((entry) => entry.snapshot?.status === 'connected')).toBe(true);
      expect(calls).toEqual(['codex', 'glm', 'deepseek']);
      expect(html).toContain('agents-usage dashboard');
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

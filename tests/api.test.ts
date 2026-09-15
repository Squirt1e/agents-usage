import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';
import { CredentialManager, MemoryCredentialStore } from '../src/server/credentials/store';
import { UsageDatabase } from '../src/server/persistence/database';
import { UsageOrchestrator } from '../src/server/orchestrator';
import { createDashboardServer, type DashboardServer } from '../src/server/api';
import type { ProviderAdapter } from '../src/server/adapters/types';

const servers: DashboardServer[] = [];
const databases: UsageDatabase[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const db = new UsageDatabase(':memory:');
  databases.push(db);
  const calls = new Map<string, number>();
  const adapters = (['codex', 'glm', 'deepseek'] as const).map((provider): ProviderAdapter => ({
    provider,
    channel: 'stable',
    async refresh() {
      calls.set(provider, (calls.get(provider) ?? 0) + 1);
      const capturedAt = '2026-09-10T08:00:00.000Z';
      return { provider, status: 'connected', capturedAt, lastSuccessAt: capturedAt, source: 'fixture', metrics: [] };
    }
  }));
  const timing = { refreshMs: 300_000, timeoutMs: 1_000, cooldownMs: 30_000, maxBackoffMs: 900_000 };
  const orchestrator = new UsageOrchestrator(adapters, db, { codex: timing, glm: timing, deepseek: timing }, () => new Date('2026-09-10T08:00:00.000Z'));
  const store = new MemoryCredentialStore();
  const credentials = new CredentialManager(store, async (_provider, secret) => ({ valid: secret.startsWith('valid-'), message: 'invalid key' }));
  const config = loadConfig({ AGENTS_USAGE_DATA_DIR: '/tmp/agents-usage-test' });
  const server = createDashboardServer({
    orchestrator, database: db, credentials, config,
    collectorVersions: { dashboard: '0.1.0', codex: '0.152.0', glm: 'monitor-v1', deepseek: 'balance-v1' }
  });
  servers.push(server);
  const address = await server.listen(0);
  return { db, calls, credentials, server, baseUrl: address.url };
}

describe('loopback dashboard API', () => {
  it('serves cached states without triggering upstream refreshes', async () => {
    const { baseUrl, calls } = await fixture();
    const response = await fetch(`${baseUrl}/api/snapshots`);

    expect(response.status).toBe(200);
    expect((await response.json() as { providers: unknown[] }).providers).toHaveLength(3);
    expect(calls.size).toBe(0);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('rejects untrusted origins and mutations without the ephemeral session token', async () => {
    const { baseUrl } = await fixture();
    const hostile = await fetch(`${baseUrl}/api/refresh/codex`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(hostile.status).toBe(403);

    const missingToken = await fetch(`${baseUrl}/api/refresh/codex`, { method: 'POST', headers: { Origin: baseUrl } });
    expect(missingToken.status).toBe(403);
  });

  it('supports masked credential add, replace, and delete flows', async () => {
    const { baseUrl } = await fixture();
    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`).then((response) => response.json()) as { sessionToken: string };
    expect(bootstrap.sessionToken).not.toBe('[REDACTED]');
    const headers = { Origin: baseUrl, 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken };

    const saved = await fetch(`${baseUrl}/api/credentials/glm`, { method: 'PUT', headers, body: JSON.stringify({ secret: 'valid-glm-secret' }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ configured: true, suffix: 'cret' });

    const settingsText = await fetch(`${baseUrl}/api/settings`).then((response) => response.text());
    expect(settingsText).not.toContain('valid-glm-secret');
    expect(JSON.parse(settingsText).credentials.glm).toEqual({ configured: true, suffix: 'cret' });

    const deleted = await fetch(`${baseUrl}/api/credentials/glm`, { method: 'DELETE', headers });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${baseUrl}/api/settings`).then((response) => response.json())).credentials.glm).toEqual({ configured: false });
  });

  it('persists explicit experimental opt-in and removes its credential when disabled', async () => {
    const { baseUrl, credentials } = await fixture();
    await credentials.replace('glm', 'wallet-experimental', 'valid-wallet-secret');
    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`).then((response) => response.json()) as { sessionToken: string };
    const headers = { Origin: baseUrl, 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken };

    const enabled = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT', headers, body: JSON.stringify({ experimental: { glmWallet: true } })
    });
    expect((await enabled.json()).experimental.glmWallet).toBe(true);

    const disabled = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT', headers, body: JSON.stringify({ experimental: { glmWallet: false } })
    });
    expect((await disabled.json()).experimental.glmWallet).toBe(false);
    expect(await credentials.status('glm', 'wallet-experimental')).toEqual({ configured: false });
  });

  it('publishes an initial cached snapshot over server-sent events', async () => {
    const { baseUrl } = await fixture();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const chunk = await response.body!.getReader().read();
    controller.abort();
    expect(new TextDecoder().decode(chunk.value)).toContain('event: snapshot');
  });

  it('reports redacted operational diagnostics without exposing credentials', async () => {
    const { baseUrl, credentials, db } = await fixture();
    await credentials.replace('glm', 'default', 'valid-glm-secret');
    db.saveFailure('glm', {
      kind: 'compatibility', message: 'schema changed', at: '2026-09-10T08:00:00.000Z',
      diagnostic: { authorization: 'Bearer valid-glm-secret' }
    });

    const response = await fetch(`${baseUrl}/api/diagnostics`);
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(body.database).toEqual({ location: ':memory:', sizeBytes: 0 });
    expect(body.collectors.codex).toBe('0.152.0');
    expect(body.providers.glm.currentError).toMatchObject({ kind: 'compatibility' });
    expect(body.credentials.glm).toEqual({ configured: true, suffix: 'cret' });
    expect(text).not.toContain('valid-glm-secret');
  });
});

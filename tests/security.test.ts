import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { createDashboardServer } from '../src/server/api';
import { loadConfig } from '../src/server/config';
import { CredentialManager, MemoryCredentialStore } from '../src/server/credentials/store';
import { UsageOrchestrator } from '../src/server/orchestrator';
import { UsageDatabase } from '../src/server/persistence/database';

const timing = { refreshMs: 300_000, timeoutMs: 1_000, cooldownMs: 30_000, maxBackoffMs: 900_000 };

function requestWithHost(url: string, host: string) {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { headers: { Host: host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('local security boundary', () => {
  it('binds to loopback, rejects hostile Host headers, protects mutations, deletes credentials, and redacts diagnostics', async () => {
    const database = new UsageDatabase(':memory:');
    const credentials = new CredentialManager(new MemoryCredentialStore(), async () => ({ valid: true }));
    const orchestrator = new UsageOrchestrator([], database, { codex: timing, glm: timing, deepseek: timing });
    const server = createDashboardServer({ orchestrator, database, credentials, config: loadConfig({}) });
    const address = await server.listen(0);

    try {
      expect(address.host).toBe('127.0.0.1');
      expect(await requestWithHost(`${address.url}/api/settings`, 'evil.example')).toBe(403);
      expect((await fetch(`${address.url}/api/refresh/glm`, { method: 'POST' })).status).toBe(403);

      await credentials.replace('deepseek', 'default', 'deepseek-private-value', false);
      database.saveFailure('deepseek', {
        kind: 'compatibility', message: 'payload changed', at: '2026-09-10T08:00:00.000Z',
        diagnostic: { cookie: 'deepseek-private-value', authorization: 'Bearer deepseek-private-value' }
      });
      const bootstrap = await fetch(`${address.url}/api/bootstrap`).then((response) => response.json()) as { sessionToken: string };
      const diagnostics = await fetch(`${address.url}/api/diagnostics`).then((response) => response.text());
      const settings = await fetch(`${address.url}/api/settings`).then((response) => response.text());
      expect(diagnostics).not.toContain('deepseek-private-value');
      expect(settings).not.toContain('deepseek-private-value');

      const deleted = await fetch(`${address.url}/api/credentials/deepseek`, {
        method: 'DELETE', headers: { Origin: address.url, 'X-Session-Token': bootstrap.sessionToken }
      });
      expect(deleted.status).toBe(204);
      expect(await credentials.status('deepseek', 'default')).toEqual({ configured: false });
    } finally {
      await server.close();
      database.close();
    }
  });
});

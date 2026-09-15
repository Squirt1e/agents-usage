import { describe, expect, it, vi } from 'vitest';
import rateLimitFixture from './fixtures/codex-rate-limits.json';
import legacyRateLimitFixture from './fixtures/codex-rate-limits-legacy.json';
import { CodexAppServerSupervisor, JsonRpcClient, type RpcMessage, type RpcTransport } from '../src/server/adapters/codex/json-rpc';
import {
  CodexAdapter,
  normalizeCodexRateLimits,
  normalizeCodexUsage,
  parseCodexVersion,
  type CodexRpc
} from '../src/server/adapters/codex/adapter';

class FakeTransport implements RpcTransport {
  sent: RpcMessage[] = [];
  private messageHandler: (message: RpcMessage) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  send(message: RpcMessage) { this.sent.push(message); }
  onMessage(handler: (message: RpcMessage) => void) { this.messageHandler = handler; }
  onClose(handler: (error?: Error) => void) { this.closeHandler = handler; }
  emit(message: RpcMessage) { this.messageHandler(message); }
  fail(error: Error) { this.closeHandler(error); }
  close() {}
}

describe('Codex JSON-RPC client', () => {
  it('correlates responses and sends the initialized notification', async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    const initializing = client.initialize({ name: 'agents-usage', version: '0.1.0' });
    const request = transport.sent[0] as { id: number };
    transport.emit({ id: request.id, result: { userAgent: 'codex-cli/0.152.0', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } });

    await expect(initializing).resolves.toMatchObject({ platformOs: 'macos' });
    expect(transport.sent[1]).toEqual({ method: 'initialized' });
  });

  it('delivers notifications and rejects pending work when the process closes', async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    const notifications: unknown[] = [];
    client.onNotification('account/rateLimits/updated', (params) => notifications.push(params));
    transport.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 8 } } } });
    const pending = client.request('account/read', {});
    transport.fail(new Error('process exited'));

    expect(notifications).toHaveLength(1);
    await expect(pending).rejects.toThrow(/process exited/i);
  });

  it('restarts the app-server client once after a process failure', async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const waits: number[] = [];
    const supervisor = new CodexAppServerSupervisor(
      () => transports.shift()!,
      async (milliseconds) => { waits.push(milliseconds); },
      1_000
    );

    const response = supervisor.request('account/read', {});
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    first.emit({ id: first.sent[0].id, result: { userAgent: 'codex-cli/0.152.0', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } });
    await vi.waitFor(() => expect(first.sent).toHaveLength(3));
    first.fail(new Error('process exited'));
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.emit({ id: second.sent[0].id, result: { userAgent: 'codex-cli/0.152.0', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } });
    await vi.waitFor(() => expect(second.sent).toHaveLength(3));
    second.emit({ id: second.sent[2].id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });

    await expect(response).resolves.toMatchObject({ account: { type: 'chatgpt' } });
    expect(waits).toEqual([250]);
  });
});

describe('Codex usage normalization', () => {
  it('preserves every quota bucket with used, remaining, reset, plan, and credit values', () => {
    const snapshot = normalizeCodexRateLimits(rateLimitFixture, new Date('2026-09-10T08:00:00.000Z'));

    expect(snapshot.provider).toBe('codex');
    expect(snapshot.metrics.find((metric) => metric.key === 'codex.primary.remaining')?.value).toBe(85);
    expect(snapshot.metrics.find((metric) => metric.key === 'codex.secondary.used')?.windowSeconds).toBe(604_800);
    expect(snapshot.metrics.find((metric) => metric.key === 'review.primary.used')).toBeTruthy();
    expect(snapshot.metrics.find((metric) => metric.key === 'codex.credits.balance')?.value).toBe(12.5);
    expect(snapshot.diagnostic?.sharedBucket).toBe('codex');
    expect(normalizeCodexRateLimits(legacyRateLimitFixture, new Date('2026-09-10T08:00:00.000Z')).metrics[0].key).toBe('codex.primary.used');
  });

  it('normalizes optional daily activity without treating it as quota', () => {
    const metrics = normalizeCodexUsage({
      summary: { lifetimeTokens: 1_000_000, currentStreakDays: 3 },
      dailyUsageBuckets: [{ startDate: '2026-09-10', tokens: 42_000 }]
    }, '2026-09-10');

    expect(metrics.find((metric) => metric.key === 'activity.daily.tokens')?.value).toBe(42_000);
    expect(metrics.find((metric) => metric.key === 'activity.daily.tokens')?.direction).toBe('activity');
  });

  it('reports a signed-out account as an authentication failure and never reads usage files', async () => {
    const methods: string[] = [];
    const rpc: CodexRpc = {
      request: vi.fn(async (method: string) => {
        methods.push(method);
        return method === 'account/read' ? { account: null, requiresOpenaiAuth: true } : {};
      }),
      onNotification: () => undefined
    };
    const adapter = new CodexAdapter(rpc, () => new Date('2026-09-10T08:00:00.000Z'));

    await expect(adapter.refresh()).rejects.toMatchObject({ kind: 'authentication' });
    expect(methods).toEqual(['account/read']);
  });

  it('parses CLI versions for compatibility diagnostics', () => {
    expect(parseCodexVersion('codex-cli 0.152.0')).toEqual({ major: 0, minor: 152, patch: 0 });
    expect(parseCodexVersion('unexpected')).toBeUndefined();
  });
});

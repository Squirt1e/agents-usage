import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderSnapshot } from '../src/shared/contracts';
import { UsageDatabase } from '../src/server/persistence/database';
import { createSafeLogger } from '../src/server/logging';
import {
  CredentialManager,
  MacOSKeychainStore,
  MemoryCredentialStore,
  createCommandRunner,
  type CommandRunner,
  type CredentialValidator,
  type SpawnCommand
} from '../src/server/credentials/store';

const temporaryDirectories: string[] = [];

function database() {
  const directory = mkdtempSync(join(tmpdir(), 'agents-usage-'));
  temporaryDirectories.push(directory);
  return new UsageDatabase(join(directory, 'usage.db'));
}

function snapshot(): ProviderSnapshot {
  return {
    provider: 'deepseek',
    status: 'connected',
    capturedAt: '2026-09-10T08:00:00.000Z',
    lastSuccessAt: '2026-09-10T08:00:00.000Z',
    source: 'fixture',
    metrics: [{
      key: 'usd-total',
      value: 12.5,
      unit: 'USD',
      direction: 'balance',
      confidence: ['authoritative'],
      source: 'fixture'
    }]
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SQLite usage persistence', () => {
  it('retains the last successful snapshot and separate failure time', () => {
    const db = database();
    db.saveSuccessfulSnapshot(snapshot());
    db.saveFailure('deepseek', {
      kind: 'network',
      message: 'request timed out',
      at: '2026-09-10T08:05:00.000Z'
    });

    const state = db.getProviderState('deepseek');
    expect(state.snapshot?.capturedAt).toBe('2026-09-10T08:00:00.000Z');
    expect(state.snapshot?.metrics[0].confidence).toContain('stale');
    expect(state.error?.at).toBe('2026-09-10T08:05:00.000Z');
    db.close();
  });

  it('compacts old observations while retaining daily totals and the latest sample', () => {
    const db = database();
    db.addBalanceObservation({ provider: 'deepseek', currency: 'USD', total: 10, observedAt: '2026-09-01T00:00:00.000Z', localDay: '2026-09-01', adjustment: false });
    db.addBalanceObservation({ provider: 'deepseek', currency: 'USD', total: 8, observedAt: '2026-09-01T02:00:00.000Z', localDay: '2026-09-01', adjustment: false });
    db.addBalanceObservation({ provider: 'deepseek', currency: 'USD', total: 7, observedAt: '2026-09-10T08:00:00.000Z', localDay: '2026-09-10', adjustment: false });

    db.compactObservations('2026-09-05T00:00:00.000Z');

    expect(db.getDailySummary('deepseek', 'USD', '2026-09-01')).toMatchObject({ estimatedSpend: 2, partial: true });
    expect(db.listBalanceObservations('deepseek', 'USD', '2026-09-01')).toHaveLength(0);
    expect(db.listBalanceObservations('deepseek', 'USD', '2026-09-10')).toHaveLength(1);
    db.close();
  });

  it('rejects secret settings and redacts diagnostic payloads before persistence', () => {
    const db = database();
    expect(() => db.setSetting('deepseek.apiKey', 'do-not-store')).toThrow(/secret/i);
    db.saveSuccessfulSnapshot({
      ...snapshot(),
      diagnostic: { authorization: 'Bearer do-not-store', safe: 'visible' }
    });

    const stored = db.getProviderState('deepseek').snapshot;
    expect(stored?.diagnostic).toEqual({ authorization: '[REDACTED]', safe: 'visible' });
    expect(readFileSync(db.path).includes(Buffer.from('do-not-store'))).toBe(false);
    db.close();
  });
});

describe('credential lifecycle', () => {
  it('detaches Keychain commands from the parent terminal so prompts consume stdin', async () => {
    let detached: boolean | undefined;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
    }) as unknown as ChildProcessWithoutNullStreams;
    const spawnCommand: SpawnCommand = (_command, _args, options) => {
      detached = options.detached;
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };

    await createCommandRunner(spawnCommand)('security', ['probe'], 'value');

    expect(detached).toBe(true);
  });

  it('redacts credentials before diagnostic logging', () => {
    const lines: string[] = [];
    const logger = createSafeLogger((line) => lines.push(line));

    logger.error('provider failed', { authorization: 'Bearer hidden-value', safe: 'network' });

    expect(lines.join('\n')).not.toContain('hidden-value');
    expect(lines.join('\n')).toContain('[REDACTED]');
    expect(lines.join('\n')).toContain('network');
  });

  it('uses a provider-scoped macOS Keychain service without placing secrets in arguments', async () => {
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    const runner: CommandRunner = async (command, args, input) => {
      calls.push({ command, args, input });
      return { stdout: args.includes('-w') ? 'stored-secret\n' : '', stderr: '' };
    };
    const store = new MacOSKeychainStore(runner);

    await store.set('glm', 'default', 'stored-secret');
    expect(await store.get('glm', 'default')).toBe('stored-secret');
    await store.delete('glm', 'default');

    expect(calls.map(({ command }) => command)).toEqual(['security', 'security', 'security']);
    expect(calls[0].args).not.toContain('stored-secret');
    // `security ... -w` prompts for the password twice; one line stores an empty value after retry.
    expect(calls[0].input).toBe('stored-secret\nstored-secret');
    expect(calls[1].args).toContain('agents-usage.glm');
  });

  it('validates a replacement before swapping the stored key', async () => {
    const store = new MemoryCredentialStore();
    await store.set('glm', 'default', 'old-secret');
    const validator: CredentialValidator = async (_provider, secret) => ({
      valid: secret === 'new-valid-secret',
      message: secret === 'new-valid-secret' ? undefined : 'invalid key'
    });
    const manager = new CredentialManager(store, validator);

    await expect(manager.replace('glm', 'default', 'bad-secret')).rejects.toThrow(/invalid key/i);
    expect(await store.get('glm', 'default')).toBe('old-secret');

    await manager.replace('glm', 'default', 'new-valid-secret');
    expect(await manager.status('glm', 'default')).toEqual({ configured: true, suffix: 'cret' });
    expect(await store.get('glm', 'default')).toBe('new-valid-secret');
  });

  it('deletes provider credentials without returning their prior value', async () => {
    const store = new MemoryCredentialStore();
    await store.set('deepseek', 'default', 'secret-value');
    const manager = new CredentialManager(store, async () => ({ valid: true }));

    await expect(manager.delete('deepseek', 'default')).resolves.toBeUndefined();
    expect(await manager.status('deepseek', 'default')).toEqual({ configured: false });
  });
});

/**
 * In-memory `UsageClient` for tests and for exercising the panel without a
 * service.
 *
 * The panel tests and the Tauri host work both need a client that behaves like a
 * real one and records what the UI asked for. This module is deliberately *not*
 * imported by `main.ts`: the shipped panel always talks to the host or the local
 * service. It is a development/test double, and its call log is what lets a test
 * assert that hiding a platform did not delete a credential.
 */

import type { CollectorError, MetricDirection, ProviderId } from '../shared/contracts';
import {
  parsePanelSettings,
  parseUsageMetric,
  type ConnectionId,
  type ConnectionStatus,
  type CredentialStatus,
  type CredentialTarget,
  type DesktopProviderSnapshot,
  type DesktopProviderState,
  type DesktopUsageMetric,
  type PanelSettings,
  type PanelSettingsPatch,
  type PanelSnapshot
} from '../shared/desktop-contract';
import { UsageClientError, type PanelEvent, type RefreshResult, type UsageClient } from '../shared/usage-client';

export type FakeUsageClientMethod = keyof UsageClient;

export interface FakeUsageClientCall {
  method: FakeUsageClientMethod | 'emit';
  args: unknown[];
}

export interface FakeUsageClient extends UsageClient {
  readonly calls: FakeUsageClientCall[];
  /** Argument lists of every call to one method, in order. */
  methodCalls(method: FakeUsageClientMethod): unknown[][];
  /** Events pushed to subscribers so far. */
  readonly emitted: PanelEvent[];
  emit(event: PanelEvent): void;
  currentSnapshot(): PanelSnapshot;
  setSnapshot(snapshot: PanelSnapshot): void;
  currentSettings(): PanelSettings;
  setSettings(settings: PanelSettings): void;
  /** Make the next credential validation fail. Pass `null` to succeed again. */
  failValidation(message: string | null): void;
  /** Number of times `openWebVersion` was called. */
  readonly webVersionOpens: number;
}

export interface FakeUsageClientOptions {
  snapshot?: PanelSnapshot;
  settings?: Partial<PanelSettings>;
  /** Reject `readSnapshot` with this error. */
  snapshotError?: Error;
  refresh?: Partial<RefreshResult>;
  /**
   * State the service publishes when it runs a manual refresh: `readSnapshot`
   * returns it from then on.
   *
   * A real service answers a manual refresh with an acknowledgement and publishes
   * what it did, so this — not `refresh.status` — is where a test says whether the
   * collection succeeded. `refresh.status` stays for the transports that do carry a
   * verdict (`cooldown`, or a failure the service reported in the reply).
   */
  refreshedSnapshot?: PanelSnapshot;
  /** Secrets the fake service must reject as invalid. */
  invalidSecrets?: string[];
  validateError?: string;
}

export function createFakeUsageClient(options: FakeUsageClientOptions = {}): FakeUsageClient {
  let snapshot: PanelSnapshot = options.snapshot ?? { providers: [] };
  let settings: PanelSettings = defaultPanelSettings(options.settings);
  let validateError: string | null = options.validateError ?? null;
  const invalidSecrets = options.invalidSecrets ?? [];
  const calls: FakeUsageClientCall[] = [];
  const emitted: PanelEvent[] = [];
  const listeners = new Set<(event: PanelEvent) => void>();
  let webVersionOpens = 0;

  const record = (method: FakeUsageClientMethod, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const client: FakeUsageClient = {
    calls,
    emitted,
    get webVersionOpens() {
      return webVersionOpens;
    },
    methodCalls(method) {
      return calls.filter((call) => call.method === method).map((call) => call.args);
    },
    emit(event) {
      emitted.push(event);
      for (const listener of [...listeners]) listener(event);
    },
    currentSnapshot() {
      return snapshot;
    },
    setSnapshot(next) {
      snapshot = next;
    },
    currentSettings() {
      return settings;
    },
    setSettings(next) {
      settings = next;
    },
    failValidation(message) {
      validateError = message;
    },
    async readSnapshot() {
      record('readSnapshot');
      if (options.snapshotError) throw options.snapshotError;
      return snapshot;
    },
    async readSettings() {
      record('readSettings');
      return settings;
    },
    async updateSettings(patch: PanelSettingsPatch) {
      record('updateSettings', patch);
      settings = {
        ...settings,
        ...patch,
        platformVisibility: { ...settings.platformVisibility, ...(patch.platformVisibility ?? {}) },
        credentials: settings.credentials
      };
      return settings;
    },
    async refresh(provider: ProviderId) {
      record('refresh', provider);
      // Publishing before answering mirrors the real service, and it is what the
      // panel reads its verdict from.
      if (options.refreshedSnapshot) snapshot = options.refreshedSnapshot;
      const result = options.refresh ?? {};
      return {
        provider,
        // The default mirrors the service the panel actually talks to: a manual
        // refresh is acknowledged without a verdict, and what happened is read from
        // the state published above. A test that wants a verdict passes one.
        status: result.status ?? 'requested',
        at: result.at ?? '2026-09-10T08:00:00.000Z',
        ...(result.nextEligibleAt ? { nextEligibleAt: result.nextEligibleAt } : {}),
        ...(result.error ? { error: result.error } : {})
      };
    },
    async validateCredential(target: CredentialTarget, secret: string): Promise<CredentialStatus> {
      record('validateCredential', target, secret);
      if (validateError !== null || invalidSecrets.includes(secret)) {
        throw new UsageClientError('invalid', validateError ?? '密钥验证失败，原凭据保持不变', { status: 400 });
      }
      const status: CredentialStatus = {
        configured: true,
        suffix: secret.slice(-4),
        validatedAt: '2026-09-10T08:00:00.000Z'
      };
      settings = { ...settings, credentials: { ...settings.credentials, [target]: status } };
      return status;
    },
    async deleteCredential(target: CredentialTarget) {
      record('deleteCredential', target);
      settings = { ...settings, credentials: { ...settings.credentials, [target]: { configured: false } } };
    },
    subscribe(listener) {
      record('subscribe');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async openWebVersion() {
      record('openWebVersion');
      webVersionOpens += 1;
    }
  };
  return client;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

export function defaultPanelSettings(patch: Partial<PanelSettings> = {}): PanelSettings {
  return parsePanelSettings({
    timezone: 'Asia/Shanghai',
    glmRegion: 'china',
    glmWalletEnabled: true,
    glmWalletVisible: true,
    platformVisibility: {},
    credentials: {
      glm: { configured: true, suffix: '1234' },
      deepseek: { configured: true, suffix: '9012' },
      'glm-wallet': { configured: true, suffix: '5678' },
      codex: { delegated: true }
    },
    ...patch
  });
}

/**
 * Build a metric through the same parser the transports use, so a fixture has
 * exactly the shape a real snapshot has (including the scope derived from
 * `details.localDay`). Absent fields stay absent, never zero.
 */
export function metricOf(input: {
  key: string;
  unit: string;
  direction: MetricDirection;
  value: number | string | null;
} & Partial<DesktopUsageMetric>): DesktopUsageMetric {
  const parsed = parseUsageMetric({ source: 'fixture', confidence: ['authoritative'], ...input });
  if (!parsed) throw new Error(`invalid test metric: ${String(input.key)}`);
  return parsed;
}

export interface ProviderStateInput extends Partial<Omit<DesktopProviderState, 'provider' | 'snapshot'>> {
  /** Capture time of the produced snapshot. */
  capturedAt?: string;
  status?: ConnectionStatus;
  source?: string;
}

export function providerStateOf(
  provider: ProviderId,
  metrics: DesktopUsageMetric[],
  input: ProviderStateInput = {}
): DesktopProviderState {
  const { capturedAt = '2026-09-10T08:00:00.000Z', status = 'connected', source = 'fixture', ...rest } = input;
  const connection = rest.connection;
  return {
    provider,
    snapshot: {
      provider,
      status,
      capturedAt,
      lastSuccessAt: capturedAt,
      source,
      metrics,
      ...(connection ? { connection } : {})
    },
    ...rest
  };
}

/** A provider state that failed, optionally keeping its last good snapshot. */
export function failedStateOf(
  provider: ProviderId,
  error: CollectorError,
  input: { snapshot?: DesktopProviderSnapshot; connection?: ConnectionId } = {}
): DesktopProviderState {
  return {
    provider,
    error,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    ...(input.connection ? { connection: input.connection } : {})
  };
}

export function snapshotOf(providers: DesktopProviderState[]): PanelSnapshot {
  return { providers, generatedAt: '2026-09-10T08:00:00.000Z' };
}

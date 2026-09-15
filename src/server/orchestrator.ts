import { EventEmitter } from 'node:events';
import {
  providerSnapshotSchema,
  unavailableSnapshot,
  type CollectorError,
  type ProviderId,
  type ProviderSnapshot
} from '../shared/contracts';
import { CollectorFailure, type ProviderAdapter } from './adapters/types';
import type { ProviderTiming } from './config';
import type { UsageDatabase } from './persistence/database';

export interface RefreshResult {
  status: 'success' | 'failure' | 'cooldown';
  snapshot?: ProviderSnapshot;
  nextEligibleAt?: string;
}

export class UsageOrchestrator {
  private readonly inFlight = new Map<ProviderId, Promise<RefreshResult>>();
  private readonly lastAttempt = new Map<ProviderId, number>();
  private readonly failures = new Map<ProviderId, number>();
  private readonly events = new EventEmitter();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly adapters: ProviderAdapter[],
    private readonly database: UsageDatabase,
    private readonly timings: Record<ProviderId, ProviderTiming>,
    private readonly now: () => Date = () => new Date()
  ) {}

  refreshProvider(provider: ProviderId, options: { force?: boolean } = {}): Promise<RefreshResult> {
    const running = this.inFlight.get(provider);
    if (running) return running;
    const nowMs = this.now().getTime();
    const previousAttempt = this.lastAttempt.get(provider);
    const backoff = Math.min(1_000 * 2 ** Math.max(0, (this.failures.get(provider) ?? 0) - 1), this.timings[provider].maxBackoffMs);
    const waitMs = Math.max(this.timings[provider].cooldownMs, (this.failures.get(provider) ?? 0) > 0 ? backoff : 0);
    if (!options.force && previousAttempt !== undefined && nowMs < previousAttempt + waitMs) {
      return Promise.resolve({
        status: 'cooldown',
        snapshot: this.database.getProviderState(provider).snapshot,
        nextEligibleAt: new Date(previousAttempt + waitMs).toISOString()
      });
    }
    this.lastAttempt.set(provider, nowMs);
    const refresh = this.performRefresh(provider).finally(() => this.inFlight.delete(provider));
    this.inFlight.set(provider, refresh);
    return refresh;
  }

  private async performRefresh(provider: ProviderId): Promise<RefreshResult> {
    const adapters = this.adapters.filter((adapter) => adapter.provider === provider);
    const stable = adapters.find((adapter) => adapter.channel === 'stable');
    const experimental = adapters.filter((adapter) => adapter.channel === 'experimental' && adapter.enabled?.() !== false);
    if (!stable) return this.failure(provider, new CollectorFailure('missing_config', `No stable ${provider} adapter is configured`));

    const stableResult = await this.runAdapter(stable).then(
      (snapshot) => ({ ok: true as const, snapshot }),
      (error) => ({ ok: false as const, error })
    );
    if (!stableResult.ok) return this.failure(provider, stableResult.error);

    const experimentalResults = await Promise.all(experimental.map((adapter) => this.runAdapter(adapter).then(
      (snapshot) => ({ ok: true as const, snapshot }),
      (error) => ({ ok: false as const, error })
    )));
    const successfulExperimental = experimentalResults.filter((result): result is { ok: true; snapshot: ProviderSnapshot } => result.ok);
    const experimentalFailure = experimentalResults.find((result): result is { ok: false; error: unknown } => !result.ok);
    const merged = providerSnapshotSchema.parse({
      ...stableResult.snapshot,
      source: successfulExperimental.length ? `${stableResult.snapshot.source}+experimental` : stableResult.snapshot.source,
      metrics: [...stableResult.snapshot.metrics, ...successfulExperimental.flatMap((result) => result.snapshot.metrics)],
      diagnostic: {
        ...(stableResult.snapshot.diagnostic ?? {}),
        ...(experimentalFailure ? { experimentalError: this.toCollectorError(experimentalFailure.error) } : {})
      }
    });
    this.failures.set(provider, 0);
    this.database.saveSuccessfulSnapshot(merged);
    const result: RefreshResult = { status: 'success', snapshot: merged };
    this.events.emit('update', { provider, result });
    return result;
  }

  private runAdapter(adapter: ProviderAdapter): Promise<ProviderSnapshot> {
    const controller = new AbortController();
    const timeoutMs = this.timings[adapter.provider].timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new CollectorFailure('network', `${adapter.provider} collector timed out`));
      }, timeoutMs);
      adapter.refresh(controller.signal).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  private failure(provider: ProviderId, cause: unknown): RefreshResult {
    const error = this.toCollectorError(cause);
    this.failures.set(provider, (this.failures.get(provider) ?? 0) + 1);
    this.database.saveFailure(provider, error);
    const persisted = this.database.getProviderState(provider).snapshot;
    const snapshot = persisted ?? unavailableSnapshot(provider, `${provider}-collector`, error);
    const result: RefreshResult = { status: 'failure', snapshot };
    this.events.emit('update', { provider, result });
    return result;
  }

  private toCollectorError(cause: unknown): CollectorError {
    const failure = cause instanceof CollectorFailure ? cause : new CollectorFailure('unknown', cause instanceof Error ? cause.message : String(cause));
    return {
      kind: failure.kind,
      message: failure.message,
      at: this.now().toISOString(),
      ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {})
    };
  }

  getProviderState(provider: ProviderId) {
    return this.database.getProviderState(provider);
  }

  getAllStates() {
    return (['codex', 'glm', 'deepseek'] as const).map((provider) => ({ provider, ...this.database.getProviderState(provider) }));
  }

  getDiagnostics() {
    return Object.fromEntries((['codex', 'glm', 'deepseek'] as const).map((provider) => {
      const state = this.database.getProviderState(provider);
      const failureCount = this.failures.get(provider) ?? 0;
      const lastAttempt = this.lastAttempt.get(provider);
      const backoffMs = failureCount > 0
        ? Math.min(1_000 * 2 ** Math.max(0, failureCount - 1), this.timings[provider].maxBackoffMs)
        : 0;
      const waitMs = lastAttempt === undefined ? 0 : Math.max(this.timings[provider].cooldownMs, backoffMs);
      return [provider, {
        channels: this.adapters.filter((adapter) => adapter.provider === provider).map((adapter) => adapter.channel),
        lastSuccessAt: state.snapshot?.lastSuccessAt,
        lastAttemptAt: lastAttempt === undefined ? undefined : new Date(lastAttempt).toISOString(),
        consecutiveFailures: failureCount,
        backoffMs,
        nextEligibleAt: lastAttempt === undefined ? undefined : new Date(lastAttempt + waitMs).toISOString(),
        currentError: state.error
      }];
    }));
  }

  subscribe(listener: (event: { provider: ProviderId; result: RefreshResult }) => void) {
    this.events.on('update', listener);
    return () => this.events.off('update', listener);
  }

  start() {
    for (const provider of ['codex', 'glm', 'deepseek'] as const) {
      void this.refreshProvider(provider);
      const timer = setInterval(() => { void this.refreshProvider(provider); }, this.timings[provider].refreshMs);
      timer.unref();
      this.timers.add(timer);
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}

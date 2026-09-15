import { z } from 'zod';
import {
  normalizeMetric,
  providerSnapshotSchema,
  type ProviderSnapshot,
  type UsageMetric
} from '../../../shared/contracts';
import { redactSecrets } from '../../../shared/redaction';
import { CollectorFailure, type ProviderAdapter } from '../types';

export interface CodexRpc {
  request(method: string, params?: unknown): Promise<any>;
  onNotification(method: string, handler: (params: unknown) => void): void;
}

export class CodexAdapter {
  readonly provider = 'codex' as const;
  readonly channel = 'stable' as const;
  private readonly updateHandlers = new Set<() => void>();

  constructor(private readonly rpc: CodexRpc, private readonly now: () => Date = () => new Date()) {
    rpc.onNotification('account/rateLimits/updated', () => {
      for (const handler of this.updateHandlers) handler();
    });
  }

  onRateLimitsUpdated(handler: () => void) {
    this.updateHandlers.add(handler);
  }

  async refresh(): Promise<ProviderSnapshot> {
    const account = await this.rpc.request('account/read', {});
    if (!account?.account) {
      throw new CollectorFailure('authentication', 'Codex is not signed in; complete sign-in through Codex');
    }
    let snapshot: ProviderSnapshot;
    try {
      snapshot = normalizeCodexRateLimits(await this.rpc.request('account/rateLimits/read', {}), this.now());
    } catch (error) {
      if (error instanceof CollectorFailure) throw error;
      throw new CollectorFailure('compatibility', 'Codex rate-limit response is incompatible', { cause: String(error) });
    }
    try {
      const usage = await this.rpc.request('account/usage/read', {});
      const day = this.now().toISOString().slice(0, 10);
      snapshot = providerSnapshotSchema.parse({ ...snapshot, metrics: [...snapshot.metrics, ...normalizeCodexUsage(usage, day)] });
    } catch {
      // Daily activity is optional and never suppresses authoritative rate-limit data.
    }
    return snapshot;
  }
}

const rateLimitWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: z.number().int().positive().nullable().optional()
});

const rateLimitSnapshotSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  planType: z.string().nullable().optional(),
  primary: rateLimitWindowSchema.nullable().optional(),
  secondary: rateLimitWindowSchema.nullable().optional(),
  credits: z.object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullable().optional()
  }).nullable().optional()
}).passthrough();

const rateLimitsResponseSchema = z.object({
  accountId: z.string().nullable().optional(),
  rateLimits: rateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), rateLimitSnapshotSchema).nullable().optional(),
  rateLimitResetCredits: z.unknown().optional()
}).passthrough();

function windowMetrics(bucketId: string, bucket: z.infer<typeof rateLimitSnapshotSchema>, name: 'primary' | 'secondary'): UsageMetric[] {
  const window = bucket[name];
  if (!window) return [];
  const resetAt = window.resetsAt ? new Date(window.resetsAt * 1_000).toISOString() : undefined;
  const details = { bucketId, bucketName: bucket.limitName ?? undefined, planType: bucket.planType ?? undefined };
  return [
    normalizeMetric({ provider: 'codex', key: `${bucketId}.${name}.used`, label: `${bucket.limitName ?? bucketId} ${name}`, value: window.usedPercent, unit: 'percent', direction: 'used', resetAt, windowSeconds: window.windowDurationMins ? window.windowDurationMins * 60 : undefined, source: 'codex-app-server', details }),
    normalizeMetric({ provider: 'codex', key: `${bucketId}.${name}.remaining`, label: `${bucket.limitName ?? bucketId} ${name}`, value: 100 - window.usedPercent, unit: 'percent', direction: 'remaining', resetAt, windowSeconds: window.windowDurationMins ? window.windowDurationMins * 60 : undefined, source: 'codex-app-server', details })
  ];
}

export function normalizeCodexRateLimits(value: unknown, now: Date): ProviderSnapshot {
  const response = rateLimitsResponseSchema.parse(value);
  const buckets = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length > 0
    ? response.rateLimitsByLimitId
    : { codex: response.rateLimits };
  const metrics: UsageMetric[] = [];
  for (const [key, bucket] of Object.entries(buckets)) {
    const bucketId = bucket.limitId ?? key;
    metrics.push(...windowMetrics(bucketId, bucket, 'primary'), ...windowMetrics(bucketId, bucket, 'secondary'));
    if (bucket.credits?.balance != null) {
      const balance = Number(bucket.credits.balance);
      metrics.push(normalizeMetric({
        provider: 'codex', key: `${bucketId}.credits.balance`, label: 'Credits',
        value: Number.isFinite(balance) ? balance : bucket.credits.balance,
        unit: 'credits', direction: 'balance', source: 'codex-app-server',
        details: { hasCredits: bucket.credits.hasCredits, unlimited: bucket.credits.unlimited }
      }));
    }
  }
  const capturedAt = now.toISOString();
  return providerSnapshotSchema.parse({
    provider: 'codex', status: 'connected', capturedAt, lastSuccessAt: capturedAt,
    source: 'codex-app-server', metrics,
    diagnostic: redactSecrets({ accountId: response.accountId, sharedBucket: Object.hasOwn(buckets, 'codex') ? 'codex' : null })
  });
}

const usageSchema = z.object({
  summary: z.object({
    currentStreakDays: z.number().int().nullable().optional(),
    lifetimeTokens: z.number().int().nullable().optional(),
    longestRunningTurnSec: z.number().int().nullable().optional(),
    longestStreakDays: z.number().int().nullable().optional(),
    peakDailyTokens: z.number().int().nullable().optional()
  }),
  dailyUsageBuckets: z.array(z.object({ startDate: z.string(), tokens: z.number().int().nonnegative() })).nullable().optional()
});

export function normalizeCodexUsage(value: unknown, localDay: string): UsageMetric[] {
  const usage = usageSchema.parse(value);
  const metrics: UsageMetric[] = [];
  const today = usage.dailyUsageBuckets?.find((bucket) => bucket.startDate === localDay);
  if (today) metrics.push(normalizeMetric({ provider: 'codex', key: 'activity.daily.tokens', label: 'Today tokens', value: today.tokens, unit: 'tokens', direction: 'activity', source: 'codex-app-server' }));
  if (usage.summary.lifetimeTokens != null) metrics.push(normalizeMetric({ provider: 'codex', key: 'activity.lifetime.tokens', label: 'Lifetime tokens', value: usage.summary.lifetimeTokens, unit: 'tokens', direction: 'activity', source: 'codex-app-server' }));
  return metrics;
}

export function parseCodexVersion(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : undefined;
}

export function isSupportedCodexVersion(value: string) {
  const version = parseCodexVersion(value);
  return Boolean(version && (version.major > 0 || version.minor >= 100));
}

export type CodexProviderAdapter = ProviderAdapter & CodexAdapter;

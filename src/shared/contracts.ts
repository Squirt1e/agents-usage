import { z } from 'zod';

export const providerIdSchema = z.enum(['codex', 'glm', 'deepseek']);
export const confidenceSchema = z.enum([
  'authoritative',
  'experimental',
  'estimated',
  'partial',
  'stale',
  'unavailable'
]);
export const metricDirectionSchema = z.enum(['used', 'remaining', 'balance', 'spend', 'activity']);
export const connectionStatusSchema = z.enum(['connected', 'degraded', 'disconnected', 'unavailable']);
export const errorKindSchema = z.enum([
  'missing_config',
  'authentication',
  'compatibility',
  'network',
  'rate_limit',
  'process',
  'storage',
  'unknown'
]);

const isoTimestamp = z.string().datetime({ offset: true });
const jsonObject = z.record(z.string(), z.unknown());

export const collectorErrorSchema = z.object({
  kind: errorKindSchema,
  message: z.string().min(1).max(500),
  at: isoTimestamp,
  retryAt: isoTimestamp.optional(),
  diagnostic: jsonObject.optional()
});

export const usageMetricSchema = z.object({
  key: z.string().min(1).max(120),
  label: z.string().max(160).optional(),
  value: z.union([z.number().finite(), z.string().max(500), z.null()]),
  unit: z.string().min(1).max(24),
  direction: metricDirectionSchema,
  limit: z.number().finite().optional(),
  resetAt: isoTimestamp.optional(),
  windowSeconds: z.number().int().positive().optional(),
  confidence: z.array(confidenceSchema).min(1),
  source: z.string().min(1).max(120),
  details: jsonObject.optional()
}).superRefine((metric, context) => {
  if (metric.unit === 'percent' && typeof metric.value === 'number' && (metric.value < 0 || metric.value > 100)) {
    context.addIssue({ code: 'custom', message: 'Percentage must be between 0 and 100', path: ['value'] });
  }
});

export const providerSnapshotSchema = z.object({
  provider: providerIdSchema,
  status: connectionStatusSchema,
  capturedAt: isoTimestamp,
  lastSuccessAt: isoTimestamp.optional(),
  source: z.string().min(1).max(120),
  metrics: z.array(usageMetricSchema),
  error: collectorErrorSchema.optional(),
  diagnostic: jsonObject.optional()
});

export type ProviderId = z.infer<typeof providerIdSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type MetricDirection = z.infer<typeof metricDirectionSchema>;
export type CollectorError = z.infer<typeof collectorErrorSchema>;
export type UsageMetric = z.infer<typeof usageMetricSchema>;
export type ProviderSnapshot = z.infer<typeof providerSnapshotSchema>;

export interface MetricInput {
  provider: ProviderId;
  key: string;
  label?: string;
  value: number | string | null | undefined;
  unit: string;
  direction: MetricDirection;
  limit?: number;
  resetAt?: string;
  windowSeconds?: number;
  confidence?: Confidence[];
  source: string;
  details?: Record<string, unknown>;
}

export function normalizeMetric(input: MetricInput): UsageMetric {
  const unavailable = input.value === undefined || input.value === null;
  const confidence = [...(input.confidence ?? ['authoritative'])];
  if (unavailable && !confidence.includes('unavailable')) confidence.push('unavailable');
  return usageMetricSchema.parse({
    key: input.key,
    label: input.label,
    value: unavailable ? null : input.value,
    unit: input.unit,
    direction: input.direction,
    limit: input.limit,
    resetAt: input.resetAt,
    windowSeconds: input.windowSeconds,
    confidence,
    source: input.source,
    details: input.details
  });
}

export function markSnapshotStale(snapshot: ProviderSnapshot, error: CollectorError): ProviderSnapshot {
  return providerSnapshotSchema.parse({
    ...snapshot,
    status: 'degraded',
    error,
    metrics: snapshot.metrics.map((metric) => ({
      ...metric,
      confidence: metric.confidence.includes('stale') ? metric.confidence : [...metric.confidence, 'stale']
    }))
  });
}

export function unavailableSnapshot(provider: ProviderId, source: string, error: CollectorError): ProviderSnapshot {
  return providerSnapshotSchema.parse({
    provider,
    status: error.kind === 'missing_config' || error.kind === 'authentication' ? 'disconnected' : 'unavailable',
    capturedAt: error.at,
    source,
    metrics: [],
    error
  });
}

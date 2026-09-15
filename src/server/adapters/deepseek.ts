import { z } from 'zod';
import { normalizeMetric, providerSnapshotSchema, type ProviderSnapshot } from '../../shared/contracts';
import { CollectorFailure, type ProviderAdapter } from './types';
import type { DailySpendEstimator } from './deepseek-estimator';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface DeepSeekOptions {
  getCredential: () => Promise<string | undefined>;
  fetcher?: FetchLike;
  now?: () => Date;
  estimator?: DailySpendEstimator;
}

export class DeepSeekAdapter implements ProviderAdapter {
  readonly provider = 'deepseek' as const;
  readonly channel = 'stable' as const;

  constructor(private readonly options: DeepSeekOptions) {}

  async refresh(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const credential = await this.options.getCredential();
    if (!credential) throw new CollectorFailure('missing_config', 'DeepSeek API key is not configured');
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)('https://api.deepseek.com/user/balance', {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
        signal
      });
    } catch (error) {
      throw new CollectorFailure('network', 'DeepSeek balance request failed', { cause: String(error) });
    }
    if (response.status === 401 || response.status === 403) throw new CollectorFailure('authentication', 'DeepSeek rejected the API key');
    if (response.status === 429) throw new CollectorFailure('rate_limit', 'DeepSeek balance endpoint is rate limited');
    if (!response.ok) throw new CollectorFailure('network', `DeepSeek balance request failed with HTTP ${response.status}`);
    let raw: unknown;
    try { raw = await response.json(); }
    catch { throw new CollectorFailure('compatibility', 'DeepSeek balance response is not valid JSON'); }
    const now = (this.options.now ?? (() => new Date()))();
    let snapshot: ProviderSnapshot;
    try { snapshot = normalizeDeepSeekBalance(raw, now); }
    catch (error) { throw new CollectorFailure('compatibility', 'DeepSeek balance response is incompatible', { cause: String(error) }); }
    if (this.options.estimator) {
      const totals = snapshot.metrics.filter((metric) => metric.key.endsWith('.total') && typeof metric.value === 'number');
      for (const metric of totals) {
        const estimate = this.options.estimator.record(metric.unit, metric.value as number, now);
        snapshot.metrics.push(normalizeMetric({
          provider: 'deepseek', key: `spend.${metric.unit}.daily`, label: 'Today spend',
          value: estimate.estimatedSpend, unit: metric.unit, direction: 'spend',
          confidence: estimate.partial ? ['estimated', 'partial'] : ['estimated'],
          source: 'balance-delta-estimator',
          details: { localDay: estimate.localDay, adjustmentCount: estimate.adjustmentCount }
        }));
      }
    }
    return snapshot;
  }
}

const money = z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number);
const balanceSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({
    currency: z.string().min(1).max(12),
    total_balance: money,
    granted_balance: money,
    topped_up_balance: money
  }))
});

export function normalizeDeepSeekBalance(value: unknown, now: Date): ProviderSnapshot {
  const balance = balanceSchema.parse(value);
  const metrics = balance.balance_infos.flatMap((entry) => [
    normalizeMetric({ provider: 'deepseek', key: `wallet.${entry.currency}.total`, label: 'Total balance', value: entry.total_balance, unit: entry.currency, direction: 'balance', source: 'deepseek-balance', details: { available: balance.is_available } }),
    normalizeMetric({ provider: 'deepseek', key: `wallet.${entry.currency}.granted`, label: 'Granted balance', value: entry.granted_balance, unit: entry.currency, direction: 'balance', source: 'deepseek-balance' }),
    normalizeMetric({ provider: 'deepseek', key: `wallet.${entry.currency}.topped-up`, label: 'Topped-up balance', value: entry.topped_up_balance, unit: entry.currency, direction: 'balance', source: 'deepseek-balance' })
  ]);
  const capturedAt = now.toISOString();
  return providerSnapshotSchema.parse({
    provider: 'deepseek', status: 'connected', capturedAt, lastSuccessAt: capturedAt,
    source: 'deepseek-balance', metrics,
    diagnostic: { available: balance.is_available, currencies: balance.balance_infos.map((entry) => entry.currency) }
  });
}

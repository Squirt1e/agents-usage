import { localDayIn, visibleProviders, type DesktopUsageMetric, type PanelSettings, type PanelSnapshot } from '../../shared/desktop-contract';
import type { ProviderId } from '../../shared/contracts';
import {
  codexWindows,
  glmQuotaWindows,
  metricNumber,
  providerView,
  quotaRemainingPercent,
  shouldRenderMetric,
  totalBalances,
  walletBalances,
  withoutConnection,
  type MetricGateOptions
} from '../lib/metrics';

export type MinimalSummary =
  | { provider: ProviderId; kind: 'missing' }
  | { provider: ProviderId; kind: 'quota'; window: '5h' | '7d' | '30d'; value: number; remaining: number; stale: boolean; warning: boolean; resetAt?: string }
  | { provider: ProviderId; kind: 'balance'; value: number; currency: string; stale: boolean; warning: boolean }
  | { provider: ProviderId; kind: 'multi-currency'; stale: boolean; warning: boolean };

function usable(metric: DesktopUsageMetric | undefined, gate: MetricGateOptions): DesktopUsageMetric | undefined {
  return shouldRenderMetric(metric, gate).render && metricNumber(metric) !== null ? metric : undefined;
}

function quotaSummary(
  provider: ProviderId,
  windows: Array<{ id: string; used?: DesktopUsageMetric; remaining?: DesktopUsageMetric }>,
  settings: PanelSettings,
  gate: MetricGateOptions
): MinimalSummary | undefined {
  const names: Record<string, '5h' | '7d' | '30d'> = {
    'five-hour': '5h', '5h': '5h', weekly: '7d', 'tools.monthly': '30d'
  };
  for (const window of windows) {
    const remainingMetric = usable(window.remaining, gate);
    const usedMetric = usable(window.used, gate);
    const remaining = quotaRemainingPercent(remainingMetric, usedMetric);
    if (remaining === null) continue;
    const selected = settings.quotaValueMode === 'remaining' ? remainingMetric : usedMetric;
    const value = metricNumber(selected);
    const name = names[window.id];
    if (value === null || name === undefined) continue;
    const source = selected;
    return {
      provider,
      kind: 'quota',
      window: name,
      value,
      remaining,
      stale: source?.confidence.includes('stale') === true,
      warning: settings.quotaWarningThreshold > 0 && remaining <= settings.quotaWarningThreshold,
      ...(source?.resetAt ? { resetAt: source.resetAt } : {})
    };
  }
  return undefined;
}

export function minimalSummaries(snapshot: PanelSnapshot | undefined, settings: PanelSettings, now: Date): MinimalSummary[] {
  const gate: MetricGateOptions = { now, timezone: settings.timezone, localDay: localDayIn(settings.timezone, now) };
  return visibleProviders(settings).map((provider): MinimalSummary => {
    const off = provider === 'glm' && !settings.glmWalletEnabled ? 'wallet' : provider === 'deepseek' && !settings.deepseekWebEnabled ? 'web' : undefined;
    const view = providerView(off && snapshot ? withoutConnection(snapshot, provider, off) : snapshot, provider);
    if (provider === 'codex') return quotaSummary(provider, codexWindows(view), settings, gate) ?? { provider, kind: 'missing' };
    if (provider === 'glm' && settings.credentials.glm.configured) {
      const quota = quotaSummary(provider, glmQuotaWindows(view), settings, gate);
      if (quota) return quota;
    }
    const balances = provider === 'glm'
      ? settings.glmWalletEnabled && settings.credentials['glm-wallet'].configured ? walletBalances(view) : []
      : settings.credentials.deepseek.configured ? totalBalances(view) : [];
    const trusted = balances.filter(({ metric }) => usable(metric, gate));
    if (trusted.length === 0) return { provider, kind: 'missing' };
    const warning = settings.balanceWarningThreshold > 0 && trusted.some(({ metric }) => {
      const amount = metricNumber(metric);
      return amount !== null && amount <= settings.balanceWarningThreshold;
    });
    const stale = trusted.some(({ metric }) => metric.confidence.includes('stale'));
    if (trusted.length > 1) return { provider, kind: 'multi-currency', stale, warning };
    const first = trusted[0]!;
    return { provider, kind: 'balance', value: metricNumber(first.metric)!, currency: first.currency, stale, warning };
  });
}

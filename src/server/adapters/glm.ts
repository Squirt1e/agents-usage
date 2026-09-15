import { z } from 'zod';
import { normalizeMetric, providerSnapshotSchema, type ProviderSnapshot, type UsageMetric } from '../../shared/contracts';
import { redactSecrets } from '../../shared/redaction';
import { CollectorFailure, type ProviderAdapter } from './types';

export type GlmRegion = 'china' | 'international';
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function glmBaseDomain(region: GlmRegion): string {
  return region === 'china' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
}

const quotaEntrySchema = z.object({
  type: z.string(),
  percentage: z.number().min(0).max(100).optional(),
  currentValue: z.number().optional(),
  usage: z.number().optional(),
  nextResetTime: z.number().positive().optional(),
  windowDuration: z.string().optional(),
  usageDetails: z.unknown().optional()
}).passthrough();

const activityEntrySchema = z.object({
  model: z.string().optional(),
  tool: z.string().optional(),
  tokens: z.number().nonnegative().optional(),
  count: z.number().nonnegative().optional(),
  usage: z.number().nonnegative().optional()
}).passthrough();

function unwrapData(value: unknown): unknown {
  return value && typeof value === 'object' && 'data' in value ? (value as { data: unknown }).data : value;
}

function durationSeconds(window: string | undefined) {
  if (!window) return undefined;
  const match = window.match(/^(\d+)\s*([hd])$/i);
  if (!match) return undefined;
  return Number(match[1]) * (match[2].toLowerCase() === 'h' ? 3_600 : 86_400);
}

function formatLocalDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function quotaKey(entry: z.infer<typeof quotaEntrySchema>) {
  const type = entry.type.toUpperCase();
  const window = entry.windowDuration?.toLowerCase();
  if (type.includes('WEEK') || window === '7d' || window === '168h') return 'weekly';
  if (type === 'TOKENS_LIMIT' || window === '5h') return '5h';
  if (type === 'TIME_LIMIT') return 'tools.monthly';
  return undefined;
}

export function normalizeGlmPayloads(quotaValue: unknown, modelValue: unknown, toolValue: unknown, now: Date): ProviderSnapshot {
  const parsedQuota = z.object({ limits: z.array(quotaEntrySchema) }).safeParse(unwrapData(quotaValue));
  if (!parsedQuota.success) throw new CollectorFailure('compatibility', 'GLM quota response omitted the limits array', { issues: parsedQuota.error.issues });
  const quota = parsedQuota.data;
  const metrics: UsageMetric[] = [];
  const unknownLimits: unknown[] = [];
  for (const entry of quota.limits) {
    const key = quotaKey(entry);
    if (!key) {
      unknownLimits.push(redactSecrets(entry));
      continue;
    }
    if (entry.percentage === undefined) throw new CollectorFailure('compatibility', `GLM quota ${entry.type} omitted percentage`);
    const resetAt = entry.nextResetTime ? new Date(entry.nextResetTime).toISOString() : undefined;
    const windowSeconds = durationSeconds(entry.windowDuration) ?? (key === '5h' ? 18_000 : key === 'weekly' ? 604_800 : undefined);
    metrics.push(
      normalizeMetric({ provider: 'glm', key: `quota.${key}.used`, label: `${key} used`, value: entry.percentage, unit: 'percent', direction: 'used', resetAt, windowSeconds, source: 'glm-monitor', details: { type: entry.type, currentValue: entry.currentValue, limit: entry.usage } }),
      normalizeMetric({ provider: 'glm', key: `quota.${key}.remaining`, label: `${key} remaining`, value: 100 - entry.percentage, unit: 'percent', direction: 'remaining', resetAt, windowSeconds, source: 'glm-monitor', details: { type: entry.type, currentValue: entry.currentValue, limit: entry.usage } })
    );
  }
  if (!metrics.length) throw new CollectorFailure('compatibility', 'GLM quota response contains no recognized quota entries', { unknownLimits });

  const modelEntries = z.array(activityEntrySchema).catch([]).parse(unwrapData(modelValue));
  for (const entry of modelEntries) {
    if (entry.model && entry.tokens !== undefined) metrics.push(normalizeMetric({ provider: 'glm', key: `model.${entry.model}.tokens`, label: entry.model, value: entry.tokens, unit: 'tokens', direction: 'activity', source: 'glm-monitor' }));
  }
  const toolEntries = z.array(activityEntrySchema).catch([]).parse(unwrapData(toolValue));
  for (const entry of toolEntries) {
    if (entry.tool && (entry.count ?? entry.usage) !== undefined) metrics.push(normalizeMetric({ provider: 'glm', key: `tool.${entry.tool}.count`, label: entry.tool, value: entry.count ?? entry.usage, unit: 'calls', direction: 'activity', source: 'glm-monitor' }));
  }

  const capturedAt = now.toISOString();
  return providerSnapshotSchema.parse({
    provider: 'glm', status: 'connected', capturedAt, lastSuccessAt: capturedAt,
    source: 'glm-monitor', metrics,
    diagnostic: { unknownLimits }
  });
}

interface GlmAdapterOptions {
  region: GlmRegion | (() => GlmRegion);
  getCredential: () => Promise<string | undefined>;
  fetcher?: FetchLike;
  now?: () => Date;
}

async function readJson(response: Response, label: string) {
  if (response.status === 401 || response.status === 403) throw new CollectorFailure('authentication', `GLM rejected the Coding Plan key (${response.status})`);
  if (response.status === 429) throw new CollectorFailure('rate_limit', 'GLM usage endpoint is rate limited');
  if (!response.ok) throw new CollectorFailure('network', `${label} failed with HTTP ${response.status}`);
  try {
    const value = await response.json();
    if (value && typeof value === 'object' && (value as Record<string, unknown>).success === false) {
      const rawMessage = (value as Record<string, unknown>).msg;
      const message = typeof rawMessage === 'string' && rawMessage.trim() ? rawMessage.trim().slice(0, 300) : 'request rejected';
      const kind = /coding\s*plan|套餐|未开通|不存在/i.test(message) ? 'missing_config' : 'authentication';
      throw new CollectorFailure(kind, `GLM: ${String(redactSecrets(message))}`, {
        code: (value as Record<string, unknown>).code
      });
    }
    return value;
  }
  catch (error) {
    if (error instanceof CollectorFailure) throw error;
    throw new CollectorFailure('compatibility', `${label} returned invalid JSON`);
  }
}

export class GlmAdapter implements ProviderAdapter {
  readonly provider = 'glm' as const;
  readonly channel = 'stable' as const;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly options: GlmAdapterOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async refresh(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const key = await this.options.getCredential();
    if (!key) throw new CollectorFailure('missing_config', 'GLM Coding Plan API key is not configured');
    const region = typeof this.options.region === 'function' ? this.options.region() : this.options.region;
    const base = glmBaseDomain(region);
    const headers = { Authorization: key, 'Accept-Language': 'en-US,en', 'Content-Type': 'application/json' };
    const now = this.now();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59, 999);
    const query = new URLSearchParams({ startTime: formatLocalDateTime(start), endTime: formatLocalDateTime(end) });
    const request = (path: string, withQuery = true) => this.fetcher(`${base}${path}${withQuery ? `?${query}` : ''}`, { method: 'GET', headers, signal });
    const [modelResponse, toolResponse, quotaResponse] = await Promise.all([
      request('/api/monitor/usage/model-usage'),
      request('/api/monitor/usage/tool-usage'),
      request('/api/monitor/usage/quota/limit', false)
    ]);
    const [models, tools, quota] = await Promise.all([
      readJson(modelResponse, 'GLM model usage'), readJson(toolResponse, 'GLM tool usage'), readJson(quotaResponse, 'GLM quota')
    ]);
    try { return normalizeGlmPayloads(quota, models, tools, now); }
    catch (error) {
      if (error instanceof CollectorFailure) throw error;
      throw new CollectorFailure('compatibility', 'GLM monitor response is incompatible', { cause: String(error) });
    }
  }
}

interface GlmWalletOptions {
  enabled: boolean | (() => boolean);
  endpoint: string;
  getCredential: () => Promise<string | undefined>;
  fetcher?: FetchLike;
  now?: () => Date;
}

export class GlmWalletAdapter implements ProviderAdapter {
  readonly provider = 'glm' as const;
  readonly channel = 'experimental' as const;

  constructor(private readonly options: GlmWalletOptions) {}

  enabled(): boolean {
    return typeof this.options.enabled === 'function' ? this.options.enabled() : this.options.enabled;
  }

  async refresh(signal?: AbortSignal): Promise<ProviderSnapshot> {
    if (!this.enabled()) throw new CollectorFailure('missing_config', 'Experimental GLM wallet collection is disabled');
    const credential = await this.options.getCredential();
    if (!credential) throw new CollectorFailure('missing_config', 'Experimental GLM wallet credential is not configured');
    let url: URL;
    try { url = new URL(this.options.endpoint); }
    catch { throw new CollectorFailure('missing_config', 'Experimental GLM wallet endpoint is invalid'); }
    if (url.protocol !== 'https:') throw new CollectorFailure('missing_config', 'Experimental GLM wallet endpoint must use HTTPS');
    const response = await (this.options.fetcher ?? fetch)(url, { method: 'GET', headers: { Authorization: credential }, signal });
    const raw = await readJson(response, 'Experimental GLM wallet');
    const data = z.object({ balance: z.number(), currency: z.string().min(1) }).parse(unwrapData(raw));
    const capturedAt = (this.options.now ?? (() => new Date()))().toISOString();
    return providerSnapshotSchema.parse({
      provider: 'glm', status: 'connected', capturedAt, lastSuccessAt: capturedAt,
      source: 'glm-wallet-experimental',
      metrics: [normalizeMetric({ provider: 'glm', key: `wallet.${data.currency}.balance`, label: 'Wallet balance', value: data.balance, unit: data.currency, direction: 'balance', confidence: ['experimental'], source: 'glm-wallet-experimental' })]
    });
  }
}

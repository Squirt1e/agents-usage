import { describe, expect, it } from 'vitest';
import { CollectorFailure } from '../src/server/adapters/types';
import {
  GlmAdapter,
  GlmWalletAdapter,
  glmBaseDomain,
  normalizeGlmPayloads,
  type FetchLike
} from '../src/server/adapters/glm';

const quotaPayload = {
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', percentage: 18, windowDuration: '5h', nextResetTime: 1_789_000_000_000 },
      { type: 'WEEKLY_LIMIT', percentage: 36, windowDuration: '7d', nextResetTime: 1_789_600_000_000 },
      { type: 'TIME_LIMIT', percentage: 20, currentValue: 20, usage: 100 },
      { type: 'NEW_UNKNOWN_LIMIT', percentage: 9, privateToken: 'must-not-leak' }
    ]
  }
};

describe('GLM stable collector', () => {
  it('uses the selected provider-owned domain and only read-only monitor requests', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/quota/limit')) return new Response(JSON.stringify(quotaPayload), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const adapter = new GlmAdapter({
      region: 'international',
      getCredential: async () => 'glm-key-value',
      fetcher,
      now: () => new Date('2026-09-10T08:00:00.000Z')
    });

    const snapshot = await adapter.refresh();

    expect(glmBaseDomain('china')).toBe('https://open.bigmodel.cn');
    expect(glmBaseDomain('international')).toBe('https://api.z.ai');
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.init?.method === 'GET')).toBe(true);
    expect(requests.every((request) => request.url.includes('/api/monitor/usage/'))).toBe(true);
    expect(requests.every((request) => request.init?.headers && (request.init.headers as Record<string, string>).Authorization === 'glm-key-value')).toBe(true);
    expect(snapshot.metrics.find((metric) => metric.key === 'quota.5h.remaining')?.value).toBe(82);
    expect(snapshot.metrics.find((metric) => metric.key === 'quota.weekly.used')?.value).toBe(36);
    expect(JSON.stringify(snapshot.diagnostic)).not.toContain('must-not-leak');
  });

  it('resolves the selected region at refresh time', async () => {
    let region: 'china' | 'international' = 'china';
    const urls: string[] = [];
    const adapter = new GlmAdapter({
      region: () => region,
      getCredential: async () => 'key',
      fetcher: async (url) => {
        urls.push(String(url));
        if (String(url).endsWith('/quota/limit')) return new Response(JSON.stringify(quotaPayload), { status: 200 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
    });

    await adapter.refresh();
    region = 'international';
    await adapter.refresh();

    expect(urls.slice(0, 3).every((url) => url.startsWith('https://open.bigmodel.cn'))).toBe(true);
    expect(urls.slice(3).every((url) => url.startsWith('https://api.z.ai'))).toBe(true);
  });

  it('uses the provider-required local date-time format for activity queries', async () => {
    const urls: URL[] = [];
    const adapter = new GlmAdapter({
      region: 'china', getCredential: async () => 'key',
      fetcher: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        if (url.pathname.endsWith('/quota/limit')) return new Response(JSON.stringify(quotaPayload), { status: 200 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
      now: () => new Date('2026-09-10T08:23:45.000Z')
    });

    await adapter.refresh();

    for (const url of urls.filter((entry) => !entry.pathname.endsWith('/quota/limit'))) {
      expect(url.searchParams.get('startTime')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/);
      expect(url.searchParams.get('endTime')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:59:59$/);
    }
  });

  it('preserves model and tool activity as non-quota metrics', () => {
    const snapshot = normalizeGlmPayloads(
      quotaPayload,
      { data: [{ model: 'glm-5', tokens: 1200 }] },
      { data: [{ tool: 'web-search', count: 4 }] },
      new Date('2026-09-10T08:00:00.000Z')
    );

    expect(snapshot.metrics.find((metric) => metric.key === 'model.glm-5.tokens')?.direction).toBe('activity');
    expect(snapshot.metrics.find((metric) => metric.key === 'tool.web-search.count')?.value).toBe(4);
  });

  it('classifies missing keys, authentication, rate limiting, and incompatible schemas', async () => {
    const noKey = new GlmAdapter({ region: 'china', getCredential: async () => undefined });
    await expect(noKey.refresh()).rejects.toMatchObject({ kind: 'missing_config' });

    for (const [status, kind] of [[401, 'authentication'], [429, 'rate_limit']] as const) {
      const adapter = new GlmAdapter({
        region: 'china', getCredential: async () => 'key',
        fetcher: async () => new Response('{}', { status })
      });
      await expect(adapter.refresh()).rejects.toMatchObject({ kind });
    }

    expect(() => normalizeGlmPayloads({ data: { changed: true } }, { data: [] }, { data: [] }, new Date())).toThrow(CollectorFailure);
  });

  it('surfaces an HTTP 200 Coding Plan business rejection instead of reporting a schema change', async () => {
    const adapter = new GlmAdapter({
      region: 'china', getCredential: async () => 'key',
      fetcher: async () => new Response(JSON.stringify({
        code: 500, msg: '当前用户不存在coding plan', success: false
      }), { status: 200 })
    });

    await expect(adapter.refresh()).rejects.toMatchObject({
      kind: 'missing_config', message: 'GLM: 当前用户不存在coding plan'
    });
  });
});

describe('GLM experimental wallet collector', () => {
  it('is disabled by default and labels enabled balance data experimental', async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: { balance: 88.5, currency: 'CNY' } }), { status: 200 });
    };
    const disabled = new GlmWalletAdapter({ enabled: false, endpoint: 'https://example.invalid/balance', getCredential: async () => 'account-token', fetcher });
    await expect(disabled.refresh()).rejects.toMatchObject({ kind: 'missing_config' });
    expect(calls).toBe(0);

    const enabled = new GlmWalletAdapter({ enabled: true, endpoint: 'https://wallet.example.test/balance', getCredential: async () => 'account-token', fetcher, now: () => new Date('2026-09-10T08:00:00.000Z') });
    const snapshot = await enabled.refresh();
    expect(snapshot.metrics[0]).toMatchObject({ value: 88.5, unit: 'CNY', confidence: ['experimental'] });
  });
});

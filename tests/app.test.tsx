// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/client/App';

type Listener = (event: MessageEvent) => void;

class FakeEventSource {
  static instance: FakeEventSource;
  private listeners = new Map<string, Listener>();
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.instance = this; }
  addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener as Listener); }
  emit(name: string, data: unknown) { this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) })); }
  close() {}
}

const settings = {
  glmRegion: 'china' as const,
  timezone: 'Asia/Shanghai',
  experimental: { glmWallet: false },
  credentials: { glm: { configured: false }, deepseek: { configured: false }, glmWallet: { configured: false }, codex: { delegated: true as const } }
};

const emptyProviders = (['codex', 'glm', 'deepseek'] as const).map((provider) => ({ provider }));

describe('dashboard application', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') return new Response(JSON.stringify({ sessionToken: 'local-session', settings }), { status: 200 });
      if (url === '/api/snapshots') return new Response(JSON.stringify({ providers: emptyProviders }), { status: 200 });
      if (url.startsWith('/api/refresh/')) return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
  });

  it('offers an overview refresh and applies live snapshot events', async () => {
    render(<App />);
    await screen.findByText('本地采集 · 只读面板');

    fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/refresh/codex', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/refresh/glm', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/refresh/deepseek', expect.objectContaining({ method: 'POST' })));

    FakeEventSource.instance.emit('snapshot', { providers: [{
      provider: 'deepseek', snapshot: {
        provider: 'deepseek', status: 'connected', capturedAt: '2026-09-10T08:00:00.000Z',
        lastSuccessAt: '2026-09-10T08:00:00.000Z', source: 'fixture', metrics: [{
          key: 'wallet.CNY.total', label: '总余额', value: 42, unit: 'CNY', direction: 'balance', confidence: ['authoritative'], source: 'fixture'
        }]
      }
    }] });
    expect(await screen.findByText('¥42.00')).toBeVisible();
  });
});

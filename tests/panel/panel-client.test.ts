// Task 6.1: the shared usage client and its two transports.
//
// @vitest-environment jsdom
// Covers the HTTP transport (error mapping, session token on mutations, and the
// settings round trip: the service speaks the panel contract natively, so every
// field must survive the ride untouched) and the desktop transport (Tauri
// bridge commands, injected host configuration, and the HTTP fallback when no
// bridge exists). The event stream is exercised with a fake `EventSource` so a
// dropped stream is deterministic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpUsageClient,
  UsageClientError,
  type EventSourceLike,
  type PanelEvent
} from '../../src/shared/usage-client';
import {
  createBrowserFallbackHost,
  createDesktopHostControls,
  createDesktopUsageClient,
  detectDesktopBridge,
  DESKTOP_COMMANDS,
  DESKTOP_EVENTS,
  type DesktopCommandBridge
} from '../../src/desktop/lib/desktop-client';

type Listener = (event: { data?: string }) => void;

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  onerror: ((event: unknown) => void) | null = null;
  onopen: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }

  fail() {
    this.onerror?.({ type: 'error' });
  }
}

/** Panel-shaped settings as the local service stores and returns them. */
const serviceSettings = {
  theme: 'dark',
  timezone: 'Asia/Shanghai',
  glmRegion: 'china',
  glmWalletEnabled: true,
  platformVisibility: { glm: false },
  codexResetFormat: 'absolute',
  peakReminder: { deepseek: { mode: 'builtin' } },
  credentials: {
    glm: { configured: true, suffix: '1234' },
    deepseek: { configured: false },
    'glm-wallet': { configured: true, suffix: '5678' },
    codex: { delegated: true }
  }
};

/** Settings as the Rust service serializes them: credential statuses are a list. */
const serviceSettingsArray = {
  theme: 'light',
  timezone: 'Asia/Shanghai',
  glmRegion: 'china',
  glmWalletEnabled: false,
  deepseekWebEnabled: true,
  credentials: [
    { target: 'glm', configured: false, delegated: false, enabled: true },
    { target: 'glm-wallet', configured: false, delegated: false, enabled: false },
    { target: 'deepseek', configured: true, suffix: '23cb', delegated: false, enabled: true },
    { target: 'deepseek-web', configured: false, delegated: false, enabled: true },
    { target: 'codex', configured: false, delegated: true, enabled: true }
  ]
};

const providersPayload = {
  providers: [
    {
      provider: 'glm',
      snapshot: {
        provider: 'glm',
        status: 'connected',
        capturedAt: '2026-09-10T08:00:00.000Z',
        lastSuccessAt: '2026-09-10T08:00:00.000Z',
        source: 'glm-monitor',
        metrics: [
          { key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used', confidence: ['authoritative'], source: 'glm-monitor' }
        ]
      }
    }
  ]
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A typed fetch double: the request init is forwarded to the handler so a test
 * can assert on the method, headers and body of a mutation.
 */
function fetchStub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe('http usage client', () => {
  it('reads the snapshot and keeps every settings field the service sent', async () => {
    const fetchMock = fetchStub((url) => {
      if (url === '/api/bootstrap') return jsonResponse({ sessionToken: 'local-session', settings: serviceSettings });
      if (url === '/api/snapshots') return jsonResponse(providersPayload);
      return jsonResponse({});
    });
    const client = createHttpUsageClient({ fetch: fetchMock });

    const snapshot = await client.readSnapshot();
    expect(snapshot.providers.map((state) => state.provider)).toEqual(['glm']);
    expect(snapshot.providers[0]?.snapshot?.metrics[0]?.key).toBe('quota.5h.used');

    const settings = await client.readSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.glmRegion).toBe('china');
    expect(settings.glmWalletEnabled).toBe(true);
    // Nothing between the service and the panel: a mapped-out field would
    // quietly reset a user's choice (platformVisibility, peakReminder).
    expect(settings.platformVisibility).toEqual({ glm: false });
    expect(settings.peakReminder).toEqual({ deepseek: { mode: 'builtin' } });
    expect(settings.codexResetFormat).toBe('absolute');
    expect(settings.credentials['glm-wallet']).toEqual({ configured: true, suffix: '5678' });
    expect(settings.credentials.deepseek.configured).toBe(false);
  });

  it('sends the bootstrap session token with every mutation', async () => {
    const fetchMock = fetchStub((url) => {
      if (url === '/api/bootstrap') return jsonResponse({ sessionToken: 'local-session', settings: serviceSettings });
      if (url === '/api/credentials/deepseek') return jsonResponse({ configured: true, suffix: 'test' });
      return jsonResponse(serviceSettings);
    });
    const client = createHttpUsageClient({ fetch: fetchMock });

    await client.updateSettings({ glmRegion: 'international', glmWalletEnabled: false });
    const settingsCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/settings');
    expect(settingsCall).toBeDefined();
    expect(settingsCall?.[1]?.method).toBe('PUT');
    expect((settingsCall?.[1]?.headers as Record<string, string>)['X-Session-Token']).toBe('local-session');
    expect(JSON.parse(String(settingsCall?.[1]?.body))).toEqual({
      glmRegion: 'international',
      glmWalletEnabled: false
    });

    const status = await client.validateCredential('deepseek', 'sk-test');
    expect(status).toEqual({ configured: true, suffix: 'test' });
    const credentialCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/credentials/deepseek');
    expect(credentialCall?.[1]?.method).toBe('PUT');
    expect((credentialCall?.[1]?.headers as Record<string, string>)['X-Session-Token']).toBe('local-session');
    expect(JSON.parse(String(credentialCall?.[1]?.body))).toEqual({ secret: 'sk-test' });
  });

  it('rejects an invalid replacement with the service message and keeps the old mask', async () => {
    const fetchMock = fetchStub((url) => {
      if (url === '/api/bootstrap') return jsonResponse({ sessionToken: 'local-session', settings: serviceSettings });
      return jsonResponse({ error: 'DeepSeek rejected the API key' }, 400);
    });
    const client = createHttpUsageClient({ fetch: fetchMock });

    await expect(client.validateCredential('deepseek', 'wrong')).rejects.toMatchObject({
      kind: 'invalid',
      message: 'DeepSeek rejected the API key'
    });
    // The rejected replacement never deletes the working credential.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });

  it('maps a rejected session and an unreachable service to distinct errors', async () => {
    const sessionClient = createHttpUsageClient({
      fetch: fetchStub(() => jsonResponse({ error: 'Invalid local session token' }, 403))
    });
    await expect(sessionClient.readSnapshot()).rejects.toBeInstanceOf(UsageClientError);
    await expect(sessionClient.readSnapshot()).rejects.toMatchObject({ kind: 'session' });

    const offlineClient = createHttpUsageClient({
      fetch: fetchStub(() => {
        throw new TypeError('fetch failed');
      })
    });
    await expect(offlineClient.readSnapshot()).rejects.toMatchObject({ kind: 'network' });
  });

  it('forwards settings patches the service must judge, without reshaping', async () => {
    const fetchMock = fetchStub((url) => {
      if (url === '/api/bootstrap') return jsonResponse({ sessionToken: 'local-session', settings: serviceSettings });
      return jsonResponse(serviceSettings);
    });
    const client = createHttpUsageClient({ fetch: fetchMock });
    const patch = { platformVisibility: { glm: false }, peakReminder: { deepseek: { mode: 'off' as const } } };
    await client.updateSettings(patch);
    const settingsCall = fetchMock.mock.calls.find(([url]) => String(url) === '/api/settings');
    expect(JSON.parse(String(settingsCall?.[1]?.body))).toEqual(patch);
  });

  it('reports a refresh cooldown instead of throwing', async () => {
    const client = createHttpUsageClient({
      fetch: fetchStub((url) => {
        if (url === '/api/bootstrap') return jsonResponse({ sessionToken: 'local-session', settings: serviceSettings });
        return jsonResponse({ status: 'cooldown', nextEligibleAt: '2026-09-10T09:00:00.000Z' }, 429);
      })
    });
    const result = await client.refresh('glm');
    expect(result.status).toBe('cooldown');
    expect(result.nextEligibleAt).toBe('2026-09-10T09:00:00.000Z');
  });

  it('re-reads the snapshot and reconnects after the event stream drops', async () => {
    FakeEventSource.instances = [];
    let snapshotCalls = 0;
    const fetchMock = fetchStub((url) => {
      if (url === '/api/bootstrap') return jsonResponse({ sessionToken: 'local-session', settings: serviceSettings });
      if (url === '/api/snapshots') {
        snapshotCalls += 1;
        return jsonResponse(providersPayload);
      }
      return jsonResponse({});
    });
    const client = createHttpUsageClient({
      fetch: fetchMock,
      eventSourceFactory: (url) => new FakeEventSource(url),
      sessionToken: 'local-session',
      recovery: { delaysMs: [1] }
    });
    const events: PanelEvent[] = [];
    const unsubscribe = client.subscribe((event) => events.push(event));

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0]!;
    first.emit('snapshot', providersPayload);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'snapshot')).toBe(true));

    const before = snapshotCalls;
    first.fail();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(1));
    await vi.waitFor(() => expect(snapshotCalls).toBeGreaterThan(before));

    expect(events.some((event) => event.type === 'connection' && event.status === 'reconnecting')).toBe(true);
    expect(events.filter((event) => event.type === 'snapshot')).toHaveLength(2);
    expect(first.closed).toBe(true);

    unsubscribe();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
  });

  it('understands the retired provider event shape and never blanks a card', async () => {
    FakeEventSource.instances = [];
    let snapshotCalls = 0;
    const client = createHttpUsageClient({
      fetch: fetchStub((url) => {
        if (url === '/api/snapshots') {
          snapshotCalls += 1;
          return jsonResponse(providersPayload);
        }
        return jsonResponse({});
      }),
      eventSourceFactory: (url) => new FakeEventSource(url),
      sessionToken: 'local-session',
      recovery: { delaysMs: [1] }
    });
    const events: PanelEvent[] = [];
    const unsubscribe = client.subscribe((event) => events.push(event));
    const source = FakeEventSource.instances[0]!;

    // The retired service nests the refresh result under `result`.
    source.emit('provider', {
      provider: 'glm',
      result: { status: 'success', snapshot: providersPayload.providers[0]!.snapshot }
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'provider')).toBe(true));
    const providerEvent = events.find((event) => event.type === 'provider');
    expect(providerEvent?.type === 'provider' ? providerEvent.state?.snapshot?.metrics[0]?.key : undefined).toBe(
      'quota.5h.used'
    );

    // An event without a usable state falls back to re-reading the snapshot.
    const before = snapshotCalls;
    source.emit('provider', { provider: 'glm' });
    await vi.waitFor(() => expect(snapshotCalls).toBeGreaterThan(before));
    expect(events.filter((event) => event.type === 'provider')).toHaveLength(1);

    unsubscribe();
  });

  it('does not reconnect in a tight loop once unsubscribed', async () => {
    FakeEventSource.instances = [];
    const client = createHttpUsageClient({
      fetch: fetchStub(() => jsonResponse(providersPayload)),
      eventSourceFactory: (url) => new FakeEventSource(url),
      sessionToken: 'local-session',
      recovery: { delaysMs: [1] }
    });
    const unsubscribe = client.subscribe(() => undefined);
    const source = FakeEventSource.instances[0]!;
    unsubscribe();
    source.fail();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe('desktop usage client', () => {
  it('unwraps Tauri event envelopes before parsing a pushed snapshot', () => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const registrations = new Map<string, number>();
    let callbackId = 0;
    const bridge = detectDesktopBridge({
      __TAURI_INTERNALS__: {
        async invoke(command, args) {
          if (command === 'plugin:event|listen' && typeof args?.event === 'string' && typeof args.handler === 'number') {
            registrations.set(args.event, args.handler);
          }
          return undefined;
        },
        transformCallback(callback) {
          callbackId += 1;
          callbacks.set(callbackId, callback);
          return callbackId;
        }
      }
    });
    const client = createDesktopUsageClient({ bridge, config: null });
    const events: PanelEvent[] = [];
    const unsubscribe = client.subscribe((event) => events.push(event));
    const snapshotCallback = callbacks.get(registrations.get(DESKTOP_EVENTS.snapshot)!);

    snapshotCallback?.({ event: DESKTOP_EVENTS.snapshot, id: 1, payload: providersPayload });

    const snapshotEvent = events.find((event) => event.type === 'snapshot');
    expect(snapshotEvent?.type === 'snapshot' ? snapshotEvent.snapshot.providers[0]?.provider : undefined).toBe('glm');
    unsubscribe();
  });

  it('reads a rejected credential as the service stated it, not as a failed command', async () => {
    // What the Tauri host really rejects with when the service refuses a write:
    // the service's own envelope, wrapped in a transport sentence that carries
    // Rust's status *reason phrase*. Replacing that with the command name — or
    // failing to recognise the phrase and printing both — is what made a rejected
    // web login token, an unreadable console answer and an unreachable service
    // look identical to the user.
    const invoke = vi.fn(async () => {
      throw 'service returned HTTP 400 Bad Request: {"error":"the DeepSeek web login token was rejected as invalid or expired; paste a fresh one"}';
    });
    const client = createDesktopUsageClient({
      bridge: { invoke: invoke as unknown as DesktopCommandBridge['invoke'] },
      config: null
    });

    await expect(client.validateCredential('deepseek-web', 'pasted-token')).rejects.toMatchObject({
      kind: 'invalid',
      status: 400,
      message: 'the DeepSeek web login token was rejected as invalid or expired; paste a fresh one'
    });
    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.validateCredential, {
      target: 'deepseek-web',
      secret: 'pasted-token'
    });
  });

  it('keeps a compatibility failure readable on screen', async () => {
    // The console answering in a shape the collector cannot read: the panel shows
    // the service's sentence alone, never the transport wrapper around it.
    const invoke = vi.fn(async () => {
      throw 'service returned HTTP 400 Bad Request: {"error":"the DeepSeek web cost response no longer provides biz_data (`data` is null or absent; envelope keys: code, msg)"}';
    });
    const client = createDesktopUsageClient({
      bridge: { invoke: invoke as unknown as DesktopCommandBridge['invoke'] },
      config: null
    });

    const failure = await client.validateCredential('deepseek-web', 'pasted-token').catch((error: unknown) => error as UsageClientError);
    expect(failure.message).toBe(
      'the DeepSeek web cost response no longer provides biz_data (`data` is null or absent; envelope keys: code, msg)'
    );
    expect(failure.message).not.toContain('service returned HTTP');
    expect(failure.message).not.toContain('panel_validate_credential');
  });

  it('keeps the session verdict a host failure reported', async () => {
    const invoke = vi.fn(async () => {
      throw 'service returned HTTP 403: {"error":"Invalid local session token"}';
    });
    const client = createDesktopUsageClient({
      bridge: { invoke: invoke as unknown as DesktopCommandBridge['invoke'] },
      config: null
    });

    await expect(client.readSettings()).rejects.toMatchObject({ kind: 'session', status: 403 });
  });

  it('names the command only when the service gave no reason', async () => {
    // The host could not reach the service at all: there is no service envelope,
    // so the panel says what failed and keeps the host's own detail in view.
    const invoke = vi.fn(async () => {
      throw new Error('service request failed: connection refused');
    });
    const client = createDesktopUsageClient({
      bridge: { invoke: invoke as unknown as DesktopCommandBridge['invoke'] },
      config: null
    });

    await expect(client.readSettings()).rejects.toMatchObject({
      kind: 'unavailable',
      message: '桌面宿主命令失败：panel_settings（service request failed: connection refused）'
    });
  });

  it('reads the credential statuses the desktop service really returns', async () => {
    // `/api/settings` answers with an array of statuses carrying their own
    // `target` (the Rust `CredentialStatus`), not with an object keyed by target.
    // Reading only the object form showed every configured credential — including
    // a working API key with a mask — as 尚未配置.
    const invoke = vi.fn(async (command: string) => {
      if (command === DESKTOP_COMMANDS.settings) return serviceSettingsArray;
      return {};
    });
    const client = createDesktopUsageClient({
      bridge: { invoke: invoke as unknown as DesktopCommandBridge['invoke'] },
      config: null
    });

    const settings = await client.readSettings();
    expect(settings.credentials.deepseek).toEqual({ configured: true, suffix: '23cb' });
    expect(settings.credentials.glm).toEqual({ configured: false });
    expect(settings.credentials['deepseek-web']).toEqual({ configured: false });
    expect(settings.deepseekWebEnabled).toBe(true);
  });

  it('talks to the Tauri host when a bridge is present', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === DESKTOP_COMMANDS.snapshot) return providersPayload;
      if (command === DESKTOP_COMMANDS.settings) return { timezone: 'Asia/Shanghai', glmWalletEnabled: false };
      if (command === DESKTOP_COMMANDS.validateCredential) return { configured: true, suffix: '9999' };
      if (command === DESKTOP_COMMANDS.refresh) return { status: 'success', at: '2026-09-10T08:00:00.000Z' };
      return {};
    });
    const client = createDesktopUsageClient({
      bridge: { invoke: invoke as unknown as DesktopCommandBridge['invoke'] },
      config: null
    });

    const snapshot = await client.readSnapshot();
    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.snapshot, undefined);
    expect(snapshot.providers[0]?.provider).toBe('glm');

    const settings = await client.readSettings();
    expect(settings.glmWalletEnabled).toBe(false);
    expect(settings.timezone).toBe('Asia/Shanghai');

    const status = await client.validateCredential('glm', 'sk-live');
    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.validateCredential, { target: 'glm', secret: 'sk-live' });
    expect(status).toEqual({ configured: true, suffix: '9999' });

    const refresh = await client.refresh('codex');
    expect(refresh).toMatchObject({ provider: 'codex', status: 'success' });

    await expect(client.readSettings()).resolves.toBeDefined();
  });

  it('reads the service acknowledgement as "no verdict", never as a failure', async () => {
    // What `panel_refresh` really forwards: the Rust service runs the collection and
    // then answers with an acknowledgement, because the outcome is published as the
    // provider's new state. Reporting that as `failure` made every manual refresh in
    // the panel say "刷新失败" while the collection had succeeded.
    const invoke = vi.fn(async (command: string) => {
      if (command === DESKTOP_COMMANDS.refresh) return { status: 'refresh-requested' };
      return {};
    });
    const client = createDesktopUsageClient({
      bridge: { invoke: invoke as unknown as DesktopCommandBridge['invoke'] },
      config: null
    });

    await expect(client.refresh('codex')).resolves.toMatchObject({ provider: 'codex', status: 'requested' });
  });

  it('keeps a verdict the host does report', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === DESKTOP_COMMANDS.refresh) return { status: 'failure', error: { kind: 'network', message: 'boom' } };
      return {};
    });
    const client = createDesktopUsageClient({
      bridge: { invoke: invoke as unknown as DesktopCommandBridge['invoke'] },
      config: null
    });

    await expect(client.refresh('glm')).resolves.toMatchObject({
      provider: 'glm',
      status: 'failure',
      error: { kind: 'network', message: 'boom' }
    });
  });

  it('subscribes to host events and recovers by re-reading the snapshot', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const invoke = vi.fn(async (command: string) => {
      if (command === DESKTOP_COMMANDS.snapshot) return providersPayload;
      return {};
    });
    const bridge: DesktopCommandBridge = {
      invoke: invoke as unknown as DesktopCommandBridge['invoke'],
      listen(event, handler) {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      }
    };
    const client = createDesktopUsageClient({ bridge, config: null, recovery: { delaysMs: [1] } });
    const events: PanelEvent[] = [];
    const unsubscribe = client.subscribe((event) => events.push(event));

    handlers.get('panel://snapshot')?.(providersPayload);
    expect(events.some((event) => event.type === 'snapshot')).toBe(true);

    const before = invoke.mock.calls.filter(([command]) => command === DESKTOP_COMMANDS.snapshot).length;
    handlers.get('panel://connection')?.({ status: 'reconnecting' });
    await vi.waitFor(() =>
      expect(invoke.mock.calls.filter(([command]) => command === DESKTOP_COMMANDS.snapshot).length).toBeGreaterThan(before)
    );
    expect(events.some((event) => event.type === 'connection' && event.status === 'reconnecting')).toBe(true);

    unsubscribe();
    expect(handlers.size).toBe(0);
  });

  it('degrades to the HTTP transport when neither a bridge nor injected config exists', async () => {
    const fetchMock = fetchStub((url) => {
      if (url === '/api/bootstrap') return jsonResponse({ sessionToken: 'local-session', settings: serviceSettings });
      if (url === '/api/snapshots') return jsonResponse(providersPayload);
      return jsonResponse(serviceSettings);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);

    const client = createDesktopUsageClient({ bridge: null, config: null });
    const snapshot = await client.readSnapshot();
    expect(snapshot.providers).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/snapshots');

    // Without a bridge the panel is still an ordinary browser client.
    const settings = await client.readSettings();
    expect(settings.timezone).toBe('Asia/Shanghai');

    const unsubscribe = client.subscribe(() => undefined);
    expect(FakeEventSource.instances[0]?.url).toBe('/events');
    unsubscribe();
  });

  it('uses the host-injected origin and session token when there is no bridge', async () => {
    const fetchMock = fetchStub((url) => {
      if (url.endsWith('/api/snapshots')) return jsonResponse(providersPayload);
      return jsonResponse(serviceSettings);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = createDesktopUsageClient({
      bridge: null,
      config: { origin: 'http://127.0.0.1:4716', sessionToken: 'injected-token' }
    });
    await client.readSnapshot();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:4716/api/snapshots');
    // The injected session token avoids the bootstrap round trip entirely.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('bootstrap'))).toBe(true);
  });

  it('exposes host window controls only when the host is present', async () => {
    expect(createDesktopHostControls(null)).toBeNull();

    const invoke = vi.fn(async (command: string) => {
      if (command === DESKTOP_COMMANDS.pinnedState) return true;
      if (command === DESKTOP_COMMANDS.setPinned) return true;
      return undefined;
    });
    const controls = createDesktopHostControls({ invoke: invoke as unknown as DesktopCommandBridge['invoke'] });
    expect(controls).not.toBeNull();
    expect(await controls?.readPinned()).toBe(true);
    expect(await controls?.setPinned(true)).toBe(true);
    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.setPinned, { pinned: true });
    await controls?.hide();
    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.hide, undefined);
    await controls?.openWebVersion();
    expect(invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.openWebVersion, undefined);
  });

  it('decodes the header event as a boolean intent, defaulting to visible', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const bridge: DesktopCommandBridge = {
      invoke: vi.fn(async () => undefined) as unknown as DesktopCommandBridge['invoke'],
      listen(event, handler) {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      }
    };
    const controls = createDesktopHostControls(bridge);
    const seen: boolean[] = [];
    const unsubscribe = controls?.subscribeHeader((visible) => seen.push(visible));

    handlers.get(DESKTOP_EVENTS.header)?.({ visible: false });
    handlers.get(DESKTOP_EVENTS.header)?.({ visible: true });
    // A malformed payload reads as "visible": the header never disappears on a
    // host's malformed word, it only ever fails to disappear.
    handlers.get(DESKTOP_EVENTS.header)?.(undefined);
    expect(seen).toEqual([false, true, true]);

    unsubscribe?.();
    expect(handlers.size).toBe(0);
  });

  it('leaves the header alone outside a bridge', () => {
    const controls = createBrowserFallbackHost(() => undefined);
    const seen: boolean[] = [];
    const unsubscribe = controls.subscribeHeader((visible) => seen.push(visible));
    unsubscribe();
    expect(seen).toEqual([]);
  });
});

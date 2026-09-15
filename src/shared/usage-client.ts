/**
 * Transport-agnostic usage client.
 *
 * The panel and the companion web page render from this interface and never
 * touch `fetch`, `EventSource` or the Tauri bridge directly. Two transports
 * implement it:
 *
 * - `createHttpUsageClient()` (this file) talks to the local service over
 *   `/api/...` and `/events`: `GET /api/bootstrap` hands out the `X-Session-Token`
 *   used by every mutation (`PUT /api/settings`,
 *   `PUT|DELETE /api/credentials/:target`, `POST /api/refresh/:provider`).
 * - `createDesktopUsageClient(bridge)` (`src/desktop/desktop-client.ts`) talks
 *   to the Tauri host and degrades to the HTTP client when no bridge exists, so
 *   the panel stays testable in a plain browser.
 */

import type { CollectorError, ProviderId } from './contracts';
import {
  parseCredentialStatus,
  parsePanelSettings,
  parsePanelSnapshot,
  parseProviderState,
  type CredentialStatus,
  type CredentialTarget,
  type PanelSettings,
  type PanelSettingsPatch,
  type PanelSnapshot
} from './desktop-contract';

export type UsageClientErrorKind =
  /** The request never reached the service. */
  | 'network'
  /** The local service rejected the session token. */
  | 'session'
  /** The service rejected the credential or the caller. */
  | 'authentication'
  /** The service refused the value (invalid secret, invalid settings). */
  | 'invalid'
  /** This transport cannot express the requested operation. */
  | 'unsupported'
  | 'unavailable'
  | 'unknown';

export class UsageClientError extends Error {
  readonly kind: UsageClientErrorKind;
  readonly status?: number;

  constructor(kind: UsageClientErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UsageClientError';
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
  }
}

/**
 * What one manual refresh reported back.
 *
 * A transport that cannot know the outcome says so instead of guessing:
 * `requested` means the service took the refresh and ran it, and the result is
 * published as the provider's new state rather than carried in the reply (the
 * Rust service answers `refresh-requested`); `busy` means the call was merged
 * into a refresh already in flight. Neither is a verdict, and neither may be
 * read as a failure — that reading is what made every manual refresh in the
 * panel look broken.
 */
export type RefreshStatus = 'success' | 'failure' | 'cooldown' | 'busy' | 'requested';

export interface RefreshResult {
  provider: ProviderId;
  status: RefreshStatus;
  /** When the attempt finished, as an ISO-8601 timestamp. */
  at: string;
  /** Set for `cooldown`: the earliest instant another refresh is accepted. */
  nextEligibleAt?: string;
  error?: CollectorError;
}

/** State of the live event stream, so the panel can say "using cached data". */
export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Events pushed by a transport.
 *
 * `provider` carries the state of one provider when the transport could parse
 * it; a listener may also simply re-read the snapshot.
 */
export type PanelEvent =
  | { type: 'snapshot'; snapshot: PanelSnapshot }
  | { type: 'provider'; provider: ProviderId; state?: PanelSnapshot['providers'][number] }
  | { type: 'settings'; settings: PanelSettings }
  | { type: 'connection'; status: StreamStatus; message?: string };

export interface UsageClient {
  readSnapshot(): Promise<PanelSnapshot>;
  readSettings(): Promise<PanelSettings>;
  /**
   * Persist a settings patch and return the settings the service now holds.
   *
   * The patch travels verbatim: the service validates each field and rejects
   * an unusable one with `UsageClientError` (`invalid`) instead of the client
   * second-guessing the panel's vocabulary.
   */
  updateSettings(patch: PanelSettingsPatch): Promise<PanelSettings>;
  refresh(provider: ProviderId): Promise<RefreshResult>;
  /**
   * Validate a secret with a read-only query and, only when it is valid, replace
   * the stored credential. On failure the previous credential stays untouched
   * and this rejects with `UsageClientError` of kind `invalid`.
   *
   * Resolves with the masked status only — the raw secret never comes back.
   */
  validateCredential(target: CredentialTarget, secret: string): Promise<CredentialStatus>;
  /** Revoke the credential of one connection. Other connections are unaffected. */
  deleteCredential(target: CredentialTarget): Promise<void>;
  /** Subscribe to pushed events. Returns the unsubscribe function. */
  subscribe(listener: (event: PanelEvent) => void): () => void;
  /** Open the companion web page in the user's browser. */
  openWebVersion(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Reconnection helper
// ---------------------------------------------------------------------------

export interface RecoveryOptions {
  /**
   * Delays between reconnect attempts, in milliseconds. The last entry repeats,
   * so the loop backs off instead of spinning.
   */
  delaysMs?: readonly number[];
  /** Called with the new state on every transition. */
  onState?: (status: StreamStatus, message?: string) => void;
  /** Called before each reconnect attempt so the caller can re-read state. */
  onRecover?: () => void;
  setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface Recovery {
  /** Give up after a failure and schedule the next attempt. */
  schedule(): void;
  /** Note that the stream recovered; the next failure starts from the first delay. */
  reset(): void;
  /** Stop the loop and cancel pending timers. */
  cancel(): void;
  readonly attempts: number;
}

export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * Bounded reconnect loop shared by both transports.
 *
 * A dropped stream is not fatal: the panel reconnects with a capped backoff and
 * re-reads the full snapshot so it never shows data older than it has to. The
 * loop never retries in a tight loop and stops as soon as the caller cancels it.
 */
export function createRecovery(options: RecoveryOptions = {}): Recovery {
  const delays = options.delaysMs && options.delaysMs.length > 0 ? options.delaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let handle: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let cancelled = false;

  return {
    schedule() {
      if (cancelled) return;
      if (handle !== undefined) return;
      const index = Math.min(attempts, delays.length - 1);
      const delay = delays[index] ?? DEFAULT_RECONNECT_DELAYS_MS[DEFAULT_RECONNECT_DELAYS_MS.length - 1] ?? 30_000;
      attempts += 1;
      options.onState?.('reconnecting', `实时连接中断，将在 ${Math.round(delay / 1_000)} 秒后重试`);
      handle = setTimer(() => {
        handle = undefined;
        if (cancelled) return;
        options.onRecover?.();
      }, delay);
    },
    reset() {
      attempts = 0;
    },
    cancel() {
      cancelled = true;
      if (handle !== undefined) {
        clearTimer(handle);
        handle = undefined;
      }
    },
    get attempts() {
      return attempts;
    }
  };
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/** The subset of `EventSource` this client uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
  onerror?: ((event: unknown) => void) | null;
  onopen?: ((event: unknown) => void) | null;
}

export interface HttpUsageClientOptions {
  /**
   * Origin of the local service. Empty means "same origin as this document",
   * which is what the companion web page and the Vite dev proxy use.
   */
  baseUrl?: string;
  /** Event stream URL; defaults to `${baseUrl}/events`. */
  eventsUrl?: string;
  /** Session token injected by the host; otherwise `/api/bootstrap` is used. */
  sessionToken?: string;
  fetch?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSourceLike;
  /** Injected for tests; keeps the reconnect loop deterministic. */
  recovery?: Omit<RecoveryOptions, 'onRecover' | 'onState'>;
  /** How the companion web page is opened. Defaults to a new browser tab. */
  openExternal?: (url: string) => void;
}

interface BootstrapPayload {
  sessionToken?: string;
  settings?: unknown;
}

export function createHttpUsageClient(options: HttpUsageClientOptions = {}): UsageClient {
  const baseUrl = options.baseUrl ?? '';
  const eventsUrl = options.eventsUrl ?? `${baseUrl}/events`;
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const eventSourceFactory =
    options.eventSourceFactory ??
    ((url: string) => new EventSource(url) as unknown as EventSourceLike);

  let sessionToken = options.sessionToken;
  let bootstrap: Promise<BootstrapPayload> | undefined;
  const listeners = new Set<(event: PanelEvent) => void>();

  function emit(event: PanelEvent) {
    for (const listener of [...listeners]) listener(event);
  }

  async function ensureBootstrap(): Promise<BootstrapPayload> {
    if (sessionToken) return { sessionToken };
    bootstrap ??= (async () => {
      const response = await fetchJson(`${baseUrl}/api/bootstrap`);
      return (await response.json()) as BootstrapPayload;
    })().catch((error: unknown) => {
      bootstrap = undefined;
      throw error;
    });
    const payload = await bootstrap;
    if (typeof payload.sessionToken === 'string' && payload.sessionToken !== '') sessionToken = payload.sessionToken;
    return payload;
  }

  async function fetchJson(url: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await request(url, init);
    } catch (error) {
      throw new UsageClientError('network', '网络异常，无法连接本地服务', { cause: error });
    }
    if (!response.ok) throw await toError(response);
    return response;
  }

  async function toError(response: Response): Promise<UsageClientError> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // Not a service error envelope: the shared mapping falls back to the status.
      payload = undefined;
    }
    return serviceFailure(response.status, payload);
  }

  async function mutationHeaders(): Promise<Record<string, string>> {
    const payload = await ensureBootstrap();
    return { 'Content-Type': 'application/json', 'X-Session-Token': payload.sessionToken ?? '' };
  }

  async function readSettings(): Promise<PanelSettings> {
    const payload = await ensureBootstrap();
    // The local service speaks the panel contract natively (camelCase, field
    // for field with DesktopSettings): parse it directly. Mapping it through
    // any intermediate shape would silently drop the fields the mapping
    // predates — theme, platform visibility, peakReminder — and a browser
    // fallback that ignores half the settings is worse than no mapping.
    if (payload.settings !== undefined) return parsePanelSettings(payload.settings);
    const response = await fetchJson(`${baseUrl}/api/settings`);
    return parsePanelSettings(await response.json());
  }

  async function readSnapshot(): Promise<PanelSnapshot> {
    const response = await fetchJson(`${baseUrl}/api/snapshots`);
    return parsePanelSnapshot(await response.json());
  }

  return {
    readSnapshot,
    readSettings,
    async updateSettings(patch) {
      // Forward the patch verbatim: the service validates each field and the
      // response is what it now holds.
      const response = await fetchJson(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: await mutationHeaders(),
        body: JSON.stringify(patch)
      });
      return parsePanelSettings(await response.json());
    },
    async refresh(provider) {
      const at = new Date().toISOString();
      let response: Response;
      try {
        response = await request(`${baseUrl}/api/refresh/${provider}`, {
          method: 'POST',
          headers: await mutationHeaders()
        });
      } catch {
        // The service is not reachable: report a failure instead of throwing, so
        // the panel keeps the last snapshot on screen.
        return {
          provider,
          status: 'failure',
          at,
          error: { kind: 'network', message: '网络异常，无法连接本地服务', at }
        };
      }
      let payload: { status?: RefreshStatus; nextEligibleAt?: string; error?: unknown } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = {};
      }
      if (response.status === 403) {
        throw new UsageClientError('session', '本地会话已失效，请重新打开面板', { status: 403 });
      }
      if (response.status === 429 || payload.status === 'cooldown') {
        return {
          provider,
          status: 'cooldown',
          at,
          ...(typeof payload.nextEligibleAt === 'string' ? { nextEligibleAt: payload.nextEligibleAt } : {})
        };
      }
      if (!response.ok || payload.status === 'failure') {
        return {
          provider,
          status: 'failure',
          at,
          error: {
            kind: errorKindForStatus(response.status),
            message: typeof payload.error === 'string' && payload.error.trim() !== '' ? payload.error : '刷新失败，继续显示上次数据',
            at
          }
        };
      }
      // Everything else that came back 2xx is an acknowledgement: the service ran
      // the refresh and published what it did, so the reply carries no verdict.
      // Claiming success here would be as wrong as claiming failure (the desktop
      // transport used to do the latter); the caller reads the published state.
      if (payload.status === 'success' || payload.status === 'busy') return { provider, status: payload.status, at };
      return { provider, status: 'requested', at };
    },
    async validateCredential(target: CredentialTarget, secret: string) {
      const response = await fetchJson(`${baseUrl}/api/credentials/${target}`, {
        method: 'PUT',
        headers: await mutationHeaders(),
        body: JSON.stringify({ secret })
      });
      return parseCredentialStatus(await response.json());
    },
    async deleteCredential(target: CredentialTarget) {
      const response = await request(`${baseUrl}/api/credentials/${target}`, {
        method: 'DELETE',
        headers: await mutationHeaders()
      });
      if (!response.ok) throw await toError(response);
    },
    subscribe(listener) {
      listeners.add(listener);
      let source: EventSourceLike | undefined;
      let cancelled = false;
      const recovery = createRecovery({
        ...options.recovery,
        onState: (status, message) => emit({ type: 'connection', status, ...(message ? { message } : {}) }),
        onRecover: () => {
          // Re-read the full snapshot before reopening the stream: the cached
          // reading may be arbitrarily old after a drop.
          void readSnapshot()
            .then((snapshot) => emit({ type: 'snapshot', snapshot }))
            .catch(() => undefined);
          open();
        }
      });

      function open() {
        if (cancelled) return;
        try {
          source = eventSourceFactory(eventsUrl);
        } catch {
          // No event stream available in this runtime: keep the cached snapshot
          // and retry on the same backoff instead of throwing at subscribe time.
          recovery.schedule();
          return;
        }
        emit({ type: 'connection', status: 'connecting' });
        source.addEventListener('snapshot', (event) => {
          recovery.reset();
          emit({ type: 'connection', status: 'open' });
          const payload = parseEvent(event);
          if (payload === undefined) return;
          // The `snapshot` event carries the whole provider list.
          emit({ type: 'snapshot', snapshot: parsePanelSnapshot(payload) });
        });
        source.addEventListener('provider', (event) => {
          recovery.reset();
          emit({ type: 'connection', status: 'open' });
          const state = parseProviderState(unwrapProviderEvent(parseEvent(event)));
          if (state?.provider && (state.snapshot || state.error)) {
            emit({ type: 'provider', provider: state.provider, state });
            return;
          }
          // The event carried no usable state: re-read the snapshot instead of
          // emitting an empty state that would blank the card.
          void readSnapshot()
            .then((snapshot) => emit({ type: 'snapshot', snapshot }))
            .catch(() => undefined);
        });
        source.onerror = () => {
          if (cancelled) return;
          closeSource();
          recovery.schedule();
        };
        source.onopen = () => {
          recovery.reset();
          emit({ type: 'connection', status: 'open' });
        };
      }

      function closeSource() {
        const current = source;
        source = undefined;
        try {
          current?.close();
        } catch {
          // Closing an already-dead stream is not an error.
        }
      }

      function parseEvent(event: { data?: string }): unknown | undefined {
        if (typeof event.data !== 'string') return undefined;
        try {
          return JSON.parse(event.data) as unknown;
        } catch {
          return undefined;
        }
      }

      open();
      return () => {
        cancelled = true;
        listeners.delete(listener);
        recovery.cancel();
        closeSource();
        if (listeners.size > 0) emit({ type: 'connection', status: 'closed' });
      };
    },
    async openWebVersion() {
      const url = baseUrl === '' ? '/' : baseUrl;
      if (options.openExternal) {
        options.openExternal(url);
        return;
      }
      const opened = globalThis.open?.(url, '_blank', 'noopener');
      void opened;
    }
  };
}

/**
 * Normalize a `provider` event.
 *
 * An earlier service version sent `{ provider, result: { status, snapshot } }`
 * while the current Rust host sends the provider state directly. Both are
 * accepted;
 * anything without a snapshot or an error makes the caller re-read the snapshot.
 */
export function unwrapProviderEvent(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const record = payload as Record<string, unknown>;
  const result = record.result;
  if (typeof result === 'object' && result !== null) {
    return { provider: record.provider, ...(result as Record<string, unknown>) };
  }
  return payload;
}

/**
 * Turn a failed local-service response into the shared error vocabulary.
 *
 * Exported because two transports reach the same service through different
 * shapes of failure: the HTTP client holds the `Response`, while the desktop
 * bridge only has the string the Tauri host built from it
 * (`service returned HTTP 400: {"error":"…"}`). Both read the service's own
 * reason here, so a rejected credential says *why* on either path — the bridge
 * used to replace it with the command name, which told the user nothing about
 * the value they had just submitted.
 *
 * `payload` is the decoded response body when there is one; anything that is
 * not an error envelope leaves the status-based message in place.
 */
export function serviceFailure(status: number, payload?: unknown): UsageClientError {
  let message = `本地服务返回 ${status}`;
  const envelope = payload as { error?: unknown } | undefined;
  if (envelope && typeof envelope === 'object' && typeof envelope.error === 'string' && envelope.error.trim() !== '') {
    message = envelope.error;
  }
  if (status === 403 && /session/i.test(message)) return new UsageClientError('session', '本地会话已失效，请重新打开面板', { status: 403 });
  if (status === 401 || status === 403) return new UsageClientError('authentication', message, { status });
  if (status === 400 || status === 422) return new UsageClientError('invalid', message, { status });
  if (status === 409) return new UsageClientError('unavailable', message, { status: 409 });
  return new UsageClientError('unavailable', message, { status });
}

function errorKindForStatus(status: number): CollectorError['kind'] {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status === 502 || status === 503 || status === 504) return 'network';
  if (status === 400 || status === 422) return 'compatibility';
  return 'unknown';
}

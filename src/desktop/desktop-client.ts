/**
 * Desktop transport: the panel talks to the Tauri host through this module.
 *
 * The Rust service owns collection, the cache and the credentials; the Tauri
 * host exposes a *restricted* command surface and forwards events. The panel
 * never imports from `crates/**` (Rust) and never shells out — it only knows the
 * command names below.
 *
 * ## Command contract the host must implement
 *
 * | command                   | args             | result                        |
 * | ------------------------- | ---------------- | ----------------------------- |
 * | `panel_snapshot`          | —                | `PanelSnapshot`               |
 * | `panel_settings`          | —                | `PanelSettings`               |
 * | `panel_update_settings`   | `{ patch }`      | `PanelSettings`               |
 * | `panel_refresh`           | `{ provider }`   | `RefreshResult`               |
 * | `panel_validate_credential` | `{ target, secret }` | masked `CredentialStatus` |
 * | `panel_delete_credential` | `{ target }`     | —                             |
 * | `panel_open_web_version`  | —                | —                             |
 * | `panel_pinned_state`      | —                | `boolean`                     |
 * | `panel_set_pinned`        | `{ pinned }`     | `boolean`                     |
 * | `panel_hide`              | —                | —                             |
 * | `panel_set_height`        | `{ height }`     | applied (clamped) height      |
 * | `panel_open_settings`     | `{ section? }`   | —                             |
 * | `panel_settings_ready`    | —                | —                             |
 * | `panel_settings_section`  | —                | current settings section      |
 *
 * Events emitted towards the panel: `panel://snapshot` (`PanelSnapshot`),
 * `panel://provider` (`{ provider, state }`), `panel://settings`
 * (`PanelSettings`), `panel://connection` (`{ status, message? }`),
 * `panel://pinned` (`boolean`) and `panel://visibility` (`{ visible }`).
 * The header's collapse is driven by the pointer in the webview, not by a host
 * event.
 *
 * Events emitted towards the settings window: `panel://settings`,
 * `panel://snapshot` and `panel://settings-section` (`{ section }`). Both windows
 * therefore see a setting written from either one — that is what makes a change
 * visible in the panel the moment it is made in the settings window.
 *
 * ## Degradation
 *
 * 1. `window.__TAURI_INTERNALS__` exists → commands and events go to the host.
 * 2. Otherwise `window.__AGENTS_USAGE__` exists (host-injected service origin,
 *    session token, capability flags) → the HTTP transport is used against that
 *    origin.
 * 3. Neither exists (plain browser, jsdom, Vite dev) → the HTTP transport with
 *    relative URLs is used, so the panel remains fully testable outside Tauri.
 */

import type { ProviderId } from '../shared/contracts';
import {
  parseCredentialStatus,
  parsePanelSettings,
  parsePanelSnapshot,
  parseProviderState,
  type CredentialStatus,
  type CredentialTarget,
  type PanelSettingsPatch,
  type PanelSnapshot
} from '../shared/desktop-contract';
import {
  createHttpUsageClient,
  createRecovery,
  serviceFailure,
  UsageClientError,
  type PanelEvent,
  type RefreshResult,
  type RefreshStatus,
  type UsageClient
} from '../shared/usage-client';

/** Commands the host exposes. Kept in one place so the Rust side can mirror it. */
export const DESKTOP_COMMANDS = {
  snapshot: 'panel_snapshot',
  settings: 'panel_settings',
  updateSettings: 'panel_update_settings',
  refresh: 'panel_refresh',
  validateCredential: 'panel_validate_credential',
  deleteCredential: 'panel_delete_credential',
  openWebVersion: 'panel_open_web_version',
  pinnedState: 'panel_pinned_state',
  setPinned: 'panel_set_pinned',
  hide: 'panel_hide',
  setHeight: 'panel_set_height',
  /** Open the settings window, or bring it forward on the given section. */
  openSettings: 'panel_open_settings',
  /** Settings window -> host: the first render is on screen, show the window. */
  settingsReady: 'panel_settings_ready',
  /** Settings window -> host: which section should be showing. */
  settingsSection: 'panel_settings_section'
} as const;

export const DESKTOP_EVENTS = {
  snapshot: 'panel://snapshot',
  provider: 'panel://provider',
  settings: 'panel://settings',
  connection: 'panel://connection',
  pinned: 'panel://pinned',
  /** Host -> panel: intended visibility, so the panel can animate in/out. */
  visibility: 'panel://visibility',
  /**
   * Host -> panel: intended header visibility. The header settles away when the
   * pointer leaves the window and comes back when it returns; the host drives it
   * because a non-key window's webview receives no pointer events.
   */
  header: 'panel://header',
  /**
   * Host -> settings window: which section to show. Sent when a new window is
   * created for a named entry point and again on every later request while the
   * window already exists, so one window serves every entry point.
   */
  settingsSection: 'panel://settings-section'
} as const;

/** Minimal shape of `window.__TAURI_INTERNALS__` (no `@tauri-apps/api` needed). */
export interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  transformCallback?(callback: (payload: unknown) => void, once?: boolean): number;
}

/** Host-injected configuration, used when no Tauri internals are present. */
export interface InjectedDesktopConfig {
  origin?: string;
  sessionToken?: string;
  webUrl?: string;
  capabilities?: { pin?: boolean; hide?: boolean; openWebVersion?: boolean };
  /**
   * Settings window only: the section this window was created for. Injected at
   * build time because it is part of the window's identity, not a later request —
   * a window opened from a card's gear must render that platform's section on its
   * very first frame rather than switching to it after mounting.
   */
  settingsSection?: string;
}

export interface DesktopCommandBridge {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a host event. Returns the unlisten function. */
  listen?(event: string, handler: (payload: unknown) => void): () => void;
}

export interface DesktopUsageClientOptions {
  /** Injected instead of a real bridge (tests). */
  bridge?: DesktopCommandBridge | null;
  /** Injected instead of `window.__AGENTS_USAGE__` (tests). */
  config?: InjectedDesktopConfig | null;
  /** Used when neither a bridge nor injected config exists. */
  fallback?: UsageClient;
  recovery?: Parameters<typeof createRecovery>[0];
}

interface DesktopGlobalScope {
  __TAURI_INTERNALS__?: TauriInternals;
  __AGENTS_USAGE__?: InjectedDesktopConfig;
  open?: typeof globalThis.open;
}

function desktopScope(): DesktopGlobalScope {
  return globalThis as unknown as DesktopGlobalScope;
}

function tauriEventPayload(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('payload' in value)) return value;
  return (value as { payload: unknown }).payload;
}

/** Build a bridge from `window.__TAURI_INTERNALS__`, or `null` in a browser. */
export function detectDesktopBridge(scope: DesktopGlobalScope = desktopScope()): DesktopCommandBridge | null {
  const internals = scope.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return null;
  const invoke = internals.invoke.bind(internals) as DesktopCommandBridge['invoke'];
  if (typeof internals.transformCallback !== 'function') return { invoke };
  const transformCallback = internals.transformCallback.bind(internals);
  return {
    invoke,
    listen(event, handler) {
      const id = transformCallback((event) => handler(tauriEventPayload(event)));
      void invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler: id }).catch(() => undefined);
      return () => {
        void invoke('plugin:event|unlisten', { event, eventId: id }).catch(() => undefined);
      };
    }
  };
}

/** Read `window.__AGENTS_USAGE__`, or `null` when the host did not inject it. */
export function detectInjectedConfig(scope: DesktopGlobalScope = desktopScope()): InjectedDesktopConfig | null {
  const config = scope.__AGENTS_USAGE__;
  if (!config || typeof config !== 'object') return null;
  return config;
}

/**
 * The failure string the Tauri host builds when the local service answers with a
 * non-success status: `service returned HTTP 400 Bad Request: {"error":"…"}`.
 * Rust renders the whole status, reason phrase included, so the phrase is
 * optional in the pattern — matching only `HTTP 400:` is what let a rejected
 * token past a decoder that was already there, and the whole raw string ended up
 * on screen as if it were the reason. Everything else the host can reject with is
 * a transport problem (the service is not running, the command name is unknown),
 * which is a different story for the user and is reported as one.
 */
const SERVICE_FAILURE = /^service returned HTTP (\d{3})(?:\s[^:]*)?:\s([\s\S]*)$/;

/** Longest raw (non-envelope) body worth showing in a 350pt panel. */
const MAX_RAW_BODY = 200;

/**
 * Read a failed host command as the service reason it carries.
 *
 * The host forwards the service's own answer; presenting the command name
 * instead (`桌面宿主命令失败：panel_validate_credential`) hid every actionable
 * reason — a token the provider rejected looked exactly like a broken panel.
 */
export function hostFailure(command: string, error: unknown): UsageClientError {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  const match = SERVICE_FAILURE.exec(text.trim());
  if (match) {
    const body = (match[2] ?? '').trim();
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      // A body the service did not send as an envelope is only worth repeating
      // while it stays readable; the mapping otherwise names the status alone.
      payload = body !== '' && body.length <= MAX_RAW_BODY ? { error: body } : undefined;
    }
    return serviceFailure(Number(match[1]), payload);
  }
  const detail = text.trim();
  const message = detail === '' || detail === command ? `桌面宿主命令失败：${command}` : `桌面宿主命令失败：${command}（${detail}）`;
  return new UsageClientError('unavailable', message, { cause: error });
}

function normalizeRefreshResult(provider: ProviderId, value: unknown): RefreshResult {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const status = record.status;
  const at = typeof record.at === 'string' && record.at !== '' ? record.at : new Date().toISOString();
  // The host forwards the service's answer verbatim, and the service acknowledges
  // a manual refresh without a verdict (`refresh-requested`) because the result is
  // published as the provider's new state. An unrecognized status is therefore an
  // acknowledgement, not a failure: reading it as one made every manual refresh in
  // the panel report "刷新失败" while the collection had actually succeeded.
  const normalizedStatus: RefreshStatus =
    status === 'success' || status === 'failure' || status === 'cooldown' || status === 'busy' ? status : 'requested';
  const nextEligibleAt = typeof record.nextEligibleAt === 'string' ? record.nextEligibleAt : undefined;
  const error = typeof record.error === 'object' && record.error !== null ? (record.error as RefreshResult['error']) : undefined;
  return {
    provider,
    status: normalizedStatus,
    at,
    ...(nextEligibleAt ? { nextEligibleAt } : {}),
    ...(error ? { error } : {})
  };
}

/**
 * Create the panel's usage client.
 *
 * Prefers the Tauri bridge, then host-injected HTTP configuration, then a plain
 * HTTP client with relative URLs. The HTTP path is the documented browser
 * fallback: the panel is usable (and testable) without a Tauri runtime.
 */
export function createDesktopUsageClient(options: DesktopUsageClientOptions = {}): UsageClient {
  const scope = desktopScope();
  const bridge = options.bridge !== undefined ? options.bridge : detectDesktopBridge(scope);
  const config = options.config !== undefined ? options.config : detectInjectedConfig(scope);
  const httpClient =
    options.fallback ??
    createHttpUsageClient({
      baseUrl: config?.origin ?? '',
      ...(config?.sessionToken ? { sessionToken: config.sessionToken } : {})
    });

  if (!bridge) return httpClient;

  const recoverOptions = options.recovery;
  const listeners = new Set<(event: PanelEvent) => void>();
  const emit = (event: PanelEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return (await bridge.invoke<T>(command, args)) as T;
    } catch (error) {
      throw hostFailure(command, error);
    }
  };

  const readSnapshot = async (): Promise<PanelSnapshot> => parsePanelSnapshot(await invoke(DESKTOP_COMMANDS.snapshot));

  return {
    readSnapshot,
    async readSettings() {
      return parsePanelSettings(await invoke(DESKTOP_COMMANDS.settings));
    },
    async updateSettings(patch: PanelSettingsPatch) {
      return parsePanelSettings(await invoke(DESKTOP_COMMANDS.updateSettings, { patch }));
    },
    async refresh(provider: ProviderId) {
      return normalizeRefreshResult(provider, await invoke(DESKTOP_COMMANDS.refresh, { provider }));
    },
    async validateCredential(target: CredentialTarget, secret: string): Promise<CredentialStatus> {
      return parseCredentialStatus(await invoke(DESKTOP_COMMANDS.validateCredential, { target, secret }));
    },
    async deleteCredential(target: CredentialTarget) {
      await invoke(DESKTOP_COMMANDS.deleteCredential, { target });
    },
    subscribe(listener) {
      // Without the host event bridge the HTTP stream still works: the service
      // is a loopback HTTP server in both runtimes.
      if (!bridge.listen) return httpClient.subscribe(listener);
      listeners.add(listener);
      const recovery = createRecovery({
        ...recoverOptions,
        onState: (status, message) => emit({ type: 'connection', status, ...(message ? { message } : {}) }),
        onRecover: () => {
          void readSnapshot()
            .then((snapshot) => emit({ type: 'snapshot', snapshot }))
            .catch(() => undefined);
        }
      });
      const unlisten = [
        bridge.listen(DESKTOP_EVENTS.snapshot, (payload) => {
          recovery.reset();
          emit({ type: 'connection', status: 'open' });
          emit({ type: 'snapshot', snapshot: parsePanelSnapshot(payload) });
        }),
        bridge.listen(DESKTOP_EVENTS.provider, (payload) => {
          recovery.reset();
          emit({ type: 'connection', status: 'open' });
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
          const state = parseProviderState(record.state ?? payload);
          if (state) emit({ type: 'provider', provider: state.provider, state });
        }),
        bridge.listen(DESKTOP_EVENTS.settings, (payload) => {
          recovery.reset();
          emit({ type: 'settings', settings: parsePanelSettings(payload) });
        }),
        bridge.listen(DESKTOP_EVENTS.connection, (payload) => {
          const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
          const status = record.status;
          const message = typeof record.message === 'string' ? record.message : undefined;
          if (status === 'reconnecting' || status === 'closed') {
            // The host lost its connection to the local service: retry with a
            // capped backoff and re-read the snapshot on every attempt.
            recovery.schedule();
            return;
          }
          if (status === 'open' || status === 'connecting') {
            emit({ type: 'connection', status, ...(message ? { message } : {}) });
          }
        })
      ];
      return () => {
        listeners.delete(listener);
        recovery.cancel();
        for (const off of unlisten) off();
      };
    },
    async openWebVersion() {
      await invoke(DESKTOP_COMMANDS.openWebVersion);
    }
  };
}

// ---------------------------------------------------------------------------
// Host window controls (hide / pin / open web version)
// ---------------------------------------------------------------------------

/**
 * Controls the panel exposes to the host.
 *
 * Hiding and pinning are *host* decisions: the panel asks, and renders the state
 * the host reports back. It never keeps a private copy of `pinned`, so a menu-bar
 * click, a pin toggle and an outside click all stay consistent.
 */
export interface PanelHostControls {
  /** Ask the host to collapse the panel (Escape with no overlay open). */
  hide(): Promise<void>;
  /**
   * Ask the host to size the window to the panel's content. The host clamps the
   * request to the display, so the panel asks for what it needs and stays out of
   * the question of how much screen it may take.
   */
  setHeight(height: number): Promise<void>;
  /** Read the host's current pinned state. */
  readPinned(): Promise<boolean>;
  /** Ask the host to change the pinned state; resolves with the new state. */
  setPinned(pinned: boolean): Promise<boolean>;
  /** Subscribe to host-driven changes of the pinned state. */
  subscribePinned(listener: (pinned: boolean) => void): () => void;
  /**
   * Subscribe to the host's intended visibility so the panel can play its
   * enter/leave transition around the window being shown or hidden.
   */
  subscribeVisibility(listener: (visible: boolean) => void): () => void;
  /**
   * Subscribe to the host's intended header visibility: `false` collapses the
   * header, `true` brings it back. The host tracks the pointer, not focus.
   */
  subscribeHeader(listener: (visible: boolean) => void): () => void;
  /**
   * Open the settings window, or bring the already-open one to `section`.
   *
   * The panel asks; the host decides. One window serves every entry point, so this is
   * idempotent by design: calling it twice focuses the same window twice rather than
   * opening a second copy of the same form.
   */
  openSettings(section: string): Promise<void>;
  /** Ask the host to open the companion web page in the browser. */
  openWebVersion(): Promise<void>;
}

/**
 * Build the host controls for a bridge. Returns `null` when no Tauri bridge is
 * present, in which case the panel runs in the browser fallback: hiding is a
 * no-op, pinning is unavailable and the web version opens as a normal tab.
 */
export function createDesktopHostControls(bridge: DesktopCommandBridge | null = detectDesktopBridge()): PanelHostControls | null {
  if (!bridge) return null;
  const invoke = <T,>(command: string, args?: Record<string, unknown>) => bridge.invoke<T>(command, args);
  return {
    async hide() {
      await invoke(DESKTOP_COMMANDS.hide).catch(() => undefined);
    },
    async setHeight(height) {
      await invoke(DESKTOP_COMMANDS.setHeight, { height }).catch(() => undefined);
    },
    async readPinned() {
      const value = await invoke<unknown>(DESKTOP_COMMANDS.pinnedState).catch(() => false);
      return value === true;
    },
    async setPinned(pinned) {
      const value = await invoke<unknown>(DESKTOP_COMMANDS.setPinned, { pinned }).catch(() => pinned);
      return value === true;
    },
    subscribePinned(listener) {
      if (!bridge.listen) return () => undefined;
      return bridge.listen(DESKTOP_EVENTS.pinned, (payload) => listener(payload === true));
    },
    subscribeVisibility(listener) {
      if (!bridge.listen) return () => undefined;
      return bridge.listen(DESKTOP_EVENTS.visibility, (payload) => {
        const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
        listener(record.visible !== false);
      });
    },
    subscribeHeader(listener) {
      if (!bridge.listen) return () => undefined;
      return bridge.listen(DESKTOP_EVENTS.header, (payload) => {
        const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
        listener(record.visible !== false);
      });
    },
    async openSettings(section) {
      await invoke(DESKTOP_COMMANDS.openSettings, { section }).catch(() => undefined);
    },
    async openWebVersion() {
      await invoke(DESKTOP_COMMANDS.openWebVersion).catch(() => undefined);
    }
  };
}

/**
 * The settings window's own host controls.
 *
 * A separate surface from `PanelHostControls` on purpose: the settings window never
 * hides itself, never pins and never sizes itself — the host fixes it at 600x400.
 * What it needs instead is to name the section it was opened on and to say when its
 * first render is on screen, and both of those exist only under Tauri; in a browser
 * this returns `null` and the settings surface renders as a sheet instead.
 */
export interface SettingsWindowHostControls {
  /** Ask the host to reveal the window (its first render is on screen). */
  ready(): Promise<void>;
  /** The section this window was created for, if the host named one. */
  initialSection(): string | undefined;
  /** Subscribe to later "show this section" requests. */
  subscribeSection(listener: (section: string | undefined) => void): () => void;
  /**
   * Ask the host which section should be showing.
   *
   * The durable half of the handoff, and the reason it exists: `panel://settings-section`
   * is emitted into the webview, so a request that arrives before this window's listener
   * is registered is lost. The host remembers the request instead, and the window reads
   * it once it is mounted — which is what makes "click a card's gear, land on that
   * platform" hold however the timing falls.
   */
  readSection(): Promise<string | undefined>;
}

export function createSettingsWindowHost(
  bridge: DesktopCommandBridge | null = detectDesktopBridge()
): SettingsWindowHostControls | null {
  if (!bridge) return null;
  const invoke = <T,>(command: string, args?: Record<string, unknown>) => bridge.invoke<T>(command, args);
  return {
    async ready() {
      await invoke(DESKTOP_COMMANDS.settingsReady).catch(() => undefined);
    },
    initialSection() {
      const initial = desktopScope().__AGENTS_USAGE__?.settingsSection;
      return typeof initial === 'string' ? initial : undefined;
    },
    subscribeSection(listener) {
      if (!bridge.listen) return () => undefined;
      return bridge.listen(DESKTOP_EVENTS.settingsSection, (payload) => {
        const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
        listener(typeof record.section === 'string' ? record.section : undefined);
      });
    },
    async readSection() {
      const value = await invoke<unknown>(DESKTOP_COMMANDS.settingsSection).catch(() => undefined);
      return typeof value === 'string' && value !== '' ? value : undefined;
    }
  };
}

/**
 * Browser fallback host: no menubar window to hide and nothing to pin, but the
 * companion web page still opens. Used by `main.tsx` when the panel runs outside
 * Tauri (Vite dev server, tests).
 */
export function createBrowserFallbackHost(openWebVersion: () => void | Promise<void>): PanelHostControls {  return {
    async hide() {
      // Outside Tauri there is no menubar window to collapse.
    },
    async setHeight() {
      // A browser page is sized by its own window; there is nothing to resize.
    },
    async readPinned() {
      return false;
    },
    async setPinned(pinned) {
      return pinned;
    },
    subscribePinned() {
      return () => undefined;
    },
    subscribeVisibility() {
      // Outside Tauri the panel is a normal page: it does not fade in and out.
      return () => undefined;
    },
    subscribeHeader() {
      // Outside Tauri there is no pointer tracking: the header never leaves.
      return () => undefined;
    },
    async openSettings() {
      // Outside Tauri there is no second window. The caller that offers the browser
      // fallback (see `main.tsx`) never routes here, but the contract has to be
      // complete: a host control that is present but not implemented is a trap.
    },
    async openWebVersion() {
      await openWebVersion();
    }
  };
}

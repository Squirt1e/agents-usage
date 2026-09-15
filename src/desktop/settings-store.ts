/**
 * One settings store per window.
 *
 * ## Why a store and not `useState` in a component
 *
 * The settings are written in one window and read in the other: the settings window
 * edits them, the panel renders them (the theme, the visible platforms, their
 * order), and both must show the same values without a re-open. The host writes the
 * settings and then broadcasts them to *every* window (`panel://settings`), so both
 * sides can stay in step by subscribing — but "subscribe, and adopt what the host
 * says" is easy to get subtly wrong when each component does it for itself:
 *
 * - a component that only adopts its own write's return value goes stale the moment
 *   the *other* window writes,
 * - a component that only listens for the event waits for a round trip even for the
 *   write it just made,
 * - and two listeners for one event can notify the same React tree twice.
 *
 * The store answers all three the same way: it holds the current settings, applies
 * a write's answer immediately, reconciles the host's broadcast by identity, and
 * notifies exactly once per *change* — an event that echoes the value already held
 * is not a change, so it is not announced.
 *
 * ## What it deliberately does not do
 *
 * No theme side effect: `usePanelTheme` writes `document.documentElement`, and each
 * document has its own. The store is the value, not the surfaces built from it.
 * The theme still reaches both windows because both call `usePanelTheme` on
 * whatever the store reports.
 */

import { parsePanelSettings, type PanelSettings, type PanelSettingsPatch } from '../shared/desktop-contract';
import type { UsageClient } from '../shared/usage-client';

export interface SettingsStore {
  /** The settings as this window currently believes them. */
  read(): PanelSettings;
  /**
   * Write a patch, adopt the answer, and resolve with it.
   *
   * The answer is adopted before the host's broadcast arrives, so a control that
   * depends on the new value (a checked switch, a highlighted option) is correct on
   * the frame the write returns. The broadcast that follows is recognised as an echo
   * and changes nothing.
   */
  write(patch: PanelSettingsPatch): Promise<PanelSettings>;
  /**
   * Re-read the settings from the service and adopt them.
   *
   * For the writes that are not a settings patch — a credential being validated or
   * deleted changes the stored-credential state the service reports. Those answers
   * carry more than the request, so the panel and the settings window both re-read
   * rather than patching their copy by hand.
   */
  refresh(): Promise<PanelSettings>;
  /** Replace the held settings from a source outside this window (a test, a cache). */
  adopt(settings: PanelSettings): void;
  /** Observe every change. Returns the unsubscribe function. */
  subscribe(listener: (settings: PanelSettings) => void): () => void;
  /** Stop listening to the client. */
  dispose(): void;
}

export interface SettingsStoreOptions {
  /** The client to read and write through. */
  client: UsageClient;
  /** Starting value, when the caller already has one (a cache, a test fixture). */
  initial?: PanelSettings;
}

/**
 * Whether two settings are the same value.
 *
 * Compared canonically — identical shape, identical leaves, key order irrelevant —
 * rather than by reference: the host sends a fresh object for every broadcast, and
 * `platformVisibility` / `peakReminder` / `credentials` are nested objects that the
 * parser rebuilds each time. A structural comparison is what makes an echo
 * recognisable, which is the whole point of having this at all.
 *
 * Written out rather than delegating to `JSON.stringify(value, keys)`: that overload
 * reorders keys at *every* level, including the leaves of arrays, and this is the
 * function that decides whether a window re-renders.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

const sameSettings = (a: PanelSettings, b: PanelSettings): boolean => canonical(a) === canonical(b);

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const { client } = options;
  let current = options.initial ?? parsePanelSettings({});
  const listeners = new Set<(settings: PanelSettings) => void>();

  /** Adopt a value, announcing it only when it is really a different one. */
  const adopt = (next: PanelSettings) => {
    if (sameSettings(current, next)) return;
    current = next;
    for (const listener of listeners) listener(current);
  };

  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'settings') adopt(event.settings);
  });

  return {
    read: () => current,
    async write(patch) {
      const next = await client.updateSettings(patch);
      adopt(next);
      return next;
    },
    async refresh() {
      const next = await client.readSettings();
      adopt(next);
      return next;
    },
    adopt,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
      unsubscribe();
    }
  };
}

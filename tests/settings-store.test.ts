// The settings store: one per window, and the thing that makes "the setting I just
// changed in the other window is already here" true without double work.
//
// Two properties carry that, and both are easy to lose by accident:
//
//   1. a write's own answer is adopted immediately, so the control that made the
//      change is correct on the frame the write returns rather than a round trip
//      later;
//   2. the host's broadcast that follows is recognised as an echo. It is a *fresh
//      object* with the same contents, so a reference comparison would treat it as a
//      change and re-render every consumer of the settings — including the panel's
//      whole card tree — once per write.
//
// The second is why the comparison is structural, and why it is pinned here.
import { describe, expect, it, vi } from 'vitest';
import { parsePanelSettings, type PanelSettings } from '../src/shared/desktop-contract';
import type { PanelEvent, UsageClient } from '../src/shared/usage-client';
import { createSettingsStore } from '../src/desktop/settings/settings-store';

/** A client whose settings can be driven by hand, as the host would drive them. */
function fakeClient(initial: PanelSettings) {
  let settings = initial;
  const listeners = new Set<(event: PanelEvent) => void>();
  const client = {
    async readSettings() {
      return settings;
    },
    async updateSettings(patch: Partial<PanelSettings>) {
      settings = { ...settings, ...patch } as PanelSettings;
      return settings;
    },
    subscribe(listener: (event: PanelEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  } as unknown as UsageClient;
  return {
    client,
    /** What the host would broadcast after a write. */
    broadcast(next: PanelSettings) {
      settings = next;
      for (const listener of [...listeners]) listener({ type: 'settings', settings: next });
    },
    listenerCount: () => listeners.size
  };
}

const base = () => parsePanelSettings({});

describe('settings store', () => {
  it('announces a change once, not once per route', async () => {
    const harness = fakeClient(base());
    const store = createSettingsStore({ client: harness.client });
    const seen = vi.fn();
    store.subscribe(seen);

    await store.write({ theme: 'light' });
    // The write's answer, adopted straight away: the caller does not wait for a
    // round trip to know what it just set.
    expect(store.read().theme).toBe('light');
    expect(seen).toHaveBeenCalledTimes(1);

    // The host then broadcasts the same settings, as a fresh object. That is an
    // echo, not a change: announcing it would re-render every consumer twice per
    // write, which is exactly the kind of thing that shows up as a flicker.
    harness.broadcast({ ...store.read() });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('adopts a write made in the other window', () => {
    const harness = fakeClient(base());
    const store = createSettingsStore({ client: harness.client });
    const seen = vi.fn();
    store.subscribe(seen);

    // The settings window wrote it; this window only ever hears the broadcast.
    harness.broadcast({ ...base(), theme: 'light', quotaValueMode: 'used' });
    expect(store.read().theme).toBe('light');
    expect(store.read().quotaValueMode).toBe('used');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('sees a nested change, and only a nested change', () => {
    const harness = fakeClient(base());
    const store = createSettingsStore({ client: harness.client });
    const seen = vi.fn();
    store.subscribe(seen);

    // A visibility toggle is the interesting case: it arrives as a rebuilt object
    // inside a rebuilt object, so a shallow comparison would call it equal.
    harness.broadcast({ ...base(), platformVisibility: { glm: false } });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(store.read().platformVisibility).toEqual({ glm: false });

    harness.broadcast({ ...base(), platformVisibility: { glm: false } });
    expect(seen).toHaveBeenCalledTimes(1);

    harness.broadcast({ ...base(), platformVisibility: { glm: true } });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('stops listening once it is disposed', () => {
    const harness = fakeClient(base());
    const store = createSettingsStore({ client: harness.client });
    expect(harness.listenerCount()).toBe(1);
    store.dispose();
    expect(harness.listenerCount()).toBe(0);
  });

  it('starts from a cache when the window already has one', () => {
    const harness = fakeClient(base());
    const store = createSettingsStore({ client: harness.client, initial: { ...base(), theme: 'light' } });
    expect(store.read().theme).toBe('light');
  });
});

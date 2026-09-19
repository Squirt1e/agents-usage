/**
 * The settings window's wiring: everything between the transport and the panel.
 *
 * Split out from the entry point so the *window* and the *sheet* (the browser
 * fallback, which mounts the same surface inside the panel's document) — and the
 * component tests — all run the identical code. A test that re-implemented this
 * wiring would be testing a second product: the interesting behaviour here is
 * precisely what a test harness would be tempted to fake, namely which patch goes
 * out, what happens to a credential, and how a section request travels.
 *
 * Returns props ready to spread into `SettingsPanel`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '../../shared/contracts';
import type { CredentialStatus, PanelSettings, PanelSnapshot } from '../../shared/desktop-contract';
import type { UsageClient } from '../../shared/usage-client';
import { createSettingsStore, type SettingsStore } from './settings-store';
import type { SettingsPanelProps, SettingsSection } from './SettingsPanel';

export interface SettingsWindowOptions {
  client: UsageClient;
  /** The section the window was opened on. */
  initialSection?: SettingsSection;
  /** Subscribe to the host's later "show this section" requests. */
  onSelectSectionRequest?: (listener: (section: SettingsSection) => void) => () => void;
  /**
   * Ask the host which section should be showing, once, on mount.
   *
   * The event above only reaches a window that is already listening. A request made
   * while the window was still booting would be lost, so the host records it and the
   * window reads it back here — see `readSection` in `desktop-client.ts`.
   */
  readSection?: () => Promise<SettingsSection | undefined>;
  /** Called once the first render is on screen (the host reveals the window then). */
  onReady?: () => void;
}

export function useSettingsWindow(options: SettingsWindowOptions): SettingsPanelProps {
  const { client, initialSection, onSelectSectionRequest, readSection, onReady } = options;
  /**
   * The same store the panel uses, for the same reason: this window must show what
   * the panel writes, the panel must show what this window writes, and neither may
   * re-render twice for one change (`panel://settings` reaches both).
   */
  const storeRef = useRef<SettingsStore | undefined>(undefined);
  storeRef.current ??= createSettingsStore({ client });
  const store = storeRef.current;
  useEffect(() => () => store.dispose(), [store]);

  const [settings, setSettings] = useState<PanelSettings>(() => store.read());
  const [snapshot, setSnapshot] = useState<PanelSnapshot | undefined>();
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'platforms');
  const [togglingVisibility, setTogglingVisibility] = useState<ReadonlySet<ProviderId>>(new Set());
  /** Whether the mount read has settled, whichever way it went. */
  const [loaded, setLoaded] = useState(false);
  /** Latest settings for handlers that must not close over a stale copy. */
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => store.subscribe(setSettings), [store]);

  /**
   * Load once, on mount.
   *
   * Both outcomes are fine: the window stays usable either way, since every write
   * reports its own failure and the settings it already has are the defaults the
   * panel would show too. What matters is that it settles, because the host is
   * holding the window back until it does.
   */
  useEffect(() => {
    let active = true;
    void Promise.all([store.refresh(), client.readSnapshot()])
      .then(([, nextSnapshot]) => {
        if (active) setSnapshot(nextSnapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [store, client]);

  /**
   * Announce the first render, once.
   *
   * The host keeps the window hidden until this lands, which is what stops an empty
   * window's first frame from ever being visible. Kept in its own effect so the load
   * above does not have to depend on the callback: a caller that builds `onReady`
   * inline would otherwise re-trigger the whole read on every render.
   */
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const announced = useRef(false);
  useEffect(() => {
    if (!loaded || announced.current) return;
    announced.current = true;
    readyRef.current?.();
  }, [loaded]);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'snapshot') setSnapshot(event.snapshot);
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (!onSelectSectionRequest) return;
    return onSelectSectionRequest((next) => setSection(next));
  }, [onSelectSectionRequest]);

  /**
   * Read the section the host is holding, once.
   *
   * Deliberately not dependent on `readSection`'s identity: an inline arrow from the
   * entry point would re-run this on every render, and re-reading would fight the
   * reader the moment they clicked a different section by hand.
   */
  const readSectionRef = useRef(readSection);
  readSectionRef.current = readSection;
  useEffect(() => {
    let active = true;
    void readSectionRef
      .current?.()
      .then((wanted) => {
        if (active && wanted) setSection(wanted);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  /**
   * Write a patch.
   *
   * The store adopts the write's own answer, so the control that made the change is
   * right on the frame the write returns; the host's broadcast that follows reaches
   * this window too and is recognised as an echo rather than a second change. The
   * panel learns about it from the same broadcast — that is what makes a setting
   * changed here visible there.
   */
  const updateSettings = useCallback(
    async (patch: Parameters<UsageClient['updateSettings']>[0]) => {
      await store.write(patch);
    },
    [store]
  );

  const setVisibility = useCallback(
    (provider: ProviderId, visible: boolean) => {
      // Visibility is display only: no connection is stopped and no credential is
      // deleted. The service keeps collecting hidden platforms.
      const next = { ...settingsRef.current.platformVisibility, [provider]: visible };
      setTogglingVisibility((current) => new Set(current).add(provider));
      void updateSettings({ platformVisibility: next }).finally(() => {
        setTogglingVisibility((current) => {
          const rest = new Set(current);
          rest.delete(provider);
          return rest;
        });
      });
    },
    [updateSettings]
  );

  const validateCredential = useCallback(
    async (target: Parameters<UsageClient['validateCredential']>[0], secret: string): Promise<CredentialStatus> => {
      const status = await client.validateCredential(target, secret);
      // The service returns the mask; re-read so this window shows it too. The host
      // re-collects the platform the credential belongs to (`panel_validate_credential`
      // in lib.rs), so this window does not ask for a refresh of its own.
      await store.refresh();
      return status;
    },
    [client, store]
  );

  const deleteCredential = useCallback(
    async (target: Parameters<UsageClient['deleteCredential']>[0]) => {
      await client.deleteCredential(target);
      await store.refresh();
    },
    [client, store]
  );

  return {
    section,
    onSelectSection: setSection,
    settings,
    snapshot,
    togglingVisibility,
    onToggleVisibility: setVisibility,
    onReorder: (order) => void updateSettings({ platformOrder: order }),
    onThemeChange: (theme) => updateSettings({ theme }),
    onQuotaValueModeChange: (quotaValueMode) => updateSettings({ quotaValueMode }),
    onQuotaWarningThresholdChange: (quotaWarningThreshold) => updateSettings({ quotaWarningThreshold }),
    onBalanceWarningThresholdChange: (balanceWarningThreshold) => updateSettings({ balanceWarningThreshold }),
    onUpdateSettings: updateSettings,
    onValidateCredential: validateCredential,
    onDeleteCredential: deleteCredential
  };
}

/**
 * Entry point for the settings window (the host's second document).
 *
 * The whole behaviour lives in `useSettingsWindow`; this file is only the host
 * plumbing around it:
 *
 * - `createDesktopUsageClient()` talks to the Tauri host when the window runs in the
 *   app, and degrades to the loopback HTTP service in a browser,
 * - the section the window was opened on is injected by the host as part of the
 *   window's identity (`window.__AGENTS_USAGE__.settingsSection`), and later requests
 *   arrive as `panel://settings-section` — that is how one window serves every entry
 *   point,
 * - `panel_settings_ready` is what the host waits for before showing the window, so
 *   an empty window's first frame is never visible.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import './panel.css';
import './settings.css';
import { createDesktopUsageClient, createSettingsWindowHost } from './desktop-client';
import { SettingsPanel, parseSettingsSection, type SettingsSection } from './SettingsPanel';
import { useSettingsWindow, type SettingsWindowOptions } from './settings-window';
import { usePanelTheme } from './theme';

export type SettingsAppProps = Omit<SettingsWindowOptions, 'client'> & {
  /** Fixed for the window's lifetime. */
  client: SettingsWindowOptions['client'];
};

export function SettingsApp(props: SettingsAppProps) {
  const panelProps = useSettingsWindow(props);
  // The theme reaches both windows because both call this on whatever the store
  // reports: the palette lives in `panel.css`, and each document resolves it itself.
  usePanelTheme(panelProps.settings.theme);
  return <SettingsPanel {...panelProps} />;
}

function mount(): void {
  const container = document.getElementById('settings-root');
  if (!container) return;

  const client = createDesktopUsageClient();
  const host = createSettingsWindowHost();
  const root = createRoot(container);

  // Stable across renders: the effects that subscribe re-attach when these change.
  const onReady = host ? () => void host.ready() : undefined;
  const onSelectSectionRequest = host
    ? (listener: (section: SettingsSection) => void) =>
        host.subscribeSection((raw) => listener(parseSettingsSection(raw)))
    : undefined;
  const injected = host?.initialSection();
  // The durable half of the section handoff: the host remembers which section the last
  // entry point asked for, so a request that arrived while this window was still booting
  // is not lost (see `readSection` in desktop-client.ts).
  const readSection = host
    ? async () => {
        const raw = await host.readSection();
        return raw === undefined ? undefined : parseSettingsSection(raw);
      }
    : undefined;

  root.render(
    createElement(SettingsApp, {
      client,
      ...(injected ? { initialSection: parseSettingsSection(injected) } : {}),
      ...(onReady ? { onReady } : {}),
      ...(onSelectSectionRequest ? { onSelectSectionRequest } : {}),
      ...(readSection ? { readSection } : {})
    })
  );
}

mount();

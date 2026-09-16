/**
 * Shared harnesses for the two windows.
 *
 * The split moved a lot of behaviour from one window to the other, so most settings
 * tests now belong to the settings window rather than the panel. Both harnesses render
 * the *real* wiring — `main.tsx`'s `onOpenSettings` contract for the panel,
 * `useSettingsWindow` for the settings window — because the interesting behaviour of
 * this feature is exactly what a hand-rolled harness would be tempted to fake: which
 * patch goes out, what a credential does, how a section request travels.
 */
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { PanelApp, type PanelHostProps } from '../../src/desktop/panel/PanelApp';
import { createFakeUsageClient, type FakeUsageClient } from '../../src/desktop/lib/fake-client';
import { SettingsPanel, type SettingsSection } from '../../src/desktop/settings/SettingsPanel';
import { useSettingsWindow } from '../../src/desktop/settings/settings-window';
import { usePanelTheme } from '../../src/desktop/lib/theme';
import type { PanelSettings } from '../../src/shared/desktop-contract';

export const NOW = new Date('2026-09-10T08:00:00.000Z');

export interface PanelHarnessOptions {
  client?: FakeUsageClient;
  settings?: Partial<PanelSettings>;
  onRequestHide?: () => void;
  now?: Date;
}

/**
 * The panel: the overview and the frame around it.
 *
 * `onOpenSettings` is a spy by default, because the panel's half of every settings
 * entry point is "ask the host for this section" and nothing more — the section is
 * what the host turns into a window.
 */
export function renderPanel(options: PanelHarnessOptions = {}) {
  const client = options.client ?? createFakeUsageClient({ settings: options.settings ?? {} });
  const onOpenSettings = vi.fn<(section: SettingsSection) => void>();
  const host: PanelHostProps = {
    pinned: false,
    onTogglePin: vi.fn(),
    onRequestHide: options.onRequestHide ?? vi.fn(),
    onSetHeight: vi.fn()
  };
  const view = render(
    <PanelApp client={client} host={host} now={options.now ?? NOW} onOpenSettings={onOpenSettings} />
  );
  return { client, host, onOpenSettings, ...view };
}

export interface SettingsHarnessOptions {
  client?: FakeUsageClient;
  settings?: Partial<PanelSettings>;
  section?: SettingsSection;
  /** A host request channel, when the test drives "show this section". */
  onSelectSectionRequest?: (listener: (section: SettingsSection) => void) => () => void;
  /** The host's remembered section, when the test drives the mount-time read. */
  readSection?: () => Promise<SettingsSection | undefined>;
  onReady?: () => void;
}

/** The settings window's content, through its own wiring. */
export function SettingsWindowHarness(props: SettingsHarnessOptions) {
  const panelProps = useSettingsWindow({
    client: props.client!,
    ...(props.section ? { initialSection: props.section } : {}),
    ...(props.onSelectSectionRequest ? { onSelectSectionRequest: props.onSelectSectionRequest } : {}),
    ...(props.readSection ? { readSection: props.readSection } : {}),
    ...(props.onReady ? { onReady: props.onReady } : {})
  });
  // Both entry points do this (see `settings-main.tsx` and `main.tsx`): the theme is
  // per *document*, and the settings window is its own document.
  usePanelTheme(panelProps.settings.theme);
  return <SettingsPanel {...panelProps} />;
}

export function renderSettings(options: SettingsHarnessOptions = {}) {
  const client = options.client ?? createFakeUsageClient({ settings: options.settings ?? {} });
  const view = render(<SettingsWindowHarness {...options} client={client} />);
  return { client, ...view };
}

/**
 * Both windows on screen at once, over one client.
 *
 * This is the arrangement the feature exists for: a change made in the settings
 * window shows up in the panel without a re-open. Neither harness can show that on
 * its own.
 */
export function renderBothWindows(options: SettingsHarnessOptions = {}) {
  const client = options.client ?? createFakeUsageClient({ settings: options.settings ?? {} });
  const panel = renderPanel({ client, ...(options.settings ? { settings: options.settings } : {}) });
  const settings = render(<SettingsWindowHarness {...options} client={client} />);
  return { client, panel, settings };
}

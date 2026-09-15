/**
 * Entry point for the compact menubar panel.
 *
 * Wires the shared usage client and the host window controls to `PanelApp`:
 * - `createDesktopUsageClient()` talks to the Tauri host when the panel runs in
 *   the app, and degrades to the loopback HTTP service in a browser,
 * - `createDesktopHostControls()` asks the host to hide the window (Escape with no
 *   overlay open), to pin/unpin it, and to open the companion web page,
 * - the pinned state comes from the host: the panel renders what the host reports
 *   and never keeps a private copy, so a menu-bar click and the pin button agree,
 * - the header's collapse follows the pointer: the host tracks the window's cursor
 *   enter/leave (a non-key window's webview sees no pointer events) and reports the
 *   intended header visibility here.
 *
 * ## Settings
 *
 * Every settings entry point asks the host to open the settings window
 * (`panel_open_settings`). Outside Tauri there is no second window to open, so this
 * file mounts the very same surface as a 560x380 sheet over this document: the
 * component, its sections and its behaviour are identical, only the shell differs
 * (see `SettingsPanel` and `settings-window.ts`).
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import './panel.css';
import './settings.css';
import { PanelApp, type PanelHostProps } from './PanelApp';
import { SettingsPanel, type SettingsSection } from './SettingsPanel';
import { useSettingsWindow } from './settings-window';
import { usePanelTheme } from './theme';
import { createBrowserFallbackHost, createDesktopHostControls, createDesktopUsageClient } from './desktop-client';
import type { UsageClient } from '../shared/usage-client';

/**
 * The browser fallback's settings surface: the same panel, the same wiring, hosted
 * in a sheet instead of a window.
 *
 * It is a separate component rather than a branch inside `PanelApp` because the
 * panel is not the settings window's parent anywhere else — putting "maybe render
 * settings" inside it would make the panel the one component that knows about the
 * fallback, which is exactly the coupling the split removed.
 */
function SettingsSheet(props: {
  client: UsageClient;
  section: SettingsSection;
  onSelectSection(section: SettingsSection): void;
  onClose(): void;
}) {
  const panelProps = useSettingsWindow({
    client: props.client,
    initialSection: props.section,
    onSelectSectionRequest: (listener) => {
      // A sheet never receives a host request, but the entry points can re-target it
      // (clicking another card's gear while it is open), so the prop is honoured.
      listener(props.section);
      return () => undefined;
    }
  });
  usePanelTheme(panelProps.settings.theme);
  return (
    <div className="settings-sheet-backdrop" onClick={props.onClose}>
      {/* The sheet is the settings window's own frame, so a click inside it must not
          close it — the same rule the panel has for internal clicks. */}
      <div className="settings-sheet" role="dialog" aria-label="设置" onClick={(event) => event.stopPropagation()}>
        <SettingsPanel {...panelProps} onSelectSection={props.onSelectSection} />
      </div>
    </div>
  );
}

function mount(): void {
  const container = document.getElementById('panel-root');
  if (!container) return;

  const client = createDesktopUsageClient();
  const controls = createDesktopHostControls();
  // Outside Tauri there is nothing to hide or pin; the panel stays fully usable
  // (this is also the path the panel tests and the browser preview take).
  const host = controls ?? createBrowserFallbackHost(() => client.openWebVersion());
  const root = createRoot(container);

  let pinned = false;
  // The panel's header follows the pointer, and the host owns the pointer
  // tracking (cursor enter/leave fire even when the window is not key). The
  // panel only renders what the host reports, so a re-show or a hover that never
  // left replays nothing.
  let headerVisible = true;
  // Stable across renders: the panel's height effect re-attaches when this
  // identity changes, and re-rendering must not restart the measurement.
  const setHeight = (height: number) => {
    void host.setHeight(height);
  };

  /** Which settings section the sheet is showing, or `undefined` when it is closed. */
  let sheetSection: SettingsSection | undefined;

  const openSettings = (section: SettingsSection) => {
    if (controls) {
      void controls.openSettings(section);
      return;
    }
    // Already open on this section: nothing to re-render, and re-rendering would
    // remount the sheet and lose whatever the reader had typed.
    if (sheetSection === section) return;
    sheetSection = section;
    render();
  };

  const render = () => {
    const hostProps: PanelHostProps = {
      pinned,
      headerVisible,
      onTogglePin: () => {
        void host.setPinned(!pinned).then((next) => {
          pinned = next;
          render();
        });
      },
      onRequestHide: () => {
        void host.hide();
      },
      onSetHeight: setHeight
    };
    const onSheet = !controls && sheetSection !== undefined;
    root.render(
      createElement(
        'div',
        null,
        createElement(PanelApp, { client, host: hostProps, onOpenSettings: openSettings }),
        onSheet
          ? createElement(SettingsSheet, {
              client,
              section: sheetSection!,
              onSelectSection: openSettings,
              onClose: () => {
                sheetSection = undefined;
                render();
              }
            })
          : null
      )
    );
  };

  render();
  void host.readPinned().then((value) => {
    if (value === pinned) return;
    pinned = value;
    render();
  });
  // The host can change the pin state on its own (menu-bar menu, focus rules).
  host.subscribePinned((value) => {
    if (value === pinned) return;
    pinned = value;
    render();
  });
  // The header's collapse is host-driven: the host hides it after the pointer has
  // been away for the delay and restores it when the pointer returns or the panel
  // is shown again. Repeated values are dropped, so a hover that never left
  // replays nothing.
  host.subscribeHeader((value) => {
    if (value === headerVisible) return;
    headerVisible = value;
    render();
  });

  // Enter/leave transition. The host announces the intended visibility, plays
  // the window show, and delays the real hide until the leave transition ends,
  // so the panel never disappears without fading out.
  //
  // Only a real state change animates: a repeated "visible" would otherwise dip
  // an already-visible panel to opacity 0 and fade it back, which reads as the
  // panel blinking. The host starts with the window hidden, so `false` is the
  // correct initial belief.
  let visible = false;
  host.subscribeVisibility((next) => {
    if (next === visible) return;
    visible = next;
    if (visible) {
      container.dataset.anim = 'enter';
      // Two frames: let the browser paint the "enter" state before removing it,
      // otherwise the transition is skipped.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (container.dataset.anim === 'enter') delete container.dataset.anim;
        });
      });
      return;
    }
    container.dataset.anim = 'leave';
  });
}

mount();

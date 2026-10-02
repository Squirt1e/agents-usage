/**
 * Entry point for the compact menubar panel.
 *
 * Wires the shared usage client and the host window controls to `PanelApp`:
 * - `createDesktopUsageClient()` talks to the Tauri host when the panel runs in
 *   the app, and degrades to the loopback HTTP service in a browser,
 * - `createDesktopHostControls()` asks the host to hide the window (Escape with no
 *   overlay open) and to open the companion web page,
 * - the header's collapse follows the pointer: the host tracks the window's cursor
 *   enter/leave (a non-key window's webview sees no pointer events) and reports the
 *   intended header visibility here.
 *
 * ## Settings
 *
 * Every settings entry point asks the host to open the settings window
 * (`panel_open_settings`). Outside Tauri there is no second window to open, so this
 * file mounts the very same surface as a 600x400 sheet over this document: the
 * component, its sections and its behaviour are identical, only the shell differs
 * (see `SettingsPanel` and `settings-window.ts`).
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../panel.css';
import '../settings.css';
import { PanelApp, type PanelHostProps } from './PanelApp';
import { SettingsPanel, type SettingsSection } from '../settings/SettingsPanel';
import { useSettingsWindow } from '../settings/settings-window';
import { usePanelTheme } from '../lib/theme';
import { createBrowserFallbackHost, createDesktopHostControls, createDesktopUsageClient, detectDesktopBridge } from '../lib/desktop-client';
import type { UsageClient } from '../../shared/usage-client';

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

/**
 * How long the rail's window takes to reach a new height, in milliseconds.
 *
 * Only the rail height travels. Its width stays at 58 points while the separate
 * detail window owns its own frame. The duration follows the size motion budget.
 */
const MINIMAL_LAYOUT_ANIMATION_MS = 220;

function mount(): void {
  const container = document.getElementById('panel-root');
  if (!container) return;

  const client = createDesktopUsageClient();
  const controls = createDesktopHostControls();
  const detailBridge = detectDesktopBridge();
  const setMinimalDetail: NonNullable<PanelHostProps['onSetMinimalDetail']> = (selection, index) => {
    void detailBridge?.invoke('panel_set_minimal_detail', { selection, index });
  };
  // Outside Tauri there is nothing to hide; the panel stays fully usable
  // (this is also the path the panel tests and the browser preview take).
  const host = controls ?? createBrowserFallbackHost(() => client.openWebVersion());
  const root = createRoot(container);

  // The panel's header follows the pointer, and the host owns the pointer
  // tracking (cursor enter/leave fire even when the window is not key). The
  // panel only renders what the host reports, so a re-show or a hover that never
  // left replays nothing.
  let headerVisible = true;
  // Stable across renders: the panel's height effect re-attaches when this
  // identity changes, and re-rendering must not restart the measurement.
  const setHeight = (height: number) => {
    if (layoutAnimation !== 0) window.cancelAnimationFrame(layoutAnimation);
    layoutAnimation = 0;
    void host.setHeight(height);
  };
  let layoutAnimation = 0;
  const setMinimalLayout = (width: number, height: number, anchor: boolean) => {
    if (layoutAnimation !== 0) window.cancelAnimationFrame(layoutAnimation);
    layoutAnimation = 0;
    /**
     * Where the window is *now*, read from the document rather than remembered.
     *
     * These were shadow variables seeded with the full panel's own size (350 × 560),
     * on the assumption that a `visibility` event had corrected them. A panel the host
     * shows before this document loads — every dev session, and any packaged start
     * where the window is already up — never gets that event, so the first animation
     * of the session began from a size the window had never been: the host was asked
     * for 350 × 560 on its anchoring frame, threw the window open to that, and then
     * animated back down to the rail. The viewport cannot be stale in the same way —
     * the webview *is* the window — so it is read here, per animation.
     */
    const fromHeight = window.innerHeight;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    // Nothing to travel: the width steps here regardless, and a height that barely
    // moved does not deserve an animation that repaints the same frame for its whole
    // duration. `reduced` takes the same branch, so the preference drops the movement
    // rather than the size change.
    if (reduced || Math.abs(height - fromHeight) < 1) {
      void host.setMinimalLayout(width, height, anchor);
      return;
    }
    // The width is the whole of the "reveal": one frame at the target, anchored if
    // this call is the one that brought the rail into existence. Only the height below
    // is reported again.
    void host.setMinimalLayout(width, fromHeight, anchor);
    const started = window.performance.now();
    const step = () => {
      const progress = Math.min(1, (window.performance.now() - started) / MINIMAL_LAYOUT_ANIMATION_MS);
      // Ease-out, not ease-in-out: this is a reveal. The window's right edge is
      // pinned by the anchor, so what the reader sees is the card being uncovered
      // from the left — and that reads as arriving, not as travelling away and back.
      const eased = 1 - (1 - progress) ** 3;
      void host.setMinimalLayout(width, fromHeight + (height - fromHeight) * eased, false);
      layoutAnimation = progress === 1 ? 0 : window.requestAnimationFrame(step);
    };
    layoutAnimation = window.requestAnimationFrame(step);
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
      headerVisible,
      onRequestHide: () => {
        void host.hide();
      },
      onSetHeight: setHeight,
      // Absent outside the app, and that absence is the whole signal: the companion
      // web page serves this same document, where a 58-point rail would be a column
      // in the middle of a full-size page. `PanelApp` reads this to stay on the cards.
      ...(controls ? { onSetMinimalLayout: setMinimalLayout, onSetMinimalDetail: setMinimalDetail } : {})
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
      if (layoutAnimation !== 0) window.cancelAnimationFrame(layoutAnimation);
      layoutAnimation = 0;
      window.dispatchEvent(new Event('panel:reopened'));
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

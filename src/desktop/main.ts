/**
 * Entry point for the compact menubar panel.
 *
 * Wires the shared usage client and the host window controls to `PanelApp`:
 * - `createDesktopUsageClient()` talks to the Tauri host when the panel runs in
 *   the app, and degrades to the loopback HTTP service in a browser,
 * - `createDesktopHostControls()` asks the host to hide the window (Escape with no
 *   overlay open), to pin/unpin it, and to open the companion web page,
 * - the pinned state comes from the host: the panel renders what the host reports
 *   and never keeps a private copy, so a menu-bar click and the pin button agree.
 * - the header's collapse follows the pointer: the host tracks the window's cursor
 *   enter/leave (a non-key window's webview sees no pointer events) and reports the
 *   intended header visibility here.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import './panel.css';
import { PanelApp, type PanelHostProps } from './PanelApp';
import { createBrowserFallbackHost, createDesktopHostControls, createDesktopUsageClient } from './desktop-client';

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
    root.render(createElement(PanelApp, { client, host: hostProps }));
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

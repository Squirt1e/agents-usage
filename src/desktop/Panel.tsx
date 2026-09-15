/**
 * The panel shell: 350 logical pixels wide, header with the title, the top icon row
 * (refresh / settings / pin), a body that scrolls inside the window's height, and
 * the frame's bottom status module.
 *
 * It is purely presentational — `PanelApp` owns the data. There is no page state
 * left here: the settings surfaces are their own window, so the body always shows
 * the overview. What used to drive a page swap (`viewKey` + `direction`, which
 * reached CSS as `data-view-direction`) went with them, and with it the exit
 * animation a swap needed: a panel that never swaps a page has nothing to animate
 * away from.
 */

import type { ReactNode } from 'react';
import { useHeaderCollapse } from './panel-header';

export interface PanelProps {
  title: string;
  /**
   * Whether the header is meant to be on screen. `false` marks the panel with
   * `data-header-hidden` (the CSS visibility/border steps key on it) and starts
   * the collapse travel in `panel-header.ts`; the collapse is host-driven (a
   * pinned panel's header settles away while the panel is out of focus), so this
   * only renders the intent.
   */
  headerVisible?: boolean;
  /**
   * Header icon buttons. The row belongs to the overview, which is the only page,
   * so it is always on screen.
   */
  tools?: ReactNode;
  /**
   * The message stack (refresh result, dropped stream, failed settings write). It
   * hangs just above the frame's bottom row and floats over the content, so a
   * message never moves the cards and never changes the height the window is
   * asked for.
   */
  toasts?: ReactNode;
  /**
   * The frame's bottom status module, below the scrolling body so it keeps its
   * place instead of scrolling away with the content.
   */
  footer?: ReactNode;
  /** Persistent connection details, anchored above the footer without layout space. */
  details?: ReactNode;
  children: ReactNode;
}

export function Panel(props: PanelProps) {
  const attachHeader = useHeaderCollapse(props.headerVisible !== false);
  return (
    <div
      className="panel"
      data-panel-surface="true"
      data-header-hidden={props.headerVisible === false ? '' : undefined}
    >
      <header
        ref={attachHeader}
        className="panel-header"
        aria-hidden={props.headerVisible === false ? true : undefined}
        data-tauri-drag-region="deep"
      >
        <div className="panel-heading">
          <h1 className="panel-title">{props.title}</h1>
        </div>
        {props.tools ? <div className="panel-tools">{props.tools}</div> : null}
      </header>
      <div className="panel-body">{props.children}</div>
      {/* The bottom row is the stack's anchor: `bottom: 100%` on `.panel-toasts`
          lands the messages just above it whatever that row's height is. The
          wrapper exists so the anchor survives a panel without a footer. */}
      <div className="panel-bottom">
        {props.footer ? (
          <footer className="panel-footer" data-testid="panel-footer">
            {props.footer}
          </footer>
        ) : null}
        {props.details}
        {props.toasts}
      </div>
    </div>
  );
}

export interface PanelIconButtonProps {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  active?: boolean;
  onClick(): void;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  children: ReactNode;
}

export function PanelIconButton(props: PanelIconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button${props.active ? ' is-active' : ''}`}
      aria-label={props.label}
      {...(props.pressed === undefined ? {} : { 'aria-pressed': props.pressed })}
      disabled={props.disabled === true}
      onClick={props.onClick}
      ref={props.buttonRef}
    >
      {props.children}
    </button>
  );
}

/**
 * The panel shell: 350 logical pixels wide, header with title and sync time, the
 * top icon row (refresh / platform management / pin), and a body that scrolls
 * inside a bounded height.
 *
 * It is purely presentational — `PanelApp` owns the data and the view state. The
 * one thing this file decides is how a page swap is animated: `viewKey` and
 * `direction` are handed to CSS (see the page-transition section of `panel.css`)
 * instead of being animated in JavaScript.
 */

import type { ReactNode } from 'react';
import { useHeaderCollapse } from './panel-header';
import { BackIcon } from './icons';

/** Which way a page swap travels: deeper into the panel, or back out of it. */
export type PanelDirection = 'forward' | 'back';

export interface PanelProps {
  title: string;
  /**
   * Identity of the page in the body: `overview`, `app-settings`, or
   * `settings:<provider>`. It reaches the DOM as a React `key`, so a new value
   * remounts the page — which is what replays the transition, and why the body
   * also comes back scrolled to its top rather than keeping the offset of the
   * page that left.
   */
  viewKey: string;
  /** Which way the user last travelled, for the transition to animate along. */
  direction: PanelDirection;
  onBack?(): void;
  /**
   * Header icon buttons. They stay mounted on the pages that do not own them and
   * are hidden rather than unmounted, so hiding them can be a fade instead of a
   * blink; `toolsVisible` drives that.
   */
  tools?: ReactNode;
  /** Whether this page owns the tool row; `false` fades it out (see `.panel-tools`). */
  toolsVisible?: boolean;
  /** Inner overlay (platform management) rendered above the body. */
  overlay?: ReactNode;
  /**
   * Whether the header is meant to be on screen. `false` marks the panel with
   * `data-header-hidden` (the CSS visibility/border steps key on it) and starts
   * the collapse travel in `panel-header.ts`; the collapse is host-driven (a
   * pinned panel's header settles away while the panel is out of focus), so this
   * only renders the intent.
   */
  headerVisible?: boolean;
  /**
   * The message stack (refresh result, dropped stream, failed settings write). It
   * hangs just above the frame's bottom row and floats over the content, so a
   * message never moves the cards and never changes the height the window is
   * asked for.
   */
  toasts?: ReactNode;
  /**
   * The frame's bottom status module, below the scrolling body so it keeps its
   * place on every page instead of scrolling away with the content.
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
      data-view-direction={props.direction}
      data-header-hidden={props.headerVisible === false ? '' : undefined}
    >
      <header
        ref={attachHeader}
        className="panel-header"
        aria-hidden={props.headerVisible === false ? true : undefined}
        data-tauri-drag-region="deep"
      >
        {/* Keyed like the body: the heading names the page, so it travels with it
            rather than cutting to the new title in place. */}
        <div className="panel-heading" key={props.viewKey}>
          <h1 className="panel-title">
            {props.onBack ? (
              <button type="button" className="back-button" onClick={props.onBack} aria-label="返回用量总览">
                <BackIcon />{props.title}
              </button>
            ) : props.title}
          </h1>
        </div>
        {/* The row is kept mounted on sub-pages so its exit is a fade rather than a
            blink; `aria-hidden` is what keeps its buttons out of every query and off
            the accessibility tree while it is hidden. */}
        {props.tools ? (
          <div className="panel-tools" aria-hidden={props.toolsVisible === false ? true : undefined}>
            {props.tools}
          </div>
        ) : null}
      </header>
      <div className="panel-body" key={props.viewKey}>{props.children}</div>
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
      {props.overlay}
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

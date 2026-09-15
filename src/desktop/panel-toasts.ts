/**
 * The panel's messages: what a toast carries, how long it stays, and how a stack
 * of them behaves.
 *
 * A message reports something that just happened (a refresh verdict, a dropped
 * stream, a failed settings write). It floats over the content instead of taking
 * a row, and it withdraws on its own — so the rules here are plain data
 * operations, testable without a layout engine, and `PanelToasts.tsx` is the thin
 * part that renders them and runs the clocks.
 */

import type { StatusTone } from './StatusRow';

/** A message before it enters the stack. */
export interface PanelNotice {
  tone: StatusTone | 'info';
  text: string;
  /**
   * What the message is about, for the one case the panel itself has to take it
   * back: the live-connection warning goes away when the stream reopens, which no
   * timer can know.
   */
  tag?: string;
}

/** A message on screen. */
export interface PanelToast extends PanelNotice {
  /** Stable across renders, so the item keeps its own clock and animation. */
  id: number;
  /**
   * How many times this same message has been reported. It keys the countdown:
   * repeating a message restarts its clock instead of stacking a duplicate.
   */
  repeat: number;
}

/**
 * How long a message stays before it withdraws on its own.
 *
 * A result is one short line ("Codex 已更新") and is read at a glance, so it leaves
 * quickly. A failure names the platform, the fallback and the reason — a line or
 * two at 11px — and gets longer, because a message that vanishes mid-read is worse
 * than one that lingers a moment. Neither is a delay the user has to wait out:
 * a message is a note about something already on screen, not a gate.
 */
export const NOTICE_TIMEOUT_MS = 2_500;
export const NOTICE_ERROR_TIMEOUT_MS = 4_500;

/** The dwell time for a message, by tone. */
export function noticeTimeoutMs(tone: PanelNotice['tone']): number {
  return tone === 'warning' || tone === 'danger' ? NOTICE_ERROR_TIMEOUT_MS : NOTICE_TIMEOUT_MS;
}

/**
 * How long the exit takes before the item leaves the stack.
 *
 * Kept in step with the transform/opacity transition on `.panel-toast.is-leaving`:
 * dropping the item any earlier would cut its own exit short.
 */
export const PANEL_TOAST_EXIT_MS = 150;

/**
 * How many messages the stack may hold at once.
 *
 * The stack hangs off the bottom of the frame and the panel is ~560 pixels tall,
 * so a fourth toast would start covering the cards the user is reading. Past the
 * limit the oldest leaves: what just happened is what the user wants to see.
 */
export const PANEL_TOAST_LIMIT = 3;

/**
 * Announce a message.
 *
 * The same text twice is one toast, not two: a flapping connection would
 * otherwise pile up identical rows. The one already on screen restarts its clock
 * (that is what `repeat` is for) and keeps its place in the stack.
 */
export function pushToast(stack: PanelToast[], notice: PanelNotice, id: number): PanelToast[] {
  const existing = stack.findIndex((toast) => toast.text === notice.text);
  if (existing !== -1) {
    return stack.map((toast, index) =>
      index === existing ? { ...toast, tone: notice.tone, repeat: toast.repeat + 1 } : toast
    );
  }
  const grown = [...stack, { ...notice, id, repeat: 0 }];
  return grown.length > PANEL_TOAST_LIMIT ? grown.slice(grown.length - PANEL_TOAST_LIMIT) : grown;
}

/** Drop one message, once its exit has played. */
export function dropToast(stack: PanelToast[], id: number): PanelToast[] {
  return stack.filter((toast) => toast.id !== id);
}

/** Take back every message carrying a tag (the connection warning, for instance). */
export function dropToastsTagged(stack: PanelToast[], tag: string): PanelToast[] {
  return stack.filter((toast) => toast.tag !== tag);
}

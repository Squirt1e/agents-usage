/**
 * How tall the panel asks to be.
 *
 * The main page owns the height; every other page inherits it:
 *
 * - **The main page with cards.** The window is exactly as tall as the cards need
 *   — measured from their real bottoms, capped at three complete cards so a fourth
 *   is reached by scrolling — so there is never half a card at the fold and never
 *   blank space under the last one.
 * - **The main page with no cards** (every platform hidden, or the first loading
 *   frame). The window takes the minimum height.
 * - **Every other page** — the settings page, each per-platform configuration
 *   page. They never decide a height of their own: they follow whatever the main
 *   page currently asks for and scroll inside it, so opening a form neither
 *   stretches the panel nor makes it jump.
 *
 * Only cards count: the `data-panel-block="section"` markers on settings blocks are
 * inert for sizing. The split here is deliberate — `desiredPanelHeight` is plain
 * arithmetic over measurements, so the rule is unit-testable without a layout
 * engine, and `usePanelHeight` is the thin part that reads the DOM and reports the
 * number to the host.
 */

import { useEffect, useRef } from 'react';

/** Floor for the panel; matches `min-height` on `.panel` and the host's own floor. */
export const PANEL_MIN_HEIGHT = 320;

/** The most whole cards the panel ever shows at once. */
export const MAX_VISIBLE_CARDS = 3;

/** Attribute marking a card-like block, and the value that makes it a card. */
export const PANEL_BLOCK_ATTRIBUTE = 'data-panel-block';
export const PANEL_CARD_VALUE = 'card';

/**
 * Attribute the content sets on `.panel` while it is animating its own layout.
 *
 * The window is the one box CSS cannot animate, and the panel normally waits for
 * the layout to settle (`PANEL_HEIGHT_SETTLE_MS`) before asking the host for a new
 * size and then travels there over `PANEL_HEIGHT_ANIMATION_MS`. That is right for
 * a step — data landing, a card appearing — but wrong for an animation the
 * content is already playing: waiting for it to finish means the window collapses
 * *after* the movement that caused it, which reads as the panel being a beat
 * behind. While this attribute is set, the measured height is reported on the
 * frame it was measured, so the window and the content move as one.
 *
 * It is an attribute rather than a module flag so that the announcement belongs to
 * the panel that carries it: it can be seen, and it cannot outlive the animation
 * that set it.
 */
export const PANEL_ANIMATING_ATTRIBUTE = 'data-panel-animating';

/**
 * How long the content must hold still before the host is asked to resize.
 *
 * Resizing on every frame of a load would step the window (the loading state,
 * then cards as data lands); waiting for the layout to settle collapses that into
 * one movement, and is far below the threshold where a resize reads as late.
 */
export const PANEL_HEIGHT_SETTLE_MS = 80;

/**
 * How long the window takes to travel from one height to the next.
 *
 * The host can only *set* a size, so the panel animates the window itself by
 * reporting a height per frame along an ease-in-out curve. Steps this small read
 * as one smooth movement, and keeping it near the panel's own fade (260ms) makes
 * a grow-on-open look like part of the same motion.
 *
 * This is the one switch CSS cannot make, which is why the preference is checked
 * in script too: under `prefers-reduced-motion: reduce` the travel is dropped and
 * the target height is reported once (AGENTS.md §1.1/§1.4). The window still
 * changes size — it just stops being a movement.
 */
export const PANEL_HEIGHT_ANIMATION_MS = 240;

/**
 * The one easing curve for everything that travels in step with the window's
 * height: the reporting in `usePanelHeight` and the header collapse in
 * `panel-header.ts` share it, so content moving alongside the window never races
 * a differently-shaped curve.
 *
 * Ease-in-out cubic. Not ease-out: a front-loaded curve spends a quarter of the
 * distance on the first frame, which reads as the same snap the animation exists
 * to avoid. This one leaves and lands gently.
 */
export function easeHeightTravel(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

/**
 * Ask the height hook to re-measure now.
 *
 * The header collapse animates a box the height hook does not observe: its
 * `ResizeObserver` watches the body's content, which keeps its size while the
 * header above it shrinks. The collapse loop calls this every frame; with
 * [`PANEL_ANIMATING_ATTRIBUTE`] set, the measurement runs immediately and the
 * intermediate height is reported on the frame it was measured.
 */
let requestMeasure: (() => void) | null = null;

export function requestPanelHeightMeasure(): void {
  requestMeasure?.();
}

/**
 * How often the panel re-takes the measurement when nothing told it to.
 *
 * The measurement normally follows `ResizeObserver`, but a notification can be
 * lost: the host hides this window for most of its life, a hidden WebKit view gets
 * no frames, and a size that changed while it was hidden is never announced when
 * it comes back. The failure is silent and permanent — the window stands at the
 * height its content had minutes ago, too short for the cards on screen.
 *
 * The check is a handful of rectangle reads and reports nothing when the answer is
 * unchanged, so a slow tick costs almost nothing and bounds how long a wrong
 * height can survive. It is the same reasoning as the snapshot re-read in
 * `PanelApp`: the event is the fast path, the tick is the guarantee.
 */
export const PANEL_HEIGHT_SAFETY_MS = 1_000;

/** Whether the user asked for less motion. `matchMedia` is optional in jsdom. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export interface PanelHeightInput {
  /** Window border, header, footer and body padding: everything that is not content. */
  chrome: number;
  /**
   * Bottom edges of the cards, relative to the content's top, in document order.
   * Empty on a main page that has no cards to show.
   */
  cardBottoms: number[];
  /** Whether this view is the main page — the one that owns the height. */
  isMain: boolean;
  /** What the main page last asked for, for the views that follow it. */
  mainHeight: number;
}

/**
 * The height the panel should ask the host for, in logical pixels.
 *
 * Main page: the frame plus the bottom edge of the last card it may show whole, or
 * the minimum when it has no cards at all. Any other page: whatever the main page
 * last asked for.
 */
export function desiredPanelHeight(input: PanelHeightInput): number {
  const { chrome, cardBottoms, isMain, mainHeight } = input;
  if (!isMain) return Math.max(PANEL_MIN_HEIGHT, Math.round(mainHeight));
  if (cardBottoms.length === 0) return PANEL_MIN_HEIGHT;
  const lastVisible = cardBottoms[Math.min(cardBottoms.length, MAX_VISIBLE_CARDS) - 1]!;
  return Math.max(PANEL_MIN_HEIGHT, Math.round(chrome + lastVisible));
}

export interface PanelHeightOptions {
  /** Changes when the view does, so the measurement re-attaches to the new content. */
  viewKey: string;
  /** Whether this view is the main page, the only one that decides a height. */
  isMain: boolean;
  /** Report a new desired height. Expected to be stable across renders. */
  onSetHeight(height: number): void;
}

/**
 * Measure the panel and report the height it wants.
 *
 * Re-measures whenever the content resizes (data arriving, a card growing, a view
 * swapping cards for a form) and whenever the view changes. Reports only once the
 * layout has settled, and only a change of a whole pixel — the host resizes the
 * window in response, and a report that echoed the resize back would be a
 * feedback loop.
 *
 * The panel's message is not part of this: it floats over the content instead of
 * taking a row, so it never moves a card and never asks for a different height.
 */
export function usePanelHeight(options: PanelHeightOptions): void {
  const { viewKey, isMain, onSetHeight } = options;
  /** What the main page last asked for; the other pages follow it. */
  const mainHeight = useRef(PANEL_MIN_HEIGHT);
  /** The height the host last applied; 0 until the first report. */
  const reported = useRef(0);
  /** In-flight height animation, so a new target can take it over. */
  const animation = useRef(0);

  useEffect(() => {
    const panel = document.querySelector<HTMLElement>('.panel');
    const body = document.querySelector<HTMLElement>('.panel-body');
    if (!panel || !body) return;

    /**
     * The block the cards live in, resolved on every measurement rather than once.
     *
     * The body's child is swapped whenever the view changes *branch*, and the error
     * state and the overview share one view key — so the element this effect first
     * saw can be replaced without the effect re-running. A remembered reference
     * then measures a detached node, whose rectangles are all zero, and the panel
     * drops to the minimum height with its cards right there on screen.
     */
    const currentContent = (): HTMLElement | null => {
      const next = body.firstElementChild;
      return next instanceof HTMLElement ? next : null;
    };

    /** Send a height, skipping values the host already has. */
    const report = (height: number) => {
      if (Math.abs(height - reported.current) < 1) return;
      reported.current = height;
      onSetHeight(height);
    };

    /**
     * Travel to `height` in steps, because the host has no way to animate a
     * window resize. The very first report is sent as-is: there is no earlier
     * height to travel from, and growing the window up from zero would be absurd.
     * So is every report once motion is unwelcome: the window arrives at its new
     * size without the journey.
     */
    const moveTo = (height: number) => {
      const from = reported.current;
      if (from === 0 || prefersReducedMotion()) {
        if (animation.current !== 0) window.cancelAnimationFrame(animation.current);
        animation.current = 0;
        report(height);
        return;
      }
      if (animation.current !== 0) window.cancelAnimationFrame(animation.current);
      const start = window.performance.now();
      const step = () => {
        const elapsed = window.performance.now() - start;
        const progress = Math.min(1, elapsed / PANEL_HEIGHT_ANIMATION_MS);
        const eased = easeHeightTravel(progress);
        animation.current = progress === 1 ? 0 : window.requestAnimationFrame(step);
        report(progress === 1 ? height : Math.round(from + (height - from) * eased));
      };
      animation.current = window.requestAnimationFrame(step);
    };

    /**
     * Whether the content is animating its own layout right now — in which case
     * the window has to keep up with it instead of being told where it ended up.
     */
    const following = () => panel.hasAttribute(PANEL_ANIMATING_ATTRIBUTE);

    const measure = () => {
      timer = 0;
      const content = currentContent();
      if (!content) return;
      // Point the observer at whatever the body shows now: a swap it was never
      // told about would otherwise leave it watching an element nobody renders into.
      if (content !== observed) {
        observer?.disconnect();
        observer?.observe(content);
        observed = content;
      }
      const styles = window.getComputedStyle(body);
      const padding =
        (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);
      const contentBox = content.getBoundingClientRect();
      const cardBottoms = [
        ...content.querySelectorAll<HTMLElement>(`[${PANEL_BLOCK_ATTRIBUTE}="${PANEL_CARD_VALUE}"]`)
      ].map((card) => card.getBoundingClientRect().bottom - contentBox.top);
      const next = desiredPanelHeight({
        // `panel.offsetHeight - body.clientHeight` is the border, header and
        // footer; the body's padding belongs to the content's frame, not to the
        // content itself.
        chrome: panel.offsetHeight - body.clientHeight + padding,
        cardBottoms,
        isMain,
        mainHeight: mainHeight.current
      });
      // Remembered while the main page is on screen, so a settings page opened
      // afterwards inherits exactly the height the user was just looking at —
      // including the minimum a card-less main page asks for, otherwise opening
      // a form from an emptied overview would snap the window back up to the
      // height of cards that are no longer there.
      if (isMain) mainHeight.current = next;
      // Following the content means reporting what it measures now: travelling to
      // it would put the window's own 240ms slide on top of a movement that is
      // already animated.
      if (following()) report(next);
      else moveTo(next);
    };

    let timer = 0;
    let observed: HTMLElement | null = null;
    let observer: ResizeObserver | null = null;
    const schedule = () => {
      if (timer !== 0) window.clearTimeout(timer);
      // While the content animates itself the layout never holds still, so the
      // settle delay would postpone the measurement until the animation was over —
      // exactly the lag this is here to avoid.
      if (following()) {
        timer = 0;
        measure();
        return;
      }
      timer = window.setTimeout(measure, PANEL_HEIGHT_SETTLE_MS);
    };
    schedule();
    // The header collapse drives measurements through this bridge: the module
    // function exists so `panel-header.ts` can reach the live `schedule` without
    // threading a callback through two component layers.
    requestMeasure = schedule;

    // jsdom has no ResizeObserver; the measurement scheduled above still runs, so
    // tests exercise the reporting path without one — and it runs after this line
    // (the settle delay), so the observer is in place when the content is found.
    observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const safety = window.setInterval(schedule, PANEL_HEIGHT_SAFETY_MS);
    // Coming back from hidden is the moment a missed change is most likely and
    // least tolerable: the user is looking at the panel again, and a correction a
    // tick later reads as the window jumping for no reason.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(safety);
      if (timer !== 0) window.clearTimeout(timer);
      if (animation.current !== 0) window.cancelAnimationFrame(animation.current);
      animation.current = 0;
      if (requestMeasure === schedule) requestMeasure = null;
    };
  }, [viewKey, isMain, onSetHeight]);
}

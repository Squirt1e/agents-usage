/**
 * How tall the panel asks to be.
 *
 * ## The rule
 *
 * The window is as tall as the overview's content needs, and no taller than the
 * display allows. There is no card count in it any more: the panel used to cap
 * itself at three whole cards and fall back to a fixed minimum when it had none,
 * which was arithmetic over card bottoms — and the settings pages, which used to
 * share this window, inherited whatever the overview had asked for. The settings
 * surfaces are their own fixed-size window now, so the panel has exactly one page
 * and one question to answer: how much room does it need?
 *
 * `desiredPanelHeight` is that answer as plain arithmetic, so the rule is
 * unit-testable without a layout engine; `usePanelHeight` is the thin part that
 * reads the DOM and reports the number to the host.
 *
 * ## The invariant that must not be lost
 *
 * **The height must be re-measured, not merely notified.**
 *
 * The panel window spends most of its life hidden, a hidden WebKit view produces no
 * frames, and a `ResizeObserver` notification lost while hidden is never re-sent.
 * The failure is silent and permanent: the window stands at the height its content
 * had minutes ago, too short for the cards on screen, and no event will correct it.
 * (See the archived change `fix-panel-height-follows-cards`, which is where this
 * was learned.) So the measurement is driven by three things, and the third is not
 * an optimisation:
 *
 *  1. a `ResizeObserver` on the content, re-pointed whenever the content element is
 *     replaced — the fast path,
 *  2. a safety tick that re-takes the measurement whether or not anything was
 *     announced, which bounds how long a wrong height can survive,
 *  3. `visibilitychange`, because coming back from hidden is both the moment a
 *     missed change is most likely and the moment it is least tolerable.
 *
 * Anything that removes 2 or 3 has removed the guarantee, not a cost.
 */

import { useEffect, useRef } from 'react';

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
 * Two things set it today: the header's collapse travel, and the quota shape's
 * morph (`QuotaDisplay`). Both are movements of content the window is measured
 * from, so both would otherwise leave the window behind.
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
   * The content element's own height, in the same units as `chrome` (border box,
   * sub-pixel included — the rounding happens once, at the end).
   */
  contentHeight: number;
  /**
   * The tallest the host will make the window, when it knows (the display's work
   * area). The panel does not need to honour it — the host clamps — but knowing it
   * keeps the reported number honest, which matters because the report is compared
   * against the previous one to decide whether to report at all.
   */
  maxHeight?: number;
}

/**
 * The height the panel should ask the host for, in logical pixels.
 *
 * The frame plus the content, capped at the display when the caller knows it. The
 * floor is whatever the frame alone needs — a panel with no content is still a
 * panel — and deliberately not a constant: the old `320` existed to keep the
 * window from collapsing on an empty overview, and an empty overview is now simply
 * a short panel.
 */
export function desiredPanelHeight(input: PanelHeightInput): number {
  const { chrome, contentHeight, maxHeight } = input;
  const wanted = Math.round(chrome + contentHeight);
  const ceiling = maxHeight !== undefined && maxHeight > 0 ? Math.floor(maxHeight) : Number.POSITIVE_INFINITY;
  return Math.max(Math.round(chrome), Math.min(wanted, ceiling));
}

export interface PanelHeightOptions {
  /** Report a new desired height. Expected to be stable across renders. */
  onSetHeight(height: number): void;
  /** The tallest the host will make the window, when the caller knows it. */
  maxHeight?: number;
}

/**
 * Measure the panel and report the height it wants.
 *
 * Re-measures whenever the content resizes (data arriving, a card growing) and on
 * the safety tick. Reports only once the layout has settled, and only a change of a
 * whole pixel — the host resizes the window in response, and a report that echoed
 * the resize back would be a feedback loop.
 *
 * The panel's message stack is not part of this: it floats over the content instead
 * of taking a row, so it never moves a card and never asks for a different height.
 */
export function usePanelHeight(options: PanelHeightOptions): void {
  const { onSetHeight, maxHeight } = options;
  /**
   * The height the host last applied, or `null` before the first report.
   *
   * `null` rather than `0`: a computed height of zero is a real answer (a panel with
   * no measurable content, and every measurement in jsdom), and using `0` as the
   * "nothing yet" sentinel made the first report of such a panel indistinguishable
   * from a repeat of one — so it was never sent at all.
   */
  const reported = useRef<number | null>(null);
  /** In-flight height animation, so a new target can take it over. */
  const animation = useRef(0);
  // Read through a ref so a caller that passes a fresh closure each render does not
  // restart the measurement (and with it the whole observer) on every render.
  const ceiling = useRef(maxHeight);
  ceiling.current = maxHeight;

  useEffect(() => {
    const panel = document.querySelector<HTMLElement>('.panel');
    const body = document.querySelector<HTMLElement>('.panel-body');
    if (!panel || !body) return;

    /**
     * The block the cards live in, resolved on every measurement rather than once.
     *
     * The body's child is swapped whenever the content changes branch — the loading
     * state, the error state and the overview are different elements — so the
     * element this effect first saw can be replaced without the effect re-running. A
     * remembered reference then measures a detached node, whose rectangles are all
     * zero, and the panel shrinks to the frame with its cards right there on screen.
     */
    const currentContent = (): HTMLElement | null => {
      const next = body.firstElementChild;
      return next instanceof HTMLElement ? next : null;
    };

    /** Send a height, skipping values the host already has. */
    const report = (height: number) => {
      if (reported.current !== null && Math.abs(height - reported.current) < 1) return;
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
      if (from === null || prefersReducedMotion()) {
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
      // The content's own border box, read off the element rather than off the
      // scrolling body: `scrollHeight` is measured against the body's padding box,
      // which would make the body's padding part of the content *and* part of the
      // frame below, and the resulting half-padding error is invisible until the
      // window is a few pixels wrong. See `desiredPanelHeight`.
      const contentHeight = content.getBoundingClientRect().height;
      const next = desiredPanelHeight({
        // `panel.offsetHeight - body.clientHeight` is the border, header and
        // footer; the body's padding belongs to the frame around the content, so it
        // is counted here and the content is measured without it.
        chrome: panel.offsetHeight - body.clientHeight,
        contentHeight,
        ...(ceiling.current !== undefined ? { maxHeight: ceiling.current } : {})
      });
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
  }, [onSetHeight]);
}

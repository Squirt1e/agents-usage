/**
 * How the panel's header collapses and comes back.
 *
 * This module only plays the *travel* (`useHeaderCollapse`): the intended
 * visibility is reported by the host (it tracks the window's cursor enter/leave,
 * which still fire while the panel is not key) and rendered by `Panel`. The
 * travel animates a box the height hook does not observe — its `ResizeObserver`
 * watches the body's content, which keeps its size while the header above it
 * shrinks — so it follows the quota-morph contract: while the header travels, the
 * panel carries `data-panel-animating` and asks for a measurement every frame,
 * which is what makes the window shrink in step instead of a beat behind. The
 * curve and the duration are the window height's own (`panel-height.ts`), so
 * header and window share one clock.
 *
 * What CSS owns instead: the divider fading out and the contents leaving the tab
 * order exactly when the height lands on zero (the `visibility` delay on
 * `.panel[data-header-hidden] .panel-header` in panel.css — keyed on the target
 * state this module's caller renders, stepped by transition delay).
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  easeHeightTravel,
  PANEL_ANIMATING_ATTRIBUTE,
  PANEL_HEIGHT_ANIMATION_MS,
  requestPanelHeightMeasure
} from './panel-height';

/**
 * A frame of slack after the loop stops, as in QuotaDisplay: the final
 * measurement has to land while `data-panel-animating` still says "follow me",
 * so the settle path is back in charge only after the report went out.
 */
export const HEADER_COLLAPSE_SLACK_MS = 100;

/**
 * The collapse ticks on a timer, not on `requestAnimationFrame` — on purpose.
 * The travel runs while the panel is *out of focus*, and a WebKit view whose
 * window is not key stops serving frames (the height hook's safety tick exists
 * for the same fact). Timers keep firing there, and progress is computed from
 * the clock rather than counted in frames, so clamped ticks can cost the travel
 * its smoothness but never its end state.
 */
export const HEADER_COLLAPSE_TICK_MS = 16;

/**
 * The header's height `elapsedMs` into a travel between two heights, rounded to
 * whole pixels — the same granularity the window height is reported at, so the
 * two never disagree by half a pixel.
 */
export function headerTravelHeight(from: number, to: number, elapsedMs: number): number {
  const progress = Math.min(1, Math.max(0, elapsedMs / PANEL_HEIGHT_ANIMATION_MS));
  if (progress >= 1) return to;
  return Math.round(from + (to - from) * easeHeightTravel(progress));
}

/** Whether the user asked for less motion. `matchMedia` is optional in jsdom. */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Drive the header element through the collapse/expand travel.
 *
 * Returns a callback ref for the `.panel-header` element. The reported
 * visibility is the target; the element's inline height is the truth while a
 * travel is running (and while collapsed: it stays at `0px`), so an interrupted
 * travel reverses from wherever it actually is. The first sighting of the header
 * is adopted as-is — a panel that comes back already collapsed must not grow out
 * of nothing on its first frame.
 */
export function useHeaderCollapse(headerVisible: boolean): (node: HTMLElement | null) => void {
  const node = useRef<HTMLElement | null>(null);
  const adopted = useRef(false);
  const frame = useRef(0);
  const slack = useRef(0);

  const attach = useCallback((element: HTMLElement | null) => {
    node.current = element;
  }, []);

  useEffect(() => {
    const header = node.current;
    if (!header) return;
    const panel = header.closest('.panel');

    /** Stop the travel and hand the layout back to the settle path. */
    const clear = () => {
      window.clearInterval(frame.current);
      frame.current = 0;
      window.clearTimeout(slack.current);
      slack.current = 0;
      // Removed here rather than only by the slack timer so a travel
      // interrupted by the opposite target cannot leave the announcement
      // stranded: the next run re-announces if it travels.
      panel?.removeAttribute(PANEL_ANIMATING_ATTRIBUTE);
    };

    /** Announce the travel, report the current height, retire the announcement late. */
    const follow = () => {
      if (!panel) return;
      panel.setAttribute(PANEL_ANIMATING_ATTRIBUTE, '');
      requestPanelHeightMeasure();
      window.clearTimeout(slack.current);
      slack.current = window.setTimeout(() => {
        panel.removeAttribute(PANEL_ANIMATING_ATTRIBUTE);
        requestPanelHeightMeasure();
      }, PANEL_HEIGHT_ANIMATION_MS + HEADER_COLLAPSE_SLACK_MS);
    };

    /**
     * The header's padding and bottom border, as the stylesheet declares them.
     *
     * The header is border-box, so a bare `height: 0` bottoms out with the
     * padding and border still occupying their rows — the sliver of empty header
     * left behind after a collapse. The travel therefore shrinks and restores
     * them on the same eased clock as the height.
     */
    type HeaderChrome = { padTop: number; padBottom: number; border: number };
    const ZERO_CHROME: HeaderChrome = { padTop: 0, padBottom: 0, border: 0 };
    const readChrome = (): HeaderChrome => {
      const styles = window.getComputedStyle(header);
      return {
        padTop: Number.parseFloat(styles.paddingTop) || 0,
        padBottom: Number.parseFloat(styles.paddingBottom) || 0,
        border: Number.parseFloat(styles.borderBottomWidth) || 0
      };
    };
    const applyChrome = (chrome: HeaderChrome) => {
      header.style.paddingTop = `${Math.round(chrome.padTop)}px`;
      header.style.paddingBottom = `${Math.round(chrome.padBottom)}px`;
      header.style.borderBottomWidth = `${Math.round(chrome.border)}px`;
    };
    const removeChrome = () => {
      // Kebab-case on purpose: jsdom's `removeProperty` only matches the CSS
      // spelling, while browsers accept either.
      header.style.removeProperty('padding-top');
      header.style.removeProperty('padding-bottom');
      header.style.removeProperty('border-bottom-width');
    };

    /**
     * Travel height and chrome to their targets on the timer, writing and
     * reporting every step. `arrived` runs after the end values are written and
     * measured; the exact end values are what get written even when rounding
     * lands on them a beat before the clock does.
     */
    const runTravel = (
      from: number,
      to: number,
      fromChrome: HeaderChrome,
      toChrome: HeaderChrome,
      arrived: () => void
    ) => {
      const start = window.performance.now();
      const tick = () => {
        const elapsed = window.performance.now() - start;
        const progress = Math.min(1, Math.max(0, elapsed / PANEL_HEIGHT_ANIMATION_MS));
        const eased = easeHeightTravel(progress);
        const height = headerTravelHeight(from, to, elapsed);
        header.style.height = `${height}px`;
        applyChrome({
          padTop: fromChrome.padTop + (toChrome.padTop - fromChrome.padTop) * eased,
          padBottom: fromChrome.padBottom + (toChrome.padBottom - fromChrome.padBottom) * eased,
          border: fromChrome.border + (toChrome.border - fromChrome.border) * eased
        });
        requestPanelHeightMeasure();
        if (height === to) {
          window.clearInterval(frame.current);
          frame.current = 0;
          arrived();
        }
      };
      follow();
      frame.current = window.setInterval(tick, HEADER_COLLAPSE_TICK_MS);
    };

    // First sighting: pin the reported state without travelling.
    if (!adopted.current) {
      adopted.current = true;
      if (!headerVisible) {
        header.style.height = '0px';
        applyChrome(ZERO_CHROME);
      }
      return;
    }

    /** Where the header stands right now: inline height and chrome are authoritative. */
    const was = header.getBoundingClientRect().height;
    const fromChrome = readChrome();

    if (headerVisible) {
      // Expanding: read the natural height with every constraint off, then put
      // them back and travel from wherever the header actually is.
      header.style.removeProperty('height');
      header.style.removeProperty('overflow');
      removeChrome();
      const natural = header.getBoundingClientRect().height;
      const naturalChrome = readChrome();
      if (prefersReducedMotion() || natural - was < 0.5) return;
      header.style.overflow = 'hidden';
      header.style.height = `${was}px`;
      applyChrome(fromChrome);
      runTravel(was, natural, fromChrome, naturalChrome, () => {
        // Arrived: the inline constraints come off so future reflows (a longer
        // title, a font change) resize the header naturally.
        header.style.removeProperty('height');
        header.style.removeProperty('overflow');
        removeChrome();
        follow();
      });
      return clear;
    }

    // Collapsing: down to zero from wherever the header stands. The contents
    // leave the tab order through the CSS visibility delay keyed on the target
    // state, landing exactly when the height does.
    header.style.overflow = 'hidden';
    if (prefersReducedMotion()) {
      header.style.height = '0px';
      applyChrome(ZERO_CHROME);
      follow();
      return clear;
    }
    runTravel(was, 0, fromChrome, ZERO_CHROME, () => follow());
    return clear;
  }, [headerVisible]);

  return attach;
}

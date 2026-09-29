/**
 * The host's pointer probe, painted as hover.
 *
 * ## Why a paint at all
 *
 * A webview receives pointer events only while *its* window is key, and the panel's
 * windows mostly are not: the rail's window is unfocused whenever the reader is working
 * in another application, and the detail window can never be key at all — it is created
 * unfocusable so that showing it cannot take the rail's pointer events with it (see
 * `build_minimal_detail_window`). Every `:hover` rule in those documents is therefore
 * dead for a reader who has not clicked the panel first, which is exactly the reader the
 * rail exists for.
 *
 * The host samples the pointer for its own header either way and forwards the position
 * (`panel:hover-probe`), so each document answers the one question a real `pointerenter`
 * would answer — what is under this point — and paints `.is-hover` on it. The
 * stylesheet carries an `.is-hover` twin of every `:hover` rule this can reach, and
 * `tests/panel/panel-probe-hover.test.ts` reads both sides so the pair cannot drift.
 *
 * The paint is additive: where the webview *does* see pointer events, `:hover` and
 * `.is-hover` say the same thing, and the two paths cannot disagree.
 */

export interface ProbeHover {
  /**
   * Paint the control under a probe point, and answer what was under it.
   *
   * The answer is the element the point hit, not the control: a caller that needs to ask
   * a second question about the same point (which platform ring is this?) gets the hit
   * it paid for rather than hitting again.
   */
  at(x: number, y: number): Element | null;
  /** Take the paint off — the host's probe with no point says the pointer has left. */
  clear(): void;
}

/**
 * One painter per document, for the selector list that document paints.
 *
 * The paint is kept in a closure rather than in the DOM: exactly one element carries
 * `.is-hover`, and moving the pointer moves it instead of accumulating. A malformed
 * probe clears it too — a cosmetic paint must never be left behind by a message nobody
 * understood.
 */
export function createProbeHover(targets: string): ProbeHover {
  let painted: HTMLElement | null = null;
  const move = (next: HTMLElement | null) => {
    if (painted === next) return;
    painted?.classList.remove('is-hover');
    painted = next;
    next?.classList.add('is-hover');
  };
  return {
    at(x, y) {
      const under = document.elementFromPoint(x, y);
      move(under?.closest<HTMLElement>(targets) ?? null);
      return under;
    },
    clear: () => move(null)
  };
}

/** The point a probe event carries, or `null` when it says the pointer is elsewhere. */
export function probePoint(event: Event): { x: number; y: number } | null {
  const detail = (event as CustomEvent).detail as { x?: unknown; y?: unknown } | null | undefined;
  const x = Number(detail?.x);
  const y = Number(detail?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

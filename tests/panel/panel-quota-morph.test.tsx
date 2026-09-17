// @vitest-environment jsdom
// The quota shape's switch: one stroke that is a ring in one form and a progress
// bar in the other, drawn a frame at a time because path data has no interpolable
// CSS property in WebKit (see the exception in tests/panel-motion.test.ts).
//
// Two things are pinned here, because neither can be seen in a stylesheet:
//
//   1. the geometry of every frame — where the head, the coil and the far end are,
//      that the three beats happen in order, and that nothing leaves the box it is
//      drawn in (the shape used to swing its tail below the item and over the text
//      row underneath);
//   2. what the component does with the preference: reduced motion draws the
//      landing frame on the spot, and the two descriptions of the item overlap
//      only while the morph runs.
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuotaDisplay, type QuotaDisplayItem } from '../../src/desktop/panel/QuotaDisplay';
import {
  BAR_BOX,
  BAR_INSET,
  QUOTA_MORPH_MS,
  RING_BOX,
  RING_CENTER_Y,
  RING_RADIUS,
  RING_STROKE,
  beatEnd,
  headTextOpacity,
  quotaShape,
  ringTextOpacity
} from '../../src/desktop/panel/quota-morph';
import { PANEL_ANIMATING_ATTRIBUTE } from '../../src/desktop/panel/panel-height';

const WIDTH = 160;
const NOW = new Date('2026-09-10T08:00:00.000Z');
const ITEM: QuotaDisplayItem = {
  id: 'five-hour',
  label: '5小时',
  kind: 'five-hour',
  percent: 42,
  resetAt: '2026-09-10T09:42:18.000Z'
};

interface Geometry {
  head: [number, number];
  peel: [number, number];
  tail: [number, number];
  /** Points along the coil, for the extremes a frame reaches. */
  samples: Array<[number, number]>;
  /** The drawn length: the free segment plus whatever the coil still wraps. */
  length: number;
}

/** Read a frame's path back as geometry: the shape is always M/L/… plus one arc. */
function geometryOf(d: string): Geometry {
  const head = /^M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+) (.*)$/.exec(d);
  expect(head, `unexpected path ${d}`).not.toBeNull();
  const [, hx, hy, px, py, rest] = head!;
  const from: [number, number] = [Number(hx), Number(hy)];
  const peel: [number, number] = [Number(px), Number(py)];
  const arc = /^A ([\d.]+) [\d.]+ 0 ([01]) 1 ([\d.-]+) ([\d.-]+)$/.exec(rest);
  if (!arc) {
    const line = /^L ([\d.-]+) ([\d.-]+)$/.exec(rest);
    expect(line, `unexpected path tail ${rest}`).not.toBeNull();
    const tail: [number, number] = [Number(line![1]), Number(line![2])];
    const free = Math.hypot(peel[0] - from[0], peel[1] - from[1]);
    return {
      head: from,
      peel,
      tail,
      samples: [from, peel, tail],
      length: free + Math.hypot(tail[0] - peel[0], tail[1] - peel[1])
    };
  }
  const radius = Number(arc[1]);
  const tail: [number, number] = [Number(arc[3]), Number(arc[4])];
  const chord = Math.hypot(tail[0] - peel[0], tail[1] - peel[1]);
  const half = Math.asin(Math.min(1, chord / (2 * radius)));
  const turn = arc[2] === '1' ? Math.PI * 2 - 2 * half : 2 * half;
  // A clockwise arc leaving the tangent point levels off downwards, so its centre
  // sits one radius below it.
  const centre: [number, number] = [peel[0], peel[1] + radius];
  const samples: Array<[number, number]> = [from, peel];
  for (let step = 0; step <= 64; step += 1) {
    const angle = (turn * step) / 64;
    samples.push([centre[0] + radius * Math.sin(angle), centre[1] - radius * Math.cos(angle)]);
  }
  return { head: from, peel, tail, samples, length: Math.hypot(peel[0] - from[0], peel[1] - from[1]) + radius * turn };
}

const frames = (step = 0.01) => Array.from({ length: Math.round(1 / step) + 1 }, (_, i) => i * step);

describe('quota shape: the two resting forms', () => {
  it('is a ring that starts at 12 o’clock and closes on itself', () => {
    const ring = geometryOf(quotaShape(0, WIDTH).d);

    // The fill's origin is the stroke centre at the top of the ring, so the break
    // — and the point the animation pulls left — is where the design says it is.
    expect(ring.head[0]).toBeCloseTo(WIDTH / 2, 1);
    expect(ring.head[1]).toBeCloseTo(RING_CENTER_Y - RING_RADIUS, 1);
    expect(ring.peel).toEqual(ring.head);
    // Nearly a whole circle: the coil ends a hair counter-clockwise of the start,
    // which is the hairline break the resting ring shows.
    expect(quotaShape(0, WIDTH).d).toContain(`A ${RING_RADIUS}.00 ${RING_RADIUS}.00`);
    expect(ring.tail[0]).toBeCloseTo(ring.head[0] - 1, 0);
    expect(ring.length).toBeCloseTo(2 * Math.PI * RING_RADIUS - 1, 0);
    expect(quotaShape(0, WIDTH).strokeWidth).toBe(RING_STROKE);
    expect(quotaShape(0, WIDTH).drop).toBe(0);
  });

  it('is a straight bar across the item, with the label row in place', () => {
    const bar = quotaShape(1, WIDTH);

    expect(bar.d).toBe(`M ${BAR_INSET}.00 ${BAR_BOX / 2}.00 L ${WIDTH / 2}.00 ${BAR_BOX / 2}.00 L ${WIDTH - BAR_INSET}.00 ${BAR_BOX / 2}.00`);
    expect(bar.strokeWidth).toBe(4);
    expect(bar.drop).toBe(1);
    expect(bar.ringTextOpacity).toBe(0);
  });

  it('draws the bar form as a bar even when the item has not been measured yet', () => {
    expect(quotaShape(1, 0).d).toContain('L');
    expect(quotaShape(1, 0).d).not.toContain('NaN');
  });
});

describe('quota shape: the three beats', () => {
  it('unwinds the coil by exactly what the head took', () => {
    // Beat 1 is a rope being pulled: the length of the drawn line does not change
    // while the head travels, it only leaves the ring.
    const lengths = frames(0.02).map((p) => geometryOf(quotaShape(p * beatEnd(1), WIDTH).d).length);
    for (const length of lengths) expect(length).toBeCloseTo(2 * Math.PI * RING_RADIUS - 1, 0);

    // And the head really does travel: it reaches the bar's left end as beat 1 ends.
    const landed = geometryOf(quotaShape(beatEnd(1), WIDTH).d);
    expect(landed.head[0]).toBeCloseTo(BAR_INSET, 1);
    expect(landed.peel[0]).toBeCloseTo(WIDTH / 2, 1);
    // Still coiled at that point: the far end is on the ring, down and to the left.
    expect(landed.tail[1]).toBeGreaterThan(RING_CENTER_Y);
    expect(landed.tail[0]).toBeLessThan(landed.peel[0]);
  });

  it('straightens what is left into the bar before anything drops', () => {
    const mid = beatEnd(1);
    const straightened = beatEnd(2);

    // The coil is still a coil through beat 2 …
    expect(quotaShape((mid + straightened) / 2, WIDTH).d).toContain('A ');
    // … and a bar at its end, with the item still where the ring form left it.
    const landed = quotaShape(straightened, WIDTH);
    expect(landed.d).not.toContain('A ');
    expect(landed.drop).toBe(0);
    expect(landed.ringTextOpacity).toBe(0);
  });

  it('hands the motion over at the first seam without a jolt', () => {
    // The two ends are one rope up to the seam: the head's step and the far end's
    // step are the same distance, frame for frame.
    const step = 1 / 240;
    const at = (progress: number) => geometryOf(quotaShape(progress, WIDTH).d);
    const headStep = (p: number) => Math.abs(at(p).head[0] - at(p - step).head[0]);
    const tailStep = (p: number) => {
      const before = at(p - step).tail;
      const now = at(p).tail;
      return Math.hypot(now[0] - before[0], now[1] - before[1]);
    };
    for (const p of [0.1, 0.2, 0.3]) {
      expect(Math.abs(headStep(p) - tailStep(p))).toBeLessThan(0.05);
    }

    // At the seam the head lands (its last steps shrink) while the far end keeps
    // going at the speed it already had — no stall, no lurch.
    const seam = beatEnd(1);
    expect(headStep(seam)).toBeLessThan(headStep(0.25) * 0.8);
    expect(headStep(seam + 4 * step)).toBe(0);
    const landing = tailStep(seam);
    expect(tailStep(seam + step)).toBeGreaterThan(landing * 0.9);
    expect(tailStep(seam + step)).toBeLessThan(landing * 1.35);
  });

  it('lets the words leave first and brings the bar row in last', () => {
    expect(ringTextOpacity(0)).toBe(1);
    // A steady ramp rather than one that copies the shape's easing: halfway
    // through its stretch the words are halfway gone, and they are gone before the
    // straightening has finished, so the centre is empty when the coil lands.
    const half = 170 / QUOTA_MORPH_MS;
    expect(ringTextOpacity(half)).toBeCloseTo(0.5, 1);
    expect(ringTextOpacity(340 / QUOTA_MORPH_MS)).toBe(0);
    expect(ringTextOpacity(beatEnd(2))).toBe(0);
    expect(ringTextOpacity(1)).toBe(0);

    // The bar's own line comes in over its own stretch, starting a little before
    // the drop and finishing with it — a steady ramp either side.
    expect(headTextOpacity(0.35)).toBe(0);
    expect(headTextOpacity(beatEnd(2))).toBeCloseTo(0.2, 1);
    expect(headTextOpacity(500 / QUOTA_MORPH_MS)).toBeCloseTo(0.35, 1);
    expect(headTextOpacity(1)).toBe(1);
    const drops = frames(0.02).map((p) => quotaShape(p, WIDTH).drop);
    expect(drops[0]).toBe(0);
    expect(drops[drops.length - 1]).toBe(1);
    for (let index = 1; index < drops.length; index += 1) {
      expect(drops[index]!).toBeGreaterThanOrEqual(drops[index - 1]!);
    }
    // Nothing has dropped while the shape is still straightening.
    expect(quotaShape(beatEnd(2), WIDTH).drop).toBe(0);
  });

  it('stays inside the box it is drawn in', () => {
    // The shape used to swing its far end below the item — over the reset line —
    // and past the item's right edge on the way out of the ring.
    for (const p of frames(0.005)) {
      const { samples } = geometryOf(quotaShape(p, WIDTH).d);
      const ys = samples.map(([, y]) => y);
      const xs = samples.map(([x]) => x);
      expect(Math.max(...ys), `frame ${p} drops below the ring's box`).toBeLessThanOrEqual(RING_BOX);
      expect(Math.min(...xs), `frame ${p} leaves the item on the left`).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs), `frame ${p} leaves the item on the right`).toBeLessThanOrEqual(WIDTH);
    }
  });

  it('runs slow, then quick, then slow — and never stops on the way', () => {
    // The complaint this answers: easing every beat in and out stops the shape at
    // each seam, which reads as three movements. One profile for the whole journey
    // puts the fastest part in the middle and leaves neither seam a standstill.
    // The head travels leftwards, so the ground it covers is the size of the step.
    const headX = (progress: number) => geometryOf(quotaShape(progress, WIDTH).d).head[0];
    const early = Math.abs(headX(0.12) - headX(0.08));
    const middle = Math.abs(headX(0.3) - headX(0.26));
    expect(middle, 'the head should cover more ground mid-journey than at the start').toBeGreaterThan(early * 1.5);

    // Across the first seam the coil is what moves — the head has already arrived.
    const around = 0.02;
    const tailY = (progress: number) => geometryOf(quotaShape(progress, WIDTH).d).tail[1];
    expect(Math.abs(tailY(beatEnd(1) + around) - tailY(beatEnd(1) - around))).toBeGreaterThan(2);
    // Across the second, the drop picks the motion up without a pause.
    const dropSpeed = (progress: number) =>
      quotaShape(progress + around, WIDTH).drop - quotaShape(progress - around, WIDTH).drop;
    expect(dropSpeed(beatEnd(2))).toBeGreaterThan(0.05);
    // And it lands gently: the last stretch moves less than the seam did.
    expect(quotaShape(0.96, WIDTH).drop - quotaShape(0.92, WIDTH).drop).toBeLessThan(dropSpeed(beatEnd(2)));

    // The three beats land where the profile says they do.
    expect(Math.round(beatEnd(1) * QUOTA_MORPH_MS)).toBe(280);
    expect(Math.round(beatEnd(2) * QUOTA_MORPH_MS)).toBe(449);
  });

  it('draws a real path at every step', () => {
    for (const p of frames(0.005)) {
      const frame = quotaShape(p, WIDTH);
      expect(frame.d).not.toMatch(/NaN|Infinity/);
      expect(frame.strokeWidth).toBeGreaterThan(0);
      expect(frame.strokeWidth).toBeLessThanOrEqual(RING_STROKE);
    }
    // Below the flat threshold the coil is a line, never an arc of no radius.
    expect(quotaShape(1, WIDTH).d).not.toContain('A ');
  });
});

describe('quota item: the morph in the DOM', () => {
  /**
   * Replace rAF with a queue the test steps by hand.
   *
   * Every frame is stamped from the real clock plus how far the test has stepped,
   * because the morph measures itself against `performance.now()` from the moment
   * its effect ran: a fixed origin captured earlier would hand it a timestamp from
   * before its own start whenever the machine is slow enough between the two.
   */
  function frozenFrames() {
    const queued = new Map<number, FrameRequestCallback>();
    const origin = window.performance.now();
    let elapsed = 0;
    let nextId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextId += 1;
      queued.set(nextId, callback);
      return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => queued.delete(id));
    return {
      step(ms: number) {
        elapsed += ms;
        const batch = [...queued.entries()];
        queued.clear();
        // Never earlier than the real clock: the morph's own start is read from it.
        const stamp = Math.max(origin, window.performance.now()) + elapsed;
        for (const [, callback] of batch) callback(stamp);
      },
      pending: () => queued.size
    };
  }

  const renderItems = (mode: 'ring' | 'bar', replayKey?: number) =>
    render(
      <QuotaDisplay
        mode={mode}
        valueMode="used"
        items={[ITEM]}
        now={NOW}
        timezone="Asia/Shanghai"
        resetTimeFormat="countdown"
        replayKey={replayKey}
        testId="quota"
      />
    );

  it('does not replay refreshed digits again when the ring becomes a bar', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    frozenFrames();
    const view = renderItems('ring', 1);
    const item = screen.getByTestId('quota-item-five-hour');

    // A fresh replay key still owns the one intended roll.
    const refreshedDigits = [...item.querySelectorAll('.rolling-number-strip')];
    expect(refreshedDigits.length).toBeGreaterThan(0);
    for (const strip of refreshedDigits) fireEvent.animationEnd(strip);
    expect(item.querySelector('.rolling-number-strip')).toBeNull();

    // Changing only the shape must not create a second roll from zero.
    act(() => view.rerender(
      <QuotaDisplay
        mode="bar"
        valueMode="used"
        items={[ITEM]}
        now={NOW}
        timezone="Asia/Shanghai"
        resetTimeFormat="countdown"
        replayKey={1}
        testId="quota"
      />
    ));
    expect(item.querySelector('.rolling-number-strip')).toBeNull();
    expect(item.querySelector('.quota-item-head .quota-value')).toHaveTextContent('42%');
  });

  it('draws the landing frame at once when motion is unwelcome', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query }));
    const frames = frozenFrames();
    const view = renderItems('ring');

    act(() => view.rerender(<QuotaDisplay mode="bar" valueMode="used" items={[ITEM]} now={NOW} timezone="Asia/Shanghai" resetTimeFormat="countdown" testId="quota" />));

    const item = screen.getByTestId('quota-item-five-hour');
    const paths = [...item.querySelectorAll('path')];
    expect(paths.length).toBe(2);
    expect(paths[0]!.getAttribute('d')).not.toContain('A ');
    expect(frames.pending(), 'reduced motion must not queue a frame').toBe(0);
    // The resting values are the sheet's job again once the morph is over.
    expect(item.getAttribute('style') ?? '').not.toContain('--quota-drop');
    expect(item).toHaveAttribute('data-mode', 'bar');
    expect(item.querySelector('.quota-item-head')).not.toBeNull();
    expect(item.querySelector('.quota-item-ringtext')).toBeNull();
  });

  it('makes the whole item the toggle and leaves the reset line its own click', () => {
    renderItems('ring');
    const item = screen.getByTestId('quota-item-five-hour');
    const toggle = within(item).getByRole('button', { name: '切换为进度条' });

    // The stroke lives inside the toggle …
    expect(toggle.querySelector('.quota-shape')).not.toBeNull();
    // … and the reset line does not: it is a later sibling, drawn above the toggle,
    // so its own click survives while the rest of the item flips the mode.
    expect(within(toggle).queryByText('1 小时 42 分钟后重置')).toBeNull();
    expect(item.querySelector('.quota-shape-button')).not.toBeNull();
    expect(item.querySelector('.quota-shape-button + .quota-shape-slot')).not.toBeNull();
  });

  it('names both toggles without native tooltips', () => {
    // The panel is a menubar popover, and a `title` shows the system tooltip over
    // the very reading it describes. The names stay for screen readers.
    renderItems('bar');
    const item = screen.getByTestId('quota-item-five-hour');
    const shape = within(item).getByRole('button', { name: '切换为圆环' });
    const reset = within(item).getByRole('button', { name: /切换为具体时间/ });

    expect(shape).not.toHaveAttribute('title');
    expect(reset).not.toHaveAttribute('title');
    expect(shape).toHaveAccessibleName('切换为圆环');
  });

  it('layers the toggle over the shape and the reset line over the toggle', () => {
    // jsdom computes no layout, so the layering is read off the sheet: the toggle
    // covers the shape's block from behind, and the reset line is on top of it but
    // only takes clicks where it has an action of its own.
    // jsdom's `import.meta.url` is the document's, not a file path, so the sheet is
    // read from the working directory the tests run in.
    const css = readFileSync('src/desktop/panel.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // Every rule that names the selector: a shared rule and its own rule both apply.
    const block = (selector: string) =>
      [...css.matchAll(new RegExp(`\\${selector} \\{([^}]*)\\}`, 'g'))].map((match) => match[1]).join(' ');

    const toggle = block('.quota-shape-button');
    expect(toggle, '.quota-shape-button must be positioned').toMatch(/position:\s*absolute/);
    expect(toggle).toMatch(/z-index:\s*0/);
    // The hot area is the shape's block and nothing else: the ring's box in ring
    // form (interior included), the label line plus the bar in bar form. The reset
    // reading's own row is below it, so a click down there is not a mode switch —
    // which is why the block is the slot's height rather than the whole item.
    expect(toggle, 'the toggle spans the shape, not the item').toMatch(/height:\s*var\(--quota-slot-height\)/);
    expect(toggle).toMatch(/top:\s*0/);
    expect(toggle, 'the toggle must not cover the reset row').not.toMatch(/inset:\s*0/);
    expect(block('.quota-shape'), 'the stroke and the target share one box').toMatch(
      /height:\s*var\(--quota-slot-height\)/
    );
    // The drawing is decoration, never a target: `overflow: visible` plus the drop
    // leaves its box 20px below the button's in bar form, and a hit-testable box
    // there would quietly pull the hot area down over the reset reading.
    expect(block('.quota-shape'), 'the drawing must not extend the hot area').toMatch(
      /pointer-events:\s*none/
    );

    const line = block('.quota-reset');
    expect(line).toMatch(/z-index:\s*2/);
    expect(line, 'a reading with no action must not swallow the click').toMatch(/pointer-events:\s*none/);
    expect(block('.quota-reset-toggle'), 'the clickable reset line takes its own click').toMatch(
      /pointer-events:\s*auto/
    );
  });

  it('holds the shape where it is on the commit that flips the mode', () => {
    // `--quota-drop` at rest belongs to the sheet, and the sheet reads it from
    // `data-mode` — the form being moved *to*. Without the frame written in the
    // same commit, the item would paint once in the new layout with the old shape
    // still in it: the bar's row where the ring's box is, reset line and all.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    frozenFrames();
    const view = renderItems('ring');

    act(() => view.rerender(<QuotaDisplay mode="bar" valueMode="used" items={[ITEM]} now={NOW} timezone="Asia/Shanghai" resetTimeFormat="countdown" testId="quota" />));

    const item = screen.getByTestId('quota-item-five-hour');
    expect(item).toHaveAttribute('data-mode', 'bar');
    expect(item.style.getPropertyValue('--quota-drop')).toBe('0.0000');
    expect(item.querySelector('path')!.getAttribute('d')).toContain('A ');
  });

  it('tells the panel it is animating, and stops when it is done', () => {
    // The window is the host's to size, and the panel's height hook waits for the
    // layout to settle before asking for a new one. Without this announcement the
    // panel would collapse ~80ms after the morph had already finished.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const frames = frozenFrames();
    const view = renderItems('ring');
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.append(screen.getByTestId('quota-item-five-hour').closest('.quota-item')!);

    act(() => view.rerender(<QuotaDisplay mode="bar" valueMode="used" items={[ITEM]} now={NOW} timezone="Asia/Shanghai" resetTimeFormat="countdown" testId="quota" />));
    expect(panel).toHaveAttribute(PANEL_ANIMATING_ATTRIBUTE);
    expect(panel.getAttribute(PANEL_ANIMATING_ATTRIBUTE)).toBe('');

    act(() => frames.step(QUOTA_MORPH_MS));
    act(() => frames.step(32));
    // Still announced for the frame the last measurement lands on.
    expect(panel).toHaveAttribute(PANEL_ANIMATING_ATTRIBUTE);
  });

  it('carries both descriptions only while the morph runs', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const frames = frozenFrames();
    const view = renderItems('ring');
    expect(screen.getByTestId('quota-item-five-hour').querySelector('.quota-item-head')).toBeNull();

    act(() => view.rerender(<QuotaDisplay mode="bar" valueMode="used" items={[ITEM]} now={NOW} timezone="Asia/Shanghai" resetTimeFormat="countdown" testId="quota" />));
    const item = screen.getByTestId('quota-item-five-hour');
    // Mid-morph the ring's text is on its way out and the bar's line on its way in …
    expect(item.querySelector('.quota-item-ringtext')).not.toBeNull();
    expect(item.querySelector('.quota-item-head')).not.toBeNull();
    act(() => frames.step(16));
    // … while the item is still in the ring form: nothing has dropped yet, and the
    // stroke is still a ring.
    expect(Number.parseFloat(item.style.getPropertyValue('--quota-drop'))).toBe(0);
    expect(item.querySelector('path')!.getAttribute('d')).toContain('A ');

    act(() => frames.step(QUOTA_MORPH_MS));
    act(() => frames.step(32));
    expect(item.getAttribute('style') ?? '').not.toContain('--quota-drop');
    expect(item.querySelector('.quota-item-ringtext')).toBeNull();
    expect(item.querySelector('.quota-item-head')).not.toBeNull();
    expect(item.querySelector('path')!.getAttribute('d')).not.toContain('A ');
  });

  it('reverses the same beats when the bar becomes the ring again', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const frames = frozenFrames();
    const view = renderItems('bar');
    expect(screen.getByTestId('quota-item-five-hour').querySelector('.quota-item-head')).not.toBeNull();

    act(() => view.rerender(<QuotaDisplay mode="ring" valueMode="used" items={[ITEM]} now={NOW} timezone="Asia/Shanghai" resetTimeFormat="countdown" testId="quota" />));
    const item = screen.getByTestId('quota-item-five-hour');
    // It starts from the bar it is standing in, not from a fresh ring.
    expect(item.querySelector('path')!.getAttribute('d')).not.toContain('A ');

    act(() => frames.step(QUOTA_MORPH_MS));
    act(() => frames.step(32));
    expect(screen.getByTestId('quota-item-five-hour').querySelector('path')!.getAttribute('d')).toContain('A ');
    expect(screen.getByTestId('quota-item-five-hour').querySelector('.quota-item-head')).toBeNull();
    expect(screen.getByTestId('quota-item-five-hour').querySelector('.quota-item-ringtext')).not.toBeNull();
  });
});

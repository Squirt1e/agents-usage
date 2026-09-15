import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { QuotaDisplayMode, QuotaValueMode, ResetTimeFormat } from '../shared/desktop-contract';
import { formatResetLabel, type QuotaWindowKind } from './metrics';
import { PANEL_ANIMATING_ATTRIBUTE } from './panel-height';
import { QUOTA_MORPH_MS, quotaShape, ringTextOpacity, type QuotaShape } from './quota-morph';
import { ReplayNumber } from './ReplayNumber';

export interface QuotaDisplayItem {
  id: string;
  label: string;
  /** The window's own units: five-hour vs weekly countdowns and clocks differ. */
  kind: QuotaWindowKind;
  percent: number | null;
  resetAt?: string;
  stale?: boolean;
}

export interface QuotaDisplayProps {
  mode: QuotaDisplayMode;
  valueMode: QuotaValueMode;
  items: QuotaDisplayItem[];
  now: Date;
  timezone?: string;
  /** One format for the whole group: clicking any reset line flips every one. */
  resetTimeFormat: ResetTimeFormat;
  onToggleResetTimeFormat?(): void;
  /** Clicking the ring or the bar itself flips the display mode. */
  onToggleDisplayMode?(): void;
  overlay?: ReactNode;
  /**
   * Whether `overlay` is a cover over placeholder data. The items are then blurred
   * by `.is-covered` rather than by the cover's own `backdrop-filter`: a backdrop is
   * sampled late for a cover that mounts inside an animating card — which is what a
   * page swap does — and the fake values show through until it lands.
   */
  covered?: boolean;
  testId?: string;
  replayKey?: number;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function ResetLine(props: { item: QuotaDisplayItem; now: Date; timezone?: string; format: ResetTimeFormat; onToggle?(): void }) {
  const resetLabel = props.item.resetAt
    ? formatResetLabel(props.item.resetAt, props.now, {
        format: props.format,
        kind: props.item.kind,
        timezone: props.timezone
      })
    : undefined;

  if (!resetLabel) return <div className="quota-reset">重置时间未知</div>;
  if (resetLabel === '等待刷新') {
    return <div className="quota-reset quota-reset-waiting">等待刷新</div>;
  }
  return (
    <button
      type="button"
      className="quota-reset quota-reset-toggle"
      // Name only, no `title`: the panel is a menubar popover, and a native
      // tooltip under the cursor covers the reading it is describing.
      aria-label={`${resetLabel}，切换为${props.format === 'countdown' ? '具体时间' : '倒计时'}`}
      onClick={props.onToggle}
      disabled={props.onToggle === undefined}
    >
      {resetLabel}
    </button>
  );
}

/**
 * One quota item, in both of its display forms.
 *
 * The ring and the bar are the *same* stroke along the same path (see
 * `quota-morph.ts`), so the mode switch is a change of geometry rather than a
 * swap of two pictures. The component owns the clock only: `quotaShape` decides
 * what the frame looks like, CSS decides where the pieces sit (it derives the
 * bar's row from `--quota-drop`), and this walks the progress between the two
 * resting values.
 *
 * Both texts overlap while the morph runs and only the current mode's text stays
 * mounted afterwards — the outgoing one has faded out by then, and a resting item
 * must carry one description of itself, not two.
 */
function QuotaItem(props: QuotaDisplayProps & { item: QuotaDisplayItem }) {
  const { item, mode } = props;
  const percent = item.percent === null ? null : clampPercent(item.percent);
  const replay = !!props.replayKey && !props.covered && percent !== null;
  const valueLabel = props.valueMode === 'remaining' ? '剩余' : '已用';
  const label = percent === null ? `${item.label} ${valueLabel}未返回` : `${item.label} ${valueLabel} ${formatPercent(percent)}%`;
  const itemRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<SVGPathElement>(null);
  const fillRef = useRef<SVGPathElement>(null);
  const ringTextRef = useRef<SVGGElement>(null);
  /** 0 = ring form, 1 = bar form; every frame between the two. */
  const progressRef = useRef(mode === 'bar' ? 1 : 0);
  const [morphing, setMorphing] = useState(false);

  /**
   * The frame this item is showing at `progress`.
   *
   * The item's own box is the shape's ruler, and the shape never reports a size
   * back into it: writing the measured width onto the SVG let every frame widen
   * the grid track it was measured in, so a single toggle grew the whole panel.
   */
  const frameAt = (progress: number): QuotaShape | null => {
    const node = itemRef.current;
    return node ? quotaShape(progress, node.clientWidth) : null;
  };

  /** Draw a frame's shape: the two paths and the ring text's fade. */
  const paint = (frame: QuotaShape) => {
    for (const path of [trackRef.current, fillRef.current]) {
      path?.setAttribute('d', frame.d);
      path?.setAttribute('stroke-width', frame.strokeWidth.toFixed(2));
    }
    ringTextRef.current?.setAttribute('opacity', frame.ringTextOpacity.toFixed(3));
  };

  /** Draw a frame of the shape only: a re-render's job, since it moves nothing. */
  const draw = (progress: number) => {
    const frame = frameAt(progress);
    if (frame) paint(frame);
  };

  /**
   * Draw a frame *and* move the item to it.
   *
   * The drop is written here rather than left to the sheet alone because the
   * sheet reads it from `data-mode`, which is the form being moved *to*: on the
   * commit that flips the mode, the sheet would already put the bar's row where
   * only the end of the morph may put it. Whoever writes last before the paint
   * has to be the frame the shape is actually on.
   */
  const apply = (progress: number) => {
    const node = itemRef.current;
    const frame = frameAt(progress);
    if (!node || !frame) return;
    node.style.setProperty('--quota-drop', frame.drop.toFixed(4));
    node.style.setProperty('--quota-head', frame.headOpacity.toFixed(4));
    paint(frame);
  };

  /**
   * Settled in this mode: the sheet's own value for it is the right one, so the
   * item must not keep an inline copy that would shadow it.
   */
  const releaseDrop = () => {
    const style = itemRef.current?.style;
    style?.removeProperty('--quota-drop');
    style?.removeProperty('--quota-head');
  };

  /**
   * Tell the panel that this item is animating its own layout, for as long as the
   * morph takes.
   *
   * The window's size is the host's to set, and the panel's height hook normally
   * waits for the layout to settle before asking for a new one — with the morph
   * collapsing the item over ~270ms, that would mean the window shrinking after
   * the animation had already finished. Announcing the morph lets the hook follow
   * the measured height frame by frame instead, so the panel's edge and the card's
   * collapse together.
   */
  const announceAnimation = () => {
    const panel = itemRef.current?.closest('.panel');
    if (!panel) return () => undefined;
    panel.setAttribute(PANEL_ANIMATING_ATTRIBUTE, '');
    // A frame of slack after the loop stops: the last measurement lands a frame or
    // two later, and the settle path has to be back in charge by then.
    const timer = window.setTimeout(() => {
      panel.removeAttribute(PANEL_ANIMATING_ATTRIBUTE);
    }, QUOTA_MORPH_MS + 100);
    return () => {
      window.clearTimeout(timer);
      panel.removeAttribute(PANEL_ANIMATING_ATTRIBUTE);
    };
  };

  /**
   * How far the reset line has to move to sit centred under the ring.
   *
   * The line hugs its text, so this is half of what the item has left over — and
   * it is measured rather than computed from CSS because a percentage in a
   * transform would be the line's own width, not the room around it. Layer by
   * layer: the countdown's wording changes its width, and the item's does not, so
   * the shift is re-measured on every render. Reading it back here (before the
   * paint) is also what keeps the line from sliding a frame late when the wording
   * changes.
   */
  const centreResetLine = () => {
    const node = itemRef.current;
    const line = node?.querySelector<HTMLElement>('.quota-reset');
    if (!node || !line) return;
    const centre = Math.max(0, (node.clientWidth - line.offsetWidth) / 2);
    node.style.setProperty('--quota-reset-centre', `${centre.toFixed(1)}px`);
  };

  // Every render lands here before the browser can paint, which is what keeps a
  // mode flip from flashing: the flip changes `data-mode` in this same commit, and
  // this puts the shape's real frame — and the drop that goes with it — back in
  // place first. It also redraws at whatever frame the morph has reached, so a
  // change in the item's width or in its reading is drawn immediately.
  useLayoutEffect(() => {
    centreResetLine();
    const target = mode === 'bar' ? 1 : 0;
    const progress = progressRef.current;
    if (progress === target) {
      releaseDrop();
      draw(progress);
      return;
    }
    // No motion asked for: the shape arrives at its new form on this frame. The
    // preference is checked in script because this travel is not a transition —
    // `d` has no interpolable CSS property, so the per-frame loop below is the
    // only way to draw it (AGENTS.md §1.4, same as the window height). Deciding it
    // here rather than in the effect below also keeps the landing frame out of a
    // painted frame: the two would otherwise be a frame apart.
    if (prefersReducedMotion()) {
      progressRef.current = target;
      releaseDrop();
      draw(target);
      return;
    }
    apply(progress);
  });

  useEffect(() => {
    const target = mode === 'bar' ? 1 : 0;
    const from = progressRef.current;
    if (from === target || prefersReducedMotion()) {
      setMorphing(false);
      return;
    }
    setMorphing(true);
    const settled = announceAnimation();
    const start = window.performance.now();
    let frame = 0;
    const step = (now: number) => {
      // Linear in time: the shape's own three beats carry the easing, so each of
      // them leaves and lands at rest.
      const elapsed = Math.min(1, (now - start) / QUOTA_MORPH_MS);
      progressRef.current = from + (target - from) * elapsed;
      apply(progressRef.current);
      if (elapsed < 1) {
        frame = window.requestAnimationFrame(step);
        return;
      }
      progressRef.current = target;
      apply(target);
      // Releasing the inline value hands the resting state back to the sheet,
      // which computes exactly this number for the mode we are now in.
      releaseDrop();
      setMorphing(false);
    };
    frame = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(frame);
      settled();
    };
  }, [mode]);

  const ringText = mode === 'ring' || morphing;

  return (
    <div
      className={`quota-item${replay ? ' is-replaying' : ''}`}
      data-mode={mode}
      role="group"
      aria-label={label}
      data-testid={`quota-item-${item.id}`}
      ref={itemRef}
    >
      {/* The toggle is the whole item — the ring's box, the room around it and the
          bar's own row — and it sits behind the content, so nothing has to be made
          click-through to reach it. The reset line is the one thing on top: where
          it has a click of its own it takes it, and where it has none the click
          falls through to this. */}
      <button
        type="button"
        className="quota-shape-button"
        // Named for screen readers, but no `title`: the shape is its own hint, and
        // a native tooltip would sit right on top of the ring it describes.
        aria-label={mode === 'ring' ? '切换为进度条' : '切换为圆环'}
        disabled={props.onToggleDisplayMode === undefined}
        onClick={props.onToggleDisplayMode}
      >
        <svg className="quota-shape" aria-hidden="true">
            <path ref={trackRef} className="quota-shape-track" fill="none" strokeLinecap="round" />
            <path
              ref={fillRef}
              className="quota-shape-fill"
              fill="none"
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${percent === null ? 0 : percent} 100`}
            />
            {ringText ? (
              <g
                ref={ringTextRef}
                className="quota-item-ringtext"
                opacity={ringTextOpacity(progressRef.current)}
              >
                {/* Baselines, not centres: the percent's ink sits just above the
                    ring's centre and the window label just below it, which is what
                    centres the pair inside the stroke (the design's own ring does
                    the same). */}
                <text className="quota-value" x="50%" y="40" textAnchor="middle">
                  {percent === null ? '—' : formatPercent(percent)}
                  {percent === null ? null : <tspan className="pct">%</tspan>}
                </text>
                <text className="quota-label" x="50%" y="55" textAnchor="middle">
                  {item.label}
                </text>
              </g>
          ) : null}
        </svg>
        {ringText && replay ? (
          <span className="quota-ring-replay" aria-hidden="true">
            <ReplayNumber text={`${formatPercent(percent)}%`} replay />
          </span>
        ) : null}
      </button>
      {/* The item's own box in the layout: the shape is drawn by the absolutely
          positioned button above, so this empty block is what gives the item its
          height in each form. */}
      <div className="quota-shape-slot" aria-hidden="true" />
      {/* The bar's own label line: the row the shape drops into. It is also a
          repetition of what the group already announces, so it stays out of the
          accessibility tree in both forms. */}
      {mode === 'bar' || morphing ? (
        <div className="quota-item-head" aria-hidden="true">
          <span className="quota-label">{item.label}</span>
          <span className="quota-value">
            {percent === null ? '—' : <ReplayNumber text={`${formatPercent(percent)}%`} replay={replay} />}
          </span>
        </div>
      ) : null}
      <ResetLine
        item={item}
        now={props.now}
        timezone={props.timezone}
        format={props.resetTimeFormat}
        onToggle={props.onToggleResetTimeFormat}
      />
    </div>
  );
}

export function QuotaDisplay(props: QuotaDisplayProps) {
  return (
    <div
      className={`quota-display ${props.mode === 'ring' ? 'gauge-row' : 'quota-list'}${props.covered ? ' is-covered' : ''}`}
      data-testid={props.testId}
      data-display-mode={props.mode}
      data-value-mode={props.valueMode}
    >
      {props.items.map((item) => (
        <QuotaItem key={`${item.id}:${props.replayKey ?? 0}`} {...props} item={item} />
      ))}
      {props.overlay}
    </div>
  );
}

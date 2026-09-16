/**
 * The ring <-> progress-bar morph.
 *
 * Both display forms are the *same* stroke drawn along one path, so switching
 * between them is a change of geometry rather than a cross-fade between two
 * pictures. Path data cannot be interpolated by CSS — WebKit has no `d` property
 * — so the timing lives here and `QuotaDisplay` walks it a frame at a time, the
 * same shape of exception the window height already has (see
 * `tests/panel-motion.test.ts`).
 *
 * The motion is the three beats the design asks for, in order:
 *
 * 1. **Break and unwind** (`travel`). The ring is cut at 12 o'clock. Its start
 *    point — the one the fill grows from — leaves the top and slides left along
 *    the ring's own tangent line, and the line behind it follows the track like
 *    a rope being unwound: the coil gives up exactly as much length as the head
 *    took, so the far end slides backwards around the circle. The fill, measured
 *    from the head, slides with it.
 * 2. **Straighten** (`relax`). What is still coiled relaxes into the bar. Its
 *    turn angle falls to zero while the chord from the tangent point to the far
 *    end stretches to the bar's remaining length; the radius follows from those
 *    two, which keeps the junction at the tangent point smooth (the coil always
 *    leaves it level) and lands the far end on the bar's right edge.
 * 3. **Drop** (`drop`). By then the stroke is already a bar. It moves down into
 *    the row the label line takes above it, while that line fades in with it and
 *    the ring's own text is long gone (`ringTextOpacity`).
 *
 * Reversing the mode walks the same three beats backwards, which is what
 * "progress bar to ring is exactly the reverse" means: nothing here is
 * direction-specific.
 *
 * The resting ring is the confirmed design's: stroke-centre radius 34 in an 82px
 * box, the fill starting at 12 o'clock and running clockwise — which is what
 * makes "the start point to the right of 0" true, and what puts the 42% mark
 * near 5 o'clock as the design's own render does.
 */

/** Height of the shape box in ring form: the ring (68 + stroke) and its clearance. */
export const RING_BOX = 82;
/** Height of the shape box in bar form: the 4px bar and the round caps' overhang. */
export const BAR_BOX = 8;
/** Distance from the bar's box to each end of the stroke, before the round cap. */
export const BAR_INSET = 4;
/** The ring's stroke-centre radius. */
export const RING_RADIUS = 34;
/** The ring's centre, measured from the top of its box. */
export const RING_CENTER_Y = 41;
/** Ring stroke: the design's ring is thin next to the 82px box it sits in. */
export const RING_STROKE = 5;
/** Bar stroke, which is also the bar's height. */
export const BAR_STROKE = 4;

/** The ring's stroke centre at 12 o'clock — where the break opens. */
const RING_TOP_Y = RING_CENTER_Y - RING_RADIUS;
/** The bar's stroke centre, measured from the top of its own box. */
const BAR_Y = BAR_BOX / 2;
/**
 * The hairline break at 12 o'clock. A closed ring needs it for two reasons: the
 * fill has to start somewhere, and an SVG arc whose ends coincide is dropped
 * entirely, which would leave the resting ring invisible.
 */
const BREAK = 1;

/**
 * How long the whole morph takes: unwinding, straightening, then dropping.
 *
 * This is the one switch that deliberately runs past the panel's 160–260ms travel
 * budget. It is not one movement but three, each of which has to be seen, and the
 * design asks for all of them; what keeps the length from reading as a slow slide
 * is the speed profile below, not a shorter duration. The exception is registered
 * in `tests/panel-motion.test.ts`.
 */
export const QUOTA_MORPH_MS = 720;

/**
 * The morph's one speed profile: a slow departure, a quick middle, a slow landing.
 *
 * It is applied to the journey as a whole, not to each beat. Easing every beat in
 * and out — which is what this did first — brings the motion to a halt twice on
 * the way, and three movements that each stop before the next one starts read as
 * three movements rather than as one thing changing.
 *
 * A raised cosine rather than a cubic: its velocity is continuous at both ends, so
 * the shape leaves and lands without the acceleration step a cubic bezier has
 * where it starts and stops.
 */
function warp(progress: number): number {
  return (1 - Math.cos(Math.PI * clamp01(progress))) / 2;
}

/**
 * Where each beat ends, as a share of the *warped* progress.
 *
 * The beats split the warped progress into near thirds on purpose. Every beat's
 * own value runs linearly across its share of that progress, so a beat taking a
 * different share would be entered and left at a different speed than its
 * neighbour runs at — which is what a hitch at the seam is. As near-thirds they
 * stay within about 15% of each other, which is inside what the change of motion
 * at the seam hides.
 *
 * Read through the profile above, these shares fall at ≈0.39 and ≈0.62 of the
 * clock: the head takes about 280ms to reach the bar's end, the coil about 170ms
 * to relax, and the drop about 270ms to settle.
 */
const HEAD_SHARE = 0.33;
const STRAIGHTEN_SHARE = 0.69;

/**
 * The morph progress (0..1 of `QUOTA_MORPH_MS`) at which a beat ends.
 *
 * Exported for the tests and for anything that needs to know the rhythm rather
 * than the geometry — the profile is the inverse of a raised cosine, so the
 * boundaries cannot be read off the shares alone.
 */
export function beatEnd(beat: 1 | 2): number {
  const share = beat === 1 ? HEAD_SHARE : STRAIGHTEN_SHARE;
  return Math.acos(1 - 2 * share) / Math.PI;
}

/**
 * How much of its average speed the head still has when it lands.
 *
 * The head arrives at the bar's left end and stays there, so its last stretch has
 * to be a landing rather than a halt: at full speed it would hit the target and
 * stop dead on the next frame, which is a jerk the eye catches on the one part of
 * the shape it has been following. Under half, the last few frames are a settle.
 */
const HEAD_ARRIVAL = 0.45;
/**
 * The far end's speed is what has to survive the handover at the end of beat 1:
 * until then it is sliding along the ring, and after it is straightening. The
 * straightening therefore starts at whatever rate makes its speed match the one
 * it had a frame earlier. That rate follows from the ring's radius and the item's
 * width, so it is derived per frame rather than tuned; the `1` is the rate the
 * straightening should still have when it lands.
 */
const STRAIGHTEN_EXIT = 1;
/** Step used to measure the far end's speed where the straightening starts. */
const SEAM_STEP = 1e-4;

/**
 * The ring's own text, out over the first stretch of the clock. A steady rate,
 * not the travel profile: a fade that copies the shape's easing disappears slowly
 * and then all at once, which is what made the words read as blinking out.
 */
const RING_TEXT_MS = 320;
/**
 * The bar's label line, in over the last stretch — starting a little before the
 * drop so the words arrive as the bar lands.
 */
const HEAD_TEXT_MS = 340;
const HEAD_TEXT_START_MS = QUOTA_MORPH_MS - HEAD_TEXT_MS;
/**
 * Below this turn angle the coil is drawn as a line. Its bulge is under a
 * fiftieth of a pixel by then, and a straight `L` avoids asking the renderer for
 * an arc of near-infinite radius.
 */
const FLAT_TURN = 2e-3;

export interface QuotaShape {
  /** Path data for the track and the fill alike, in the shape box's units. */
  d: string;
  strokeWidth: number;
  /** How far the shape has moved down into the bar's row, 0..1. */
  drop: number;
  /** The bar's label line, 0..1. */
  headOpacity: number;
  /** The ring's own text, 1..0. */
  ringTextOpacity: number;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

/**
 * How visible the ring's own text is at `progress`, 1..0.
 *
 * Exported because the text lives in the SVG and mounts on its own schedule: a
 * frame that draws a freshly mounted group needs the value the morph has already
 * reached, not a default of "fully visible" that would blink the words into a
 * ring that has been empty for half the animation.
 */
export function ringTextOpacity(progress: number): number {
  return fadeOutAt(progress, RING_TEXT_MS);
}

/**
 * How visible the bar's label line is at `progress`, 0..1.
 *
 * Exported for the same reason as the ring's own text: the row is mounted on its
 * own schedule around the mode flip, and it must come in on the frame the morph
 * has reached rather than at a default.
 */
export function headTextOpacity(progress: number): number {
  return clamp01((clamp01(progress) * QUOTA_MORPH_MS - HEAD_TEXT_START_MS) / HEAD_TEXT_MS);
}

/** A steady fade over `ms` of the clock, from the start of the morph. */
function fadeOutAt(progress: number, ms: number): number {
  return 1 - clamp01((clamp01(progress) * QUOTA_MORPH_MS) / ms);
}

/**
 * The head's travel across its beat: a quadratic that coasts into the landing.
 *
 * `f(0) = 0`, `f(1) = 1`, and the slope falls from `1 + HEAD_ARRIVAL` to
 * `1 - HEAD_ARRIVAL`, so the arrival is the slowest part of the beat that moves
 * the most.
 */
function headTravel(u: number): number {
  const t = clamp01(u);
  return t + HEAD_ARRIVAL * t * (1 - t);
}

/**
 * A curve from 0 to 1 whose slopes at its two ends are `m0` and `m1`.
 *
 * Used for the straightening, where the starting slope is dictated by the speed
 * the far end already has and the ending slope is a choice: a quadratic would tie
 * the two together, and a cubic lets the straightening come in gently without
 * leaving at a speed nothing follows.
 */
function hermite(m0: number, m1: number): (v: number) => number {
  const a = -2 + m0 + m1;
  const b = 3 - 2 * m0 - m1;
  return (v) => {
    const t = clamp01(v);
    return a * t * t * t + b * t * t + m0 * t;
  };
}

/**
 * The shape at `progress` (0 = ring, 1 = bar) for an item `width` wide.
 *
 * `width` is the layout box the shape sits in, never the shape's own size: the
 * shape is measured *by* its container, so writing a width back into it would
 * let every frame make the item a little wider than the last.
 */
export function quotaShape(progress: number, width: number): QuotaShape {
  // Wider rings only waste the box: below this the label inside would not fit, so
  // a not-yet-measured item falls back to exactly that.
  const box = Math.max(width, RING_RADIUS * 2 + RING_STROKE * 2);
  const centerX = box / 2;
  const left = BAR_INSET;
  /** What is left of the bar once the free segment has taken its share. */
  const barRemainder = box - BAR_INSET * 2 - (centerX - left);
  const fullTurn = (Math.PI * 2 * RING_RADIUS - BREAK) / RING_RADIUS;

  /**
   * Where the far end sits, for a coil that has straightened to `straight`.
   *
   * A clockwise turn of `turn` puts the chord at half that angle, which is what
   * keeps the coil leaving the tangent point level — and so the junction with the
   * free segment smooth — the whole way through.
   */
  const coil = (straight: number, headTurn: number) => {
    const turn = headTurn * (1 - straight);
    const chord = lerp(2 * RING_RADIUS * Math.sin(turn / 2), barRemainder, straight);
    return {
      turn,
      chord,
      x: centerX + chord * Math.cos(turn / 2),
      y: lerp(RING_TOP_Y, BAR_Y, straight) + chord * Math.sin(turn / 2)
    };
  };

  // The speed the far end already has when the straightening takes over: the head
  // covers (centre - left) per unit of travel, and its landing slope is what the
  // travel curve ends on.
  const landedTurn = Math.max(fullTurn - (centerX - left) / RING_RADIUS, 0);
  const atSeam = coil(0, landedTurn);
  const justAfter = coil(SEAM_STEP, landedTurn);
  const perStraight = Math.hypot(justAfter.x - atSeam.x, justAfter.y - atSeam.y) / SEAM_STEP;
  const seamSpeed = ((centerX - left) * (1 - HEAD_ARRIVAL)) / HEAD_SHARE;
  const straightenStart = Math.min(
    (seamSpeed * (STRAIGHTEN_SHARE - HEAD_SHARE)) / Math.max(perStraight, 1e-6),
    2 - STRAIGHTEN_EXIT
  );

  // One speed profile for the whole journey; each beat is a slice of it, shaped
  // only where its own ends need a landing or a handover.
  const s = warp(progress);
  const travel = headTravel(s / HEAD_SHARE);
  const straight = hermite(straightenStart, STRAIGHTEN_EXIT)(
    (s - HEAD_SHARE) / (STRAIGHTEN_SHARE - HEAD_SHARE)
  );
  const settle = clamp01((s - STRAIGHTEN_SHARE) / (1 - STRAIGHTEN_SHARE));

  // Beat 1. The head slides left along the ring's tangent line and the coil gives
  // up exactly that much of its turn: the far end slides backwards around the
  // circle, which is the line "following the start point along the ring's track".
  const travelled = (centerX - left) * travel;
  const headTurn = Math.max(fullTurn - travelled / RING_RADIUS, 0);
  // Beat 2 lifts the whole stroke from the ring's top to the bar's line — the 3px
  // between them — together with the straighten, so the free segment stays level.
  const { turn, chord, x: tailX, y: tailY } = coil(straight, headTurn);
  /** The line the stroke is drawn along: the ring's top, or the bar's own line. */
  const lineY = lerp(RING_TOP_Y, BAR_Y, straight);

  const headX = centerX - travelled;
  const flat = turn < FLAT_TURN;
  const radius = chord / (2 * Math.sin(turn / 2));
  const d = flat
    ? `M ${headX.toFixed(2)} ${lineY.toFixed(2)} L ${centerX.toFixed(2)} ${lineY.toFixed(2)} ` +
      `L ${tailX.toFixed(2)} ${tailY.toFixed(2)}`
    : `M ${headX.toFixed(2)} ${lineY.toFixed(2)} L ${centerX.toFixed(2)} ${lineY.toFixed(2)} ` +
      `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${turn > Math.PI ? 1 : 0} 1 ${tailX.toFixed(2)} ${tailY.toFixed(2)}`;

  return {
    d,
    strokeWidth: lerp(RING_STROKE, BAR_STROKE, straight),
    drop: settle,
    headOpacity: headTextOpacity(progress),
    ringTextOpacity: ringTextOpacity(progress)
  };
}

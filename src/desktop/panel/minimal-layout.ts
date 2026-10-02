/**
 * The rail's window geometry, in logical points.
 *
 * Minimal mode has no content measurement for the rail: `usePanelHeight` is retired
 * because the rail's size is decided here, not reported by a card stack. So this
 * arithmetic *is* the layout, and every term below mirrors one rule in `panel.css`.
 * `tests/panel/minimal-rail.test.ts` reads both sides, because a term that falls
 * behind the stylesheet shows up only as a rail that scrolls or clips.
 *
 * The native rail stays 58 points wide. The independent detail window measures its
 * card and asks the host for its own height; this module still supplies the rail
 * height and the shared card geometry.
 */

/** The rail column itself, matching its width in `panel.css` and the host's floor. */
export const MINIMAL_RAIL_WIDTH = 58;

/**
 * The rail's own frame radius.
 *
 * The rail wears the panel's surface, so it wears the panel's frame radius too: the
 * same 14 points `.panel` draws. It was 22 — a percentage of a 58-point column rather
 * than a radius, which made the rail's ends read as a capsule and its corners rounder
 * than the card it opens. `MINIMAL_ITEM_RADIUS` follows from it.
 */
export const MINIMAL_RAIL_RADIUS = 14;

/**
 * The focused platform plate's radius.
 *
 * The plate is inset three points inside the frame, so a corner that nests is the
 * frame's radius less that inset: 14 - 3 = 11, which is also the radius the cards use.
 */
export const MINIMAL_ITEM_RADIUS = 11;

/** `.minimal-detail`'s border, on all four sides. */
export const MINIMAL_DETAIL_BORDER = 1;

/** One platform slot's width, which the rail's own side bands are derived from. */
export const MINIMAL_ITEM_WIDTH = 52;

/** `.minimal-rail`'s border, on all four sides. */
export const MINIMAL_RAIL_BORDER = 1;

/**
 * The band above the first platform.
 *
 * The same four points as [`MINIMAL_RAIL_PADDING_BOTTOM`]: the frame is deliberately
 * symmetric, so the column reads as inset by one number rather than by two. It used to
 * be derived from the slot's own side band (`(58 - borders - item) / 2` = 2), which
 * made the head half the foot and read lopsided.
 */
export const MINIMAL_RAIL_PADDING_TOP = 4;

/**
 * The band below the last row.
 *
 * Equal to the top band by the symmetry rule above; the action column unrolls above it.
 */
export const MINIMAL_RAIL_PADDING_BOTTOM = 4;

/** Compact one-line grip above the platforms; it shares the action column's focus state. */
export const MINIMAL_DRAG_HEIGHT = 16;

/**
 * The box the reused card gets, which is the box it has in the overview.
 *
 * The overview's card is 350 less `.panel-body`'s 10-point padding on each side, so
 * a card in the rail's detail is laid out at exactly the size it was designed for —
 * same wrapping, same row widths, same labels on one line. Anything narrower would
 * make the "same card" wrap differently and stop being the same card.
 */
export const MINIMAL_CARD_WIDTH = 330;

/**
 * The detail's own padding around the card, which is none.
 *
 * The detail *is* the card (see `.minimal-detail .provider-card` in `panel.css`): its
 * border is the card's frame and the card's own 10-point padding is the only inset
 * between the content and that frame. A second padding here was what pushed the card's
 * peak rail ten points inside the card's left edge — in the overview the rail sits *on*
 * the edge — and made the detail's readings twenty points narrower than the overview's.
 */
export const MINIMAL_DETAIL_PADDING = 0;

/** The detail box: the card plus its padding and the detail's own border. */
export const MINIMAL_DETAIL_WIDTH =
  MINIMAL_CARD_WIDTH + MINIMAL_DETAIL_PADDING * 2 + MINIMAL_DETAIL_BORDER * 2;

/** The gap between the detail card and the rail it belongs to. */
export const MINIMAL_DETAIL_GAP = 7;

/** Clearance kept above and below the detail card inside the window. */
export const MINIMAL_DETAIL_MARGIN = 6;
/**
 * The action column, revealed with the host's header state.
 *
 * Two 24-point buttons, the 2-point gap between them, and the room their focus ring
 * needs on every side: the column unrolls from nothing to this, which is what makes the
 * rail taller rather than letting the buttons be painted on top of the rings.
 */
export const MINIMAL_TOOLS_HEIGHT = 62;

/**
 * The connection badge's row, including the gap above it.
 *
 * A separate row rather than a fourth action: a failing connection has to be visible
 * without pointing at the rail first, and it belongs to the panel, not to any one
 * platform's card. The 24-point plate plus the same 4-point gap the platforms use.
 */
export const MINIMAL_ALERT_HEIGHT = 28;

/**
 * The window once a detail sits beside the rail.
 *
 * Not the detail's own width: the host is asked for a *window* size and clamps it to
 * the room left of the rail's anchor, which is how a narrow display clips the detail
 * instead of pushing the rail off its margin.
 */
export const MINIMAL_RAIL_DETAIL_WIDTH =
  MINIMAL_RAIL_WIDTH + MINIMAL_DETAIL_GAP + MINIMAL_DETAIL_WIDTH;

/** One rule in `panel.css` each; the guard checks the pairing both ways. */
export const RAIL_GEOMETRY = {
  /** `.minimal-drag` — a narrow focused row above the platform readings. */
  dragHeight: MINIMAL_DRAG_HEIGHT,
  /** `.minimal-item` — one platform: a 40-point ring, one value line under it. */
  itemHeight: 64,
  /** `.minimal-stack` — the gap between one platform's slot and the next. Without it
      one item's reading sits directly on the next item's ring; at six the column broke
      into separate plates instead of stacking. */
  itemGap: 4,
  /** `.minimal-empty` — the no-platform placeholder takes one item's worth. */
  emptyHeight: 64,
  /** `.minimal-rail`'s padding above the first slot (`padding`'s first value). */
  railPaddingTop: MINIMAL_RAIL_PADDING_TOP,
  /** `.minimal-rail`'s padding below the last row, which the actions unroll into. */
  railPaddingBottom: MINIMAL_RAIL_PADDING_BOTTOM,
  /** `.minimal-rail`'s border, on all four sides. */
  railBorder: MINIMAL_RAIL_BORDER
} as const;

/**
 * The rail's own height: its items, the gaps, padding and border, plus focused controls.
 *
 * The grip and actions occupy the bottom only while the host reports the same
 * visible-header state used by the full panel,
 * and the rail collapses them the moment the pointer leaves (the host does not wait
 * out the full panel's header delay in this mode — see `schedule_header_hide`). The
 * connection badge sits between the two, and is there whenever a connection is
 * failing — pointed at or not.
 */
export function minimalRailHeight(platformCount: number, focused = false, alert = false): number {
  const { itemHeight, itemGap, emptyHeight, railPaddingTop, railPaddingBottom, railBorder } =
    RAIL_GEOMETRY;
  const items = platformCount > 0 ? platformCount * itemHeight : emptyHeight;
  // One gap *between* items, so a single platform (and the placeholder) has none.
  const gaps = platformCount > 1 ? (platformCount - 1) * itemGap : 0;
  const tools = focused ? MINIMAL_DRAG_HEIGHT + MINIMAL_TOOLS_HEIGHT : 0;
  const warning = alert ? MINIMAL_ALERT_HEIGHT : 0;
  return items + gaps + railPaddingTop + railPaddingBottom + railBorder * 2 + tools + warning;
}

/**
 * The window height for a rail, optionally beside an open detail.
 *
 * `detailHeight` is the detail's natural height, or `null` while it is closed. The
 * window keeps the detail clear of its own edges so the card's border and caret are
 * never shaved by the window frame.
 */
export function minimalPanelHeight(
  platformCount: number,
  detailHeight: number | null,
  focused = false,
  alert = false
): number {
  const rail = minimalRailHeight(platformCount, focused, alert);
  if (detailHeight === null) return rail;
  return Math.max(rail, detailHeight + MINIMAL_DETAIL_MARGIN * 2);
}

/**
 * Where the detail card sits, and where its caret points.
 *
 * The card is centred on the platform item it belongs to, then slid back inside the
 * window while keeping its caret on that item — so the caret is what tells the reader
 * which platform a clamped card is describing.
 */
export function minimalDetailPlacement(
  itemIndex: number,
  detailHeight: number,
  panelHeight: number,
  focused = false
): { top: number; caret: number } {
  const { itemHeight, itemGap, railPaddingTop, railBorder } = RAIL_GEOMETRY;
  const centre = railBorder + railPaddingTop + (focused ? MINIMAL_DRAG_HEIGHT : 0) + (itemHeight / 2) + itemIndex * (itemHeight + itemGap);
  const tallest = panelHeight - MINIMAL_DETAIL_MARGIN * 2;
  const height = Math.min(detailHeight, tallest > 0 ? tallest : detailHeight);
  const travel = Math.max(0, panelHeight - height - MINIMAL_DETAIL_MARGIN * 2);
  const top = Math.min(Math.max(centre - height / 2, MINIMAL_DETAIL_MARGIN), MINIMAL_DETAIL_MARGIN + travel);
  // The caret follows the item, not the card: a clamped card still points at the
  // platform it is about.
  const caret = Math.min(Math.max(centre - top, 14), Math.max(14, height - 14));
  return { top, caret };
}

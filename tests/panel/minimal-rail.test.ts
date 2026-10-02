// The minimal rail's two structural promises, as rules rather than conventions.
//
// A 58-point column leaves no room to absorb a mistake, and the mistakes that are
// invisible in review are these. First, the icon in the ring's centre has to be the
// platform's own mark: a letter badge is what the full cards used, and reusing it in
// the rail would quietly drop the requirement that a platform be identifiable at a
// glance. Second, that mark has to be transparent. A brand SVG exported with a white
// square behind it looks right while you are staring at it and like a sticker once it
// sits on the panel's tile.
//
// Both are properties of files rather than of behaviour, so the component test
// (`minimal-panel.test.tsx`) cannot see them: it renders the mark through whatever the
// stylesheet says. This guard reads the assets and the stylesheet directly, the way
// `panel-type-scale.test.ts` keeps the type scale honest.
//
// The second half pins the window arithmetic to the same stylesheet. The host is
// *told* a window size in minimal mode rather than measuring one, so a rule that
// drifts from `minimal-layout.ts` cannot be caught by any rendering test — the rail
// simply scrolls, or the card is clipped, and only on some platform counts.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MINIMAL_DETAIL_BORDER,
  MINIMAL_DETAIL_GAP,
  MINIMAL_DETAIL_MARGIN,
  MINIMAL_DETAIL_PADDING,
  MINIMAL_DETAIL_WIDTH,
  MINIMAL_DRAG_HEIGHT,
  MINIMAL_ALERT_HEIGHT,
  MINIMAL_ITEM_RADIUS,
  MINIMAL_ITEM_WIDTH,
  MINIMAL_RAIL_BORDER,
  MINIMAL_RAIL_PADDING_BOTTOM,
  MINIMAL_RAIL_PADDING_TOP,
  MINIMAL_RAIL_RADIUS,
  MINIMAL_TOOLS_HEIGHT,
  MINIMAL_RAIL_DETAIL_WIDTH,
  MINIMAL_RAIL_WIDTH,
  RAIL_GEOMETRY,
  minimalDetailPlacement,
  minimalPanelHeight,
  minimalRailHeight
} from '../../src/desktop/panel/minimal-layout';

const BRANDS = ['codex', 'glm', 'deepseek'] as const;
const BRAND_DIR = 'src/desktop/assets/brands';
const SHEET = 'src/desktop/panel.css';
const PANEL_SOURCE = 'src/desktop/panel/MinimalPanel.tsx';
/** Where the provider → asset map and the mask form live, shared by four surfaces. */
const BRAND_SOURCE = 'src/desktop/components/BrandMark.tsx';
const README = 'docs/desktop/README.md';

const read = (file: string) => readFileSync(file, 'utf8');
/** Comments describe intent and often name the very things being ruled out. */
const sheet = read(SHEET).replace(/\/\*[\s\S]*?\*\//g, '');
const panelSource = read(PANEL_SOURCE);
const brandSource = read(BRAND_SOURCE);

/**
 * One declaration from the rule block a selector opens, found by brace counting.
 *
 * The selector has to start its own line. `.minimal-panel` also appears inside
 * `html:has(.minimal-panel)` earlier in the file, and an unanchored search would
 * read *that* block's `width: 100%` and report the rule as missing.
 */
function declaration(css: string, selector: string, property: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`^${escaped}\\s*\\{`, 'm').exec(css);
  if (rule === null) return undefined;
  const open = css.indexOf('{', rule.index);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const match = new RegExp(`(?:^|;|\\s)${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+)`).exec(body);
  return match?.[1]?.trim();
}

/** The first number in a shorthand, which is the vertical value for `padding`. */
function leadingPx(value: string | undefined): number {
  return Number.parseFloat(value ?? '');
}

/** One numeric declaration, parsed, with the missing-rule case reported. */
function pxOf(css: string, selector: string, property: string): number {
  const value = declaration(css, selector, property);
  expect(value, `${selector} declares no ${property}`).toBeDefined();
  return Number.parseFloat(value ?? '');
}

describe('brand marks are the platform’s own, on a transparent ground', () => {
  it.each(BRANDS)('%s ships a transparent mark with no background plate', (brand) => {
    const path = `${BRAND_DIR}/${brand}.svg`;
    expect(existsSync(path), `${path} is missing from the bundle`).toBe(true);
    const svg = read(path);

    // A background plate is either a drawn rectangle or a white fill. Both are
    // invisible against a light design mock and obvious on the panel's tile.
    const plates = [...svg.matchAll(/<(rect|circle|path)\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((element) => !/fill="none"/.test(element))
      .filter((element) => /fill="(#fff(?:fff)?|white|url\(#[^)]*bg[^)]*\))"/i.test(element));
    expect(plates, `${brand}.svg draws a background plate behind the mark`).toEqual([]);

    // Every mark is a single 24-unit viewBox, so the rail can size them all alike.
    expect(svg).toContain('viewBox="0 0 24 24"');
  });

  it('colours the Codex mark from the theme instead of shipping a fixed white logo', () => {
    // The OpenAI mark has no brand colour of its own, so a hard-coded one would be
    // unreadable in one of the two themes. It travels as a mask filled with the
    // text colour, which is the only form that follows `prefers-color-scheme`.
    const codex = read(`${BRAND_DIR}/codex.svg`);
    expect(codex).toContain('fill="currentColor"');

    const mask = declaration(sheet, '.minimal-brand-codex', 'background');
    expect(mask, '.minimal-brand-codex has no background to fill its mask').toBe('var(--text)');
    expect(declaration(sheet, '.minimal-brand-codex', '-webkit-mask-image')).toBeUndefined();
    // The mask URL is supplied per provider, so the shared map is where the wiring
    // lives and the rail is where Codex is the one provider that takes the masked form.
    expect(brandSource).toContain('maskImage');
    expect(panelSource).toContain('brandMaskStyle');
    expect(panelSource).toContain("brandMaskStyle('codex')");
  });

  it('draws no letter badge where a platform mark belongs', () => {
    for (const badge of ['CX', 'GL', 'DS']) {
      expect(panelSource, `${badge} is a letter badge, not a brand mark`).not.toContain(`>${badge}<`);
    }
    // Each of the three providers resolves to a real asset import.
    for (const brand of BRANDS) {
      expect(brandSource).toContain(`../assets/brands/${brand}.svg`);
    }
  });

  it('records the pinned upstream version and its licence next to the assets', () => {
    const licence = `${BRAND_DIR}/LICENSE.lobehub.txt`;
    expect(existsSync(licence), 'the marks must ship their licence').toBe(true);
    expect(read(licence)).toContain('MIT License');

    // A pinned version is the difference between "we vendored these" and "we copied
    // something off a CDN and cannot say what". The README is where it is recorded.
    const readme = read(README);
    expect(readme).toMatch(/@lobehub\/icons-static-svg@\d+\.\d+\.\d+/);
    expect(readme).toContain('LICENSE.lobehub.txt');
    // Nothing may fetch a mark at runtime.
    expect(panelSource).not.toMatch(/https?:\/\//);
  });
});

describe('the rail is one narrow column with reachable targets', () => {
  it('keeps the rail 58 points wide and holds it at the right edge', () => {
    expect(declaration(sheet, '.minimal-rail', 'width')).toBe(`${MINIMAL_RAIL_WIDTH}px`);
    expect(declaration(sheet, '.minimal-rail', 'flex')).toBe(`0 0 ${MINIMAL_RAIL_WIDTH}px`);
    // The card takes space to the left of the rail; the rail itself must not shrink
    // when it appears, or the visible column would drift.
    expect(declaration(sheet, '.minimal-panel', 'justify-content')).toBe('flex-end');
    // Only as tall as its rings, or the pill stretches into an empty outline when the
    // window grows to hold a card.
    expect(declaration(sheet, '.minimal-rail', 'align-self')).toBe('flex-start');
    // The panel's own box is the window, and it cannot be a percentage: React mounts
    // into a `div` with no height of its own (`main.tsx`), so `100%` resolved to
    // `auto` — the rail's height — and the `overflow: hidden` below then clipped the
    // detail card at the rail's bottom edge. The window's lower strip showed the
    // desktop behind it, which is what made the card look cut off.
    expect(declaration(sheet, '.minimal-panel', 'height')).toBe('100vh');
    expect(declaration(sheet, '.minimal-panel', 'max-height')).toBeUndefined();
  });

  it('gives every rail control at least a 44-point target', () => {
    const size = (selector: string) => {
      const height = declaration(sheet, selector, 'height');
      const minHeight = declaration(sheet, selector, 'min-height');
      return {
        width: Number.parseFloat(declaration(sheet, selector, 'width') ?? '0'),
        height: Number.parseFloat(minHeight ?? height ?? '0')
      };
    };
    // Platform items fit the rail while retaining a 44-point target.
    expect(size('.minimal-item')).toEqual({ width: 52, height: 64 });
    expect(size('.minimal-empty')).toEqual({ width: 56, height: 64 });
    const item = size('.minimal-item');
    expect(item.width).toBeGreaterThanOrEqual(44);
    expect(item.height).toBeGreaterThanOrEqual(44);
  });

  it('wears the full panel’s surface and its frame radius', () => {
    // The rail is the same material as the panel, not a second palette: it used to
    // carry its own `--minimal-rail-bg`, and the two backgrounds never matched. The
    // comparison is against the panel's own declarations so the pair cannot drift.
    expect(declaration(sheet, '.minimal-rail', 'background')).toBe(
      declaration(sheet, '.panel', 'background')
    );
    expect(declaration(sheet, '.minimal-rail', 'border')).toBe(
      declaration(sheet, '.panel', 'border')
    );
    expect(sheet).not.toContain('--minimal-rail-bg');
    // The frame radius is the panel's own number, not a second one. At 22 points on a
    // 58-point column the rail's ends read as a capsule — rounder, and rounder *than
    // the card it opens*, which is what a reader sees when the detail is out.
    expect(pxOf(sheet, '.minimal-rail', 'border-radius')).toBe(pxOf(sheet, '.panel', 'border-radius'));
    expect(pxOf(sheet, '.minimal-rail', 'border-radius')).toBe(MINIMAL_RAIL_RADIUS);
    // And the plate's radius nests inside it: the frame's radius less the inset it
    // sits at on each side, so the two corner curves stay concentric.
    expect(pxOf(sheet, '.minimal-item', 'border-radius')).toBe(MINIMAL_ITEM_RADIUS);
    expect(MINIMAL_RAIL_RADIUS - MINIMAL_ITEM_RADIUS).toBe(
      (MINIMAL_RAIL_WIDTH - pxOf(sheet, '.minimal-item', 'width')) / 2
    );
  });

  it('reveals a compact drag grip above the platform readings', () => {
    expect(pxOf(sheet, '.minimal-drag', 'height')).toBe(0);
    expect(pxOf(sheet, '.minimal-panel.is-focused .minimal-drag', 'height')).toBe(MINIMAL_DRAG_HEIGHT);
    expect(declaration(sheet, '.minimal-drag', 'cursor')).toBe('move');
    expect(panelSource).toContain('minimal-drag');
    expect(panelSource).toContain('minimal-tools');
    expect(panelSource).toContain('data-tauri-drag-region');
  });

  it('gives the rail the same band at the head and the foot', () => {
    // The slot stays centred, so the room beside it is arithmetic — two points here.
    // The head band used to be *that* number while the foot kept eight for the action
    // column, and the frame read lopsided. Both ends are four now, and that is the
    // rule the stylesheet has to keep.
    expect(pxOf(sheet, '.minimal-item', 'width')).toBe(MINIMAL_ITEM_WIDTH);
    expect((MINIMAL_RAIL_WIDTH - MINIMAL_RAIL_BORDER * 2 - MINIMAL_ITEM_WIDTH) / 2).toBe(2);
    expect(MINIMAL_RAIL_PADDING_TOP).toBe(4);
    expect(MINIMAL_RAIL_PADDING_BOTTOM).toBe(4);
    expect(RAIL_GEOMETRY.railPaddingTop).toBe(MINIMAL_RAIL_PADDING_TOP);
    expect(RAIL_GEOMETRY.railPaddingBottom).toBe(MINIMAL_RAIL_PADDING_BOTTOM);
    expect(leadingPx(declaration(sheet, '.minimal-rail', 'padding'))).toBe(MINIMAL_RAIL_PADDING_TOP);
  });

  it('keeps the connection badge a filled plate, with no outline', () => {
    // Both halves are the decision: the tint stays, the border goes. `border: 0` has to
    // be spelled out rather than left to the default, because the badge is a `<button>`
    // — deleting the declaration lets the UA's grey `outset` edge back in.
    expect(declaration(sheet, '.minimal-alert', 'background')).toBe('var(--warning-bg)');
    expect(declaration(sheet, '.minimal-alert', 'border')).toBe('0');
    // And a border that does not exist is motion that cannot happen.
    expect(declaration(sheet, '.minimal-alert', 'transition') ?? '').not.toContain('border-color');
  });
});

describe('the card is a fixed size that the window only uncovers', () => {
  const px = (selector: string, property: string): number => {
    const value = declaration(sheet, selector, property);
    expect(value, `${selector} declares no ${property}`).toBeDefined();
    return Number.parseFloat(value!);
  };

  it('holds its width so the reveal cannot re-wrap it', () => {
    expect(px('.minimal-detail', 'width')).toBe(MINIMAL_DETAIL_WIDTH);
    expect(declaration(sheet, '.minimal-detail', 'position')).toBe('absolute');
    // The card's box starts at the detail's border: the detail carries the frame, the
    // card carries its own ten points of inset. A padding here was a second inset, and it
    // pushed the card's peak rail ten points inside the card's left edge.
    expect(MINIMAL_DETAIL_PADDING).toBe(0);
    expect(declaration(sheet, '.minimal-detail-scroll', 'padding')).toBeUndefined();
    expect(px('.minimal-detail .provider-card', 'padding')).toBe(10);
    // The gap between the card and the rail, which the caret straddles.
    expect(px('.minimal-detail', 'right')).toBe(MINIMAL_RAIL_WIDTH + MINIMAL_DETAIL_GAP);
    expect(MINIMAL_RAIL_DETAIL_WIDTH).toBe(MINIMAL_RAIL_WIDTH + MINIMAL_DETAIL_GAP + MINIMAL_DETAIL_WIDTH);
    // The window itself is clipped, which is what turns the frame growth into a slide.
    expect(declaration(sheet, '.minimal-panel', 'overflow')).toBe('hidden');
  });

  it('fades and slides in, and keeps a caret on the ring it belongs to', () => {
    const transition = declaration(sheet, '.minimal-detail', 'transition') ?? '';
    for (const property of ['opacity', 'transform', 'top']) {
      expect(transition, `the card does not transition ${property}`).toContain(property);
    }
    expect(px('.minimal-detail', 'opacity')).toBe(0);
    expect(declaration(sheet, '.minimal-detail.is-visible', 'opacity')).toBe('1');
    // The caret tracks the item even when the card had to be slid back inside.
    expect(declaration(sheet, '.minimal-detail::after', 'top')).toBe('var(--caret, 50%)');
    expect(panelSource).toContain("'--caret'");
    // Promoted before the transform moves and kept promoted while the frame stands: the
    // window is transparent, so a layer WebKit creates when this transition starts and
    // drops when it settles re-composites the whole surface — the blink the reader sees
    // as the card arrives and as it leaves. Same wiring as `.manage-row`.
    const promotion = declaration(sheet, '.minimal-detail', 'will-change') ?? '';
    expect(promotion).toContain('transform');
    expect(promotion).toContain('opacity');
  });

  it('keeps the frame and contents mounted so their layers do not change with every hover', () => {
    // Inserting and removing the window's largest box is what reshapes this page's
    // layer tree, and on a transparent window that re-composites the surface — the
    // blink, once when the card renders and once when it is destroyed. The frame is
    // therefore rendered unconditionally, with each platform page kept in the DOM;
    // the empty frame is transparent, inert to the pointer and hidden from assistive tech.
    expect(panelSource).toContain('aria-hidden={!hasCard}');
    expect(panelSource).toContain('inert={!hasCard}');
    expect(panelSource).toContain('props.summaries.map((summary) => (');
    expect(panelSource).toContain('inert={provider !== summary.provider}');
    expect(panelSource).toContain("'.minimal-detail-scroll.is-current'");
    expect(declaration(sheet, '.minimal-detail-scroll', 'will-change')).toBe('opacity');
    expect(declaration(sheet, '.minimal-detail', 'pointer-events')).toBe('none');
    expect(declaration(sheet, '.minimal-detail.is-visible', 'pointer-events')).toBe('auto');
    // The rail is the only surface the reader sees while no card is shown, so it holds
    // a layer of its own: a re-composite then reuses its pixels instead of repainting
    // the column (the plate that blinked).
    expect(declaration(sheet, '.minimal-rail', 'will-change')).toBe('transform');
  });

  it('never scrolls: the window grows to the card instead', () => {
    // The card must be readable in full, so no box between it and the window is a
    // scroll container. A `max-height` on the inner box was the window's size lagging
    // behind the card, and the scrollbar it caused was the window catching up in the
    // worst possible way. `overflow` is deliberately absent rather than `hidden`:
    // `overflow-x: hidden` on its own computes `overflow-y` back to `auto` and brings
    // the scrollbar straight back.
    expect(declaration(sheet, '.minimal-detail-scroll', 'overflow')).toBeUndefined();
    expect(declaration(sheet, '.minimal-detail-scroll', 'overflow-y')).toBeUndefined();
    expect(declaration(sheet, '.minimal-detail-scroll', 'overflow-x')).toBeUndefined();
    expect(declaration(sheet, '.minimal-detail-scroll', 'max-height')).toBeUndefined();
    expect(declaration(sheet, '.minimal-detail', 'overflow-y')).toBeUndefined();
    // The box is still what the card is measured through.
    expect(panelSource).toContain("'.minimal-detail-scroll.is-current'");
    expect(px('.minimal-detail', 'border')).toBe(MINIMAL_DETAIL_BORDER);
  });

  it('asks the host for a window that holds the whole card', () => {
    // No inner clamp means the requested height has to cover the card plus the
    // clearance the window keeps above and below it — the card is never cut off by
    // the panel's own arithmetic, only by a display that genuinely lacks the room.
    expect(minimalPanelHeight(1, 900)).toBe(900 + MINIMAL_DETAIL_MARGIN * 2);
    expect(minimalPanelHeight(3, 900) - 900).toBe(MINIMAL_DETAIL_MARGIN * 2);
  });

  it('re-measures through a resize observer, not only at mount', () => {
    // The card is made of components that can settle a frame later (a section
    // appearing, a label wrapping once its font arrives). A single mount-time reading
    // would freeze the window at the first number and clip whatever arrived after it,
    // which is exactly where the action row sits.
    expect(panelSource).toContain('ResizeObserver');
    expect(panelSource).toContain('minimal-detail-content');
    // The observed box is the content, whose height is natural: watching the scroller
    // would make every window resize fire the observer and chase itself.
    expect(panelSource).toContain("'.minimal-detail-scroll.is-current .minimal-detail-content'");
  });

  it('places the card from the card, platforms and top grip, not the lower controls', () => {
    // The top grip moves the platforms, so the caret follows it. Lower controls and
    // a connection badge must not move the card relative to its platform.
    expect(panelSource).toMatch(/minimalPanelHeight\(\s*props\.summaries\.length,\s*height\s*\)/);
    const placement = /minimalDetailPlacement\(([\s\S]*?)\);/.exec(panelSource);
    expect(placement, 'the card is not placed through minimalDetailPlacement').not.toBeNull();
    expect(placement![1]).toContain('props.focused');
    expect(placement![1]).not.toContain('props.issues');
  });
});

describe('the rail’s window height is the stylesheet’s arithmetic', () => {
  const px = (selector: string, property: string): number => {
    const value = declaration(sheet, selector, property);
    expect(value, `${selector} declares no ${property}`).toBeDefined();
    return Number.parseFloat(value!);
  };

  it('agrees with every rule the height is built from', () => {
    expect(px('.minimal-drag', 'height')).toBe(0);
    expect(px('.minimal-panel.is-focused .minimal-drag', 'height')).toBe(RAIL_GEOMETRY.dragHeight);
    expect(px('.minimal-item', 'min-height')).toBe(RAIL_GEOMETRY.itemHeight);
    // The placeholder replaces an item, so it has to be exactly one item tall.
    expect(px('.minimal-empty', 'min-height')).toBe(RAIL_GEOMETRY.emptyHeight);
    // One gap between neighbouring slots, which is what keeps one item's reading off
    // the next item's ring.
    expect(px('.minimal-stack', 'gap')).toBe(RAIL_GEOMETRY.itemGap);
    // The padding shorthand's first value is the band above the first slot; the third
    // is the foot the actions unroll into.
    const padding = (declaration(sheet, '.minimal-rail', 'padding') ?? '')
      .split(/\s+/)
      .map((value) => Number.parseFloat(value));
    expect(padding[0]).toBe(RAIL_GEOMETRY.railPaddingTop);
    expect(padding[2]).toBe(RAIL_GEOMETRY.railPaddingBottom);
    expect(px('.minimal-rail', 'border')).toBe(RAIL_GEOMETRY.railBorder);
    // The action column unrolls to two rows the height of one button, the gap
    // between them, and the four points of focus-ring room on every side.
    const rows = 2 * px('.minimal-tool', 'height') + px('.minimal-tools', 'gap');
    const toolsPadding = (declaration(sheet, '.minimal-panel.is-focused .minimal-tools', 'padding') ?? '')
      .split(/\s+/)
      .map((value) => Number.parseFloat(value));
    expect(px('.minimal-panel.is-focused .minimal-tools', 'height')).toBe(
      rows + toolsPadding[0]! + toolsPadding[2]!
    );
    expect(px('.minimal-panel.is-focused .minimal-tools', 'height')).toBe(MINIMAL_TOOLS_HEIGHT);
    // The connection badge's row is the badge plus the platforms' own gap.
    expect(px('.minimal-alert', 'height') + px('.minimal-alert', 'margin-top')).toBe(MINIMAL_ALERT_HEIGHT);
    expect(px('.minimal-alert', 'margin-top')).toBe(RAIL_GEOMETRY.itemGap);
  });

  it('adds up to the height the host is asked for', () => {
    // Two platforms: their slots and gap, padding and border. The grip opens only on focus.
    expect(minimalRailHeight(2)).toBe(
      2 * RAIL_GEOMETRY.itemHeight +
        RAIL_GEOMETRY.itemGap +
        RAIL_GEOMETRY.railPaddingTop +
        RAIL_GEOMETRY.railPaddingBottom +
        RAIL_GEOMETRY.railBorder * 2
    );
    // With every platform hidden the placeholder occupies one item's worth — and a
    // lone slot has no gap to add.
    expect(minimalRailHeight(0)).toBe(minimalRailHeight(1));
    expect(minimalRailHeight(3, true) - minimalRailHeight(3)).toBe(MINIMAL_TOOLS_HEIGHT + MINIMAL_DRAG_HEIGHT);
    // The badge is on screen whether or not the pointer is.
    expect(minimalRailHeight(3, false, true) - minimalRailHeight(3)).toBe(MINIMAL_ALERT_HEIGHT);
    expect(minimalRailHeight(3, true, true)).toBe(
      minimalRailHeight(3) + MINIMAL_TOOLS_HEIGHT + MINIMAL_DRAG_HEIGHT + MINIMAL_ALERT_HEIGHT
    );
    // A card taller than the rail sets the window; a short one does not shrink it.
    expect(minimalPanelHeight(3, 400)).toBe(400 + MINIMAL_DETAIL_MARGIN * 2);
    expect(minimalPanelHeight(3, 10)).toBe(minimalRailHeight(3));
    expect(minimalPanelHeight(3, null)).toBe(minimalRailHeight(3));
    expect(minimalPanelHeight(3, 10, false, true)).toBe(minimalRailHeight(3, false, true));
  });
});

describe('the rail’s window animation starts from the window it is animating', () => {
  const main = read('src/desktop/panel/main.tsx');

  it('reads the live viewport instead of remembering a size', () => {
    // The remembered pair was seeded with the *full* panel's 350x560 and corrected only
    // by a `visibility` event — which a panel the host shows before this document loads
    // never receives (every dev session, and any start where the window is already up).
    // The session's first animation then asked the host for a size the window had never
    // had, on the anchoring frame, so the window flew open to it and animated back.
    expect(main).not.toContain('layoutWidth');
    expect(main).not.toContain('layoutHeight');
    expect(main).toMatch(/const fromHeight = window\.innerHeight/);
  });

  it('steps the width once and animates only the height', () => {
    // The rail's right edge is pinned, so a width that travelled read as the whole
    // panel sliding sideways: the reader saw the rail leave and the card arrive
    // instead of one shape being uncovered. The width is reported once, at the
    // target, and only the height is reported again by the animation.
    expect(main).not.toMatch(/const fromWidth = window\.innerWidth/);
    expect(main).not.toMatch(/width:\s*fromWidth/);
    // The anchoring call — the one that may move the window — is the first frame.
    expect(main).toMatch(/host\.setMinimalLayout\(width, fromHeight, anchor\)/);
    expect(main).toMatch(/host\.setMinimalLayout\(width, fromHeight \+ \(height - fromHeight\) \* eased, false\)/);
  });
});

describe('the card follows the ring it belongs to', () => {
  const rail = RAIL_GEOMETRY.railBorder + RAIL_GEOMETRY.railPaddingTop;
  // Each slot is its own height plus the gap that follows it.
  const pitch = RAIL_GEOMETRY.itemHeight + RAIL_GEOMETRY.itemGap;
  const centreOf = (index: number) => rail + RAIL_GEOMETRY.itemHeight / 2 + index * pitch;

  it('centres on the item when there is room', () => {
    const panel = minimalPanelHeight(3, 90);
    const { top, caret } = minimalDetailPlacement(1, 90, panel);
    expect(top + caret).toBe(centreOf(1));
    expect(top).toBeGreaterThanOrEqual(MINIMAL_DETAIL_MARGIN);
    expect(top + 90).toBeLessThanOrEqual(panel - MINIMAL_DETAIL_MARGIN);
    const focused = minimalDetailPlacement(1, 90, minimalPanelHeight(3, 90, true), true);
    expect(focused.top + focused.caret).toBe(centreOf(1) + MINIMAL_DRAG_HEIGHT);
  });

  it('slides back inside the window and keeps pointing at the item', () => {
    // A tall card on a short rail: both ends clamp, and the caret has to keep
    // answering "which platform is this about?" after the clamp.
    const panel = minimalPanelHeight(3, 230);
    for (const index of [0, 1, 2]) {
      const { top, caret } = minimalDetailPlacement(index, 230, panel);
      expect(top, `item ${index} starts above the window`).toBeGreaterThanOrEqual(MINIMAL_DETAIL_MARGIN);
      expect(top + 230).toBeLessThanOrEqual(panel - MINIMAL_DETAIL_MARGIN);
      expect(caret).toBe(centreOf(index) - top);
      // The caret stays on the card's own edge, where a caret can be drawn.
      expect(caret).toBeGreaterThanOrEqual(14);
      expect(caret).toBeLessThanOrEqual(230 - 14);
    }
  });

  it('keeps the caret on the card when even the item cannot be reached', () => {
    // Degenerate but real: a card as tall as the whole window. The caret clamps to
    // the card instead of pointing at a coordinate that is not on it.
    const panel = minimalPanelHeight(1, 200);
    const { top, caret } = minimalDetailPlacement(2, 200, panel);
    expect(top).toBe(MINIMAL_DETAIL_MARGIN);
    expect(caret).toBeGreaterThanOrEqual(14);
    expect(caret).toBeLessThanOrEqual(200 - 14);
  });
});

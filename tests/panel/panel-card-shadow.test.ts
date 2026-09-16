// A card's shadow has exactly the body's gutter to fade in.
//
// `.panel-body` is a scroll container, so it clips at its own padding box — and
// the outermost card sits one `padding` away from that edge on every side (first
// card's top, last card's bottom, both sides). A shadow that reaches past the
// gutter is not cropped softly, it is sliced off flat: the `0 7px 18px` hover
// shadow used to end in a hard horizontal seam across the panel just above the
// footer, where the eye expects the fade to keep going. The guard pins the budget
// itself — blur + spread (+ offset, downwards) ≤ gutter — and takes both numbers
// from the sheet, so the geometry cannot drift back out of the box it lives in.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../../src/desktop/panel.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** The selectors that paint a shadow around a card. */
const SHADOWED_SELECTORS = ['.provider-card:hover', ".provider-card[data-period='peak']"];

interface Layer {
  offsetY: number;
  blur: number;
  spread: number;
}

/** The declarations of one rule, as written. */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

/** The gutter a card's shadow may occupy: `.panel-body`'s own padding. */
function gutterPx(): number {
  const padding = ruleBody('.panel-body').match(/padding\s*:\s*([^;]+);/)?.[1] ?? '';
  const values = padding
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseFloat(value));
  expect(values.every((value) => Number.isFinite(value)), `unreadable padding: ${padding}`).toBe(true);
  // One value applies to all four sides, which is what makes a single gutter
  // number the right budget for the check below.
  expect(values, `the gutter is only a single number for a uniform padding: ${padding}`).toHaveLength(1);
  return values[0]!;
}

/** One `box-shadow` layer, in the order CSS writes its lengths. */
function layerOf(layer: string): Layer {
  // A zero offset is written bare (`0 0 7px`), so the lengths are the tokens that
  // are a number with an optional `px` — the colour and a `var()` are single
  // tokens this pattern skips.
  const lengths = layer
    .split(/\s+/)
    .filter((token) => /^-?\d+(?:\.\d+)?(?:px)?$/.test(token))
    .map((token) => Number.parseFloat(token));
  expect(lengths.length, `a shadow layer needs its two offsets: ${layer}`).toBeGreaterThanOrEqual(2);
  const [, offsetY = 0, blur = 0, spread = 0] = lengths;
  return { offsetY: offsetY!, blur: blur!, spread: spread! };
}

function layersOf(selector: string): Layer[] {
  const shadow = ruleBody(selector).match(/box-shadow\s*:\s*([^;]+);/)?.[1];
  expect(shadow, `${selector} paints no shadow for this guard to check`).toBeDefined();
  return shadow!.split(',').map(layerOf);
}

describe('card shadow fits the body gutter', () => {
  const gutter = gutterPx();

  it('leaves the last card its 10px of fade', () => {
    expect(gutter).toBeGreaterThan(0);
  });

  for (const selector of SHADOWED_SELECTORS) {
    it(`${selector} stays inside the gutter`, () => {
      const layers = layersOf(selector);
      expect(layers.length).toBeGreaterThan(0);
      for (const { offsetY, blur, spread } of layers) {
        expect(
          blur + spread,
          `"${selector}" blurs ${blur}px + ${spread}px sideways, past the ${gutter}px gutter — ` +
            'the shadow would be cut flat against the body edge'
        ).toBeLessThanOrEqual(gutter);
        expect(
          blur + spread + Math.max(offsetY, 0),
          `"${selector}" reaches ${blur + spread + offsetY}px below the card, past the ${gutter}px gutter — ` +
            'the fade would be sliced off above the footer'
        ).toBeLessThanOrEqual(gutter);
      }
    });
  }
});

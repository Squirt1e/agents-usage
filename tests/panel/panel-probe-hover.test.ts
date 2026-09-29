// The hover the host's pointer probe paints, and the stylesheet it has to agree with.
//
// A webview receives pointer events only while its window is key, so the panel's own
// `:hover` rules are dead for the reader the rail exists for: someone working in another
// application with the panel pinned on screen. The host forwards the pointer instead and
// each document paints `.is-hover` on the control under it (`panel/probe-hover.ts`).
//
// Two things can silently rot here, and neither shows up in a rendering test:
//
//   - a control the probe paints without an `.is-hover` twin, which stays dead exactly
//     where the feature is supposed to work;
//   - a `:hover` rule that changes while its twin does not, which makes the two feedback
//     paths look different depending on whether the reader had clicked the panel first.
//
// So this guard reads the selector lists out of the two documents and compares each
// twin's declarations against the `:hover` rule's, property by property.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHEET = readFileSync('src/desktop/panel.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const PANEL_APP = readFileSync('src/desktop/panel/PanelApp.tsx', 'utf8');
const DETAIL_WINDOW = readFileSync('src/desktop/panel/MinimalDetailWindow.tsx', 'utf8');

/**
 * The rule a selector opens, found inside the selector list it may share.
 *
 * The panel's hover rules are grouped (`sel:hover, sel.is-active`), so the selector is not
 * at the start of a line and a plain "this selector opens the rule" lookup would miss it.
 */
function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:,[^{]*)?\\{`, 'm').exec(css);
  if (rule === null) return undefined;
  const open = css.indexOf('{', rule.index);
  return css.slice(open + 1, css.indexOf('}', open));
}

/** Every property that rule names, in the order written. */
function declaredProperties(css: string, selector: string): string[] {
  const body = ruleBody(css, selector);
  if (body === undefined) return [];
  return [...body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((match) => match[1]!);
}

/** One declaration from that rule. */
function declaration(css: string, selector: string, property: string): string | undefined {
  const body = ruleBody(css, selector);
  if (body === undefined) return undefined;
  const match = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(body);
  return match?.[1]?.trim();
}

/** The selectors a document's target list names, in the order it lists them. */
function paintedSelectors(source: string): string[] {
  const array = /PROBE_HOVER_TARGETS = \[([\s\S]*?)\]/.exec(source);
  if (array) return [...array[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  const single = /PROBE_HOVER_TARGETS = '([^']+)'/.exec(source);
  expect(single, 'the document names no probe-hover targets').not.toBeNull();
  return single![1]!.split(',').map((entry) => entry.trim());
}

const PANEL_TARGETS = paintedSelectors(PANEL_APP);
const DETAIL_TARGETS = paintedSelectors(DETAIL_WINDOW);

/**
 * The `:hover` rule each painted control has, and the twin it must match.
 *
 * Written out rather than derived: the whole point is that a control's hover state and the
 * paint's are the same, and a control whose `:hover` rule is renamed out from under this
 * list shows up as a missing rule rather than as a silently skipped check.
 */
const PAIRS: Array<[string, string]> = [
  ['.minimal-tool:hover', '.minimal-tool.is-hover'],
  ['.minimal-alert:hover', '.minimal-alert.is-hover'],
  ['.minimal-empty button:hover', '.minimal-empty button.is-hover'],
  ['.icon-button:hover:not(:disabled)', '.icon-button.is-hover:not(:disabled)'],
  ['.connection-trigger.is-visible:hover', '.connection-trigger.is-visible.is-hover'],
  ['.gear-button:hover', '.gear-button.is-hover'],
  ['.quota-shape-button:hover:not(:disabled)', '.quota-shape-button.is-hover:not(:disabled)'],
  ['.quota-reset-toggle:hover:not(:disabled)', '.quota-reset-toggle.is-hover:not(:disabled)']
];

describe('the probe paints what the stylesheet says it paints', () => {
  it('covers both documents, and every control those documents reach for', () => {
    // The rail's own controls and the full panel's: one painter serves both panel shapes,
    // because a control that only exists in one of them is simply never hit in the other.
    for (const selector of ['.minimal-tool', '.minimal-alert', '.minimal-empty button', '.icon-button', '.connection-trigger']) {
      expect(PANEL_TARGETS, `${selector} is painted by nobody`).toContain(selector);
    }
    // The card is a window of its own, and it can never be key, so it paints its own.
    for (const selector of ['.gear-button', '.quota-shape-button', '.quota-reset-toggle']) {
      expect(DETAIL_TARGETS, `${selector} is painted by nobody`).toContain(selector);
    }
    // And both documents install the painter: a list without the listener does nothing.
    for (const [name, source] of [['PanelApp', PANEL_APP], ['MinimalDetailWindow', DETAIL_WINDOW]] as const) {
      expect(source, `${name} never creates the painter`).toContain('createProbeHover(PROBE_HOVER_TARGETS)');
      expect(source, `${name} never listens for the probe`).toContain("'panel:hover-probe'");
      // The paint has to be taken back when the host says the pointer has gone, or a
      // control stays lit on a window that is not receiving anything.
      expect(source, `${name} never clears the paint`).toContain('probeHover.current?.clear()');
    }
    // Every pair this guard checks is a control one of the documents paints: a pair left
    // behind by a renamed list would otherwise keep passing while nothing painted it.
    for (const [hover] of PAIRS) {
      const base = hover.replace(/:hover.*$/, '');
      const painted = [...PANEL_TARGETS, ...DETAIL_TARGETS];
      expect(
        painted.some((entry) => base === entry || base.startsWith(`${entry}.`) || base.startsWith(`${entry}:`)),
        `${hover} is guarded but no document paints ${base}`
      ).toBe(true);
    }
  });

  it.each(PAIRS)('%s has a twin that says exactly the same', (hover, painted) => {
    const properties = declaredProperties(SHEET, hover);
    expect(properties.length, `${hover} declares nothing`).toBeGreaterThan(0);
    for (const property of properties) {
      expect(
        declaration(SHEET, painted, property),
        `${hover} sets ${property}, but ${painted} does not`
      ).toBe(declaration(SHEET, hover, property));
    }
  });
});

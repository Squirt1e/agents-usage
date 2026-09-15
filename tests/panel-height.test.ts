// Task 6.2 / 6.3: the main page owns the window height — exactly its cards, or the
// minimum when it has none — and every other page inherits that height. The rule is
// plain arithmetic over measurements, so it is pinned here without a layout engine;
// `usePanelHeight` (covered in panel-height-hook.test.tsx) reads the DOM.
import { describe, expect, it } from 'vitest';
import {
  desiredPanelHeight,
  MAX_VISIBLE_CARDS,
  PANEL_MIN_HEIGHT
} from '../src/desktop/panel-height';

/** Window border + header + footer + body padding, in content pixels. */
const CHROME = 100;
/** The main page, as the hook passes it. */
const MAIN = { isMain: true, mainHeight: PANEL_MIN_HEIGHT };
/** Any settings or configuration page. */
const SUB = { isMain: false, mainHeight: 594 };

describe('panel height rule', () => {
  it('fits a single card exactly', () => {
    expect(desiredPanelHeight({ ...MAIN, chrome: CHROME, cardBottoms: [260] })).toBe(CHROME + 260);
  });

  it('fits three cards exactly, gaps between them included', () => {
    // Bottoms are measured, so the third card's bottom already covers the gaps.
    // Nothing else shares the body's flow: the panel's messages float above the
    // frame's bottom row (`.panel-toasts`), so a message cannot push a card down
    // and move this number.
    const cardBottoms = [200, 410, 620];
    expect(desiredPanelHeight({ ...MAIN, chrome: CHROME, cardBottoms })).toBe(CHROME + 620);
  });

  it('stops at the third card when a view has more', () => {
    const cardBottoms = [200, 410, 620, 830];
    expect(desiredPanelHeight({ ...MAIN, chrome: CHROME, cardBottoms })).toBe(
      CHROME + cardBottoms[MAX_VISIBLE_CARDS - 1]!
    );
  });

  it('holds the floor for a card shorter than the designed minimum', () => {
    expect(desiredPanelHeight({ ...MAIN, chrome: CHROME, cardBottoms: [10] })).toBe(PANEL_MIN_HEIGHT);
  });

  it('rounds to whole pixels so the host is not asked to resize for fractions', () => {
    expect(desiredPanelHeight({ ...MAIN, chrome: 99.4, cardBottoms: [260.7] })).toBe(
      Math.round(99.4 + 260.7)
    );
  });

  it('takes the minimum on the main page when there are no cards at all', () => {
    // Every platform hidden, or the first loading frame.
    expect(desiredPanelHeight({ ...MAIN, chrome: CHROME, cardBottoms: [] })).toBe(PANEL_MIN_HEIGHT);
  });

  it('makes a page without cards take the main page height, not its own', () => {
    // A settings form: tall content, no cards, and no opinion about the window.
    expect(desiredPanelHeight({ ...SUB, chrome: 40, cardBottoms: [] })).toBe(594);
  });

  it('makes a page without cards follow the main page even as that height changes', () => {
    expect(desiredPanelHeight({ isMain: false, mainHeight: 731, chrome: 40, cardBottoms: [] })).toBe(
      731
    );
  });
});

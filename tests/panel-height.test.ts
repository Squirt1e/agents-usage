// The panel's height rule: as tall as the overview's content needs, capped at the
// display. Plain arithmetic over measurements, so it is pinned here without a layout
// engine; `usePanelHeight` (covered in panel-height-hook.test.tsx) reads the DOM.
//
// What this file used to pin, and why it no longer does: the window was sized to the
// bottom edge of the last card it may show whole — at most three — and fell back to a
// fixed minimum when there were none, while every other page inherited whatever the
// main page had asked for. The settings surfaces are their own fixed-size window now,
// so the panel has one page and one question: how much room does the overview need?
// The archived change `fix-panel-height-follows-cards` owns the other half of this
// story (a lost notification must not strand the window at a stale height), and that
// invariant lives in `usePanelHeight` rather than in this arithmetic.
import { describe, expect, it } from 'vitest';
import { desiredPanelHeight } from '../src/desktop/panel-height';

/** Window border + header + footer, in logical pixels. */
const CHROME = 100;

describe('panel height rule', () => {
  it('fits the content exactly, gaps and all', () => {
    // The content element's own height already covers the gaps between cards and
    // the padding around them: it is one measurement, not a sum of card bottoms.
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 520 })).toBe(CHROME + 520);
  });

  it('does not stop at three cards any more', () => {
    // The old rule capped the window at three whole cards and made the fourth a
    // scroll. The cap is gone: a tall overview is a tall panel, up to the display.
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 1400 })).toBe(CHROME + 1400);
  });

  it('stops at the display when the caller knows it', () => {
    // The host clamps anyway (see `clamp_panel_height`), but the panel should not
    // report a number it knows the window can never take: the report is compared
    // against the previous one to decide whether to report at all, so a number that
    // can never be reached would be re-sent for ever.
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 2000, maxHeight: 900 })).toBe(900);
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 300, maxHeight: 900 })).toBe(400);
  });

  it('has no floor beyond the frame itself', () => {
    // The `320px` floor existed to keep an empty overview from collapsing the
    // window. An empty overview is now simply a short panel: the empty state and the
    // first loading frame are content, and the frame around them is the floor.
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 0 })).toBe(CHROME);
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 10 })).toBe(CHROME + 10);
  });

  it('never reports less than the frame, however small the display is', () => {
    // A display shorter than the panel's own chrome cannot be honoured either; the
    // host has the last word, and asking for less than the frame would take the
    // header off screen.
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 40, maxHeight: 60 })).toBe(CHROME);
  });

  it('rounds to whole pixels so the host is not asked to resize for fractions', () => {
    expect(desiredPanelHeight({ chrome: 99.4, contentHeight: 260.7 })).toBe(Math.round(99.4 + 260.7));
    expect(desiredPanelHeight({ chrome: 99.4, contentHeight: 260.7, maxHeight: 360.2 })).toBe(360);
  });

  it('ignores a display height that is not a usable number', () => {
    // A monitor lookup that came back empty or absurd must not zero the panel.
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 300, maxHeight: 0 })).toBe(400);
    expect(desiredPanelHeight({ chrome: CHROME, contentHeight: 300, maxHeight: Number.NaN })).toBe(400);
  });
});

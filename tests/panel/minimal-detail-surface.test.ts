// The minimal detail card sits in a transparent window, and the rail is the only
// surface in it.
//
// A card filled with the bare `--card` colour therefore had nothing opaque underneath:
// in the dark theme that colour is a 3.5% white, so the desktop read straight through
// the open card and its text became unreadable. The overview never shows this because
// its card lands on the panel's own gradient, so the two layers composite into an
// opaque card. The fix is to carry *both* layers on the detail itself, and these rules
// are what the stylesheet has to keep saying.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHEET = readFileSync('src/desktop/panel.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** One declaration from the rule block a selector opens, found by brace counting. */
function declaration(selector: string, property: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`^${escaped}\\s*\\{`, 'm').exec(SHEET);
  if (rule === null) return undefined;
  const open = SHEET.indexOf('{', rule.index);
  const close = SHEET.indexOf('}', open);
  const body = SHEET.slice(open + 1, close);
  const match = new RegExp(
    `(?:^|;|\\s)${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+)`
  ).exec(body);
  return match?.[1]?.trim();
}

describe('the open detail card is opaque', () => {
  it('composites the card colour over the panel surface', () => {
    const surface = declaration('.minimal-detail', '--detail-surface') ?? '';
    // The panel's gradient is the layer that makes the result opaque — the window
    // behind the card paints nothing.
    expect(surface).toContain(declaration('.panel', 'background')!);
    // And the card colour is what lifts the flattened card off the panel, exactly as
    // `--card` lifts the overview's card. Without it the detail would read as bare
    // panel rather than as the same card.
    expect(surface, 'the card colour is the layer over the panel surface').toContain('--card');
    // A single-layer fill is the bug: it is the translucent layer on its own.
    expect(declaration('.minimal-detail', 'background')).toBe('var(--detail-surface)');
  });

  it('gives the caret the same fill, because it pokes out of the card', () => {
    expect(declaration('.minimal-detail::after', 'background')).toBe('var(--detail-surface)');
  });

  it('does not offer scrolling while the native window grows between cards', () => {
    expect(declaration('.minimal-detail-window .minimal-detail-scroll', 'overflow-y')).toBe('hidden');
    expect(declaration('.minimal-detail-window.is-clipped .minimal-detail-scroll', 'overflow-y')).toBe('auto');
  });

  it('gives the connection view the card’s inset, since it is not a card', () => {
    // The detail frame pads nothing: a platform card brings its own ten points (which is
    // what puts its peak rail on the frame's edge), and the connection view — which has
    // no `.provider-card` — has to bring the same ten. Rows without it sat flush against
    // the frame, which is exactly what happened when the frame's own padding was removed.
    expect(declaration('.minimal-detail-connection', 'padding')).toBe(
      declaration('.provider-card', 'padding')
    );
  });

  it('puts the peak rail on the card’s own edge, and keeps the content clear of it', () => {
    // The detail *is* the card: its border is the card's frame and the card's own ten
    // points are the only inset. A second padding on the scroll box inset the whole card
    // and left the peak rail floating ten points inside the card's left edge, where the
    // overview draws it on the edge itself.
    expect(declaration('.minimal-detail-scroll', 'padding')).toBeUndefined();
    expect(declaration('.provider-card::before', 'left')).toBe('-1px');
    expect(declaration('.minimal-detail .provider-card', 'padding')).toBe('10px');
  });

  it('breathes the peak background and logo while the quota arc stays still', () => {
    expect(declaration('.minimal-item.is-peak .minimal-ring::before', 'animation') ?? '').toContain('minimal-peak-fill-breathe');
    expect(declaration('.minimal-item.is-peak .minimal-brand-original', 'animation') ?? '').toContain('minimal-peak-original-breathe');
    expect(declaration('.minimal-item.is-peak .minimal-brand-peak', 'animation') ?? '').toContain('minimal-peak-color-breathe');
    expect(declaration('.minimal-brand-peak', 'background')).toBe('var(--peak)');
    expect(declaration('.minimal-ring-arc', 'animation')).toBeUndefined();
    expect(SHEET).not.toContain('.minimal-ring::after');
  });

  it('clears the tile highlight when native dismissal ends selection', () => {
    // WebKit can retain :hover after the pointer leaves the separate detail window.
    expect(SHEET).not.toMatch(/\.minimal-item:hover\s*[,{]/);
    expect(declaration('.minimal-item.is-active', 'background')).toBe('var(--minimal-selection)');
  });
});

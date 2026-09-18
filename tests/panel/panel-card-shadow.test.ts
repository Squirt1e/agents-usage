// A card is a container, not a button or a warning.
//
// Hover depth implied the whole card could be opened, and the peak halo read like
// an error. Interaction feedback now belongs to the actual controls, while peak
// is carried by the small header capsule and side rail.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../../src/desktop/panel.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** The declarations of one rule, as written. */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('non-interactive cards stay visually still', () => {
  it('does not add card-wide hover feedback', () => {
    expect(CSS).not.toMatch(/\.provider-card:hover\s*\{/);
  });

  it('does not turn peak into a full-card border or glow', () => {
    expect(CSS).not.toMatch(/\.provider-card\[data-period='peak'\]\s*\{/);
  });

  it('uses a dedicated side rail for peak emphasis', () => {
    const rail = ruleBody('.provider-card::before');
    expect(rail).toMatch(/opacity\s*:\s*0/);
    expect(rail).toMatch(/background\s*:\s*var\(--peak\)/);
  });
});

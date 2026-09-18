// Clearance between a card's main quota and auxiliary data belongs to the
// auxiliary section itself. When no Tokens or wallet section exists, no spacing
// element is mounted and the quota ends at the card padding without a reserved
// strip for missing content.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../../src/desktop/panel.css', import.meta.url), 'utf8');

const CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector: string): string {
  const start = CLEAN.indexOf(`${selector} {`);
  expect(start, `missing rule for ${selector}`).toBeGreaterThan(-1);
  const open = CLEAN.indexOf('{', start);
  const close = CLEAN.indexOf('}', open);
  return CLEAN.slice(open + 1, close);
}

describe('quota block bottom clearance', () => {
  it('puts clearance on the conditional auxiliary section, not the quota block', () => {
    expect(ruleBody('.quota-display')).not.toMatch(/padding-bottom\s*:/);
    const secondary = ruleBody('.card-section-secondary');
    expect(secondary).toMatch(/margin-top\s*:\s*[1-9]/);
    expect(secondary).toMatch(/padding-top\s*:\s*[1-9]/);
  });
});

// The panel shows readings, not a document: dragging across it must not paint a
// text selection, and the drags that do matter — the window header, the platform
// reorder grip — must not fight one either. The one place a selection is the
// user's own is a form field. Both halves are easy to lose in a refactor, and
// losing the second half is silent (the field inherits the surface's `none`, and
// a credential simply cannot be selected or replaced by paste), so they are
// pinned here rather than left to the eye.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../src/desktop/panel.css', import.meta.url), 'utf8');

/** The body of a rule block, found by brace counting. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `missing block: ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated block: ${selector}`);
}

/** Rule blocks are read without comments, so a commented-out rule cannot pass. */
const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('panel text selection', () => {
  it('disables selection on the panel surface itself', () => {
    const panel = block(clean, '.panel {');
    // Both spellings: older WebKit only reads the prefixed one, and a standard
    // declaration alone would leave the panel selectable there.
    expect(panel).toMatch(/(?:^|[;{\s])user-select:\s*none;/);
    expect(panel).toMatch(/-webkit-user-select:\s*none;/);
  });

  it('keeps text selectable inside form fields', () => {
    const start = clean.indexOf('.panel input,');
    expect(start, 'missing block: .panel input,').toBeGreaterThan(-1);
    expect(clean.slice(start, clean.indexOf('{', start))).toContain('input');
    const fields = block(clean, '.panel input,');
    expect(fields).toMatch(/(?:^|[;{\s])user-select:\s*text;/);
    expect(fields).toMatch(/-webkit-user-select:\s*text;/);
  });
});

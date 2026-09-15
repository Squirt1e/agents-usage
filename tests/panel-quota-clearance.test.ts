// The quota block's bottom padding exists to clear the rows that may follow it
// (今日 Tokens, the connection state). Made unconditional it survives when no
// row follows — a healthy connection and no Tokens metric — and stacks with the
// card's own padding into a strip of dead space the user reads as the missing
// row's reserved seat. The guard pins the conditional form: a padding-bottom on
// those blocks is only allowed on a `:not(:last-child)` selector.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../src/desktop/panel.css', import.meta.url), 'utf8');

const CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

interface PaddedBlock {
  selector: string;
  body: string;
}

/** Every rule whose selector mentions one of the quota blocks, with its body. */
function quotaBlocks(): PaddedBlock[] {
  const blocks: PaddedBlock[] = [];
  const selectorPattern = /([^{}]*\.quota-display[^{}]*|[^{}]*\[data-provider='codex'\] \.quota-list[^{}]*)\{/g;
  for (const match of CLEAN.matchAll(selectorPattern)) {
    const open = match.index! + match[0].length;
    let depth = 1;
    let index = open;
    while (index < CLEAN.length && depth > 0) {
      if (CLEAN[index] === '{') depth += 1;
      else if (CLEAN[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ selector: match[1]!.trim(), body: CLEAN.slice(open, index - 1) });
  }
  return blocks;
}

describe('quota block bottom clearance', () => {
  it('applies padding-bottom only while a row follows the quota block', () => {
    const padded = quotaBlocks().filter(({ body }) => /padding-bottom\s*:/.test(body));
    expect(padded.length, 'the quota blocks should carry the clearance').toBeGreaterThan(0);
    for (const { selector, body } of padded) {
      const value = body.match(/padding-bottom\s*:\s*([^;]+);/)?.[1];
      expect(
        selector,
        `padding-bottom: ${value} on "${selector}" must sit on a :not(:last-child) form — ` +
          'unconditional, it reads as the tokens row\'s reserved seat when no row follows'
      ).toContain(':not(:last-child)');
    }
  });
});

// The panel is exactly as wide as its window, so nothing in it may scroll
// sideways. That is not cosmetic: a body that overflows horizontally is panned by
// the first two-finger swipe, and what the user sees is the whole frame shifted
// with its title cut off at the left edge. jsdom computes no layout, so the rules
// are read off the sheet — the browser check that the content actually fits is
// described in docs/desktop/verification.md.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('src/desktop/panel.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every rule that names the selector, joined: a shared rule and its own both
 * apply. The argument is a regular expression, so a selector written with a space
 * or a newline can be matched without repeating the sheet's formatting.
 */
function rule(selector: string): string {
  return [...CSS.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'g'))]
    .map((match) => match[1])
    .join(' ');
}

describe('panel width: nothing scrolls sideways', () => {
  it('clips the page horizontally, so a pan cannot shift the frame', () => {
    const page = rule('html,\\s*body');
    // `clip`, not `hidden`: a hidden box is still scrollable, clip is not.
    expect(page, 'the document must not be horizontally scrollable').toMatch(/overflow-x:\s*clip/);
  });

  it('never lets the scrolling body gain a horizontal axis', () => {
    const body = rule('.panel-body');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body, 'the body must not offer a horizontal scroll').toMatch(/overflow-x:\s*hidden/);
    // `clip` cannot be used beside `overflow-y: auto` (the pair is invalid and the
    // used value falls back to `hidden`, which is still pannable), so the content
    // is what has to fit.
    expect(body).not.toMatch(/overflow-x:\s*clip/);
  });

  it('makes long service messages fit inside their independent detail layer', () => {
    // A service message can be one long token. It now belongs to the footer
    // detail, not a card; it still has to break inside that bounded layer.
    for (const selector of ['.state-block', '.connection-detail p']) {
      const block = rule(selector);
      expect(block, `${selector} must break inside a long word`).toMatch(/overflow-wrap:\s*anywhere/);
    }
    expect(rule('.connection-details')).toMatch(/width:\s*min\(/);
  });

  it('never lets a credential failure squeeze the stored state into a column', () => {
    // A rejected credential answers with a sentence, and that sentence shares a
    // row with "已保存 ····abcd" / "尚未配置". While both were flexible the state
    // lost: the panel showed it one character per line, reading as "尚 未 配 置"
    // beside the error. The state keeps its width, the message wraps on its own
    // row, and a message with no spaces breaks instead of widening the panel.
    const row = rule('\\.credential-status');
    expect(row, 'the row must be able to wrap').toMatch(/flex-wrap:\s*wrap/);
    expect(rule('\\.credential-status > span:first-child'), 'the stored state must not shrink').toMatch(
      /flex:\s*0\s+0\s+auto/
    );
    const feedback = rule('\\.credential-feedback');
    expect(feedback, 'the message must claim its own row').toMatch(/flex:\s*1\s+1\s+100%/);
    expect(feedback, 'a message without spaces must break').toMatch(/overflow-wrap:\s*anywhere/);
    expect(feedback, 'the message must be allowed to shrink').toMatch(/min-width:\s*0/);
  });
});

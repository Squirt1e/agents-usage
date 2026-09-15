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

/**
 * The settings window loads `panel.css` — that is where the two palettes and every
 * shared control live — and then `settings.css`.
 *
 * Vite emits **one** CSS bundle for both documents, so the two sheets end up in a
 * single declaration set that both windows load. A bare rule in `settings.css`
 * therefore applies to the panel too, and being concatenated second it wins: the
 * first version of this file wrote `html, body { width: 100%; overflow: hidden }`
 * and replaced the panel's own `width: 350px; overflow-x: clip` — the rule that stops
 * a trackpad pan from shifting the whole frame sideways. The fix is scoping, and
 * these assertions are what keep it scoped.
 */
describe('settings window: nothing here reaches the panel', () => {
  const SETTINGS_CSS = readFileSync(new URL('../src/desktop/settings.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );

  /** Comments out, whitespace folded: a rule read as one line regardless of formatting. */
  const settingsClean = SETTINGS_CSS.replace(/\s+/g, ' ');

  /**
   * Every declaration of the rules that name this selector, whitespace folded so a
   * selector written across two lines or an indented body reads as a one-liner.
   *
   * The pattern is written out rather than derived from a plain selector string:
   * escaping a `.` through a regex build is exactly the kind of thing that quietly
   * matches nothing, and a guard that matches nothing passes.
   */
  const settingsRule = (pattern: RegExp): string =>
    [...settingsClean.matchAll(pattern)].map((match) => match[1]).join(' ');

  it('keys the document rules on the settings document itself', () => {
    const page = settingsRule(/:root:has\(#settings-root\)\s*body\s*\{([^}]*)\}/g);
    expect(page, 'the settings document must state its own box').toMatch(/width:\s*100%/);
    expect(page, 'and must not inherit the panel 350px width').not.toMatch(/width:\s*350px/);
    // `overflow: hidden` on the document is right here — the window is fixed and the
    // content area scrolls — and wrong in the panel, which is the point of scoping it.
    expect(page).toMatch(/overflow:\s*hidden/);
  });

  it('declares no unscoped top-level rule at all', () => {
    // The contract that makes the bundle safe: every selector in this sheet is keyed
    // on something only the settings document has — its `.settings-*` classes, its
    // `#settings-root`, or `:root:has(#settings-root)` around either. A bare `html`,
    // `body`, `*` or element selector would be read by the panel's document too, and
    // would win, because this sheet is concatenated second.
    // `@keyframes` bodies are skipped: their `from` / `to` steps are not selectors,
    // and a guard that counted them would report a problem with the keyframes rather
    // than with the rules it exists to check.
    const withoutKeyframes = settingsClean.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ' ');
    const preludes = [...withoutKeyframes.matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{/g)].map((match) => match[1]!.trim());
    expect(preludes.length, 'no rules parsed — the guard would pass vacuously').toBeGreaterThan(10);
    for (const prelude of preludes) {
      for (const selector of prelude.split(',').map((part) => part.trim())) {
        if (selector === '') continue;
        const scoped =
          selector.startsWith('.settings-') ||
          selector.startsWith('#settings-root') ||
          selector.startsWith(':root:has(#settings-root)');
        expect(
          scoped,
          `settings.css declares "${selector}" unscoped: the bundle loads it in the panel document too, where it wins`
        ).toBe(true);
      }
    }
  });

  it('leaves the panel sheet alone', () => {
    // The neutralisation is this sheet's job; editing `panel.css` to suit the
    // settings window would put the panel's own geometry at risk instead.
    expect(rule('\\.panel'), 'panel.css must keep the panel width').toMatch(/width:\s*350px/);
  });
});

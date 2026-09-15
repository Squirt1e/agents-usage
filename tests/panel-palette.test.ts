// The panel ships two palettes. A colour written straight into a rule belongs to
// neither: it keeps the dark theme's value when the light theme is selected. That
// is exactly how the light theme shipped half-finished — bright mint rings and a
// dark segment background on a white panel — so the rules are enforced here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(new URL('../src/desktop/panel.css', import.meta.url), 'utf8');

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

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

// Blocks are read from the comment-free stylesheet, so removing them below
// actually removes them.
const clean = withoutComments(CSS);
const dark = block(clean, ':root {');
const light = block(clean, ":root[data-theme='light'] {");
/** Everything that is not a palette: the rules the two themes share. */
const rules = clean.replace(dark, '').replace(light, '');

/**
 * The colour variables a palette defines. Shape and type tokens (`--radius`,
 * `--mono`) are shared and legitimately live in the base block only, so only
 * values that *are* colours are compared.
 */
const colourVariables = (palette: string) =>
  [...palette.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
    .filter(([, , value]) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(value!))
    .map((match) => match[1]!)
    .sort();

const variable = (palette: string, name: string): string | undefined =>
  [...palette.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
    .find((match) => match[1] === name)?.[2]?.trim().toLowerCase();

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    return channels.reduce((sum, channel, index) => {
      const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
    }, 0);
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('panel palette', () => {
  it('keeps every colour in a theme variable', () => {
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/\brgba?\(/);
  });

  it('lets the light palette override every colour the dark one sets', () => {
    // A colour missing from the light block silently keeps its dark value, which
    // is how a half-finished light theme looks: bright mint rings on a white
    // panel, a dark segment background, an unreadable spinner track.
    expect(colourVariables(light)).toEqual(colourVariables(dark));
  });

  it('announces the scheme in both palettes so native controls follow', () => {
    expect(dark).toMatch(/color-scheme:\s*dark/);
    expect(light).toMatch(/color-scheme:\s*light/);
  });

  it('keeps macOS action and enabled-state colours separate from platform data', () => {
    expect(variable(light, '--action')).toBe('#0066cc');
    expect(variable(light, '--switch-on-bg')).toBe('#34c759');
    expect(variable(light, '--switch-on-thumb')).toBe('#ffffff');
    expect(variable(light, '--action')).not.toBe(variable(light, '--mint'));
    expect(variable(light, '--switch-on-bg')).not.toBe(variable(light, '--action'));
    expect(block(clean, ':focus-visible')).toMatch(/outline:\s*2px solid var\(--action\)/);
    expect(block(clean, '.switch:checked')).toMatch(/background:\s*var\(--switch-on-bg\)/);
    expect(block(clean, '.switch:checked::after')).toMatch(/background:\s*var\(--switch-on-thumb\)/);
    expect(block(clean, '.segmented-option.is-active')).toMatch(/color:\s*var\(--action\)/);
  });

  it('maps the new semantic roles to the existing dark palette', () => {
    expect(variable(dark, '--action')).toBe(variable(dark, '--mint'));
    expect(variable(dark, '--healthy-border')).toBe(variable(dark, '--active-border'));
    expect(variable(dark, '--primary-bg')).toBe(variable(dark, '--active-bg'));
    expect(variable(dark, '--switch-on-border')).toBe(variable(dark, '--active-border'));
    expect(variable(dark, '--switch-on-bg')).toBe(variable(dark, '--active-bg'));
    expect(variable(dark, '--switch-on-thumb')).toBe(variable(dark, '--mint'));
  });

  it('keeps the light switch off state a switch, not a disabled control', () => {
    // macOS draws a control that cannot be used as a grey knob on a grey track,
    // and that is what the light off state used to be: an off switch that read
    // as a broken one. The state belongs to the track; the knob stays the white
    // slider it is when the switch is on.
    const track = variable(light, '--switch-bg')!;
    const thumb = variable(light, '--switch-thumb')!;
    const channels = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
    expect(channels(thumb).every((channel) => channel >= 240), `off knob ${thumb} is a grey knob`).toBe(true);
    // Both edges have to hold on the white card the switch sits on: the track is
    // what makes the off state visible, and the knob is what makes it a control.
    expect(contrast(track, variable(light, '--card')!)).toBeGreaterThan(1.2);
    expect(contrast(thumb, track)).toBeGreaterThan(1.2);
    // Disabled is the panel's one treatment for "cannot be used": the fade.
    expect(block(clean, '.switch:disabled')).toMatch(/opacity:\s*0?\.\d+/);
  });

  it('keeps macOS light text and actions readable on white grouped cards', () => {
    const card = variable(light, '--card')!;
    expect(card).toBe('#ffffff');
    expect(contrast(variable(light, '--text')!, card)).toBeGreaterThanOrEqual(7);
    expect(contrast(variable(light, '--text-dim')!, card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(variable(light, '--action')!, card)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * The settings window's own sheet. It has no palettes of its own — it inherits both
 * from `panel.css`, which `settings.html` loads first — so the rule it has to keep
 * is the one that makes that sharing work: every colour it writes is a variable
 * reference, never a value.
 */
describe('settings window palette', () => {
  const settingsClean = readFileSync(new URL('../src/desktop/settings.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );

  it('takes every colour from a theme variable', () => {
    // A literal colour belongs to neither palette: it keeps the dark theme's value
    // when the light theme is selected. Named colours are not a problem in this
    // sheet (there are none, and the panel's convention is hex/rgba), so the check
    // is the same pair the panel's own sheet is held to.
    expect(settingsClean).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(settingsClean).not.toMatch(/\brgba?\(/);
  });
});

// The type scale, as a rule rather than a convention.
//
// Both windows read one stylesheet pair, and between them they had grown eleven
// font sizes — 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13.5, 15 and 19. Three of
// those (9.5 / 10 / 10.5) sat within half a pixel of each other while carrying
// three different levels, which the eye cannot resolve: the hierarchy was really
// being carried by colour, and the extra half-pixels were noise that made every
// later rule a guess about which one to copy.
//
// The scale now has seven named steps. This guard is what keeps it seven: a raw
// pixel size in a rule fails here, so the sprawl cannot return one rule at a time
// — the same way `panel-motion.test.ts` keeps every switch travelling and
// `panel-palette.test.ts` keeps every colour in a palette.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SHEET_FILES = ['src/desktop/panel.css', 'src/desktop/settings.css'];
/** The palette block is where a scale is *defined*; it is exempt from the rule. */
const PALETTE_ANCHOR = `:root {`;

const read = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The palette block of `panel.css`, found by brace counting. */
function paletteBlock(css: string): string {
  const start = css.indexOf(PALETTE_ANCHOR);
  expect(start, 'panel.css has no :root palette').toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error('unterminated :root block');
}

const panel = read(SHEET_FILES[0]!);
const settings = read(SHEET_FILES[1]!);
const palette = paletteBlock(panel);

/** Every `--text-*: Npx` step this project defines. */
const stepOf = (name: string): number => {
  const match = new RegExp(`${name}\\s*:\\s*([0-9.]+)px`).exec(palette);
  expect(match, `${name} is not defined in the palette`).not.toBeNull();
  return Number(match![1]);
};

describe('the type scale is a scale', () => {
  it('defines every step in the palette', () => {
    for (const name of [
      '--text-2xs',
      '--text-xs',
      '--text-sm',
      '--text-md',
      '--text-base',
      '--text-lg',
      '--text-xl',
      '--text-display'
    ]) {
      expect(stepOf(name), `${name} missing`).toBeGreaterThan(0);
    }
  });

  it('ascends, and keeps every step far enough from its neighbours to be seen', () => {
    const names = [
      '--text-2xs',
      '--text-xs',
      '--text-sm',
      '--text-md',
      '--text-base',
      '--text-lg',
      '--text-xl',
      '--text-display'
    ];
    const sizes = names.map(stepOf);
    for (let index = 1; index < sizes.length; index += 1) {
      expect(sizes[index]!, `${names[index]} must be larger than ${names[index - 1]}`).toBeGreaterThan(
        sizes[index - 1]!
      );
      // Half a pixel is not a level: the whole point of the scale is that
      // neighbouring steps are distinguishable.
      expect(
        sizes[index]! - sizes[index - 1]!,
        `${names[index - 1]} and ${names[index]} are too close to read as different levels`
      ).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('names a step in every rule, in both sheets', () => {
    for (const [file, css] of SHEET_FILES.map((file) => [file, read(file)] as const)) {
      // The settings document is a different sheet that imports the same palette,
      // so its rules are checked against the same scale.
      const body = file === SHEET_FILES[0] ? css.replace(palette, '') : css;
      const raw = [...body.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => match[1]);
      expect(raw, `${file} sets a raw font size: ${raw.join(', ')}`).toEqual([]);
    }
  });

  it('keeps the document base out of the shorthand, so its token can change', () => {
    // A `font:` shorthand cannot take a var() for one part without the whole
    // declaration going invalid at computed-value time.
    for (const [file, css] of SHEET_FILES.map((file) => [file, read(file)] as const)) {
      expect(/(^|[^-\w])font:\s*[^;]*[0-9.]+px/.test(css), `${file} sizes text inside the font shorthand`).toBe(
        false
      );
    }
  });

  it('uses every step it defines', () => {
    // A step nobody names is a step that has already been abandoned.
    for (const name of ['--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-base', '--text-lg', '--text-xl', '--text-display']) {
      const uses = [...panel.matchAll(new RegExp(`var\\(${name}\\)`, 'g'))].length +
        [...settings.matchAll(new RegExp(`var\\(${name}\\)`, 'g'))].length;
      expect(uses, `${name} is defined but never used`).toBeGreaterThan(0);
    }
  });
});

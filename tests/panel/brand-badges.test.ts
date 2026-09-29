// Every surface that identifies a platform draws that platform's own mark.
//
// The panel and the settings window used to label platforms `CX`／`GL`／`DS`, and each
// surface carried its own copy of the letters, so a badge could be changed on one
// surface while the others kept the letters — which is exactly what happened when the
// minimal rail introduced the brand SVGs. This guard reads the sources rather than
// rendering them: the badge is a property of the file, and the surfaces live in two
// different windows, so no single component test can see all three.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The three surfaces that identify a platform, and the provider rows they carry. */
const BADGE_SURFACES = [
  'src/desktop/panel/PlatformCard.tsx',
  'src/desktop/settings/PlatformSettings.tsx',
  'src/desktop/settings/SettingsPanel.tsx'
];

/** The one module allowed to resolve a provider to a brand asset. */
const BRAND_SOURCE = 'src/desktop/components/BrandMark.tsx';
const PANEL_SOURCE = 'src/desktop/panel/MinimalPanel.tsx';
const SHEET = 'src/desktop/panel.css';
const LETTERS = ['CX', 'GL', 'DS'];

const read = (file: string) => readFileSync(file, 'utf8');

/** One declaration from the rule block a selector opens, found by brace counting. */
function declaration(css: string, selector: string, property: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`^${escaped}\\s*\\{`, 'm').exec(css);
  if (rule === null) return undefined;
  const open = css.indexOf('{', rule.index);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const match = new RegExp(
    `(?:^|;|\\s)${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+)`
  ).exec(body);
  return match?.[1]?.trim();
}

describe('platform badges draw the platform’s mark', () => {
  it('never falls back to a letter badge on any surface', () => {
    for (const surface of BADGE_SURFACES) {
      const source = read(surface);
      for (const letters of LETTERS) {
        expect(source, `${surface} still draws the ${letters} letter badge`).not.toContain(`>${letters}<`);
      }
      // A local provider → letter map is how the surfaces drifted apart: one badge
      // could be changed while the others kept their copy.
      expect(source, `${surface} keeps a local provider → badge map`).not.toMatch(
        /Record<ProviderId, string>/
      );
    }
  });

  it('draws the shared mark on every surface', () => {
    for (const surface of BADGE_SURFACES) {
      const source = read(surface);
      expect(source, `${surface} does not use the shared mark`).toContain("from '../components/BrandMark'");
      expect(source, `${surface} does not render the shared mark`).toContain('<BrandMark');
    }
  });

  it('resolves the three marks from the vendored assets in one module', () => {
    const brands = read(BRAND_SOURCE);
    for (const brand of ['codex', 'glm', 'deepseek']) {
      expect(brands, `BrandMark does not resolve ${brand}`).toContain(`../assets/brands/${brand}.svg`);
    }
    // No surface imports an asset itself: a second copy of the map is a second place
    // to update when a provider is added or the pinned version is bumped.
    for (const surface of [...BADGE_SURFACES, PANEL_SOURCE]) {
      expect(read(surface), `${surface} imports a brand asset directly`).not.toContain('../assets/brands/');
    }
    // Nothing may fetch a mark at runtime.
    expect(brands).not.toMatch(/https?:\/\//);
  });

  it('paints the mark from the theme rather than from the file', () => {
    const sheet = read(SHEET).replace(/\/\*[\s\S]*?\*\//g, '');
    // The mask takes the shape and `currentColor` takes the badge's accent colour.
    // That pair is what keeps the fixed logo colours — and a dark-only logo — out.
    expect(declaration(sheet, '.brand-mark', 'background')).toBe('currentColor');
    expect(declaration(sheet, '.brand-mark', 'mask-image')).toBeUndefined();
    expect(declaration(sheet, '.brand-mark', '-webkit-mask-image')).toBeUndefined();
    expect(read(BRAND_SOURCE)).toContain('maskImage');
    // The letter the mark replaced needed a font; the badge must not keep one.
    expect(declaration(sheet, '.brand-badge', 'font-size')).toBeUndefined();
  });
});

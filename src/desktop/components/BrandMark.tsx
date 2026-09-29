/**
 * The platform brand marks, resolved from the vendored SVGs in one place.
 *
 * Four surfaces draw these: the overview card header, a platform manager row, the
 * settings navigation and the minimal rail's rings. Keeping the provider → asset map
 * here means a new platform is a type error in exactly one file, and the pinned
 * version and licence recorded in `docs/desktop/README.md` describe every user at
 * once instead of one of them.
 *
 * ## Why the badge form is a mask
 *
 * These badges used to draw `CX`／`GL`／`DS` letters in the platform's accent colour.
 * The GLM and DeepSeek logos carry fixed colours of their own (a gradient, and a
 * blue that is close to the badge's own ring), and the Codex mark ships as
 * `currentColor` — a fixed-colour logo would fight the badge tile in one theme and
 * disappear in the other. Masking takes only the shape and lets `color` fill it, so
 * the accent the letter used still paints the mark, from the same theme variables.
 *
 * The minimal rail keeps GLM and DeepSeek in their own colours at rest and masks
 * Codex, whose logo has no brand colour to keep. During a peak it overlays a
 * masked copy of each mark, so the original and peak colour can exchange opacity
 * without recolouring the vendored SVGs or the progress arc.
 */

import type { CSSProperties } from 'react';
import type { ProviderId } from '../../shared/contracts';
import codexMark from '../assets/brands/codex.svg';
import glmMark from '../assets/brands/glm.svg';
import deepseekMark from '../assets/brands/deepseek.svg';

/** provider → the URL of the vendored mark that stands for it. */
export const BRAND_MARKS: Record<ProviderId, string> = {
  codex: codexMark,
  glm: glmMark,
  deepseek: deepseekMark
};

/**
 * A provider's mark expressed as a mask, so the element's own colour paints it.
 *
 * The URL is supplied per provider because the three assets are three files; the
 * repeat/position/size that make a mask a mark live in `.brand-mark`.
 */
export function brandMaskStyle(provider: ProviderId): CSSProperties {
  const url = `url("${BRAND_MARKS[provider]}")`;
  return { WebkitMaskImage: url, maskImage: url };
}

export interface BrandMarkProps {
  provider: ProviderId;
}

/**
 * The mark that stands for a platform, in the badge that identifies it.
 *
 * Always `aria-hidden`: every badge sits beside the platform's written name, or
 * inside a navigation button that carries it, so the mark never holds the only copy
 * of which platform this is.
 */
export function BrandMark(props: BrandMarkProps) {
  return <span className="brand-mark" aria-hidden="true" style={brandMaskStyle(props.provider)} />;
}

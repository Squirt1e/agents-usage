// @vitest-environment jsdom
// What is left of "the panel swaps pages".
//
// There are no pages any more: the settings surfaces are their own window, so the
// panel shows the overview and nothing else. This file replaced the page-transition
// assertions, which pinned a *page swap* — a direction the app reported, a remount
// that replayed the animation, and the CSS that consumed both. That they are gone is
// now itself the property worth pinning: a switch nobody can reach would still sit in
// the motion guard's registry, and the guard's whole point is that every registered
// switch is a switch that happens.
import { readFileSync } from 'node:fs';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPanel } from '../helpers/windows';

// The stylesheet is read by relative path: this file runs in jsdom, where
// `import.meta.url` is not a file URL.
const CSS = readFileSync('src/desktop/panel.css', 'utf8');
const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the block whose opening brace follows `start`. */
function blockAt(css: string, start: number, label: string): string {
  expect(start, `missing block: ${label}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated block: ${label}`);
}

const panelElement = () => document.querySelector('.panel') as HTMLElement;
const bodyElement = () => document.querySelector('.panel-body') as HTMLElement;

describe('the panel has one page', () => {
  it('keeps the overview mounted when a settings entry point is used', async () => {
    const { onOpenSettings } = renderPanel();
    const overview = bodyElement();

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    // The same element, still there: nothing was swapped out, because the settings
    // surface is not this window's page. (It used to remount here — that remount was
    // what replayed the page-entrance animation.)
    expect(bodyElement()).toBe(overview);
    expect(screen.getByTestId('overview')).toBeInTheDocument();
    expect(onOpenSettings).toHaveBeenCalledWith('appearance');
  });

  it('carries no view-state markers any more', async () => {
    renderPanel();
    await screen.findByTestId('overview');

    // `data-view-direction` drove the page-entrance animation and the view key keyed
    // the remount. Both went with the pages; a panel that reports either has grown a
    // page back without anyone deciding to.
    expect(panelElement().dataset.viewDirection).toBeUndefined();
    expect(panelElement().dataset.viewKey).toBeUndefined();
    // And there is no "back to the overview" control, because the overview never left.
    expect(screen.queryByRole('button', { name: '返回用量总览' })).not.toBeInTheDocument();
  });

  it('keeps the tool row on screen, since it is the only page', async () => {
    renderPanel();
    const gear = await screen.findByRole('button', { name: '设置' });

    // The row used to fade out on a sub-page (`aria-hidden`, opacity 0, visibility
    // hidden) while its three buttons stayed mounted. With no sub-page there is
    // nothing to fade for, so it is an ordinary visible control.
    expect(document.querySelector('.panel-tools')).not.toHaveAttribute('aria-hidden');
    expect(gear).toBeInTheDocument();
    expect(document.querySelectorAll('.panel-tools .icon-button')).toHaveLength(3);
  });

  it('has no page-entrance animation left in the sheet', () => {
    expect(clean).not.toMatch(/panel-page-in-forward/);
    expect(clean).not.toMatch(/panel-page-in-back/);
    expect(clean).not.toMatch(/data-view-direction/);
  });

  it('leaves reduced motion to the file-wide fallback', () => {
    // AGENTS.md: a new switch needs no block of its own, the closing fallback silences
    // every transition and animation at once — so it has to exist, and it has to be the
    // `!important` one that outranks every rule above it.
    const reduceBlocks = [...clean.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)].map((match) =>
      blockAt(clean, match.index, 'reduced motion block')
    );
    expect(
      reduceBlocks.some(
        (block) =>
          block.includes('*::after') &&
          /animation:\s*none\s*!important/.test(block) &&
          /transition:\s*none\s*!important/.test(block)
      )
    ).toBe(true);
  });
});

// @vitest-environment jsdom
// Swapping the overview for a settings page used to be a cut. It is a transition
// now: the arriving page animates in from the side the user travelled towards.
// jsdom computes no animations, so these tests pin the three things the
// transition actually rests on — the direction the app reports, the remount that
// replays the animation, and the CSS that consumes both.
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelApp, type PanelHostProps } from '../src/desktop/PanelApp';
import { createFakeUsageClient } from '../src/desktop/fake-client';

// The stylesheet is read by relative path: this file runs in jsdom, where
// `import.meta.url` is not a file URL.
const CSS = readFileSync('src/desktop/panel.css', 'utf8');

/** Rule blocks are read without comments, so a commented-out rule cannot pass. */
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

function renderPanel() {
  const client = createFakeUsageClient();
  const host: PanelHostProps = { pinned: false, onTogglePin: vi.fn(), onRequestHide: vi.fn(), onSetHeight: vi.fn() };
  render(<PanelApp client={client} host={host} now={new Date('2026-09-10T08:00:00.000Z')} />);
  return { client, host };
}

const panelElement = () => document.querySelector('.panel') as HTMLElement;
const bodyElement = () => document.querySelector('.panel-body') as HTMLElement;

describe('panel page transition', () => {
  it('reports the direction of the swap, including when it turns around', async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    expect(panelElement().dataset.viewDirection).toBe('forward');

    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));
    expect(panelElement().dataset.viewDirection).toBe('back');

    // Turning around again must not keep the previous direction: the direction is
    // set in the same update as the view it describes.
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(panelElement().dataset.viewDirection).toBe('forward');
  });

  it('remounts the page on every swap, which is what replays the animation', async () => {
    renderPanel();
    const overview = bodyElement();

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const settings = bodyElement();
    expect(settings).not.toBe(overview);

    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));
    expect(bodyElement()).not.toBe(settings);
  });

  it('animates the arriving page from the side the user travelled towards', () => {
    const forwardKeys = blockAt(clean, clean.indexOf('@keyframes panel-page-in-forward'), 'forward keyframes');
    const backKeys = blockAt(clean, clean.indexOf('@keyframes panel-page-in-back'), 'back keyframes');
    expect(forwardKeys).toMatch(/translateX\(10px\)/);
    expect(backKeys).toMatch(/translateX\(-10px\)/);
    // The window is sized from this content, so a scale here would be measured
    // mid-flight and resize the window with it; only a translate is safe.
    expect(forwardKeys).not.toMatch(/scale/);
    expect(backKeys).not.toMatch(/scale/);

    expect(blockAt(clean, clean.indexOf(".panel[data-view-direction='forward']"), 'forward rule')).toMatch(
      /animation:\s*panel-page-in-forward/
    );
    expect(blockAt(clean, clean.indexOf(".panel[data-view-direction='back']"), 'back rule')).toMatch(
      /animation:\s*panel-page-in-back/
    );
  });

  it('fades the tool row between pages instead of unmounting it', async () => {
    renderPanel();
    const gear = await screen.findByRole('button', { name: '设置' });
    // Visible: no marking at all, so the buttons are ordinary, queryable controls.
    expect(document.querySelector('.panel-tools')).not.toHaveAttribute('aria-hidden');

    fireEvent.click(gear);
    // Still mounted — a row that unmounted would have no exit to animate — but the
    // role query that used to prove "gone" now proves "hidden", which is what
    // `aria-hidden` buys and what lets the fade be a transition.
    const tools = document.querySelector('.panel-tools');
    expect(tools).not.toBeNull();
    expect(tools).toHaveAttribute('aria-hidden', 'true');
    expect(tools?.querySelectorAll('.icon-button')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '设置' })).not.toBeInTheDocument();

    const hiddenRule = blockAt(clean, clean.indexOf(".panel-tools[aria-hidden='true']"), 'hidden tool row');
    expect(hiddenRule).toMatch(/opacity:\s*0/);
    expect(hiddenRule).toMatch(/visibility:\s*hidden/);
  });

  it('leaves reduced motion to the file-wide fallback', () => {
    // AGENTS.md: a new switch needs no block of its own, the closing fallback
    // silences every transition and animation at once — so it has to exist, and it
    // has to be the `!important` one that outranks every rule above it.
    const reduceBlocks = [...clean.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)].map((match) =>
      blockAt(clean, match.index, 'reduced motion block')
    );
    expect(
      reduceBlocks.some(
        (block) => block.includes('*::after') && /animation:\s*none\s*!important/.test(block) && /transition:\s*none\s*!important/.test(block)
      )
    ).toBe(true);
  });
});

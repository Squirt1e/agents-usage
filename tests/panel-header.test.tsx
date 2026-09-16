// @vitest-environment jsdom
// The pinned panel's header settles away while the pointer is off the panel, and
// comes straight back when the pointer returns — no click or focus involved. This
// file pins the pointer state machine and the rendering contract it feeds: the
// target state lands on `.panel` as `data-header-hidden`, the header leaves the
// accessibility tree while collapsed, the travel adopts a collapsed first frame
// without animating it, and the height the window follows really is written to
// the header element (jsdom reports every height as 0, so the travel collapses on
// its first frame here; the eased curve itself is pinned by the pure-function
// tests below).
import { readFileSync } from 'node:fs';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import {
  HEADER_COLLAPSE_SLACK_MS,
  headerTravelHeight
} from '../src/desktop/panel/panel-header';
import { PANEL_ANIMATING_ATTRIBUTE, PANEL_HEIGHT_ANIMATION_MS } from '../src/desktop/panel/panel-height';
import { PanelApp, type PanelHostProps } from '../src/desktop/panel/PanelApp';
import { createFakeUsageClient } from '../src/desktop/lib/fake-client';

const CSS = readFileSync('src/desktop/panel.css', 'utf8');
const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('headerTravelHeight', () => {
  it('starts where it started and ends where it ends', () => {
    expect(headerTravelHeight(46, 0, 0)).toBe(46);
    expect(headerTravelHeight(46, 0, PANEL_HEIGHT_ANIMATION_MS)).toBe(0);
    expect(headerTravelHeight(0, 46, 0)).toBe(0);
    expect(headerTravelHeight(0, 46, PANEL_HEIGHT_ANIMATION_MS)).toBe(46);
  });

  it('clamps elapsed time from both sides', () => {
    expect(headerTravelHeight(46, 0, -5)).toBe(46);
    expect(headerTravelHeight(46, 0, PANEL_HEIGHT_ANIMATION_MS + 500)).toBe(0);
  });

  it('eases through the middle: half the time is not half the distance', () => {
    // Ease-in-out cubic at progress 0.5 is exactly half; a quarter of the way
    // in, the eased share is only 6.25% — clearly behind a linear travel.
    const early = headerTravelHeight(46, 0, Math.round(PANEL_HEIGHT_ANIMATION_MS * 0.25));
    expect(early).toBeGreaterThan(23);
    expect(early).toBeLessThan(46);
    expect(headerTravelHeight(46, 0, Math.round(PANEL_HEIGHT_ANIMATION_MS * 0.5))).toBe(23);
  });

  it('reports whole pixels only', () => {
    const stepped = headerTravelHeight(46, 0, Math.round(PANEL_HEIGHT_ANIMATION_MS * 0.3));
    expect(Number.isInteger(stepped)).toBe(true);
  });
});

const panel = () => document.querySelector('.panel') as HTMLElement;
const header = () => document.querySelector('.panel-header') as HTMLElement;

/** Render the app the way main.tsx does, with only the header flag varying. */
  function renderPanel(headerVisible: boolean | undefined, onSetHeight: (height: number) => void = () => undefined) {
    const client = createFakeUsageClient();
    const host: PanelHostProps = {
      pinned: true,
      headerVisible,
    onTogglePin: vi.fn(),
    onRequestHide: vi.fn(),
    onSetHeight
  };
  const element = (): ReactElement =>
    createElement(PanelApp, { client, host, now: new Date("2026-09-12T08:00:00.000Z"), onOpenSettings: () => undefined });
  const view = render(element());
  return {
    rerenderWith(next: boolean | undefined) {
      host.headerVisible = next;
      view.rerender(element());
    }
  };
}

describe('header collapse rendering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the panel and the header while collapsed, and only then', async () => {
    const { rerenderWith } = renderPanel(false);
    await screen.findByText('用量总览');
    expect(panel().dataset.headerHidden).toBe('');
    expect(header().getAttribute('aria-hidden')).toBe('true');
    // Adopted as-is: a panel that comes back collapsed must not grow out of
    // nothing, so the height is already the end state on the first frame. The
    // padding and bottom border collapse with it — a border-box `height: 0`
    // alone would leave their rows behind.
    expect(header().style.height).toBe('0px');
    expect(header().style.paddingTop).toBe('0px');
    expect(header().style.paddingBottom).toBe('0px');
    expect(header().style.borderBottomWidth).toBe('0px');

    rerenderWith(true);
    await waitFor(() => expect(panel().dataset.headerHidden).toBeUndefined());
    expect(header().getAttribute('aria-hidden')).toBeNull();
    // The constraints come off entirely so future reflows resize naturally.
    await waitFor(() => expect(header().style.height).toBe(''));
    expect(header().style.paddingTop).toBe('');
    expect(header().style.paddingBottom).toBe('');
    expect(header().style.borderBottomWidth).toBe('');
  });

  it('starts expanded when the host says nothing', async () => {
    renderPanel(undefined);
    await screen.findByText('用量总览');
    expect(panel().dataset.headerHidden).toBeUndefined();
    expect(header().getAttribute('aria-hidden')).toBeNull();
    expect(header().style.height).toBe('');
  });

  it('writes the height on the header and retires the travel announcement', async () => {
    const onSetHeight = vi.fn();
    const { rerenderWith } = renderPanel(true, onSetHeight);
    await screen.findByText('用量总览');

    rerenderWith(false);

    // The travel announces itself on the panel, the header reaches its end
    // state, and the announcement is retired after the slack so the settle
    // path takes over again.
    await waitFor(() => expect(header().style.height).toBe('0px'));
    await waitFor(
      () => expect(panel().hasAttribute(PANEL_ANIMATING_ATTRIBUTE)).toBe(false),
      { timeout: PANEL_HEIGHT_ANIMATION_MS + HEADER_COLLAPSE_SLACK_MS + 500 }
    );
  });

  it('collapses in one step when motion is not wanted', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { rerenderWith } = renderPanel(true);
    await screen.findByText('用量总览');
    expect(header().style.height).toBe('');

    rerenderWith(false);
    await waitFor(() => expect(header().style.height).toBe('0px'));
  });
});

describe('header collapse stylesheet', () => {
  it('steps the contents out of the tab order exactly when the height lands', () => {
    // The visibility step is keyed on the target state with the travel's own
    // duration as its delay: on collapse it lands when the height reaches zero,
    // on expand it is undone immediately.
    const start = clean.indexOf('.panel[data-header-hidden] .panel-header');
    expect(start).toBeGreaterThan(-1);
    const open = clean.indexOf('{', start);
    const body = clean.slice(open + 1, clean.indexOf('}', open));
    expect(body).toMatch(/visibility:\s*hidden/);
    expect(body).toMatch(/visibility 0s linear 240ms/);
  });
});

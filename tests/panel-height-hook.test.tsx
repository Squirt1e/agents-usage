// @vitest-environment jsdom
// The panel's sizing rule, exercised against a stubbed layout: jsdom reports every
// height as 0, so the measurements are defined per element here. What this pins is
// the contract the host depends on — cards set the height exactly, a view with no
// cards falls back to the minimum, and height changes travel in steps.
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANEL_ANIMATING_ATTRIBUTE,
  PANEL_HEIGHT_ANIMATION_MS,
  PANEL_HEIGHT_SAFETY_MS,
  PANEL_HEIGHT_SETTLE_MS,
  PANEL_MIN_HEIGHT,
  requestPanelHeightMeasure,
  usePanelHeight
} from '../src/desktop/panel-height';

/** The frame the hook reads: chrome = panel height minus the body's. */
const frame = { panel: 400, body: 100 };
/** Bottom edges of the cards on screen, in content coordinates. */
let cards: number[] = [];

beforeEach(() => {
  frame.panel = 400;
  frame.body = 100;
  cards = [];
  observers = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Chrome, as the hook computes it: border + header + footer + body padding. */
const CHROME = 400 - 100;

/** jsdom has no ResizeObserver; the hook is given one it can be driven through. */
let observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function stubBox(element: HTMLElement, key: 'panel' | 'body') {
  Object.defineProperty(element, key === 'panel' ? 'offsetHeight' : 'clientHeight', {
    configurable: true,
    get: () => (key === 'panel' ? frame.panel : frame.body)
  });
}

function Harness(props: {
  cardCount: number;
  onSetHeight: (height: number) => void;
  viewKey?: string;
  isMain?: boolean;
}) {
  usePanelHeight({
    viewKey: props.viewKey ?? String(props.cardCount),
    isMain: props.isMain ?? true,
    onSetHeight: props.onSetHeight
  });
  return (
    <div className="panel">
      <div className="panel-body">
        <div data-testid="content">
          {Array.from({ length: props.cardCount }, (_, index) => (
            <div key={index} data-testid={`card-${index}`} data-panel-block="card" />
          ))}
        </div>
      </div>
    </div>
  );
}

function prepare() {
  const panel = document.querySelector('.panel') as HTMLElement;
  const body = document.querySelector('.panel-body') as HTMLElement;
  const content = screen.getByTestId('content');
  stubBox(panel, 'panel');
  stubBox(body, 'body');
  // The cards are measured relative to the content's top, which sits at 0 here.
  content.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0 }) as DOMRect;
  for (const [index, card] of screen.queryAllByTestId(/^card-/).entries()) {
    const bottom = cards[index] ?? 0;
    card.getBoundingClientRect = () => ({ top: 0, bottom, height: bottom }) as DOMRect;
  }
  return content;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, PANEL_HEIGHT_SETTLE_MS + 40));

describe('usePanelHeight', () => {
  it('fits the cards exactly', async () => {
    cards = [200, 410, 620];
    const onSetHeight = vi.fn();
    render(<Harness cardCount={3} onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620));
  });

  it('falls back to the minimum height on a main page with no cards', async () => {
    const onSetHeight = vi.fn();
    render(<Harness cardCount={0} onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(PANEL_MIN_HEIGHT));
  });

  it('makes a page without cards follow the main page height', async () => {
    // The overview settles on three cards first.
    cards = [200, 410, 620];
    const onSetHeight = vi.fn();
    const { rerender } = render(
      <Harness cardCount={3} onSetHeight={onSetHeight} viewKey="overview" />
    );
    prepare();
    const mainHeight = CHROME + 620;
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(mainHeight));

    // Opening a settings page: no cards, and it must not size itself.
    rerender(
      <Harness cardCount={0} onSetHeight={onSetHeight} viewKey="app-settings" isMain={false} />
    );
    prepare();
    await settle();
    expect(onSetHeight).toHaveBeenCalledTimes(1);
    expect(onSetHeight).toHaveBeenLastCalledWith(mainHeight);
  });

  it('keeps the settings height while the main page changes behind it', async () => {
    // A settings page opened after a two-card overview inherits that height, and
    // re-measuring it does not invent a new one.
    cards = [200, 410];
    const onSetHeight = vi.fn();
    const { rerender } = render(
      <Harness cardCount={2} onSetHeight={onSetHeight} viewKey="overview" />
    );
    prepare();
    const mainHeight = CHROME + 410;
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(mainHeight));

    rerender(<Harness cardCount={0} onSetHeight={onSetHeight} viewKey="settings:glm" isMain={false} />);
    prepare();
    await settle();
    expect(onSetHeight).toHaveBeenLastCalledWith(mainHeight);

    // Back to the overview: only the cards there may move the window.
    cards = [200, 410, 620];
    rerender(<Harness cardCount={3} onSetHeight={onSetHeight} viewKey="overview" />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenLastCalledWith(CHROME + 620), { timeout: 2000 });
  });

  it('stops at the third card when the view has more', async () => {
    cards = [200, 410, 620, 830];
    const onSetHeight = vi.fn();
    render(<Harness cardCount={4} onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620));
  });

  it('arrives at the new height in one report when motion is not wanted', async () => {
    // `prefers-reduced-motion: reduce`: the window still resizes, but it is not
    // animated towards (AGENTS.md §1.4). This is the one switch CSS cannot make,
    // so the preference has to be honoured here as well.
    const onSetHeight = vi.fn();
    const { rerender } = render(<Harness cardCount={0} onSetHeight={onSetHeight} />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(PANEL_MIN_HEIGHT));

    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    cards = [200, 410, 620];
    rerender(<Harness cardCount={3} onSetHeight={onSetHeight} viewKey="overview" />);
    prepare();
    const target = CHROME + 620;
    await waitFor(() => expect(onSetHeight).toHaveBeenLastCalledWith(target), { timeout: 2000 });

    // Two reports in total: the first height, then the target. No steps between.
    expect(onSetHeight.mock.calls.map(([height]) => height)).toEqual([PANEL_MIN_HEIGHT, target]);
  });

  it('travels from a card-less view up to a carded one in steps', async () => {
    const onSetHeight = vi.fn();
    const { rerender } = render(<Harness cardCount={0} onSetHeight={onSetHeight} />);
    prepare();
    // Nothing to travel from on the first report, so it is sent as it is.
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(PANEL_MIN_HEIGHT));

    // The overview's cards arrive: 620px of content against a 320px panel.
    cards = [200, 410, 620];
    rerender(<Harness cardCount={3} onSetHeight={onSetHeight} viewKey="overview" />);
    // The reappearing cards are new elements, so their boxes need stubbing too.
    prepare();
    const target = CHROME + 620;
    await waitFor(() => expect(onSetHeight).toHaveBeenLastCalledWith(target), { timeout: 2000 });

    const steps = onSetHeight.mock.calls.map(([height]) => height).slice(1);
    // The window is moved over several frames, not set once.
    expect(steps.length).toBeGreaterThan(2);
    expect(steps.every((height, index) => index === 0 || height >= steps[index - 1]!)).toBe(true);
    expect(steps[steps.length - 1]).toBe(target);
    // ...and it passes through the middle rather than snapping to the end.
    expect(steps.some((height) => height > PANEL_MIN_HEIGHT && height < target)).toBe(true);
  });

  it('drops back to the minimum when the main page loses its cards', async () => {
    cards = [200, 410, 620];
    const onSetHeight = vi.fn();
    const { rerender } = render(<Harness cardCount={3} onSetHeight={onSetHeight} />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620));

    // Every platform hidden: the main page has nothing to show.
    cards = [];
    rerender(<Harness cardCount={0} onSetHeight={onSetHeight} viewKey="overview-empty" />);
    await waitFor(() => expect(onSetHeight).toHaveBeenLastCalledWith(PANEL_MIN_HEIGHT), {
      timeout: 2000
    });
  });

  it('lets a page opened from a card-less overview inherit the floor', async () => {
    cards = [200, 410, 620];
    const onSetHeight = vi.fn();
    const { rerender } = render(<Harness cardCount={3} onSetHeight={onSetHeight} />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620));

    // Every platform hidden: the main page asks for the floor.
    cards = [];
    rerender(<Harness cardCount={0} onSetHeight={onSetHeight} viewKey="overview-empty" />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenLastCalledWith(PANEL_MIN_HEIGHT), {
      timeout: 2000
    });

    // Opening a settings page from that emptied overview must not snap back up
    // to the height of cards that are no longer there.
    rerender(<Harness cardCount={0} onSetHeight={onSetHeight} viewKey="app-settings" isMain={false} />);
    prepare();
    await settle();
    expect(onSetHeight).toHaveBeenLastCalledWith(PANEL_MIN_HEIGHT);
  });

  it('holds the floor for a card shorter than the designed minimum', async () => {
    cards = [10];
    const onSetHeight = vi.fn();
    render(<Harness cardCount={1} onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(PANEL_MIN_HEIGHT));
  });

  it('follows the content while it animates, instead of waiting for it to settle', async () => {
    // The quota morph collapses a card over ~270ms. Waiting for the layout to hold
    // still means asking the host for the new height ~80ms *after* the animation,
    // and then travelling to it — the panel visibly resizing once the movement is
    // over. While the content says it is animating, the measured height is
    // reported as it is measured, so the window and the card move together.
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    cards = [200, 410];
    const onSetHeight = vi.fn();
    render(<Harness cardCount={2} onSetHeight={onSetHeight} />);
    prepare();
    const panel = document.querySelector('.panel') as HTMLElement;
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledTimes(1));
    expect(onSetHeight).toHaveBeenLastCalledWith(CHROME + 410);
    const observer = observers[0]!;

    // The card collapses mid-animation, and the content says so.
    panel.setAttribute(PANEL_ANIMATING_ATTRIBUTE, '');
    cards = [200, 250];
    prepare();
    observer.callback([], observer as unknown as ResizeObserver);

    // Reported on the spot: no settle delay, and no travelling steps between the
    // two heights.
    expect(onSetHeight).toHaveBeenCalledTimes(2);
    expect(onSetHeight).toHaveBeenLastCalledWith(CHROME + 250);
  });

  it('re-takes the measurement on its own, so a lost notification cannot strand it', async () => {
    // The host hides this window for most of its life and a hidden WebKit view gets
    // no frames, so a size that changed while it was hidden is never announced. The
    // tick is what keeps the window from standing at a height its content has
    // outgrown — the failure that leaves a card cut off with no event to blame.
    vi.useFakeTimers();
    try {
      cards = [200, 410, 620];
      const onSetHeight = vi.fn();
      render(<Harness cardCount={3} onSetHeight={onSetHeight} />);
      prepare();
      await act(async () => {
        vi.advanceTimersByTime(PANEL_HEIGHT_SETTLE_MS + 40);
      });
      expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620);

      onSetHeight.mockClear();
      // The cards change and nothing says so: no observer notification at all.
      cards = [200, 410, 300];
      prepare();
      await act(async () => {
        vi.advanceTimersByTime(PANEL_HEIGHT_SAFETY_MS + PANEL_HEIGHT_SETTLE_MS + PANEL_HEIGHT_ANIMATION_MS + 60);
      });
      expect(onSetHeight).toHaveBeenCalledWith(CHROME + 300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-attaches to whatever the body shows now, so a swapped view cannot freeze it', async () => {
    // The error state and the overview share a view key, so the body's child can be
    // replaced without the hook's effect re-running. Measuring the remembered node
    // would read a detached element — every rectangle zero — and leave the window at
    // the minimum height with the cards on screen.
    vi.useFakeTimers();
    try {
      cards = [200, 410, 620];
      const onSetHeight = vi.fn();
      render(<Harness cardCount={3} onSetHeight={onSetHeight} />);
      prepare();
      await act(async () => {
        vi.advanceTimersByTime(PANEL_HEIGHT_SETTLE_MS + 40);
      });
      expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620);

      onSetHeight.mockClear();
      const body = document.querySelector('.panel-body') as HTMLElement;
      body.replaceChildren();
      const replacement = document.createElement('div');
      replacement.dataset.testid = 'content';
      replacement.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0 }) as DOMRect;
      for (const bottom of [180, 300]) {
        const card = document.createElement('div');
        card.dataset.panelBlock = 'card';
        card.getBoundingClientRect = () => ({ top: 0, bottom, height: bottom }) as DOMRect;
        replacement.append(card);
      }
      body.append(replacement);

      await act(async () => {
        vi.advanceTimersByTime(PANEL_HEIGHT_SAFETY_MS + PANEL_HEIGHT_SETTLE_MS + PANEL_HEIGHT_ANIMATION_MS + 60);
      });
      expect(onSetHeight).toHaveBeenCalledWith(CHROME + 300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resize a view whose height has not changed', async () => {
    cards = [200];
    const onSetHeight = vi.fn();
    const { rerender } = render(<Harness cardCount={1} onSetHeight={onSetHeight} />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledTimes(1));

    // A re-measure of the same layout must not ask the host to resize again.
    rerender(<Harness cardCount={1} onSetHeight={onSetHeight} viewKey="same" />);
    await settle();
    expect(onSetHeight).toHaveBeenCalledTimes(1);
  });

  it('answers an explicit re-measure request, which is how the header collapse drives it', async () => {
    // The header collapse animates a box the ResizeObserver does not watch (the
    // body's content keeps its size while the header above it shrinks), so
    // panel-header.ts asks for a measurement every frame. With the animating
    // attribute set, the answer must come on the spot — no settle delay, no
    // travelling steps.
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    cards = [200, 410];
    const onSetHeight = vi.fn();
    render(<Harness cardCount={2} onSetHeight={onSetHeight} />);
    prepare();
    const panel = document.querySelector('.panel') as HTMLElement;
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 410));

    panel.setAttribute(PANEL_ANIMATING_ATTRIBUTE, '');
    cards = [200, 560];
    prepare();
    requestPanelHeightMeasure();

    expect(onSetHeight).toHaveBeenLastCalledWith(CHROME + 560);
  });
});

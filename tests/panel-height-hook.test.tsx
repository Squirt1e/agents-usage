// @vitest-environment jsdom
// The panel's height measurement, exercised against a stubbed layout: jsdom reports
// every height as 0, so the measurements are defined per element here. What this pins
// is the contract the host depends on — the window takes the content's height, the
// change travels in steps, and **the measurement is re-taken rather than awaited**.
//
// That last one is the load-bearing half. The panel window spends most of its life
// hidden, a hidden WebKit view produces no frames, and a lost `ResizeObserver`
// notification is never re-sent: the window then stands at the height its content had
// minutes ago, with a card cut off and no event to blame. See the archived change
// `fix-panel-height-follows-cards`. The three scenarios that guard it are kept here
// verbatim — the swapped content block, the change nobody announced, and the return
// from hidden.
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANEL_ANIMATING_ATTRIBUTE,
  PANEL_HEIGHT_ANIMATION_MS,
  PANEL_HEIGHT_SAFETY_MS,
  PANEL_HEIGHT_SETTLE_MS,
  requestPanelHeightMeasure,
  usePanelHeight
} from '../src/desktop/panel/panel-height';

/** The frame the hook reads: chrome = panel height minus the body's client height. */
const frame = { panel: 400, body: 100 };
/** The content element's own border-box height, in logical pixels. */
let contentHeight = 0;

beforeEach(() => {
  frame.panel = 400;
  frame.body = 100;
  contentHeight = 0;
  observers = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Chrome, as the hook computes it: the panel's box minus the body's viewport. */
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

function Harness(props: { maxHeight?: number; paddedBody?: boolean; onSetHeight: (height: number) => void }) {
  usePanelHeight({
    onSetHeight: props.onSetHeight,
    ...(props.maxHeight !== undefined ? { maxHeight: props.maxHeight } : {})
  });
  return (
    <div className="panel">
      <div
        className="panel-body"
        style={props.paddedBody ? { paddingTop: '10px', paddingBottom: '4px' } : undefined}
      >
        <div data-testid="content" />
      </div>
    </div>
  );
}

/** Point the stubbed measurements at whatever the current `contentHeight` is. */
function prepare() {
  const panel = document.querySelector('.panel') as HTMLElement;
  const body = document.querySelector('.panel-body') as HTMLElement;
  const content = screen.getByTestId('content');
  stubBox(panel, 'panel');
  stubBox(body, 'body');
  content.getBoundingClientRect = () => ({ top: 0, bottom: contentHeight, height: contentHeight }) as DOMRect;
  return content;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, PANEL_HEIGHT_SETTLE_MS + 40));

describe('usePanelHeight', () => {
  it('asks for the frame plus the content', async () => {
    contentHeight = 620;
    const onSetHeight = vi.fn();
    render(<Harness onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620));
  });

  it('includes the scrolling body padding so the footer cannot clip the last card', async () => {
    // `clientHeight` already includes padding, while the measured content border box
    // does not. Leaving the padding out makes the native window exactly this many
    // pixels too short, so its fixed footer appears over the final card.
    contentHeight = 620;
    const onSetHeight = vi.fn();
    render(<Harness paddedBody onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 14 + 620));
  });

  it('has no card-count cap to stop at', async () => {
    // The old rule stopped the window at the third whole card. A tall overview is now
    // a tall panel; what limits it is the display, not a count.
    contentHeight = 1400;
    const onSetHeight = vi.fn();
    render(<Harness onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 1400));
  });

  it('asks for no more than the display when it is told how tall that is', async () => {
    contentHeight = 1400;
    const onSetHeight = vi.fn();
    render(<Harness maxHeight={900} onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(900));
  });

  it('takes only the frame when the overview has nothing to show', async () => {
    // Every platform hidden, or the first loading frame. There is no fixed minimum
    // to fall back to any more: the empty state is content, and the frame is the
    // floor beneath it.
    contentHeight = 0;
    const onSetHeight = vi.fn();
    render(<Harness onSetHeight={onSetHeight} />);
    prepare();

    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME));
  });

  it('arrives at the new height in one report when motion is not wanted', async () => {
    // `prefers-reduced-motion: reduce`: the window still resizes, but it is not
    // animated towards (AGENTS.md §1.4). This is the one switch CSS cannot make, so
    // the preference has to be honoured here as well.
    const onSetHeight = vi.fn();
    const { rerender } = render(<Harness onSetHeight={onSetHeight} />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME));

    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    contentHeight = 620;
    rerender(<Harness onSetHeight={onSetHeight} />);
    prepare();
    const target = CHROME + 620;
    await waitFor(() => expect(onSetHeight).toHaveBeenLastCalledWith(target), { timeout: 2000 });

    // Two reports in total: the first height, then the target. No steps between.
    expect(onSetHeight.mock.calls.map(([height]) => height)).toEqual([CHROME, target]);
  });

  it('travels from an empty overview up to a full one in steps', async () => {
    const onSetHeight = vi.fn();
    const { rerender } = render(<Harness onSetHeight={onSetHeight} />);
    prepare();
    // Nothing to travel from on the first report, so it is sent as it is.
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME));

    contentHeight = 620;
    rerender(<Harness onSetHeight={onSetHeight} />);
    prepare();
    const target = CHROME + 620;
    await waitFor(() => expect(onSetHeight).toHaveBeenLastCalledWith(target), { timeout: 2000 });

    const steps = onSetHeight.mock.calls.map(([height]) => height).slice(1);
    // The window is moved over several frames, not set once.
    expect(steps.length).toBeGreaterThan(2);
    expect(steps.every((height, index) => index === 0 || height >= steps[index - 1]!)).toBe(true);
    expect(steps[steps.length - 1]).toBe(target);
    // ...and it passes through the middle rather than snapping to the end.
    expect(steps.some((height) => height > CHROME && height < target)).toBe(true);
  });

  it('shrinks back to the frame when every platform is hidden', async () => {
    contentHeight = 620;
    const onSetHeight = vi.fn();
    const { rerender } = render(<Harness onSetHeight={onSetHeight} />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620));

    contentHeight = 70;
    rerender(<Harness onSetHeight={onSetHeight} />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenLastCalledWith(CHROME + 70), { timeout: 2000 });
  });

  it('follows the content while it animates, instead of waiting for it to settle', async () => {
    // The quota morph collapses a card over ~270ms. Waiting for the layout to hold
    // still means asking the host for the new height ~80ms *after* the animation, and
    // then travelling to it — the panel visibly resizing once the movement is over.
    // While the content says it is animating, the measured height is reported as it
    // is measured, so the window and the card move together.
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    contentHeight = 410;
    const onSetHeight = vi.fn();
    render(<Harness onSetHeight={onSetHeight} />);
    prepare();
    const panel = document.querySelector('.panel') as HTMLElement;
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledTimes(1));
    expect(onSetHeight).toHaveBeenLastCalledWith(CHROME + 410);
    const observer = observers[0]!;

    // The card collapses mid-animation, and the content says so.
    panel.setAttribute(PANEL_ANIMATING_ATTRIBUTE, '');
    contentHeight = 250;
    prepare();
    observer.callback([], observer as unknown as ResizeObserver);

    // Reported on the spot: no settle delay, and no travelling steps between the two
    // heights.
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
      contentHeight = 620;
      const onSetHeight = vi.fn();
      render(<Harness onSetHeight={onSetHeight} />);
      prepare();
      await act(async () => {
        vi.advanceTimersByTime(PANEL_HEIGHT_SETTLE_MS + 40);
      });
      expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620);

      onSetHeight.mockClear();
      // The content changes and nothing says so: no observer notification at all.
      contentHeight = 300;
      prepare();
      await act(async () => {
        vi.advanceTimersByTime(PANEL_HEIGHT_SAFETY_MS + PANEL_HEIGHT_SETTLE_MS + PANEL_HEIGHT_ANIMATION_MS + 60);
      });
      expect(onSetHeight).toHaveBeenCalledWith(CHROME + 300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-attaches to whatever the body shows now, so a swapped block cannot freeze it', async () => {
    // The error state, the loading state and the overview are different elements, so
    // the body's child can be replaced without the hook's effect re-running. Measuring
    // the remembered node would read a detached element — every rectangle zero — and
    // leave the window at the frame with the cards on screen.
    vi.useFakeTimers();
    try {
      contentHeight = 620;
      const onSetHeight = vi.fn();
      render(<Harness onSetHeight={onSetHeight} />);
      prepare();
      await act(async () => {
        vi.advanceTimersByTime(PANEL_HEIGHT_SETTLE_MS + 40);
      });
      expect(onSetHeight).toHaveBeenCalledWith(CHROME + 620);

      onSetHeight.mockClear();
      const body = document.querySelector('.panel-body') as HTMLElement;
      body.replaceChildren();
      const replacement = document.createElement('div');
      replacement.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
      body.append(replacement);

      await act(async () => {
        vi.advanceTimersByTime(PANEL_HEIGHT_SAFETY_MS + PANEL_HEIGHT_SETTLE_MS + PANEL_HEIGHT_ANIMATION_MS + 60);
      });
      expect(onSetHeight).toHaveBeenCalledWith(CHROME + 300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resize when the height has not changed', async () => {
    contentHeight = 200;
    const onSetHeight = vi.fn();
    render(<Harness onSetHeight={onSetHeight} />);
    prepare();
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledTimes(1));

    // A re-measure of the same layout must not ask the host to resize again.
    await settle();
    expect(onSetHeight).toHaveBeenCalledTimes(1);
  });

  it('answers an explicit re-measure request, which is how the header collapse drives it', async () => {
    // The header collapse animates a box the ResizeObserver does not watch (the body's
    // content keeps its size while the header above it shrinks), so panel-header.ts asks
    // for a measurement every frame. With the animating attribute set, the answer must
    // come on the spot — no settle delay, no travelling steps.
    //
    // Why it matters, in one line: without it the window keeps the height it had while
    // the header was up, and the space the header gave back becomes a blank strip under
    // the last card.
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    contentHeight = 410;
    const onSetHeight = vi.fn();
    render(<Harness onSetHeight={onSetHeight} />);
    prepare();
    const panel = document.querySelector('.panel') as HTMLElement;
    await waitFor(() => expect(onSetHeight).toHaveBeenCalledWith(CHROME + 410));

    panel.setAttribute(PANEL_ANIMATING_ATTRIBUTE, '');
    // The header has collapsed: less chrome, same content.
    frame.panel = 340;
    prepare();
    requestPanelHeightMeasure();

    expect(onSetHeight).toHaveBeenLastCalledWith(340 - 100 + 410);
  });
});

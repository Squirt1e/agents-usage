// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MinimalDetailWindow } from '../../src/desktop/panel/MinimalDetailWindow';
import { createFakeUsageClient, defaultPanelSettings, failedStateOf, metricOf, providerStateOf, snapshotOf } from '../../src/desktop/lib/fake-client';
import type { DesktopCommandBridge } from '../../src/desktop/lib/desktop-client';

/**
 * Stand in for hit testing, which jsdom does not implement.
 *
 * The host's probe hands each document a point and the document asks what is under it; a
 * test supplies the answer and records the points that were asked about.
 */
function stubElementFromPoint(target: Element | null) {
  const calls: Array<[number, number]> = [];
  const under = { current: target };
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => { calls.push([x, y]); return under.current; }
  });
  return { calls, under, restore: () => { Reflect.deleteProperty(document, 'elementFromPoint'); } };
}

it('renders the real selected provider card in the separate detail document', async () => {
  const client = createFakeUsageClient({
    settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }),
    snapshot: snapshotOf([providerStateOf('codex', [metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 76, windowSeconds: 18000 })])])
  });
  let currentSelection: { selection: 'codex' | null; index: number } = { selection: null, index: 0 };
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current' ? currentSelection : { caret: 37, height: 200 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  render(<MinimalDetailWindow client={client} bridge={bridge} />);
  currentSelection = { selection: 'codex', index: 0 };
  expect(await screen.findByTestId('card-codex')).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Codex 详情' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '配置 Codex' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('panel_open_settings', { section: 'codex' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('panel_detail_dismiss', { focus: true }));
});

it('shows a hover selection as soon as the host pushes it', async () => {
  const client = createFakeUsageClient({ settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }) });
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? { selection: null, index: 0 }
    : { caret: 37, height: 200 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  render(<MinimalDetailWindow client={client} bridge={bridge} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('panel_detail_current'));
  act(() => window.dispatchEvent(new CustomEvent('panel:minimal-detail-selection', {
    detail: { selection: 'glm', index: 1, generation: 1 }
  })));
  expect(screen.getByTestId('card-glm')).toBeInTheDocument();
});

it('turns the caret toward the rail when the host moves the card to its right', async () => {
  const client = createFakeUsageClient({ settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }) });
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? { selection: 'codex', index: 0, generation: 1 }
    : { caret: 32, height: 102, right: true });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { height: this.classList.contains('minimal-detail-content') ? 100 : 0 } as DOMRect;
  });
  try {
    render(<MinimalDetailWindow client={client} bridge={bridge} />);
    await waitFor(() => expect(document.querySelector('.minimal-detail-window')).toHaveClass('is-right'));
    act(() => window.dispatchEvent(new CustomEvent('panel:minimal-detail-caret', {
      detail: { caret: 32, right: false }
    })));
    expect(document.querySelector('.minimal-detail-window')).not.toHaveClass('is-right');
  } finally {
    rect.mockRestore();
  }
});

it('uses the full card peak treatment in the separate detail', async () => {
  const client = createFakeUsageClient({
    settings: defaultPanelSettings({ panelDisplayMode: 'minimal', peakReminder: { deepseek: {
      mode: 'custom', timezone: 'UTC', windows: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' }]
    } } }),
    snapshot: snapshotOf([providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })])])
  });
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? { selection: 'deepseek', index: 0, generation: 1 }
    : { caret: 37, height: 200 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  render(<MinimalDetailWindow client={client} bridge={bridge} />);
  const card = await screen.findByTestId('card-deepseek');
  expect(card).toHaveAttribute('data-period', 'peak');
  expect(card.querySelector('.peak-corner')).toHaveTextContent('高峰');
});

it('lays out the same card again after it was closed', async () => {
  const client = createFakeUsageClient({ settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }) });
  let current = { selection: null as 'codex' | null, index: 0, generation: 0 };
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? current : { caret: 37, height: 102 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { height: this.classList.contains('minimal-detail-content') ? 100 : 0 } as DOMRect;
  });
  try {
    render(<MinimalDetailWindow client={client} bridge={bridge} />);
    const push = (selection: 'codex' | null) => {
      current = { selection, index: 0, generation: current.generation + 1 };
      act(() => window.dispatchEvent(new CustomEvent('panel:minimal-detail-selection', { detail: current })));
    };
    push('codex');
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('panel_detail_layout', { height: 102 }));
    const first = invoke.mock.calls.filter(([command]) => command === 'panel_detail_layout').length;
    push(null);
    push('codex');
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'panel_detail_layout').length).toBeGreaterThan(first));
  } finally {
    rect.mockRestore();
  }
});

it('frames the connection view with the card’s inset, not the bare detail', async () => {
  // The detail frame pads nothing — a platform card brings its own ten points — so the
  // connection view, which is not a card, brings its own ten. Without that wrapper its
  // heading and rows sat flush against the frame's edge.
  const client = createFakeUsageClient({
    settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }),
    snapshot: snapshotOf([failedStateOf('deepseek', { kind: 'network', message: '私有连接详情', at: '2026-09-10T08:05:00.000Z' })])
  });
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? { selection: 'connection', index: 0, generation: 1 }
    : { caret: 37, height: 122 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  render(<MinimalDetailWindow client={client} bridge={bridge} />);
  const body = await screen.findByTestId('minimal-connection-body');
  expect(body.closest('.minimal-detail-connection')).not.toBeNull();
});

it('paints the hover its controls can never trigger themselves', async () => {
  // This window is created unfocusable — showing it must not take the rail's pointer
  // events — so it can never be the key window, and a webview only receives pointer events
  // while its window is key: none of the card's `:hover` rules can ever fire on their own.
  // The host forwards the pointer, and the card paints the control under it.
  const client = createFakeUsageClient({ settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }) });
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? { selection: 'codex', index: 0, generation: 1 }
    : { caret: 37, height: 122 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  render(<MinimalDetailWindow client={client} bridge={bridge} />);
  const gear = await screen.findByRole('button', { name: '配置 Codex' });
  const point = stubElementFromPoint(gear);
  try {
    window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: { x: 300, y: 20 } }));
    await waitFor(() => expect(gear).toHaveClass('is-hover'));
    // The paint is per-document, and both documents are cleared by the same message.
    window.dispatchEvent(new CustomEvent('panel:hover-probe', { detail: null }));
    await waitFor(() => expect(gear).not.toHaveClass('is-hover'));
  } finally {
    point.restore();
  }
});

it('catches up on the settings and the snapshot the hidden window missed', async () => {
  // WebKit drops the host's broadcasts while this window is hidden — the selection poll
  // exists for the same reason. Without a read on the way in, the card showed the theme
  // of whenever the document mounted and readings an hour old, which is how its numbers
  // came to disagree with the rail's.
  const client = createFakeUsageClient({
    settings: defaultPanelSettings({ panelDisplayMode: 'minimal', theme: 'dark' }),
    snapshot: snapshotOf([providerStateOf('codex', [metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 20, windowSeconds: 18000 })])])
  });
  let current: { selection: 'codex' | null; index: number } = { selection: null, index: 0 };
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? current
    : { caret: 37, height: 200 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  const push = (selection: 'codex' | null, generation: number) => {
    current = { selection, index: 0 };
    act(() => window.dispatchEvent(new CustomEvent('panel:minimal-detail-selection', { detail: { selection, index: 0, generation } })));
  };
  render(<MinimalDetailWindow client={client} bridge={bridge} />);
  push('codex', 1);
  expect(await screen.findByTestId('quota-item-five-hour')).toHaveAccessibleName(/剩余 20%/);

  // The pointer leaves and the host hides the window. While it is hidden the settings
  // window writes a theme and the service collects a new reading; both of those reach
  // the rail and neither reaches this document.
  push(null, 2);
  await waitFor(() => expect(document.querySelector('.minimal-detail')).toHaveAttribute('aria-hidden', 'true'));
  client.setSettings(defaultPanelSettings({ panelDisplayMode: 'minimal', theme: 'light' }));
  client.setSnapshot(snapshotOf([providerStateOf('codex', [metricOf({ key: 'quota.5h.remaining', unit: 'percent', direction: 'remaining', value: 42, windowSeconds: 18000 })])]));
  expect(document.documentElement.dataset.theme).toBe('dark');

  push('codex', 3);
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  expect(await screen.findByTestId('quota-item-five-hour')).toHaveAccessibleName(/剩余 42%/);
});

it('fades the card in only once the host has shown its window', async () => {
  const client = createFakeUsageClient({ settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }) });
  /** The host shows the window while it answers this call, so a held answer is a held window. */
  const pending: Array<(frame: { caret: number; height: number }) => void> = [];
  const invoke = vi.fn((command: string) => {
    if (command === 'panel_detail_current') return Promise.resolve({ selection: 'codex', index: 0, generation: 1 });
    if (command === 'panel_detail_layout') return new Promise((resolve) => pending.push(resolve));
    return Promise.resolve({ caret: 37, height: 122 });
  });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { height: this.classList.contains('minimal-detail-content') ? 100 : 0 } as DOMRect;
  });
  try {
    render(<MinimalDetailWindow client={client} bridge={bridge} />);
    const frame = (await screen.findByTestId('card-codex')).closest('.minimal-detail')!;
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    // Frames go by while the window is still hidden. A reveal on its own clock would have
    // spent the whole fade here, offscreen, and the card would then appear at its final
    // opacity — the pop-in this pins down.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(frame).not.toHaveClass('is-visible');
    await act(async () => { for (const resolve of pending) resolve({ caret: 37, height: 122 }); });
    await waitFor(() => expect(frame).toHaveClass('is-visible'));
  } finally {
    rect.mockRestore();
  }
});

it('waits for the opening read before it reveals, so the theme cannot jump', async () => {
  // A theme changed in the settings window reaches this document through the opening
  // read, because broadcasts aimed at a hidden window are dropped. Revealing before that
  // read lands shows the *previous* theme and then swaps it — the detail panel visibly
  // "switching" a moment after it appears.
  const base = createFakeUsageClient({ settings: defaultPanelSettings({ panelDisplayMode: 'minimal', theme: 'dark' }) });
  /** Held open until the test lets it go, standing in for a read still in flight. */
  let release: (() => void) | null = null;
  const client = {
    ...base,
    readSettings: () => new Promise<ReturnType<typeof base.currentSettings>>((resolve) => {
      release = () => resolve(base.currentSettings());
    })
  } as typeof base;
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? { selection: 'codex', index: 0, generation: 1 }
    : { caret: 37, height: 122 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { height: this.classList.contains('minimal-detail-content') ? 100 : 0 } as DOMRect;
  });
  try {
    render(<MinimalDetailWindow client={client} bridge={bridge} />);
    const frame = (await screen.findByTestId('card-codex')).closest('.minimal-detail')!;
    // The host has answered the height (so its window is up): the card still waits.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('panel_detail_layout', { height: 102 }));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(frame).not.toHaveClass('is-visible');
    await act(async () => { release?.(); });
    await waitFor(() => expect(frame).toHaveClass('is-visible'));
  } finally {
    rect.mockRestore();
  }
});

it('does not blink the whole card when the pointer moves to another platform', async () => {
  const client = createFakeUsageClient({ settings: defaultPanelSettings({ panelDisplayMode: 'minimal' }) });
  let current: { selection: 'codex' | 'glm' | null; index: number } = { selection: 'codex', index: 0 };
  const invoke = vi.fn(async (command: string) => command === 'panel_detail_current'
    ? current
    : { caret: 37, height: 122 });
  const bridge: DesktopCommandBridge = { invoke: invoke as DesktopCommandBridge['invoke'] };
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { height: this.classList.contains('minimal-detail-content') ? 100 : 0 } as DOMRect;
  });
  try {
    render(<MinimalDetailWindow client={client} bridge={bridge} />);
    const frame = (await screen.findByTestId('card-codex')).closest('.minimal-detail')!;
    await waitFor(() => expect(frame).toHaveClass('is-visible'));
    current = { selection: 'glm', index: 1 };
    act(() => window.dispatchEvent(new CustomEvent('panel:minimal-detail-selection', { detail: { selection: 'glm', index: 1, generation: 2 } })));
    expect(await screen.findByTestId('card-glm')).toBeInTheDocument();
    // The frame's own opacity stays where it is: the switch is the content's cross-fade,
    // and flipping the frame made every hover blink the whole card.
    expect(frame).toHaveClass('is-visible');
  } finally {
    rect.mockRestore();
  }
});

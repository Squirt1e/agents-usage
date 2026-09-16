// @vitest-environment jsdom
// The message stack as the user meets it: bottom centre of the panel, growing
// upward, each message leaving on its own clock. The panel's own rules say every
// appearance and disappearance travels (AGENTS.md §1), so the exit is asserted
// too — a message that vanished on a cut would be the jolt those rules exist for.
//
// The fake client resolves on microtasks only, so the countdown is driven with
// fake timers while the data path is flushed by hand: nothing here waits on real
// time.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelSettings, PanelSnapshot } from '../src/shared/desktop-contract';
import type { RefreshResult } from '../src/shared/usage-client';
import { PanelApp, type PanelHostProps } from '../src/desktop/panel/PanelApp';
import { NOTICE_ERROR_TIMEOUT_MS, PANEL_TOAST_EXIT_MS } from '../src/desktop/panel/panel-toasts';
import { createFakeUsageClient, failedStateOf, metricOf, providerStateOf, snapshotOf } from '../src/desktop/lib/fake-client';

const NOW = new Date('2026-09-10T08:00:00.000Z');

/** Let every pending promise of the data path settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Advance the toast clocks, flushing the state updates they cause. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
}

/** The three platforms the panel shows, each with one reading. */
function healthySnapshot(): PanelSnapshot {
  return snapshotOf([
    providerStateOf('codex', [metricOf({ key: 'codex.primary.used', value: 42, unit: 'percent', direction: 'used' })]),
    providerStateOf('glm', [metricOf({ key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used' })]),
    providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })])
  ]);
}

function failedSnapshot(): PanelSnapshot {
  return snapshotOf(
    (['codex', 'glm', 'deepseek'] as const).map((provider) =>
      failedStateOf(provider, { kind: 'network', message: '网络异常', at: '2026-09-10T08:05:00.000Z' })
    )
  );
}

/**
 * The panel as the tests drive it: which platforms it shows, what a refresh answers
 * with, and the state the service publishes as that refresh's outcome.
 */
function renderPanel(
  options: {
    settings?: Partial<PanelSettings>;
    refresh?: Partial<RefreshResult>;
    refreshedSnapshot?: PanelSnapshot;
  } = {}
) {
  const client = createFakeUsageClient({
    snapshot: healthySnapshot(),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.refresh ? { refresh: options.refresh } : {}),
    ...(options.refreshedSnapshot ? { refreshedSnapshot: options.refreshedSnapshot } : {})
  });
  const host: PanelHostProps = {
    pinned: false,
    onTogglePin: vi.fn(),
    onRequestHide: vi.fn(),
    onSetHeight: vi.fn()
  };
  render(<PanelApp client={client} host={host} now={NOW} onOpenSettings={() => undefined} />);
  return { client, host };
}

/** Refresh every platform, which reports one result per platform. */
async function refreshAll() {
  fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));
  await settle();
}

const toastTexts = () => screen.queryAllByTestId('panel-toast').map((toast) => toast.textContent);

describe('panel message stack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps successful refreshes out of the message stack', async () => {
    renderPanel();
    await settle();
    await refreshAll();

    expect(toastTexts()).toHaveLength(0);
  });

  it('names the platform that failed and nothing more', async () => {
    // The footer detail carries the reason; cached data stays on the card.
    // so the message is only the platform's name plus what happened to it. What
    // failed is what the service published, which is also what the card renders:
    // Codex kept its cached reading and came back with a fresh network error.
    const cached = providerStateOf('codex', [
      metricOf({ key: 'codex.primary.used', value: 42, unit: 'percent', direction: 'used' })
    ]);
    renderPanel({
      refreshedSnapshot: snapshotOf([
        failedStateOf(
          'codex',
          { kind: 'network', message: '网络异常，无法连接本地服务', at: '2026-09-10T08:05:00.000Z' },
          { snapshot: cached.snapshot }
        ),
        providerStateOf('glm', [metricOf({ key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used' })]),
        providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })])
      ])
    });
    await settle();
    await refreshAll();

    expect(toastTexts()).toContain('Codex 刷新失败');
    expect(toastTexts()).toHaveLength(1);
    expect(toastTexts().join(' ')).not.toContain('继续显示上次数据');
    expect(toastTexts().join(' ')).not.toContain('网络异常');
  });

  it('hangs the stack above the frame bottom, outside the body it reports on', async () => {
    renderPanel({ refreshedSnapshot: failedSnapshot() });
    await settle();
    await refreshAll();

    const layer = screen.getByTestId('panel-toasts');
    // Anchored to the frame's bottom row, not to the content: a message must not
    // take a row in the body, or it would move the cards and the window height.
    expect(layer.closest('.panel-bottom')).not.toBeNull();
    expect(layer.closest('.panel-body')).toBeNull();
    expect(screen.getByTestId('panel-footer')).toBeInTheDocument();
    // The message is text and nothing else: nothing to press, so a toast holds no
    // buttons at all.
    expect(within(screen.getAllByTestId('panel-toast')[0]!).queryAllByRole('button')).toHaveLength(0);
  });

  it('gives every message its own clock, so one leaving does not clear the rest', async () => {
    // Two platforms, so the connection warning below fits inside the stack.
    const { client } = renderPanel({ settings: { platformVisibility: { deepseek: false } }, refreshedSnapshot: failedSnapshot() });
    await settle();
    await refreshAll();
    expect(toastTexts()).toHaveLength(2);

    // A warning announced later, and it is a warning: it stays twice as long.
    await tick(500);
    await act(async () => {
      client.emit({ type: 'connection', status: 'reconnecting', message: '实时连接中断，正在使用缓存数据' });
    });
    await settle();
    expect(toastTexts()).toHaveLength(3);

    // The two refresh results reach their deadline together and play their exit.
    await tick(NOTICE_ERROR_TIMEOUT_MS - 500);
    expect(screen.getAllByTestId('panel-toast').filter((toast) => toast.className.includes('is-leaving'))).toHaveLength(2);
    await tick(PANEL_TOAST_EXIT_MS);
    expect(toastTexts()).toHaveLength(1);
    expect(toastTexts()[0]).toContain('实时连接中断');

    // The connection warning was reported later, so it keeps its own deadline.
    await tick(500);
    expect(screen.getByTestId('panel-toast')).toHaveClass('is-leaving');
    await tick(PANEL_TOAST_EXIT_MS);
    expect(screen.queryByTestId('panel-toasts')).not.toBeInTheDocument();
  });

  it('restarts a message that is reported again rather than stacking a duplicate', async () => {
    renderPanel({ refreshedSnapshot: failedSnapshot() });
    await settle();
    await refreshAll();

    // Halfway through the dwell the same three failures arrive again: same rows,
    // and their clocks start over.
    await tick(NOTICE_ERROR_TIMEOUT_MS / 2);
    await refreshAll();
    expect(toastTexts()).toHaveLength(3);

    await tick(NOTICE_ERROR_TIMEOUT_MS / 2 + 200);
    expect(toastTexts()).toHaveLength(3);
    expect(screen.getAllByTestId('panel-toast')[0]).not.toHaveClass('is-leaving');

    // Past the restarted deadline they begin to leave, and the exit is its own
    // tick: the countdown and the exit are two timers, in that order.
    await tick(NOTICE_ERROR_TIMEOUT_MS / 2);
    expect(screen.getAllByTestId('panel-toast')[0]).toHaveClass('is-leaving');
    await tick(PANEL_TOAST_EXIT_MS + 50);
    expect(screen.queryByTestId('panel-toasts')).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
// Tasks 6.2 / 6.3: the compact overview shell, the platform management overlay,
// persisted visibility, and the all-hidden case. Hiding must never delete a
// connection or stop collection, which is asserted through the fake client's
// call log.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelApp } from '../src/desktop/PanelApp';
import {
  createFakeUsageClient,
  defaultPanelSettings,
  failedStateOf,
  metricOf,
  providerStateOf,
  snapshotOf,
  type FakeUsageClient
} from '../src/desktop/fake-client';
import type { ProviderId } from '../src/shared/contracts';
import type { PanelSettings, PanelSnapshot } from '../src/shared/desktop-contract';
import type { PanelHostProps } from '../src/desktop/PanelApp';
import { PANEL_MIN_HEIGHT } from '../src/desktop/panel-height';

const NOW = new Date('2026-09-10T08:00:00.000Z');

/** Let every pending promise of the data path settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Every platform reporting a fresh collection failure. */
function failedSnapshot(providers: ProviderId[]): PanelSnapshot {
  return snapshotOf(
    providers.map((provider) =>
      failedStateOf(provider, { kind: 'network', message: '采集失败', at: '2026-09-10T08:05:00.000Z' })
    )
  );
}

/**
 * Hold every refresh open until `release` is called, so a test can move the screen
 * on before the verdicts land — which is what happens for real when a collection
 * takes a few seconds to fail.
 */
function holdRefreshes(client: FakeUsageClient) {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const asked: ProviderId[] = [];
  client.refresh = async (provider) => {
    asked.push(provider);
    await gate;
    return { provider, status: 'requested', at: NOW.toISOString() };
  };
  return { asked, release: () => open() };
}

function overviewSnapshot(): PanelSnapshot {
  return snapshotOf([
    providerStateOf('codex', [
      metricOf({
        key: 'codex.primary.used',
        value: 42,
        unit: 'percent',
        direction: 'used',
        windowSeconds: 18_000,
        resetAt: '2026-09-10T09:42:18.000Z',
        details: { bucketId: 'codex' }
      }),
      metricOf({
        key: 'codex.primary.remaining',
        value: 58,
        unit: 'percent',
        direction: 'remaining',
        windowSeconds: 18_000,
        resetAt: '2026-09-10T09:42:18.000Z',
        details: { bucketId: 'codex' }
      })
    ]),
    providerStateOf('glm', [
      metricOf({ key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used', resetAt: '2026-09-10T10:18:45.000Z' }),
      metricOf({ key: 'quota.5h.remaining', value: 72, unit: 'percent', direction: 'remaining', resetAt: '2026-09-10T10:18:45.000Z' }),
      metricOf({ key: 'wallet.CNY.balance', value: 42.6, unit: 'CNY', direction: 'balance', confidence: ['experimental'] })
    ]),
    providerStateOf('deepseek', [
      metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })
    ])
  ]);
}

function renderPanel(options: { client?: FakeUsageClient; settings?: Partial<PanelSettings>; host?: Partial<PanelHostProps> } = {}) {
  const client = options.client ?? createFakeUsageClient({ snapshot: overviewSnapshot(), settings: options.settings });
  const host: PanelHostProps = {
    pinned: false,
    onTogglePin: vi.fn(),
    onRequestHide: vi.fn(),
    onSetHeight: vi.fn(),
    ...options.host
  };
  const view = render(<PanelApp client={client} host={host} now={NOW} />);
  return { client, host, view };
}

describe('panel overview', () => {
  it('defaults both quota cards to rings showing remaining quota', () => {
    const settings = defaultPanelSettings();

    expect(settings.codexQuotaDisplay).toBe('ring');
    expect(settings.glmQuotaDisplay).toBe('ring');
    expect(settings.quotaValueMode).toBe('remaining');
  });

  it('applies one quota value mode to both supported cards', async () => {
    renderPanel({ settings: { quotaValueMode: 'used' } });

    const codex = await screen.findByTestId('card-codex');
    const glm = screen.getByTestId('card-glm');
    expect(within(codex).getByRole('group', { name: '5小时 已用 42%' })).toBeInTheDocument();
    expect(within(glm).getByRole('group', { name: '5 小时额度 已用 28%' })).toBeInTheDocument();
  });

  it('renders the Codex and GLM quota modes from their independent settings', async () => {
    renderPanel({ settings: { codexQuotaDisplay: 'bar', glmQuotaDisplay: 'ring' } });

    const codex = await screen.findByTestId('card-codex');
    const glm = screen.getByTestId('card-glm');
    expect(within(codex).getByTestId('codex-quota-display')).toHaveAttribute('data-display-mode', 'bar');
    expect(within(codex).getByText('5小时')).toBeInTheDocument();
    expect(within(glm).getByRole('group', { name: /5 小时额度/ })).toBeInTheDocument();
    expect(within(glm).getByTestId('glm-quota-list')).toHaveAttribute('data-display-mode', 'ring');
  });

  it('shows the three platforms together with the sync summary', async () => {
    const { client } = renderPanel();

    expect(await screen.findByTestId('card-codex')).toBeInTheDocument();
    expect(screen.getByTestId('card-glm')).toBeInTheDocument();
    expect(screen.getByTestId('card-deepseek')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '用量总览' })).toBeInTheDocument();
    expect(screen.getByText(/最近同步于 \d{2}:\d{2}/)).toBeInTheDocument();

    // Every card carries a gear that opens its own configuration.
    expect(screen.getByRole('button', { name: '配置 Codex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置 GLM' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置 DeepSeek' })).toBeInTheDocument();

    // The overview never shows a platform picker.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '置顶面板' })).toBeInTheDocument();
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
  });

  it('toggles a card’s reset lines together and keeps other cards unaffected', async () => {
    const snapshot = snapshotOf([
      providerStateOf('codex', [
        metricOf({
          key: 'codex.primary.used',
          value: 42,
          unit: 'percent',
          direction: 'used',
          windowSeconds: 18_000,
          resetAt: '2026-09-10T09:42:18.000Z',
          details: { bucketId: 'codex' }
        }),
        metricOf({
          key: 'codex.secondary.used',
          value: 67,
          unit: 'percent',
          direction: 'used',
          windowSeconds: 604_800,
          resetAt: '2026-09-13T16:26:00.000Z',
          details: { bucketId: 'codex' }
        })
      ]),
      providerStateOf('glm', [
        metricOf({
          key: 'quota.5h.used',
          value: 28,
          unit: 'percent',
          direction: 'used',
          resetAt: '2026-09-10T10:18:45.000Z'
        })
      ])
    ]);
    const client = createFakeUsageClient({
      snapshot,
      settings: { codexResetFormat: 'countdown', glmResetFormat: 'countdown' }
    });
    renderPanel({ client });

    // Clicking any reset line flips the whole card they belong to.
    const fiveHourLine = await screen.findByRole('button', { name: /1 小时 42 分钟后重置/ });
    expect(screen.getByRole('button', { name: /3 天 8 小时后重置/ })).toBeInTheDocument();
    fireEvent.click(fiveHourLine);

    await waitFor(() => {
      expect(client.currentSettings().codexResetFormat).toBe('absolute');
    });
    // Both Codex lines flip together while GLM keeps counting down.
    expect(client.currentSettings().glmResetFormat).toBe('countdown');
    expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ codexResetFormat: 'absolute' });
    // 09:42Z is 17:42 in Asia/Shanghai; the weekly reset lands on 09 月 14 日.
    expect(await screen.findByRole('button', { name: /17:42 重置/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /09 月 14 日 重置/ })).toBeInTheDocument();

    // The GLM card toggles on its own and never touches the Codex card.
    fireEvent.click(screen.getByRole('button', { name: /2 小时 18 分钟后重置/ }));
    await waitFor(() => {
      expect(client.currentSettings().glmResetFormat).toBe('absolute');
    });
    expect(client.currentSettings().codexResetFormat).toBe('absolute');
    // 10:18:45Z is 18:18 in Asia/Shanghai.
    expect(await screen.findByRole('button', { name: /18:18 重置/ })).toBeInTheDocument();
    expect(client.methodCalls('updateSettings')).toHaveLength(2);
  });

  it('persists the quota display mode toggled from the ring itself', async () => {
    const { client } = renderPanel();
    await screen.findByTestId('card-codex');

    // The overview shows Codex first: its rings offer the display-mode toggle.
    fireEvent.click(screen.getAllByRole('button', { name: '切换为进度条' })[0]!);
    await waitFor(() => {
      expect(client.currentSettings().codexQuotaDisplay).toBe('bar');
    });
    expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ codexQuotaDisplay: 'bar' });
    expect(await screen.findByTestId('quota-item-five-hour')).toBeInTheDocument();
  });

  it('opens the settings page with platform management first, and persists visibility', async () => {
    const { client } = renderPanel();
    await screen.findByTestId('card-glm');

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const page = await screen.findByTestId('app-settings');
    // Platform management is the first section of the settings page.
    expect(within(page).getByTestId('platform-settings')).toBeInTheDocument();
    expect(within(page).getByRole('heading', { name: '平台管理' })).toBeInTheDocument();

    const glmSwitch = within(page).getByRole('checkbox', { name: '显示 GLM' });
    expect(glmSwitch).toBeChecked();
    fireEvent.click(glmSwitch);

    await waitFor(() => expect(client.methodCalls('updateSettings')).toHaveLength(1));
    expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ platformVisibility: { glm: false } });

    // Back on the overview the hidden platform is gone.
    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));
    await waitFor(() => expect(screen.queryByTestId('card-glm')).not.toBeInTheDocument());
    expect(screen.getByTestId('card-codex')).toBeInTheDocument();
    expect(screen.getByTestId('card-deepseek')).toBeInTheDocument();

    // Hiding is display-only: no credential is deleted and the connection is kept.
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
    expect(client.currentSnapshot().providers.map((state) => state.provider)).toContain('glm');
  });

  it('reorders platforms from the keyboard as well', async () => {
    const { client } = renderPanel();
    await screen.findByTestId('card-codex');

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const page = await screen.findByTestId('app-settings');
    const handle = within(page).getByRole('button', { name: '拖动排序 GLM' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });

    await waitFor(() => expect(client.methodCalls('updateSettings')).toHaveLength(1));
    expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({
      platformOrder: ['glm', 'codex', 'deepseek']
    });
  });

  it('restores a hidden platform without touching its connection', async () => {
    const client = createFakeUsageClient({
      snapshot: overviewSnapshot(),
      settings: defaultPanelSettings({ platformVisibility: { glm: false } })
    });
    renderPanel({ client });
    await screen.findByTestId('card-codex');
    expect(screen.queryByTestId('card-glm')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(within(await screen.findByTestId('platform-settings')).getByRole('checkbox', { name: '显示 GLM' }));
    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));

    expect(await screen.findByTestId('card-glm')).toBeInTheDocument();
    expect(within(screen.getByTestId('card-glm')).getByRole('group', { name: '5 小时额度 剩余 72%' })).toBeInTheDocument();
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
  });

  it('shows an empty state with a way back when every platform is hidden', async () => {
    const client = createFakeUsageClient({
      snapshot: overviewSnapshot(),
      settings: defaultPanelSettings({ platformVisibility: { codex: false, glm: false, deepseek: false } })
    });
    renderPanel({ client });

    const empty = await screen.findByTestId('empty-selection');
    expect(empty).toHaveTextContent('尚未选择展示的平台');
    expect(screen.queryByTestId('card-codex')).not.toBeInTheDocument();

    fireEvent.click(within(empty).getByRole('button', { name: '管理平台' }));
    const page = await screen.findByTestId('platform-settings');
    for (const provider of ['Codex', 'GLM', 'DeepSeek']) {
      expect(within(page).getByRole('checkbox', { name: `显示 ${provider}` })).not.toBeChecked();
    }
    // Turning one back on brings its card back.
    fireEvent.click(within(page).getByRole('checkbox', { name: '显示 DeepSeek' }));
    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));
    expect(await screen.findByTestId('card-deepseek')).toBeInTheDocument();
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
  });

  it('refreshes the displayed platforms silently and replays their readings', async () => {
    const { client } = renderPanel();
    await screen.findByTestId('card-codex');

    fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));
    await waitFor(() => expect(client.methodCalls('refresh')).toHaveLength(3));
    expect(client.methodCalls('refresh').map((args) => args[0])).toEqual(['codex', 'glm', 'deepseek']);
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新全部平台' })).toBeEnabled());
    expect(screen.queryAllByTestId('panel-toast')).toHaveLength(0);
    expect(screen.getByTestId('card-codex').querySelector('.quota-item.is-replaying .quota-shape-fill')).not.toBeNull();
    expect(screen.getByTestId('card-glm').querySelector('.quota-item.is-replaying .quota-shape-fill')).not.toBeNull();
    expect(screen.getByTestId('card-deepseek').querySelector('.rolling-number-reel')).not.toBeNull();

    // A second successful click must replay even if the service returns exactly
    // the same readings; a value change is not the trigger for this animation.
    const first = screen.getByTestId('quota-item-five-hour');
    fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));
    await waitFor(() => expect(screen.getByTestId('quota-item-five-hour')).not.toBe(first));
    expect(screen.queryAllByTestId('panel-toast')).toHaveLength(0);
  });

  it('takes the refresh verdict from the state the service published, not the reply', async () => {
    // The service answers a manual refresh with an acknowledgement and publishes
    // what it did, so a platform that came back with a fresh error is the failed
    // one — and the others are not: nothing about their reply says so.
    const cached = providerStateOf('glm', [
      metricOf({ key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used' })
    ]);
    const client = createFakeUsageClient({
      snapshot: overviewSnapshot(),
      refresh: { status: 'requested' },
      refreshedSnapshot: snapshotOf([
        providerStateOf('codex', [metricOf({ key: 'codex.primary.used', value: 42, unit: 'percent', direction: 'used' })]),
        failedStateOf(
          'glm',
          { kind: 'missing_config', message: 'GLM Coding Plan API key is not configured', at: '2026-09-10T08:05:00.000Z' },
          { snapshot: cached.snapshot }
        ),
        providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })])
      ])
    });
    renderPanel({ client });
    await screen.findByTestId('card-codex');

    fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));

    expect(await screen.findByText('GLM 刷新失败')).toBeInTheDocument();
    expect(screen.queryByText('Codex 已更新')).not.toBeInTheDocument();
    expect(screen.queryByText('DeepSeek 已更新')).not.toBeInTheDocument();
    expect(screen.getByTestId('card-glm').querySelector('.quota-item.is-replaying')).toBeNull();
  });

  it('replays bar labels and decimal balances from zero after success', async () => {
    renderPanel({ settings: { codexQuotaDisplay: 'bar', glmQuotaDisplay: 'bar' } });
    await screen.findByTestId('card-codex');

    fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新全部平台' })).toBeEnabled());

    const codex = screen.getByTestId('card-codex');
    expect(codex.querySelector('.quota-item-head .rolling-number-reel')).not.toBeNull();
    const balance = screen.getByTestId('card-deepseek');
    expect(balance.querySelectorAll('.rolling-number-reel')).toHaveLength(4);
    const strips = [...balance.querySelectorAll<HTMLElement>('.rolling-number-strip')];
    expect(strips.map((strip) => strip.style.transform)).toEqual([
      'translateY(-18em)', 'translateY(-16em)', 'translateY(-14em)', 'translateY(-12em)'
    ]);
    expect(strips[0]?.textContent).toBe('01234567890123456789');
    expect(screen.queryAllByTestId('panel-toast')).toHaveLength(0);
  });

  it('says nothing about a platform hidden while its refresh was in flight', async () => {
    // The verdict arrives seconds after the click, and the card it belongs to may
    // be gone by then: a message about a platform the user has just hidden is
    // noise, and it would name a card that is not on screen.
    const client = createFakeUsageClient({ snapshot: overviewSnapshot() });
    const held = holdRefreshes(client);
    renderPanel({ client });
    await screen.findByTestId('card-codex');

    fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));
    expect(held.asked).toEqual(['codex', 'glm', 'deepseek']);

    // Hide GLM, then walk back to the overview: its card is gone, Codex and
    // DeepSeek are still there.
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(within(await screen.findByTestId('platform-settings')).getByRole('checkbox', { name: '显示 GLM' }));
    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));
    await waitFor(() => expect(screen.queryByTestId('card-glm')).not.toBeInTheDocument());

    // Every platform now reports a failure, GLM's included.
    client.setSnapshot(failedSnapshot(['codex', 'glm', 'deepseek']));
    held.release();
    await settle();

    expect(screen.getByText('Codex 刷新失败')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek 刷新失败')).toBeInTheDocument();
    expect(screen.queryByText('GLM 刷新失败')).not.toBeInTheDocument();
  });

  it('says nothing at all when the overview is no longer on screen', async () => {
    const client = createFakeUsageClient({ snapshot: overviewSnapshot() });
    const held = holdRefreshes(client);
    renderPanel({ client });
    await screen.findByTestId('card-codex');

    fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));
    // Into the settings page, which has no cards at all, before the results land.
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    await screen.findByTestId('app-settings');

    client.setSnapshot(failedSnapshot(['codex', 'glm', 'deepseek']));
    held.release();
    await settle();

    expect(screen.queryAllByTestId('panel-toast')).toHaveLength(0);
  });

  it('does not render the legacy footer inside the compact panel', async () => {
    renderPanel();
    await screen.findByTestId('card-codex');

    expect(screen.queryByText('本机采集 · 只读面板')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /打开网页版/ })).not.toBeInTheDocument();
  });

  it('keeps the sync line in the bottom module on every page', async () => {
    renderPanel();
    await screen.findByTestId('card-codex');

    const footer = screen.getByTestId('panel-footer');
    expect(within(footer).getByText(/最近同步于 \d{2}:\d{2}/)).toBeInTheDocument();
    // The module belongs to the frame, not to a view, so a sub-page keeps it.
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    await screen.findByTestId('app-settings');
    expect(within(screen.getByTestId('panel-footer')).getByText(/最近同步于 \d{2}:\d{2}/)).toBeInTheDocument();
  });

  it('asks the host to size the window to the panel content', async () => {
    const { host } = renderPanel();
    await screen.findByTestId('card-codex');

    // jsdom has no layout, so the measurement collapses to the floor; what this
    // pins is that the panel reports a height at all, and never below the floor.
    await waitFor(() => expect(host.onSetHeight).toHaveBeenCalledWith(PANEL_MIN_HEIGHT));
  });

  it('reports a missing sync time as missing rather than as a time', async () => {
    renderPanel({ client: createFakeUsageClient({ snapshot: snapshotOf([]) }) });

    const footer = await screen.findByTestId('panel-footer');
    await waitFor(() => expect(within(footer).getByText('尚未同步')).toBeInTheDocument());
    expect(within(footer).queryByText(/最近同步于/)).not.toBeInTheDocument();
  });

  it('reports a cooldown and keeps the last data on screen', async () => {
    const client = createFakeUsageClient({
      snapshot: overviewSnapshot(),
      refresh: { status: 'cooldown', nextEligibleAt: '2026-09-10T08:30:00.000Z' }
    });
    renderPanel({ client });
    await screen.findByTestId('card-codex');

    fireEvent.click(screen.getByRole('button', { name: '刷新全部平台' }));
    expect(await screen.findByText(/刷新冷却中/)).toBeInTheDocument();
    expect(screen.getByText('58')).toBeInTheDocument();
  });

  it('renders the loading state while the cache is being read', async () => {
    let release: (() => void) | undefined;
    const client = createFakeUsageClient({ snapshot: overviewSnapshot() });
    const original = client.readSnapshot.bind(client);
    client.readSnapshot = () =>
      new Promise((resolve) => {
        release = () => void original().then(resolve);
      });
    renderPanel({ client });

    expect(await screen.findByText('正在读取本地缓存…')).toBeInTheDocument();
    release?.();
    expect(await screen.findByTestId('card-codex')).toBeInTheDocument();
  });
});

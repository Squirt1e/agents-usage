// @vitest-environment jsdom
// Tasks 6.4 – 6.7: Codex dual gauges and countdowns, GLM quota + wallet with
// independent health, DeepSeek currencies and opt-in web usage, the metric gate
// matrix, and the rule that a local failure never hides another platform's data.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexCard } from '../src/desktop/CodexCard';
import { DeepSeekCard } from '../src/desktop/DeepSeekCard';
import { GlmCard } from '../src/desktop/GlmCard';
import { PanelApp } from '../src/desktop/PanelApp';
import {
  createFakeUsageClient,
  failedStateOf,
  metricOf,
  providerStateOf,
  snapshotOf
} from '../src/desktop/fake-client';
import type { DesktopProviderState, DesktopUsageMetric, PanelSnapshot } from '../src/shared/desktop-contract';
import { localDayIn } from '../src/shared/desktop-contract';
import { dailyBilledSpends, dailyRequests, latestAttemptFailed, providerView, shouldRenderMetric, withoutConnection, type MetricGateOptions } from '../src/desktop/metrics';
import type { PanelHostProps } from '../src/desktop/PanelApp';

const NOW = new Date('2026-09-10T08:00:00.000Z');
const TIMEZONE = 'Asia/Shanghai';
const GATE: MetricGateOptions = { now: NOW, timezone: TIMEZONE, localDay: localDayIn(TIMEZONE, NOW) };

const noop = () => undefined;
const cardProps = {
  now: NOW,
  gate: GATE,
  quotaDisplayMode: 'ring' as const,
  quotaValueMode: 'used' as const,
  resetTimeFormat: 'countdown' as const,
  onOpenSettings: noop,
  onRefresh: noop,
  balanceConfigured: true,
  webEnabled: false,
  webConfigured: false
};

function codexState(metrics: DesktopUsageMetric[], extra: Parameters<typeof providerStateOf>[2] = {}) {
  return providerStateOf('codex', metrics, extra);
}

const fiveHour = (resetAt: string) =>
  metricOf({
    key: 'codex.primary.used',
    value: 42,
    unit: 'percent',
    direction: 'used',
    windowSeconds: 18_000,
    resetAt,
    details: { bucketId: 'codex' },
    source: 'codex-app-server'
  });

const fiveHourRemaining = (resetAt: string) =>
  metricOf({
    key: 'codex.primary.remaining',
    value: 58,
    unit: 'percent',
    direction: 'remaining',
    windowSeconds: 18_000,
    resetAt,
    details: { bucketId: 'codex' },
    source: 'codex-app-server'
  });

const weekly = (resetAt: string) =>
  metricOf({
    key: 'codex.secondary.used',
    value: 67,
    unit: 'percent',
    direction: 'used',
    windowSeconds: 604_800,
    resetAt,
    details: { bucketId: 'codex' },
    source: 'codex-app-server'
  });

function renderCodex(metrics: DesktopUsageMetric[], extra: Parameters<typeof providerStateOf>[2] = {}) {
  const snapshot = snapshotOf([codexState(metrics, extra)]);
  return render(<CodexCard view={providerView(snapshot, 'codex')} {...cardProps} />);
}

describe('Codex dual gauges', () => {
  it('renders the selected remaining value and labels its meaning', () => {
    const resetAt = '2026-09-10T09:42:18.000Z';
    const snapshot = snapshotOf([codexState([fiveHour(resetAt), fiveHourRemaining(resetAt)])]);
    render(
      <CodexCard
        view={providerView(snapshot, 'codex')}
        {...cardProps}
        quotaValueMode="remaining"
      />
    );

    expect(screen.getByRole('group', { name: '5小时 剩余 58%' })).toBeInTheDocument();
    expect(screen.getByText('58')).toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
  });

  it('renders both window categories with percentages and per-window countdowns', () => {
    renderCodex([fiveHour('2026-09-10T09:42:18.000Z'), weekly('2026-09-13T16:26:00.000Z')]);

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('67')).toBeInTheDocument();
    expect(screen.getByText('5小时')).toBeInTheDocument();
    expect(screen.getByText('7天')).toBeInTheDocument();
    expect(screen.queryByText('已用额度')).not.toBeInTheDocument();
    // The five-hour window counts in hours and minutes (hours dropped at
    // zero); the weekly one in days and hours (days dropped at zero).
    expect(screen.getByText('1 小时 42 分钟后重置')).toBeInTheDocument();
    expect(screen.getByText('3 天 8 小时后重置')).toBeInTheDocument();
    // Only the countdown is shown below each ring.
    expect(screen.queryByText(/^重置于/)).not.toBeInTheDocument();
  });

  it('drops a zero hours part from the five-hour countdown and a zero days part from the weekly one', () => {
    // 42 minutes left on the five-hour window: no leading 00 hours.
    // 8h26m left on the weekly window: no leading 0 days.
    renderCodex([fiveHour('2026-09-10T08:42:00.000Z'), weekly('2026-09-10T16:26:00.000Z')]);

    expect(screen.getByText('42 分钟后重置')).toBeInTheDocument();
    expect(screen.queryByText('0 小时 42 分钟后重置')).not.toBeInTheDocument();
    expect(screen.getByText('8 小时后重置')).toBeInTheDocument();
    expect(screen.queryByText('0 天 8 小时后重置')).not.toBeInTheDocument();
  });

  it('renders the progress-bar mode for both windows and toggles a reset line in place', () => {
    const onToggle = vi.fn();
    render(
      <CodexCard
        view={providerView(snapshotOf([codexState([fiveHour('2026-09-10T09:42:18.000Z'), weekly('2026-09-13T16:26:00.000Z')])]), 'codex')}
        {...cardProps}
        quotaDisplayMode="bar"
        onToggleResetTimeFormat={onToggle}
      />
    );

    // Both windows render as progress bars carrying their percentages.
    expect(screen.getByTestId('codex-quota-display')).toHaveAttribute('data-display-mode', 'bar');
    expect(screen.getByTestId('quota-item-five-hour')).toHaveTextContent('42%');
    expect(screen.getByTestId('quota-item-weekly')).toHaveTextContent('67%');
    // The reset line stays clickable in place and flips the whole card.
    fireEvent.click(screen.getByText('3 天 8 小时后重置'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders a missing window in progress-bar mode as a dash without a zero fill', () => {
    render(
      <CodexCard
        view={providerView(snapshotOf([codexState([fiveHour('2026-09-10T09:42:18.000Z')])]), 'codex')}
        {...cardProps}
        quotaDisplayMode="bar"
      />
    );

    const missing = screen.getByTestId('quota-item-weekly');
    // Shown as missing: a dash and no fabricated percentage.
    expect(missing).toHaveTextContent('—');
    expect(missing).toHaveTextContent('重置时间未知');
  });

  it('toggles the display mode from the ring and the bar visuals themselves', () => {
    const onToggleDisplayMode = vi.fn();
    const view = render(
      <CodexCard
        view={providerView(snapshotOf([codexState([fiveHour('2026-09-10T09:42:18.000Z'), weekly('2026-09-13T16:26:00.000Z')])]), 'codex')}
        {...cardProps}
        quotaDisplayMode="ring"
        onToggleQuotaDisplay={onToggleDisplayMode}
      />
    );
    // Ring mode: each ring is the toggle for the card's display form.
    const ringToggles = screen.getAllByRole('button', { name: '切换为进度条' });
    expect(ringToggles).toHaveLength(2);
    fireEvent.click(ringToggles[0]!);
    expect(onToggleDisplayMode).toHaveBeenCalledTimes(1);

    // Bar mode: the track toggles back to rings.
    view.rerender(
      <CodexCard
        view={providerView(snapshotOf([codexState([fiveHour('2026-09-10T09:42:18.000Z'), weekly('2026-09-13T16:26:00.000Z')])]), 'codex')}
        {...cardProps}
        quotaDisplayMode="bar"
        onToggleQuotaDisplay={onToggleDisplayMode}
      />
    );
    fireEvent.click(
      within(screen.getByTestId('quota-item-five-hour')).getByRole('button', { name: '切换为圆环' })
    );
    expect(onToggleDisplayMode).toHaveBeenCalledTimes(2);
  });

  it('shows the absolute reset clock and date when that format is chosen', () => {
    render(
      <CodexCard
        view={providerView(snapshotOf([codexState([fiveHour('2026-09-10T09:42:18.000Z'), weekly('2026-09-13T16:26:00.000Z')])]), 'codex')}
        {...cardProps}
        resetTimeFormat="absolute"
      />
    );

    // 09:42Z is 17:42 in Asia/Shanghai; the weekly reset is 09 月 14 日 there.
    expect(screen.getByText('17:42 重置')).toBeInTheDocument();
    expect(screen.getByText('09 月 14 日 重置')).toBeInTheDocument();
  });

  it('maps the windows by metadata even when the provider reorders them', () => {
    renderCodex([
      metricOf({
        key: 'codex.secondary.used',
        value: 67,
        unit: 'percent',
        direction: 'used',
        windowSeconds: 604_800,
        resetAt: '2026-09-13T16:26:00.000Z',
        details: { bucketId: 'codex' }
      }),
      metricOf({
        key: 'codex.primary.used',
        value: 42,
        unit: 'percent',
        direction: 'used',
        windowSeconds: 18_000,
        resetAt: '2026-09-10T09:42:18.000Z',
        details: { bucketId: 'codex' }
      })
    ]);

    const fiveHourGauge = screen.getByRole('group', { name: /5小时/ });
    const weeklyGauge = screen.getByRole('group', { name: /7天/ });
    expect(fiveHourGauge).toHaveAccessibleName('5小时 已用 42%');
    expect(weeklyGauge).toHaveAccessibleName('7天 已用 67%');
  });

  it('waits for a refresh once the reset time has passed and keeps the last value', () => {
    renderCodex([fiveHour('2026-09-10T07:59:00.000Z'), weekly('2026-09-13T16:26:00.000Z')]);

    expect(screen.getByText('等待刷新')).toBeInTheDocument();
    // The previous quota is kept: a reached reset is not an observed zero.
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('handles a missing window without substituting the other window or zero', () => {
    renderCodex([fiveHour('2026-09-10T09:42:18.000Z')]);

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.queryByTestId('missing-window')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    // No fabricated weekly percentage and no zero.
    expect(screen.queryByText('67')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

describe('GLM quota and wallet', () => {
  const glmMetrics = [
    metricOf({
      key: 'quota.5h.used',
      value: 28,
      unit: 'percent',
      direction: 'used',
      resetAt: '2026-09-10T10:18:45.000Z',
      connection: { provider: 'glm', connection: 'quota' }
    }),
    metricOf({
      key: 'quota.weekly.used',
      value: 16,
      unit: 'percent',
      direction: 'used',
      resetAt: '2026-09-15T14:12:00.000Z',
      connection: { provider: 'glm', connection: 'quota' }
    }),
    metricOf({
      key: 'quota.5h.remaining',
      value: 72,
      unit: 'percent',
      direction: 'remaining',
      resetAt: '2026-09-10T10:18:45.000Z',
      connection: { provider: 'glm', connection: 'quota' }
    }),
    metricOf({
      key: 'quota.weekly.remaining',
      value: 84,
      unit: 'percent',
      direction: 'remaining',
      resetAt: '2026-09-15T14:12:00.000Z',
      connection: { provider: 'glm', connection: 'quota' }
    }),
    metricOf({
      key: 'wallet.CNY.balance',
      value: 42.6,
      unit: 'CNY',
      direction: 'balance',
      confidence: ['experimental'],
      connection: { provider: 'glm', connection: 'wallet' }
    }),
    metricOf({
      key: 'spend.CNY.daily',
      value: 1.28,
      unit: 'CNY',
      direction: 'spend',
      confidence: ['estimated'],
      details: { localDay: localDayIn(TIMEZONE, NOW) },
      connection: { provider: 'glm', connection: 'wallet' }
    })
  ];

  function renderGlm(
    states: PanelSnapshot,
    options: {
      enabled?: boolean;
      /** `credentials.glm.configured`: false turns the quota module into its cover. */
      quotaConfigured?: boolean;
      /** `credentials['glm-wallet'].configured`: false covers the wallet module. */
      walletConfigured?: boolean;
      quotaDisplayMode?: 'ring' | 'bar';
      quotaValueMode?: 'remaining' | 'used';
      onToggleResetTimeFormat?(): void;
    } = {}
  ) {
    return render(
      <GlmCard
        view={providerView(states, 'glm')}
        quotaConfigured={options.quotaConfigured ?? true}
        walletEnabled={options.enabled ?? true}
        walletConfigured={options.walletConfigured ?? true}
        onToggleResetTimeFormat={options.onToggleResetTimeFormat}
        {...cardProps}
        quotaDisplayMode={options.quotaDisplayMode ?? 'bar'}
        quotaValueMode={options.quotaValueMode ?? 'used'}
      />
    );
  }

  it('renders explicit remaining metrics when that value mode is selected', () => {
    renderGlm(
      snapshotOf([providerStateOf('glm', glmMetrics, { connection: { provider: 'glm', connection: 'quota' } })]),
      { quotaValueMode: 'remaining' }
    );

    expect(screen.getByRole('group', { name: '5 小时额度 剩余 72%' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '每周额度 剩余 84%' })).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText('84%')).toBeInTheDocument();
  });

  it('keeps the weekly slot visible when GLM returns only five-hour quota and shows monthly tools quota', () => {
    renderGlm(snapshotOf([providerStateOf('glm', [
      metricOf({ key: 'quota.5h.remaining', value: 100, unit: 'percent', direction: 'remaining', connection: { provider: 'glm', connection: 'quota' } }),
      metricOf({ key: 'quota.tools.monthly.remaining', value: 40, unit: 'percent', direction: 'remaining', connection: { provider: 'glm', connection: 'quota' } })
    ])]), { quotaValueMode: 'remaining', enabled: false });

    expect(screen.getByRole('group', { name: '5 小时额度 剩余 100%' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '每周额度 剩余未返回' })).toHaveTextContent('—');
    expect(screen.getByRole('group', { name: '月度工具额度 剩余 40%' })).toBeInTheDocument();
    expect(screen.queryByTestId('glm-quota-mask')).not.toBeInTheDocument();
  });

  it('shows quota bars and the wallet together', () => {
    renderGlm(snapshotOf([providerStateOf('glm', glmMetrics, { connection: { provider: 'glm', connection: 'quota' } })]));

    expect(screen.getByText('5 小时额度')).toBeInTheDocument();
    expect(screen.getByText('28%')).toBeInTheDocument();
    expect(screen.getByText('每周额度')).toBeInTheDocument();
    expect(screen.getByText('16%')).toBeInTheDocument();
    // Reset lines follow the Codex vocabulary: countdown by default.
    expect(screen.getByText('2 小时 18 分钟后重置')).toBeInTheDocument();
    expect(screen.getByText('5 天 6 小时后重置')).toBeInTheDocument();
    expect(screen.getByTestId('glm-wallet')).toBeInTheDocument();
    expect(screen.getByText('钱包余额')).toBeInTheDocument();
    expect(screen.getByText('¥ 42.60')).toBeInTheDocument();
    expect(screen.getByText('实验数据源')).toBeInTheDocument();
    expect(screen.getByText('今日钱包消费')).toBeInTheDocument();
    expect(screen.getByText('¥ 1.28')).toBeInTheDocument();
    expect(screen.getByText('估算')).toBeInTheDocument();
    expect(screen.getByText('估算')).toHaveClass('tag-estimate');
    // Real data: no frosted cover anywhere.
    expect(screen.queryByTestId('glm-quota-mask')).not.toBeInTheDocument();
    expect(screen.queryByTestId('glm-wallet-mask')).not.toBeInTheDocument();
  });

  it('covers an empty quota module with the frosted hint over placeholder data', () => {
    const withMissing = [
      metricOf({ key: 'quota.5h.used', value: null, unit: 'percent', direction: 'used', resetAt: '2026-09-10T10:18:45.000Z' }),
      glmMetrics[4]!
    ];
    renderGlm(snapshotOf([providerStateOf('glm', withMissing)]));

    // The quota module has nothing to show: the formal layout stays but is
    // filled with the placeholder windows, and the frosted hint goes on top.
    const mask = screen.getByTestId('glm-quota-mask');
    expect(mask).toHaveTextContent('暂无额度数据');
    expect(screen.getByText('5 小时额度')).toBeInTheDocument();
    expect(screen.getByText('28%')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByTestId('glm-quota-empty')).not.toBeInTheDocument();
    expect(screen.queryByText('套餐额度未返回')).not.toBeInTheDocument();
    // The wallet has data, so it is not covered and shows no placeholder rows.
    expect(screen.getByText('¥ 42.60')).toBeInTheDocument();
    expect(screen.queryByTestId('glm-wallet-mask')).not.toBeInTheDocument();
  });

  it('shows the wallet module only while its connection switch is on', () => {
    // The connection switch is the wallet module's only condition — one switch,
    // the same interaction the DeepSeek web usage module has. On it collects and
    // shows; off it is gone from the card, quota untouched.
    const view = renderGlm(snapshotOf([providerStateOf('glm', glmMetrics)]), { enabled: true });
    expect(screen.getByTestId('glm-wallet')).toBeInTheDocument();
    expect(screen.getByText('钱包余额')).toBeInTheDocument();

    view.rerender(
      <GlmCard
        view={providerView(snapshotOf([providerStateOf('glm', glmMetrics)]), 'glm')}
        quotaConfigured
        walletConfigured
        walletEnabled={false}
        {...cardProps}
        quotaDisplayMode="bar"
        quotaValueMode="used"
      />
    );
    expect(screen.queryByTestId('glm-wallet')).not.toBeInTheDocument();
    expect(screen.queryByText('钱包余额')).not.toBeInTheDocument();
    expect(screen.getByText('28%')).toBeInTheDocument();
  });

  it('covers a failing wallet that has no data and keeps the quota visible', () => {
    const quotaState = providerStateOf('glm', glmMetrics.slice(0, 2), { connection: { provider: 'glm', connection: 'quota' } });
    const walletState = failedStateOf(
      'glm',
      { kind: 'compatibility', message: 'GLM wallet response is incompatible', at: '2026-09-10T08:00:00.000Z' },
      { connection: { provider: 'glm', connection: 'wallet' } }
    );
    renderGlm(snapshotOf([quotaState, walletState]));

    expect(screen.getByText('28%')).toBeInTheDocument();
    // The failing wallet keeps its formal layout over placeholder data under
    // the frosted hint, which carries the localized failure.
    const mask = screen.getByTestId('glm-wallet-mask');
    expect(mask).toHaveTextContent('暂无钱包数据');
    expect(mask).not.toHaveTextContent('GLM wallet response is incompatible');
    expect(screen.getByTestId('glm-wallet')).toBeInTheDocument();
    expect(screen.getByText('钱包余额')).toBeInTheDocument();
  });

  it('covers a failing quota that has no data and keeps the wallet visible', () => {
    const quotaState = failedStateOf(
      'glm',
      { kind: 'authentication', message: 'GLM rejected the Coding Plan key', at: '2026-09-10T08:00:00.000Z' },
      { connection: { provider: 'glm', connection: 'quota' } }
    );
    const walletState = providerStateOf('glm', glmMetrics.slice(4), { connection: { provider: 'glm', connection: 'wallet' } });
    renderGlm(snapshotOf([quotaState, walletState]));

    expect(screen.getByText('¥ 42.60')).toBeInTheDocument();
    expect(screen.getByText('¥ 1.28')).toBeInTheDocument();
    // The empty quota module gets the frosted hint with the localized failure;
    // the formal window layout stays underneath over placeholder data.
    const mask = screen.getByTestId('glm-quota-mask');
    expect(mask).toHaveTextContent('暂无额度数据');
    expect(mask).not.toHaveTextContent('GLM rejected the Coding Plan key');
    expect(screen.getByText('5 小时额度')).toBeInTheDocument();
    expect(screen.queryByText('套餐额度未返回')).not.toBeInTheDocument();
    // The wallet has data, so it stays uncovered.
    expect(screen.queryByTestId('glm-wallet-mask')).not.toBeInTheDocument();
  });

  it('covers an unconfigured quota module with the frosted hint', () => {
    const state = failedStateOf('glm', {
      kind: 'missing_config',
      message: 'GLM Coding Plan API key is not configured',
      at: '2026-09-10T08:00:00.000Z'
    });
    renderGlm(snapshotOf([state]), { enabled: false });

    const mask = screen.getByTestId('glm-quota-mask');
    expect(mask).toHaveTextContent('配置 API Key 后显示额度');
    expect(mask).not.toHaveTextContent('需要配置');
    expect(mask).not.toHaveTextContent('GLM Coding Plan API key is not configured');
    // The formal layout stays underneath the frosted cover, with placeholder data.
    expect(screen.getByText('5 小时额度')).toBeInTheDocument();
    expect(screen.getByText('28%')).toBeInTheDocument();
    expect(screen.queryByText('套餐额度未返回')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument();
  });

  it('covers the wallet module with the frosted hint while no credential is configured', () => {
    // Enabled but unconfigured: the module keeps its layout and prompts for the
    // credential instead of vanishing, so the way to configure it stays visible.
    const quotaState = providerStateOf('glm', glmMetrics.slice(0, 2), { connection: { provider: 'glm', connection: 'quota' } });
    const walletState = failedStateOf(
      'glm',
      { kind: 'missing_config', message: 'the experimental GLM wallet credential is not configured', at: '2026-09-10T08:00:00.000Z' },
      { connection: { provider: 'glm', connection: 'wallet' } }
    );
    renderGlm(snapshotOf([quotaState, walletState]), { enabled: true });

    const mask = screen.getByTestId('glm-wallet-mask');
    expect(mask).toHaveTextContent('配置钱包凭据后显示用量');
    // The formal wallet layout stays underneath with placeholder values; the
    // neutral cover is the settings entry, without an additional link label.
    expect(screen.getByTestId('glm-wallet')).toBeInTheDocument();
    expect(screen.getByText('钱包余额')).toBeInTheDocument();
    expect(screen.getByText('¥ 42.60')).toBeInTheDocument();
    expect(screen.getByText('¥ 1.28')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument();
    // The quota connection is unaffected.
    expect(screen.getByText('28%')).toBeInTheDocument();
    expect(screen.queryByTestId('glm-quota-mask')).not.toBeInTheDocument();
  });

  it('never renders the cached readings of a switched-off wallet connection', () => {
    // Switching the experimental connection off stops collection but does not
    // erase what it collected: the last persisted reading is still published in
    // the snapshot. It must not reach the card either — the module is gone, so a
    // balance that can never change again cannot be mistaken for a live one.
    const cached = [
      metricOf({
        key: 'wallet.CNY.balance',
        value: 12.5,
        unit: 'CNY',
        direction: 'balance',
        confidence: ['experimental', 'stale'],
        connection: { provider: 'glm', connection: 'wallet' }
      }),
      metricOf({
        key: 'spend.CNY.daily',
        value: 9.75,
        unit: 'CNY',
        direction: 'spend',
        confidence: ['estimated'],
        details: { localDay: localDayIn(TIMEZONE, NOW) },
        connection: { provider: 'glm', connection: 'wallet' }
      })
    ];
    renderGlm(
      snapshotOf([
        providerStateOf('glm', glmMetrics.slice(0, 2), { connection: { provider: 'glm', connection: 'quota' } }),
        providerStateOf('glm', cached, { connection: { provider: 'glm', connection: 'wallet' } })
      ]),
      { enabled: false }
    );

    expect(screen.queryByTestId('glm-wallet')).not.toBeInTheDocument();
    expect(screen.queryByText('¥ 12.50')).not.toBeInTheDocument();
    expect(screen.queryByText('¥ 9.75')).not.toBeInTheDocument();
    expect(screen.queryByText('¥ 42.60')).not.toBeInTheDocument();
    // The wallet switch never touches the quota connection.
    expect(screen.getByText('28%')).toBeInTheDocument();
    expect(screen.queryByTestId('glm-quota-mask')).not.toBeInTheDocument();
  });

  it('toggles the whole GLM card between countdown and absolute time from any reset line', () => {
    const onToggle = vi.fn();
    const view = render(
      <GlmCard
        view={providerView(snapshotOf([providerStateOf('glm', glmMetrics.slice(0, 2), { connection: { provider: 'glm', connection: 'quota' } })]), 'glm')}
        quotaConfigured
        walletConfigured
        walletEnabled
        {...cardProps}
        quotaDisplayMode="bar"
        resetTimeFormat="countdown"
        onToggleResetTimeFormat={onToggle}
      />
    );
    // Both windows count down and share one format.
    expect(screen.getByText('2 小时 18 分钟后重置')).toBeInTheDocument();
    expect(screen.getByText('5 天 6 小时后重置')).toBeInTheDocument();
    // Clicking one line flips the whole card: the parent swaps the format.
    fireEvent.click(screen.getByText('5 天 6 小时后重置'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    view.rerender(
      <GlmCard
        view={providerView(snapshotOf([providerStateOf('glm', glmMetrics.slice(0, 2), { connection: { provider: 'glm', connection: 'quota' } })]), 'glm')}
        quotaConfigured
        walletConfigured
        walletEnabled
        {...cardProps}
        quotaDisplayMode="bar"
        resetTimeFormat="absolute"
        onToggleResetTimeFormat={onToggle}
      />
    );
    // 10:18:45Z is 18:18 in Asia/Shanghai; the weekly reset lands on 09 月 15 日.
    expect(screen.getByText('18:18 重置')).toBeInTheDocument();
    expect(screen.getByText('09 月 15 日 重置')).toBeInTheDocument();
  });
});

describe('DeepSeek balances and spend', () => {
  const deepSeekMetrics = [
    metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' }),
    metricOf({ key: 'wallet.USD.total', value: 12.05, unit: 'USD', direction: 'balance' }),
    metricOf({
      key: 'spend.CNY.daily',
      value: 3.58,
      unit: 'CNY',
      direction: 'spend',
      confidence: ['estimated', 'partial'],
      details: { localDay: localDayIn(TIMEZONE, NOW) }
    }),
    metricOf({
      key: 'spend.USD.daily',
      value: 0.42,
      unit: 'USD',
      direction: 'spend',
      confidence: ['estimated'],
      details: { localDay: localDayIn(TIMEZONE, NOW) }
    }),
    metricOf({
      key: 'wallet.CNY.granted',
      value: 0,
      unit: 'CNY',
      direction: 'balance'
    })
  ];

  it('keeps balances but hides estimated spend while web usage is off', () => {
    const snapshot = snapshotOf([providerStateOf('deepseek', deepSeekMetrics)]);
    render(<DeepSeekCard view={providerView(snapshot, 'deepseek')} {...cardProps} />);

    expect(screen.getByText('剩余余额（CNY）')).toBeInTheDocument();
    expect(screen.getByText('¥ 86.42')).toBeInTheDocument();
    expect(screen.getByText('剩余余额（USD）')).toBeInTheDocument();
    expect(screen.getByText(/12\.05/)).toBeInTheDocument();
    expect(screen.queryByText('今日消费（CNY）')).not.toBeInTheDocument();
    expect(screen.queryByText('¥ 3.58')).not.toBeInTheDocument();
    expect(screen.queryByText('今日消费（USD）')).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.42/)).not.toBeInTheDocument();
    expect(screen.queryByText(/估算/)).not.toBeInTheDocument();
    expect(screen.queryByText(/98\.47/)).not.toBeInTheDocument();
    expect(screen.queryByText(/4\.00/)).not.toBeInTheDocument();
  });

  it('keeps the balance module shaped while the key is not configured', () => {
    // The balance is the platform's own official answer to the API key, so an
    // unconfigured card keeps the module's formal layout under the frosted cover
    // instead of collapsing to a header with nothing on it. The identity arrives
    // the way the service really sends it — in `connections` alone, because a
    // connection that never succeeded has no snapshot to carry one.
    const unconfigured: DesktopProviderState = {
      provider: 'deepseek',
      error: { kind: 'missing_config', message: 'DeepSeek API key is not configured', at: '2026-09-10T08:00:00.000Z' },
      connections: [{ provider: 'deepseek', connection: 'wallet' }]
    };
    render(
      <DeepSeekCard view={providerView(snapshotOf([unconfigured]), 'deepseek')} {...cardProps} />
    );

    const module = screen.getByTestId('deepseek-balance');
    expect(module).toHaveTextContent('剩余余额');
    expect(module).toHaveTextContent('¥ 86.42');
    expect(module.className).toContain('is-covered');
    expect(screen.getByTestId('deepseek-balance-mask')).toHaveTextContent('配置 API Key 后显示余额');
  });

  it('shows only billed spend from an enabled and configured web connection', () => {
    const webDay = localDayIn(TIMEZONE, NOW);
    const webSource = 'deepseek-web-usage';
    const snapshot = snapshotOf([
      providerStateOf('deepseek', [
        ...deepSeekMetrics,
        metricOf({
          key: 'spend.CNY.daily.billed',
          value: 49.06,
          unit: 'CNY',
          direction: 'spend',
          confidence: ['experimental'],
          source: webSource,
          details: { localDay: webDay }
        }),
        metricOf({
          key: 'activity.daily.tokens',
          value: 667_259_844,
          unit: 'tokens',
          direction: 'activity',
          confidence: ['experimental'],
          source: webSource,
          details: { localDay: webDay }
        }),
        metricOf({
          key: 'activity.daily.requests',
          value: 2230,
          unit: 'requests',
          direction: 'activity',
          confidence: ['experimental'],
          source: webSource,
          details: { localDay: webDay }
        })
      ])
    ]);
    render(
      <DeepSeekCard view={providerView(snapshot, 'deepseek')} {...cardProps} webEnabled webConfigured />
    );

    // The web source owns this whole module. A currency missing from its billed
    // response is not filled from the balance-delta estimator — and the card says
    // nothing about the source being experimental: the connection is opted into on
    // its own settings page.
    expect(screen.getByText('¥ 49.06')).toBeInTheDocument();
    expect(screen.queryByText('实验数据源')).not.toBeInTheDocument();
    expect(screen.queryByText('实验功能')).not.toBeInTheDocument();
    expect(screen.queryByText(/估算/)).not.toBeInTheDocument();
    expect(screen.queryByText('今日消费（USD）')).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.42/)).not.toBeInTheDocument();
    // Tokens and requests from the same billed source pass the day gate.
    expect(screen.getByTestId('metric-deepseek-tokens')).toHaveTextContent('667.3 M');
    expect(screen.getByTestId('metric-deepseek-requests')).toHaveTextContent('2230');
  });

  it('selects billed spends and requests from the merged view', () => {
    const webDay = localDayIn(TIMEZONE, NOW);
    const snapshot = snapshotOf([
      providerStateOf('deepseek', [
        metricOf({
          key: 'spend.CNY.daily.billed',
          value: 49.06,
          unit: 'CNY',
          direction: 'spend',
          confidence: ['experimental'],
          source: 'deepseek-web-usage',
          details: { localDay: webDay }
        })
      ])
    ]);
    const view = providerView(snapshot, 'deepseek');

    expect(dailyBilledSpends(view).map((entry) => entry.currency)).toEqual(['CNY']);
    expect(dailyRequests(view)).toBeUndefined();
  });

  it('leaves no trace of the web connection while the feature is off', () => {
    // The service still reports the (disabled) experimental connection with its
    // configuration error; the card must render as if it did not exist. Its
    // identity arrives in `connections` alone, because a connection that never
    // succeeded has no snapshot to carry one.
    const webState: DesktopProviderState = {
      provider: 'deepseek',
      error: { kind: 'missing_config', message: 'the experimental DeepSeek web usage connection is disabled', at: '2026-09-10T08:00:00.000Z' },
      connections: [{ provider: 'deepseek', connection: 'web' }]
    };
    const snapshot = withoutConnection(
      snapshotOf([providerStateOf('deepseek', deepSeekMetrics), webState]),
      'deepseek',
      'web'
    );
    const view = providerView(snapshot, 'deepseek');
    expect(view.states).toHaveLength(1);
    render(<DeepSeekCard view={view} {...cardProps} />);

    // Balance remains useful; all web-only rows and reminders disappear.
    expect(screen.getByText('¥ 86.42')).toBeInTheDocument();
    expect(screen.queryByText(/估算/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('metric-deepseek-spend-CNY')).not.toBeInTheDocument();
    expect(screen.queryByText(/experimental DeepSeek web usage/)).not.toBeInTheDocument();
    expect(screen.queryByText('需要配置')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deepseek-web-mask')).not.toBeInTheDocument();
    expect(screen.queryByText('今日请求')).not.toBeInTheDocument();
  });

  it('never reads a never-succeeded web connection as the provider-wide state', () => {
    // With the switch on but no token stored, the web state is the only failure
    // the service reports and the only state that names its connection. It owns
    // no metrics and must not speak for the balance connection: the card's plan,
    // freshness and refresh verdict all read the provider-wide state.
    const webState: DesktopProviderState = {
      provider: 'deepseek',
      error: { kind: 'missing_config', message: 'the experimental DeepSeek web usage credential is not configured', at: '2026-09-10T08:05:00.000Z' },
      connections: [{ provider: 'deepseek', connection: 'web' }]
    };
    const balanceState = providerStateOf('deepseek', deepSeekMetrics);
    const view = providerView(snapshotOf([webState, balanceState]), 'deepseek');

    expect(view.primary).toBe(balanceState);
    expect(view.primary?.snapshot?.metrics).toHaveLength(deepSeekMetrics.length);
    expect(latestAttemptFailed(view)).toBe(false);
    // The web connection keeps its own identity, so the settings page can still
    // ask for that connection's state and report its own reason.
    expect(view.state('web')).toBe(webState);
    expect(view.error('web')?.message).toMatch(/credential is not configured/);
    expect(view.error()).toBeUndefined();
  });

  it('covers the billed area with the frosted placeholder while no token is stored', () => {
    const onOpenSettings = vi.fn();
    const webState = failedStateOf(
      'deepseek',
      { kind: 'missing_config', message: 'the experimental DeepSeek web usage credential is not configured', at: '2026-09-10T08:00:00.000Z' },
      { connection: { provider: 'deepseek', connection: 'web' } }
    );
    const snapshot = snapshotOf([
      providerStateOf('deepseek', [
        ...deepSeekMetrics,
        metricOf({
          key: 'spend.CNY.daily.billed',
          value: 49.06,
          unit: 'CNY',
          direction: 'spend',
          confidence: ['experimental'],
          source: 'deepseek-web-usage',
          details: { localDay: localDayIn(TIMEZONE, NOW) }
        })
      ]),
      webState
    ]);
    render(
      <DeepSeekCard
        view={providerView(snapshot, 'deepseek')}
        {...cardProps}
        webEnabled
        webConfigured={false}
        onOpenSettings={onOpenSettings}
      />
    );

    // GLM-style frosted placeholder instead of a configuration reminder block.
    const mask = screen.getByTestId('deepseek-web-mask');
    expect(mask).toBeInTheDocument();
    expect(mask).not.toHaveTextContent('需要配置');
    expect(mask).toHaveTextContent('配置网页 Token 后显示今日用量');
    fireEvent.click(mask);
    expect(onOpenSettings).toHaveBeenCalledWith('deepseek');
    expect(screen.getByTestId('deepseek-web')).toHaveClass('is-covered');
    expect(screen.queryByTestId('metric-deepseek-spend-CNY')).not.toBeInTheDocument();
    // The connection block form is banned on the main panel for this feature.
    expect(screen.queryByText('前往配置')).not.toBeInTheDocument();
    expect(screen.queryByText(/credential is not configured/)).not.toBeInTheDocument();
    expect(screen.queryByText(/估算/)).not.toBeInTheDocument();
    expect(screen.queryByText('¥ 49.06')).not.toBeInTheDocument();
  });

  it('does not print the generic missing-configuration status on a card without credentials', () => {
    const state = failedStateOf('deepseek', {
      kind: 'missing_config',
      message: '需要配置 DeepSeek API Key',
      at: '2026-09-10T08:00:00.000Z'
    });
    render(<DeepSeekCard view={providerView(snapshotOf([state]), 'deepseek')} {...cardProps} />);

    expect(screen.getByTestId('card-deepseek')).not.toHaveTextContent('需要配置');
    expect(screen.queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置 DeepSeek' })).toBeInTheDocument();
  });

  it('does not repeat a missing-configuration error beside cached card data', () => {
    const cached = providerStateOf('deepseek', [
      metricOf({ key: 'wallet.CNY.total', value: 45.34, unit: 'CNY', direction: 'balance' })
    ]);
    const state = failedStateOf(
      'deepseek',
      { kind: 'missing_config', message: '需要配置 DeepSeek API Key', at: '2026-09-10T08:00:00.000Z' },
      { snapshot: cached.snapshot }
    );
    render(<DeepSeekCard view={providerView(snapshotOf([state]), 'deepseek')} {...cardProps} />);

    expect(screen.getByText('¥ 45.34')).toBeInTheDocument();
    expect(screen.getByTestId('card-deepseek')).not.toHaveTextContent('需要配置');
  });

  it('renders a reliable zero instead of hiding it', () => {
    const snapshot = snapshotOf([
      providerStateOf('deepseek', [
        metricOf({ key: 'wallet.CNY.total', value: 0, unit: 'CNY', direction: 'balance' })
      ])
    ]);
    render(<DeepSeekCard view={providerView(snapshot, 'deepseek')} {...cardProps} />);

    expect(screen.getByText('¥ 0.00')).toBeInTheDocument();
  });
});

describe('shouldRenderMetric gate', () => {
  const base = { key: 'activity.daily.tokens', unit: 'tokens', direction: 'activity' as const, source: 'codex-app-server' };

  it('hides unsupported and unknown capabilities entirely', () => {
    expect(
      shouldRenderMetric(metricOf({ ...base, value: 42_000, capability: 'unsupported' }), GATE)
    ).toEqual({ render: false, reason: 'unsupported' });
    expect(shouldRenderMetric(metricOf({ ...base, value: 42_000, capability: 'unknown' }), GATE)).toEqual({
      render: false,
      reason: 'unknown'
    });
  });

  it('hides a missing value and renders a reliable zero', () => {
    expect(shouldRenderMetric(metricOf({ ...base, value: null }), GATE)).toEqual({
      render: false,
      reason: 'hidden-value'
    });
    expect(shouldRenderMetric(metricOf({ ...base, value: 0, capability: 'supported' }), GATE)).toEqual({
      render: true,
      stale: false
    });
    expect(shouldRenderMetric(undefined, GATE)).toEqual({ render: false, reason: 'absent' });
  });

  it('marks a same-day cached value as stale', () => {
    const metric = metricOf({
      ...base,
      value: 42_000,
      capability: 'supported',
      confidence: ['authoritative', 'stale'],
      scope: { localDay: GATE.localDay!, timezone: TIMEZONE, rangeConfirmed: true }
    });
    expect(shouldRenderMetric(metric, GATE)).toEqual({ render: true, stale: true });
  });

  it('hides a value from another day', () => {
    const metric = metricOf({
      ...base,
      value: 42_000,
      capability: 'supported',
      scope: { localDay: '2026-09-09', timezone: TIMEZONE, rangeConfirmed: true }
    });
    expect(shouldRenderMetric(metric, GATE)).toEqual({ render: false, reason: 'other-day' });
  });

  it('hides a range that was not confirmed to match today', () => {
    const metric = metricOf({
      ...base,
      value: 42_000,
      capability: 'supported',
      scope: { localDay: GATE.localDay!, timezone: TIMEZONE, rangeConfirmed: false }
    });
    expect(shouldRenderMetric(metric, { ...GATE, rangeRequired: true })).toEqual({
      render: false,
      reason: 'stale-range'
    });
  });

  it('hides a daily metric that carries no scope at all', () => {
    expect(shouldRenderMetric(metricOf({ ...base, value: 42_000 }), { ...GATE, rangeRequired: true })).toEqual({
      render: false,
      reason: 'missing-scope'
    });
    // Without the daily requirement an unscoped value is still renderable.
    expect(shouldRenderMetric(metricOf({ ...base, value: 42_000 }), GATE)).toEqual({ render: true, stale: false });
  });

  it('derives the day from details.localDay for the legacy shape', () => {
    const metric = metricOf({
      ...base,
      value: 12_000,
      details: { localDay: localDayIn(TIMEZONE, NOW) }
    });
    expect(shouldRenderMetric(metric, { ...GATE, rangeRequired: true }).render).toBe(true);
    const older = metricOf({ ...base, value: 12_000, details: { localDay: '2026-09-01' } });
    expect(shouldRenderMetric(older, { ...GATE, rangeRequired: true })).toEqual({ render: false, reason: 'other-day' });
  });
});

describe('local failures stay local', () => {
  it('leaves the other platforms visible when Codex fails to authenticate', async () => {
    const snapshot = snapshotOf([
      failedStateOf('codex', {
        kind: 'authentication',
        message: 'Codex is not signed in',
        at: '2026-09-10T08:00:00.000Z'
      }),
      providerStateOf('glm', [
        metricOf({ key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used', resetAt: '2026-09-10T10:18:45.000Z' }),
        metricOf({ key: 'quota.5h.remaining', value: 72, unit: 'percent', direction: 'remaining', resetAt: '2026-09-10T10:18:45.000Z' }),
        metricOf({ key: 'wallet.CNY.balance', value: 42.6, unit: 'CNY', direction: 'balance', confidence: ['experimental'] })
      ]),
      providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })])
    ]);
    const client = createFakeUsageClient({ snapshot });
    const host: PanelHostProps = { pinned: false, onTogglePin: noop, onRequestHide: noop, onSetHeight: noop };
    render(<PanelApp client={client} host={host} now={NOW} />);

    expect(await screen.findByRole('button', { name: '连接异常 1' })).toBeInTheDocument();
    expect(within(screen.getByTestId('card-codex')).queryByText('Codex is not signed in')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('card-glm')).getByRole('group', { name: '5 小时额度 剩余 72%' })).toBeInTheDocument();
    expect(screen.getByText('¥ 42.60')).toBeInTheDocument();
    expect(screen.getByText('¥ 86.42')).toBeInTheDocument();
    // The existing card gear remains; no failure-specific recovery entry is added.
    const codexCard = screen.getByTestId('card-codex');
    expect(within(codexCard).queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument();
    expect(within(codexCard).getByRole('button', { name: '配置 Codex' })).toBeInTheDocument();
  });

  it('hides only the Tokens row when that metric is unsupported', () => {
    renderCodex([
      fiveHour('2026-09-10T09:42:18.000Z'),
      weekly('2026-09-13T16:26:00.000Z'),
      metricOf({
        key: 'activity.daily.tokens',
        value: 42_000,
        unit: 'tokens',
        direction: 'activity',
        capability: 'unsupported'
      })
    ]);

    expect(screen.queryByText('今日 Tokens')).not.toBeInTheDocument();
    expect(screen.queryByText('42.0 K')).not.toBeInTheDocument();
    // The quota data stays on screen.
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('67')).toBeInTheDocument();
  });

  it('hides a Tokens value whose scope belongs to another day', () => {
    renderCodex([
      fiveHour('2026-09-10T09:42:18.000Z'),
      metricOf({
        key: 'activity.daily.tokens',
        value: 12_000,
        unit: 'tokens',
        direction: 'activity',
        capability: 'supported',
        scope: { localDay: '2026-09-09', timezone: TIMEZONE, rangeConfirmed: true }
      })
    ]);

    expect(screen.queryByText('今日 Tokens')).not.toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('shows Codex Tokens for the provider UTC day across the local midnight boundary', () => {
    const afterShanghaiMidnight = new Date('2026-09-10T16:30:00.000Z');
    const snapshot = snapshotOf([
      codexState([
        fiveHour('2026-09-10T18:00:00.000Z'),
        metricOf({
          key: 'activity.daily.tokens',
          value: 42_000,
          unit: 'tokens',
          direction: 'activity',
          capability: 'supported',
          scope: { localDay: '2026-09-10', timezone: 'UTC', rangeConfirmed: true }
        })
      ])
    ]);

    render(
      <CodexCard
        view={providerView(snapshot, 'codex')}
        {...cardProps}
        now={afterShanghaiMidnight}
        gate={{
          now: afterShanghaiMidnight,
          timezone: TIMEZONE,
          localDay: localDayIn(TIMEZONE, afterShanghaiMidnight)
        }}
      />
    );

    expect(screen.getByText('今日 Tokens')).toBeInTheDocument();
    expect(screen.getByText('42.0 K')).toBeInTheDocument();
  });

  it('shows a stale Tokens value with its marker', () => {
    renderCodex([
      fiveHour('2026-09-10T09:42:18.000Z'),
      metricOf({
        key: 'activity.daily.tokens',
        value: 42_000,
        unit: 'tokens',
        direction: 'activity',
        capability: 'supported',
        confidence: ['authoritative', 'stale'],
        scope: { localDay: localDayIn(TIMEZONE, NOW), timezone: TIMEZONE, rangeConfirmed: true }
      })
    ]);

    expect(screen.getByText('今日 Tokens')).toBeInTheDocument();
    expect(screen.getByText('42.0 K')).toBeInTheDocument();
    // A cached reading keeps its number and says nothing about being old: the panel
    // shows the value, not a notice beside it.
    expect(screen.queryByText(/数据已过期/)).toBeNull();
  });

  it('shows a degraded snapshot as cached data instead of hiding it', async () => {
    const staleSnapshot = providerStateOf(
      'deepseek',
      [metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance', confidence: ['authoritative', 'stale'] })],
      { status: 'degraded' }
    );
    const state = {
      ...staleSnapshot,
      error: { kind: 'network' as const, message: 'DeepSeek balance request failed', at: '2026-09-10T08:05:00.000Z' }
    };
    const client = createFakeUsageClient({ snapshot: snapshotOf([state]) });
    const host: PanelHostProps = { pinned: false, onTogglePin: noop, onRequestHide: noop, onSetHeight: noop };
    render(<PanelApp client={client} host={host} now={NOW} />);

    expect(await screen.findByText('¥ 86.42')).toBeInTheDocument();
    // The cached balance is shown, and the state that made it stale is named by the
    // failure itself rather than by a notice about time passing.
    expect(screen.getAllByText(/网络异常/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/数据已过期/)).toBeNull();
  });
});

// The verdict a refresh message is built from. The panel never learns the outcome
// from the refresh reply (the service acknowledges without one), so it reads the
// state the service published — and it has to agree with the card's status word,
// which is built from the same two facts.
describe('the verdict of a manual refresh', () => {
  it('reads a fresh success as an update', () => {
    const state = providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })]);

    expect(latestAttemptFailed(providerView(snapshotOf([state]), 'deepseek'))).toBe(false);
  });

  it('reads an error newer than the last success as a failure', () => {
    const cached = providerStateOf(
      'glm',
      [metricOf({ key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used' })],
      { capturedAt: '2026-09-10T08:00:00.000Z' }
    );
    const state = failedStateOf(
      'glm',
      { kind: 'authentication', message: 'GLM rejected the key', at: '2026-09-10T08:05:00.000Z' },
      { snapshot: cached.snapshot }
    );

    expect(latestAttemptFailed(providerView(snapshotOf([state]), 'glm'))).toBe(true);
  });

  it('does not hold an old failure against a newer success', () => {
    // A platform that failed an hour ago and succeeded now is an update: the error
    // is in the state, but the capture that came after it is what counts.
    const state = {
      ...providerStateOf('codex', [metricOf({ key: 'codex.primary.used', value: 42, unit: 'percent', direction: 'used' })], {
        capturedAt: '2026-09-10T08:30:00.000Z'
      }),
      error: { kind: 'network' as const, message: 'temporary', at: '2026-09-10T08:05:00.000Z' }
    };

    expect(latestAttemptFailed(providerView(snapshotOf([state]), 'codex'))).toBe(false);
  });

  it('reads a connection with no successful capture at all as a failure', () => {
    const state = failedStateOf('glm', { kind: 'missing_config', message: 'no key', at: '2026-09-10T08:05:00.000Z' });

    expect(latestAttemptFailed(providerView(snapshotOf([state]), 'glm'))).toBe(true);
  });

  it('reads a platform that published nothing as a failure', () => {
    // Nothing came back for it, so there is no card content to call an update.
    expect(latestAttemptFailed(providerView(snapshotOf([]), 'deepseek'))).toBe(true);
  });

  it('judges GLM by its quota connection, like the card does', () => {
    // The wallet is the experimental second connection: its failure must not turn
    // the platform's refresh verdict into a failure when the quota came back.
    const quota = providerStateOf(
      'glm',
      [metricOf({ key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used' })],
      { connection: { provider: 'glm', connection: 'quota' }, capturedAt: '2026-09-10T08:10:00.000Z' }
    );
    const wallet = failedStateOf(
      'glm',
      { kind: 'compatibility', message: 'wallet response is incompatible', at: '2026-09-10T08:10:01.000Z' },
      { connection: { provider: 'glm', connection: 'wallet' } }
    );

    expect(latestAttemptFailed(providerView(snapshotOf([quota, wallet]), 'glm'))).toBe(false);
  });
});

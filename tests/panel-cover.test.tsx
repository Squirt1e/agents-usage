// @vitest-environment jsdom
// The wiring behind the frosted cover. `panel.css` hides the placeholder values
// by blurring the *content* a cover sits on (`.is-covered > :not(.frost-hint)`),
// because a `backdrop-filter` is sampled late — or not at all — for a cover that
// mounts inside an animating card, which is exactly what returning from a
// settings page does. That rule does nothing unless the card marks the module,
// and this file says which module is marked when:
//   - placeholder columns -> marked, so the fake 28% / 16% pair is blurred,
//   - real columns, cached readings included -> not marked, so a real reading is
//     never dimmed as if it were a lie,
//   - the wallet block follows the same rule with its placeholder balances.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GlmCard } from '../src/desktop/GlmCard';
import { failedStateOf, metricOf, providerStateOf, snapshotOf } from '../src/desktop/fake-client';
import { providerView } from '../src/desktop/metrics';
import type { ProviderId } from '../src/shared/contracts';
import { localDayIn, type PanelSnapshot } from '../src/shared/desktop-contract';

const NOW = new Date('2026-09-10T08:00:00.000Z');
const TIMEZONE = 'Asia/Shanghai';
const noop = () => undefined;

function renderGlm(
  providers: Parameters<typeof snapshotOf>[0],
  options: {
    walletVisible?: boolean;
    walletEnabled?: boolean;
    onOpenSettings?(provider: ProviderId): void;
  } = {}
) {
  const snapshot: PanelSnapshot = snapshotOf(providers);
  render(
    <GlmCard
      view={providerView(snapshot, 'glm')}
      now={NOW}
      gate={{ now: NOW, timezone: TIMEZONE, localDay: localDayIn(TIMEZONE, NOW) }}
      quotaDisplayMode="ring"
      quotaValueMode="used"
      resetTimeFormat="countdown"
      walletVisible={options.walletVisible ?? false}
      walletEnabled={options.walletEnabled ?? false}
      onOpenSettings={options.onOpenSettings ?? noop}
      onToggleResetTimeFormat={noop}
      onToggleQuotaDisplay={noop}
      registerGear={noop}
    />
  );
}

const quotaMetrics = [
  metricOf({
    key: 'quota.5h.used',
    value: 63,
    unit: 'percent',
    direction: 'used',
    resetAt: '2026-09-10T10:18:45.000Z',
    connection: { provider: 'glm', connection: 'quota' }
  }),
  metricOf({
    key: 'quota.weekly.used',
    value: 41,
    unit: 'percent',
    direction: 'used',
    resetAt: '2026-09-15T14:12:00.000Z',
    connection: { provider: 'glm', connection: 'quota' }
  })
];

const walletMetrics = [
  metricOf({
    key: 'wallet.CNY.balance',
    value: 12.5,
    unit: 'CNY',
    direction: 'balance',
    confidence: ['experimental'],
    connection: { provider: 'glm', connection: 'wallet' }
  })
];

/** The same connections as `providerStateOf` sees when everything is configured. */
const configured = (metrics: ReturnType<typeof metricOf>[]) =>
  [
    providerStateOf('glm', metrics.slice(0, 2), { connection: { provider: 'glm', connection: 'quota' } }),
    providerStateOf('glm', metrics.slice(2), { connection: { provider: 'glm', connection: 'wallet' } })
  ] as Parameters<typeof snapshotOf>[0];

const quotaList = () => screen.getByTestId('glm-quota-list');

describe('frosted cover wiring', () => {
  it('blurs the quota columns only while they are placeholders', () => {
    // No credential at all: the columns fall back to the frozen 28% / 16% pair,
    // so the module is marked and the cover sits inside it.
    const unconfigured = failedStateOf('glm', {
      kind: 'missing_config',
      message: 'GLM Coding Plan API key is not configured',
      at: '2026-09-10T08:00:00.000Z'
    });
    renderGlm([unconfigured]);
    expect(quotaList().className).toContain('is-covered');
    expect(quotaList().querySelector('.frost-hint')).not.toBeNull();
    expect(quotaList()).toHaveTextContent('28%');
  });

  it('opens GLM settings from an unconfigured quota cover', () => {
    const onOpenSettings = vi.fn();
    const unconfigured = failedStateOf('glm', {
      kind: 'missing_config',
      message: 'GLM Coding Plan API key is not configured',
      at: '2026-09-10T08:00:00.000Z'
    });
    renderGlm([unconfigured], { onOpenSettings });

    const cover = screen.getByRole('button', { name: '配置 API Key 后显示额度' });
    fireEvent.click(cover);

    expect(onOpenSettings).toHaveBeenCalledWith('glm');
    expect(cover).not.toHaveTextContent('GLM Coding Plan API key is not configured');
    expect(cover).not.toHaveTextContent('需要配置');
  });

  it('leaves real quota columns uncovered', () => {
    renderGlm(configured([...quotaMetrics, ...walletMetrics]), { walletVisible: true });
    expect(quotaList().className).not.toContain('is-covered');
    expect(quotaList().querySelector('.frost-hint')).toBeNull();
    expect(quotaList()).toHaveTextContent('63%');
  });

  it('marks the wallet block only while it shows placeholder money', () => {
    // Quota is real; the wallet connection has produced nothing yet, so the block
    // shows the placeholder balances and must be covered.
    renderGlm(configured([...quotaMetrics]), { walletVisible: true, walletEnabled: false });
    const wallet = screen.getByTestId('glm-wallet');
    expect(wallet.className).toContain('is-covered');
    expect(wallet.querySelector('.frost-hint')).not.toBeNull();
    expect(wallet).toHaveTextContent('¥ 42.60');
  });

  it('opens GLM settings from a disabled wallet cover', () => {
    const onOpenSettings = vi.fn();
    renderGlm(configured([...quotaMetrics]), {
      walletVisible: true,
      walletEnabled: false,
      onOpenSettings
    });

    const cover = screen.getByRole('button', { name: '启用后显示钱包用量' });
    fireEvent.click(cover);

    expect(onOpenSettings).toHaveBeenCalledWith('glm');
  });

  it('covers the wallet once its connection switch is turned off, reading or not', () => {
    // The service stops collecting when the switch goes off but keeps publishing
    // the reading it persisted while the connection was on. A balance rendered
    // from that would never change again, and the switch would look inert — so the
    // module has to fall back to its placeholder cover, real reading or not.
    renderGlm(configured([...quotaMetrics, ...walletMetrics]), { walletVisible: true, walletEnabled: false });

    const wallet = screen.getByTestId('glm-wallet');
    expect(wallet.className).toContain('is-covered');
    expect(wallet).not.toHaveTextContent('¥ 12.50');
    expect(wallet).toHaveTextContent('¥ 42.60');
    expect(screen.getByTestId('glm-wallet-mask')).toHaveTextContent('启用后显示钱包用量');
  });

  it('leaves a wallet with real balances uncovered', () => {
    renderGlm(configured([...quotaMetrics, ...walletMetrics]), { walletVisible: true, walletEnabled: true });
    const wallet = screen.getByTestId('glm-wallet');
    expect(wallet.className).not.toContain('is-covered');
    expect(wallet.querySelector('.frost-hint')).toBeNull();
    expect(wallet).toHaveTextContent('¥ 12.50');
  });
});

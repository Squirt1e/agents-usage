// @vitest-environment jsdom
// The peak/off-peak reminder on its user-facing surfaces (add-peak-window-reminder):
// the card row (present with a schedule, absent without one, never under a frost
// cover), the countdown wording, the per-provider settings block (builtin readout,
// custom editor validation, off persistence) and the crossing toast (first sight
// stays quiet, an observed flip says exactly one line).
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelApp, type PanelHostProps } from '../src/desktop/PanelApp';
import {
  createFakeUsageClient,
  defaultPanelSettings,
  metricOf,
  providerStateOf,
  snapshotOf
} from '../src/desktop/fake-client';
import { providerView } from '../src/desktop/metrics';
import { DeepSeekCard } from '../src/desktop/DeepSeekCard';
import { GlmCard } from '../src/desktop/GlmCard';
import { localDayIn, type PanelSettings, type PanelSnapshot } from '../src/shared/desktop-contract';

/** A Thursday: 09:30 in Shanghai (inside the morning peak window). */
const NOW = new Date('2026-09-10T01:30:00.000Z');
/** The same Thursday at 12:30 Shanghai: the lunch off-peak between the windows. */
const NOW_OFFPEAK = new Date('2026-09-10T04:30:00.000Z');
const TIMEZONE = 'Asia/Shanghai';
const noop = () => undefined;

function deepseekSnapshot(): PanelSnapshot {
  return snapshotOf([
    providerStateOf('deepseek', [
      metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })
    ])
  ]);
}

function settingsWith(patch: Partial<PanelSettings> = {}): PanelSettings {
  return defaultPanelSettings(patch);
}

describe('the card period row', () => {
  it('marks the card with the period and names the next boundary in the corner', () => {
    const snapshot = deepseekSnapshot();
    render(
      <DeepSeekCard
      balanceConfigured
      webEnabled={false}
      webConfigured={false}
        view={providerView(snapshot, 'deepseek')}
        now={NOW}
        gate={{ now: NOW, timezone: TIMEZONE, localDay: localDayIn(TIMEZONE, NOW) }}
        peak={{ period: 'peak', boundaryClock: '18:00' }}
        onOpenSettings={noop}
      />
    );
    const card = screen.getByTestId('card-deepseek');
    expect(card.getAttribute('data-period')).toBe('peak');
    const corner = card.querySelector('.peak-corner');
    expect(corner?.textContent).toBe('高峰 · 18:00');
    // No dedicated row anymore: the presentation lives on the frame.
    expect(screen.queryByText(/距错峰/)).toBeNull();
  });

  it('never renders for a provider without a schedule', () => {
    const snapshot = deepseekSnapshot();
    render(
      <DeepSeekCard
      balanceConfigured
      webEnabled={false}
      webConfigured={false}
        view={providerView(snapshot, 'deepseek')}
        now={NOW}
        gate={{ now: NOW, timezone: TIMEZONE, localDay: localDayIn(TIMEZONE, NOW) }}
        onOpenSettings={noop}
      />
    );
    expect(screen.getByTestId('card-deepseek').getAttribute('data-period')).toBeNull();
    expect(document.querySelector('.peak-corner')).toBeNull();
  });

  it('removes every card presentation while the active schedule is off-peak', () => {
    const snapshot = deepseekSnapshot();
    render(
      <DeepSeekCard
        balanceConfigured
        webEnabled={false}
        webConfigured={false}
        view={providerView(snapshot, 'deepseek')}
        now={NOW_OFFPEAK}
        gate={{ now: NOW_OFFPEAK, timezone: TIMEZONE, localDay: localDayIn(TIMEZONE, NOW_OFFPEAK) }}
        peak={{ period: 'offpeak', boundaryClock: '14:00' }}
        onOpenSettings={noop}
      />
    );

    const card = screen.getByTestId('card-deepseek');
    expect(card.getAttribute('data-period')).toBeNull();
    const corner = card.querySelector('.peak-corner');
    expect(corner).not.toBeNull();
    expect(corner).toHaveAttribute('aria-hidden', 'true');
  });

  it('is not inside a frosted cover even when the card module under it is', () => {
    // The GLM card is the covered case (placeholder columns). The corner lives
    // in the card header, never a cover child: local clock data has nothing to
    // hide.
    const glmSnapshot = snapshotOf([providerStateOf('glm', [])]);
    render(
      <GlmCard
        view={providerView(glmSnapshot, 'glm')}
        now={NOW}
        gate={{ now: NOW, timezone: TIMEZONE, localDay: localDayIn(TIMEZONE, NOW) }}
        peak={{ period: 'peak', boundaryClock: '12:00' }}
        quotaDisplayMode="ring"
        quotaValueMode="used"
        resetTimeFormat="countdown"
        quotaConfigured
        walletEnabled
        walletConfigured
        onOpenSettings={noop}
        onToggleResetTimeFormat={noop}
        onToggleQuotaDisplay={noop}
        registerGear={noop}
      />
    );
    const corner = document.querySelector('.peak-corner');
    expect(corner).not.toBeNull();
    expect(corner!.closest('.is-covered')).toBeNull();
  });
});

describe('the settings block', () => {
  async function renderSettings(provider: 'codex' | 'glm' | 'deepseek', settings: PanelSettings) {
    const client = createFakeUsageClient({ snapshot: deepseekSnapshot(), settings });
    const host: PanelHostProps = { pinned: false, onTogglePin: vi.fn(), onRequestHide: vi.fn(), onSetHeight: vi.fn() };
    render(<PanelApp client={client} host={host} now={NOW} />);
    fireEvent.click(await screen.findByRole('button', { name: `配置 ${provider === 'codex' ? 'Codex' : provider === 'glm' ? 'GLM' : 'DeepSeek'}` }));
    await screen.findByTestId(`peak-settings-${provider}`);
    return client;
  }

  it('offers 内置/自定义/关闭 for a provider with a builtin table, defaulting to 关闭', async () => {
    await renderSettings('deepseek', settingsWith());
    const block = screen.getByTestId('peak-settings-deepseek');
    const group = within(block).getByRole('group', { name: '时段来源' });
    expect(group.querySelectorAll('.segmented-slider')).toHaveLength(1);
    const modes = within(group).getAllByRole('button');
    expect(modes.map((button) => button.textContent)).toEqual(['内置时段', '自定义', '关闭']);
    expect(
      modes.map((button) => button.getAttribute('aria-pressed'))
    ).toEqual(['false', 'false', 'true']);
    // Default off: the builtin readout appears only once the user picks it.
    expect(block.textContent).not.toContain('核实于 2026-09-11');
    fireEvent.click(within(block).getByRole('button', { name: '内置时段' }));
    expect(block.textContent).toContain('DeepSeek 官方定价页');
    expect(block.textContent).toContain('核实于 2026-09-11');
    expect(block.textContent).toContain('09:00 – 12:00');
  });

  it('offers only 自定义/关闭 for a provider without one', async () => {
    await renderSettings('codex', settingsWith());
    const block = screen.getByTestId('peak-settings-codex');
    const group = within(block).getByRole('group', { name: '时段来源' });
    const modes = within(group).getAllByRole('button');
    expect(modes.map((button) => button.textContent)).toEqual(['自定义', '关闭']);
    expect(modes.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('persists 关闭 immediately and keeps the stored schedule', async () => {
    const stored = {
      deepseek: {
        mode: 'custom' as const,
        windows: [{ weekdays: [1], start: '22:00', end: '01:00' }],
        timezone: 'Asia/Shanghai'
      }
    };
    const client = await renderSettings('deepseek', settingsWith({ peakReminder: stored }));
    const block = screen.getByTestId('peak-settings-deepseek');
    fireEvent.click(within(block).getByRole('button', { name: '关闭' }));
    const patches = client.methodCalls('updateSettings') as Array<Array<{ peakReminder: Record<string, { mode: string; windows?: unknown[]; timezone?: string }> }>>;
    const last = patches[patches.length - 1]![0]!.peakReminder!.deepseek!;
    expect(last.mode).toBe('off');
    // The custom schedule rides along inert: switching back must restore it.
    expect(last.windows).toEqual([{ weekdays: [1], start: '22:00', end: '01:00' }]);
  });

  it('blocks an unusable custom schedule with an inline reason', async () => {
    const client = await renderSettings('deepseek', settingsWith());
    const block = screen.getByTestId('peak-settings-deepseek');
    fireEvent.click(within(block).getByRole('button', { name: '自定义' }));
    // No rows yet: saving is blocked with the reason, nothing is written.
    fireEvent.click(within(block).getByRole('button', { name: '保存' }));
    expect(screen.getByRole('alert').textContent).toContain('至少需要一条时段');
    expect(client.methodCalls('updateSettings')).toHaveLength(0);

    fireEvent.click(within(block).getByRole('button', { name: '添加时段' }));
    expect(within(block).getByRole('group', { name: '第 1 条时段的星期' }).querySelector('.segmented-slider')).toBeNull();
    const timezone = screen.getByLabelText('判定时区') as HTMLInputElement;
    fireEvent.change(timezone, { target: { value: 'Not/AZone' } });
    fireEvent.click(within(block).getByRole('button', { name: '保存' }));
    expect(screen.getByRole('alert').textContent).toContain('时区无法解析');
    expect(client.methodCalls('updateSettings')).toHaveLength(0);
  });

  it('saves a valid custom schedule through the settings patch', async () => {
    const client = await renderSettings('codex', settingsWith());
    const block = screen.getByTestId('peak-settings-codex');
    fireEvent.click(within(block).getByRole('button', { name: '自定义' }));
    fireEvent.click(within(block).getByRole('button', { name: '添加时段' }));
    // The seeded row is Mon–Fri 09:00–18:00; shrink it to one hour and save.
    fireEvent.change(screen.getByLabelText('第 1 条时段结束'), { target: { value: '10:00' } });
    fireEvent.click(within(block).getByRole('button', { name: '保存' }));
    await screen.findByText('已保存自定义时段');
    const patches = client.methodCalls('updateSettings') as Array<Array<{ peakReminder: Record<string, { mode: string; windows: Array<{ start: string; end: string; weekdays: number[] }>; timezone: string }> }>>;
    const codex = patches[patches.length - 1]![0]!.peakReminder!.codex!;
    expect(codex.mode).toBe('custom');
    expect(codex.timezone).toBe(TIMEZONE);
    expect(codex.windows).toEqual([{ weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '10:00' }]);
  });
});

describe('the crossing toast', () => {
  it('shows nothing at all while the reminder has never been chosen', async () => {
    const client = createFakeUsageClient({ snapshot: deepseekSnapshot(), settings: settingsWith() });
    const host: PanelHostProps = { pinned: false, onTogglePin: vi.fn(), onRequestHide: vi.fn(), onSetHeight: vi.fn() };
    const view = render(<PanelApp client={client} host={host} now={NOW} />);
    await screen.findByTestId('card-deepseek');
    // Default off: no period presentation on the card, no announcements, and
    // the clock crossing a boundary of the unchosen builtin table says nothing.
    expect(screen.getByTestId('card-deepseek').getAttribute('data-period')).toBeNull();
    view.rerender(<PanelApp client={client} host={host} now={NOW_OFFPEAK} />);
    expect(screen.queryByText(/已进入/)).toBeNull();
  });

  it('stays quiet on first sight and announces exactly one observed flip', async () => {
    const client = createFakeUsageClient({
      snapshot: deepseekSnapshot(),
      settings: settingsWith({ peakReminder: { deepseek: { mode: 'builtin' } } })
    });
    const host: PanelHostProps = { pinned: false, onTogglePin: vi.fn(), onRequestHide: vi.fn(), onSetHeight: vi.fn() };
    const view = render(<PanelApp client={client} host={host} now={NOW} />);
    // First observation of the peak: nothing to announce, but the card carries it.
    await screen.findByTestId('card-deepseek');
    expect(screen.getByTestId('card-deepseek').getAttribute('data-period')).toBe('peak');
    expect(screen.queryByText(/已进入/)).toBeNull();

    // The clock moves into the lunch off-peak: one line, carrying the note.
    view.rerender(<PanelApp client={client} host={host} now={NOW_OFFPEAK} />);
    expect(await screen.findByText('DeepSeek 已进入错峰时段（错峰半价计费）')).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
// The peak/off-peak reminder on its user-facing surfaces (add-peak-window-reminder):
// the card row (present with a schedule, absent without one, never under a frost
// cover), the countdown wording, the per-provider settings block (builtin readout,
// custom editor validation, off persistence) and the crossing toast (first sight
// stays quiet, an observed flip says exactly one line).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelApp, type PanelHostProps } from '../../src/desktop/panel/PanelApp';
import {
  createFakeUsageClient,
  defaultPanelSettings,
  metricOf,
  providerStateOf,
  snapshotOf
} from '../../src/desktop/lib/fake-client';
import { providerView } from '../../src/desktop/lib/metrics';
import { PEAK_ROW_EXIT_MS } from '../../src/desktop/settings/ProviderSettings';
import { SettingsWindowHarness } from '../helpers/windows';
import { DeepSeekCard } from '../../src/desktop/panel/DeepSeekCard';
import { GlmCard } from '../../src/desktop/panel/GlmCard';
import { localDayIn, type PanelSettings, type PanelSnapshot } from '../../src/shared/desktop-contract';

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
  // The peak schedule is a platform setting, so its form lives in that platform's
  // section of the settings window — the same wiring the window itself uses.
  async function renderSettings(provider: 'codex' | 'glm' | 'deepseek', settings: PanelSettings) {
    const client = createFakeUsageClient({ snapshot: deepseekSnapshot(), settings });
    render(<SettingsWindowHarness client={client} section={provider} />);
    // The window reads its settings from the client on mount, and the *stored* theme
    // reaching the document is that read having landed. Waiting on it is not
    // belt-and-braces: the peak editor seeds its draft (windows, timezone) from the
    // settings on its first render, so a form mounted before the read finishes would
    // hold the parser's defaults and save *those* — the timezone default is `UTC`, and
    // a test that started editing early would be the one that noticed.
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme'));
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

// The editor's own behaviour (refine-peak-window-editor): what it reads back
// before anything is saved. This window renders while its first settings read is
// still in flight, so every one of these starts from a *stored* schedule — the
// case that used to arrive empty.
describe('the custom window editor', () => {
  async function renderStored(
    provider: 'codex' | 'glm' | 'deepseek',
    windows: Array<{ weekdays: number[]; start: string; end: string }>
  ) {
    const client = createFakeUsageClient({
      snapshot: deepseekSnapshot(),
      settings: settingsWith({
        peakReminder: { [provider]: { mode: 'custom' as const, windows, timezone: TIMEZONE } }
      })
    });
    render(<SettingsWindowHarness client={client} section={provider} />);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme'));
    const block = await screen.findByTestId(`peak-settings-${provider}`);
    return { client, block };
  }

  const rowsOf = (block: HTMLElement) => Array.from(block.querySelectorAll('.peak-window-item'));

  it('fills the editor from the stored schedule instead of coming up empty', async () => {
    const { block } = await renderStored('deepseek', [{ weekdays: [1, 2, 3], start: '22:00', end: '01:00' }]);
    // The mode is the reader's stored choice, not the default 关闭: it used to be
    // seeded once from the settings that were on screen at mount, which are the
    // parser's defaults while the read is in flight.
    await waitFor(() =>
      expect(within(block).getByRole('button', { name: '自定义' })).toHaveAttribute('aria-pressed', 'true')
    );
    await waitFor(() => expect(rowsOf(block)).toHaveLength(1));
    expect(screen.getByLabelText('第 1 条时段开始')).toHaveValue('22:00');
    expect(screen.getByLabelText('第 1 条时段结束')).toHaveValue('01:00');
    expect(within(block).getByRole('button', { name: '周一' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(block).getByRole('button', { name: '周四' })).toHaveAttribute('aria-pressed', 'false');
    // Nothing has been touched, so there is nothing to write.
    expect(within(block).getByRole('button', { name: '保存' })).toBeDisabled();
    expect(block.textContent).toContain('已保存');
  });

  it('marks a window that runs past midnight on the row itself', async () => {
    const { block } = await renderStored('codex', [
      { weekdays: [1], start: '09:00', end: '18:00' },
      { weekdays: [6], start: '22:00', end: '02:00' }
    ]);
    await waitFor(() => expect(rowsOf(block)).toHaveLength(2));
    const [daily, overnight] = rowsOf(block).map((row) => row.querySelector('.peak-window-card')!);
    expect(overnight!.className).toContain('is-overnight');
    expect(daily!.className).not.toContain('is-overnight');
  });

  it('steps a time with the arrow keys, in minutes and in hours', async () => {
    const { block } = await renderStored('codex', [{ weekdays: [1], start: '09:00', end: '10:00' }]);
    await waitFor(() => expect(rowsOf(block)).toHaveLength(1));
    const start = screen.getByLabelText('第 1 条时段开始');
    fireEvent.keyDown(start, { key: 'ArrowUp' });
    expect(start).toHaveValue('09:01');
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    expect(start).toHaveValue('08:01');
    // Wraps inside the day rather than leaving `HH:mm`.
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(start, { key: 'ArrowDown', shiftKey: true });
    expect(start).toHaveValue('23:01');
    // A stepped field is an edit like any other.
    expect(screen.getByLabelText('第 1 条时段开始')).toHaveValue('23:01');
    expect(block.textContent).toContain('有未保存的改动');
  });

  it('plays the exit before dropping a window, and ends on the empty placeholder', async () => {
    const { block } = await renderStored('codex', [
      { weekdays: [1], start: '09:00', end: '10:00' },
      { weekdays: [2], start: '11:00', end: '12:00' }
    ]);
    await waitFor(() => expect(rowsOf(block)).toHaveLength(2));

    fireEvent.click(screen.getByLabelText('删除第 1 条时段'));
    // Still in the document, wearing the exit: leaving is a state, not an unmount.
    expect(rowsOf(block)).toHaveLength(2);
    expect(rowsOf(block)[0]!.className).toContain('is-leaving');
    await waitFor(() => expect(rowsOf(block)).toHaveLength(1), { timeout: PEAK_ROW_EXIT_MS + 500 });
    expect(screen.getByLabelText('第 1 条时段开始')).toHaveValue('11:00');

    fireEvent.click(screen.getByLabelText('删除第 1 条时段'));
    await waitFor(() => expect(rowsOf(block)).toHaveLength(0), { timeout: PEAK_ROW_EXIT_MS + 500 });
    expect(block.textContent).toContain('还没有时段，至少添加一条才能保存');
  });

  it('reads the draft back as the period it means, and refuses to guess at a half-typed one', async () => {
    const { block } = await renderStored('codex', [{ weekdays: [1], start: '00:00', end: '23:59' }]);
    const verdict = await screen.findByTestId('peak-verdict-codex');
    await waitFor(() => expect(['peak', 'offpeak']).toContain(verdict.getAttribute('data-period')));
    expect(verdict.textContent).toMatch(/现在 (高峰|错峰)/);

    // Clear the only day: the schedule can no longer answer, and the strip says so
    // rather than judging against the part that happens to be left.
    fireEvent.click(within(block).getByRole('button', { name: '周一' }));
    await waitFor(() => expect(verdict.getAttribute('data-period')).toBeNull());
    expect(verdict.textContent).toContain('时段不完整，无法判定');

    // Put it back and the judgement returns.
    fireEvent.click(within(block).getByRole('button', { name: '周一' }));
    await waitFor(() => expect(['peak', 'offpeak']).toContain(verdict.getAttribute('data-period')));
  });

  it('shows the same read-back for the builtin table, and names the zone it judged in', async () => {
    const client = createFakeUsageClient({
      snapshot: deepseekSnapshot(),
      settings: settingsWith({ peakReminder: { deepseek: { mode: 'builtin' } } })
    });
    render(<SettingsWindowHarness client={client} section="deepseek" />);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme'));
    await screen.findByTestId('peak-settings-deepseek');
    const verdict = await screen.findByTestId('peak-verdict-deepseek');
    await waitFor(() => expect(['peak', 'offpeak']).toContain(verdict.getAttribute('data-period')));
    // Only the custom editor carries the zone row; the builtin table brings its own.
    expect(screen.queryByLabelText('判定时区')).toBeNull();
  });

  it('turns the zone field to its failure tone while the name cannot be parsed', async () => {
    const { block } = await renderStored('codex', [{ weekdays: [1], start: '09:00', end: '10:00' }]);
    await waitFor(() => expect(rowsOf(block)).toHaveLength(1));
    const zone = screen.getByLabelText('判定时区');
    expect(zone.className).not.toContain('is-invalid');
    expect(block.textContent).toMatch(/该时区现在 \d{2}:\d{2}/);

    fireEvent.change(zone, { target: { value: 'Not/AZone' } });
    expect(zone.className).toContain('is-invalid');
    expect(zone).toHaveAttribute('aria-invalid', 'true');
    expect(block.textContent).toContain('无法解析');
    // The preview cannot judge without a zone either.
    expect(screen.getByTestId('peak-verdict-codex')).toHaveTextContent('时段不完整，无法判定');
  });
});

describe('the crossing toast', () => {
  it('shows nothing at all while the reminder has never been chosen', async () => {
    const client = createFakeUsageClient({ snapshot: deepseekSnapshot(), settings: settingsWith() });
    const host: PanelHostProps = { pinned: false, onTogglePin: vi.fn(), onRequestHide: vi.fn(), onSetHeight: vi.fn() };
    const view = render(<PanelApp client={client} host={host} now={NOW} onOpenSettings={() => undefined} />);
    await screen.findByTestId('card-deepseek');
    // Default off: no period presentation on the card, no announcements, and
    // the clock crossing a boundary of the unchosen builtin table says nothing.
    expect(screen.getByTestId('card-deepseek').getAttribute('data-period')).toBeNull();
    view.rerender(<PanelApp client={client} host={host} now={NOW_OFFPEAK} onOpenSettings={() => undefined} />);
    expect(screen.queryByText(/已进入/)).toBeNull();
  });

  it('stays quiet on first sight and announces exactly one observed flip', async () => {
    const client = createFakeUsageClient({
      snapshot: deepseekSnapshot(),
      settings: settingsWith({ peakReminder: { deepseek: { mode: 'builtin' } } })
    });
    const host: PanelHostProps = { pinned: false, onTogglePin: vi.fn(), onRequestHide: vi.fn(), onSetHeight: vi.fn() };
    const view = render(<PanelApp client={client} host={host} now={NOW} onOpenSettings={() => undefined} />);
    // First observation of the peak: nothing to announce, but the card carries it.
    await screen.findByTestId('card-deepseek');
    expect(screen.getByTestId('card-deepseek').getAttribute('data-period')).toBe('peak');
    expect(screen.queryByText(/已进入/)).toBeNull();

    // The clock moves into the lunch off-peak: one line, carrying the note.
    view.rerender(<PanelApp client={client} host={host} now={NOW_OFFPEAK} onOpenSettings={() => undefined} />);
    expect(await screen.findByText('DeepSeek 已进入错峰时段（错峰半价计费）')).toBeInTheDocument();
  });
});

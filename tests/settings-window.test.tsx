// @vitest-environment jsdom
// The settings window.
//
// Everything that used to be "the panel's settings pages" lives here now, and this
// file is the record of *why* it works the same way: one section at a time, the
// credential lifecycle (validate → replace → delete), the wallet display toggle
// versus disabling the experimental connection, and the drag ordering. What changed is
// the shell around it — a fixed window with a section column instead of pages swapped
// inside the panel — so the assertions moved with it rather than being rewritten.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlatformSettings } from '../src/desktop/PlatformSettings';
import {
  createFakeUsageClient,
  defaultPanelSettings,
  failedStateOf,
  metricOf,
  providerStateOf,
  snapshotOf
} from '../src/desktop/fake-client';
import { render } from '@testing-library/react';
import type { PanelSettings, PanelSnapshot } from '../src/shared/desktop-contract';
import type { ProviderId } from '../src/shared/contracts';
import { renderBothWindows, renderSettings } from './helpers/windows';

function panelSnapshot(): PanelSnapshot {
  return snapshotOf([
    providerStateOf('codex', [
      metricOf({
        key: 'codex.primary.used',
        value: 42,
        unit: 'percent',
        direction: 'used',
        windowSeconds: 18_000,
        resetAt: '2026-09-10T09:42:18.000Z'
      })
    ]),
    providerStateOf('glm', [
      metricOf({
        key: 'quota.5h.used',
        value: 28,
        unit: 'percent',
        direction: 'used',
        resetAt: '2026-09-10T10:18:45.000Z',
        connection: { provider: 'glm', connection: 'quota' }
      }),
      metricOf({
        key: 'wallet.CNY.balance',
        value: 42.6,
        unit: 'CNY',
        direction: 'balance',
        confidence: ['experimental'],
        connection: { provider: 'glm', connection: 'wallet' }
      })
    ]),
    providerStateOf('deepseek', [
      metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })
    ])
  ]);
}

/** A client with a realistic snapshot, for the sections that read connection state. */
function clientWith(settings: Partial<PanelSettings> = {}) {
  return createFakeUsageClient({ snapshot: panelSnapshot(), settings });
}

describe('the settings window and its sections', () => {
  it('lists every section, in order, on a column that does not scroll away', async () => {
    renderSettings();
    const nav = await screen.findByRole('tablist', { name: '设置分类' });

    expect(within(nav).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '▦平台管理',
      '◐外观',
      'CXCodex',
      'GLGLM',
      'DSDeepSeek'
    ]);
    // One scrolling area, and it is the content — the title bar belongs to the host
    // and the nav is a fixed column.
    expect(document.querySelector('.settings-content')).toBeInTheDocument();
    expect(nav.closest('.settings-content')).toBeNull();
  });

  it('opens on 平台管理, which is the setting users reach for most', async () => {
    renderSettings();
    expect(await screen.findByTestId('settings-pane-platforms')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '平台管理' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows only one section at a time, and never two platforms together', async () => {
    renderSettings({ client: clientWith(), section: 'glm' });
    const view = await screen.findByTestId('settings-glm');
    expect(within(view).getByLabelText('GLM Coding Plan API Key')).toBeInTheDocument();

    expect(screen.queryByTestId('settings-codex')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-deepseek')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
    // The platform manager is a section of its own and never mixes in credentials.
    expect(screen.queryByRole('checkbox', { name: '显示 Codex' })).not.toBeInTheDocument();
  });

  it('keeps 平台管理 free of credential forms', async () => {
    renderSettings({ client: clientWith(), section: 'platforms' });
    await screen.findByRole('checkbox', { name: '显示 Codex' });

    expect(screen.queryByLabelText('GLM Coding Plan API Key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
    expect(screen.queryByText('CLI 路径')).not.toBeInTheDocument();
  });

  it('moves between sections with the arrow keys, as one control', async () => {
    renderSettings({ client: clientWith() });
    const nav = await screen.findByRole('tablist', { name: '设置分类' });
    const platforms = within(nav).getByRole('tab', { name: '平台管理' });
    platforms.focus();

    fireEvent.keyDown(nav, { key: 'ArrowDown' });
    expect(await screen.findByTestId('settings-pane-appearance')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '外观' })).toHaveAttribute('aria-selected', 'true');
    // Roving focus: the next arrow key continues from where the reader is.
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '外观' }));

    fireEvent.keyDown(nav, { key: 'End' });
    expect(await screen.findByTestId('settings-pane-deepseek')).toBeInTheDocument();
  });

  it('follows a section request from the host without remounting the window', async () => {
    // One window serves every entry point: a second request moves the *section*, which
    // is why the host emits `panel://settings-section` rather than opening a window.
    let ask: ((section: never) => void) | undefined;
    renderSettings({
      client: clientWith(),
      onSelectSectionRequest: (listener) => {
        ask = listener as (section: never) => void;
        return () => undefined;
      }
    });
    await screen.findByTestId('settings-pane-platforms');

    ask!('glm' as never);
    expect(await screen.findByTestId('settings-pane-glm')).toBeInTheDocument();
  });

  it('says nothing to the host until its first render has settled', async () => {
    // The host holds the window hidden until this lands, so an empty first frame is
    // never what the user sees.
    const onReady = vi.fn();
    renderSettings({ client: clientWith(), onReady });
    await screen.findByTestId('settings-pane-platforms');
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));

    // And only once, whatever else re-renders afterwards.
    const { client } = renderSettings({ client: clientWith(), onReady });
    client.emit({ type: 'snapshot', snapshot: panelSnapshot() });
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
  });
});

describe('per-platform configuration', () => {
  it('shows Codex managed-login guidance and never a secret form', async () => {
    renderSettings({ client: clientWith(), section: 'codex' });
    const view = await screen.findByTestId('settings-codex');

    expect(within(view).getByRole('heading', { name: '账号连接' })).toBeInTheDocument();
    expect(within(view).queryByLabelText(/API Key/)).not.toBeInTheDocument();
    expect(within(view).getByLabelText('Codex CLI 绝对路径')).toBeInTheDocument();
  });

  it('saves an absolute Codex CLI path for Finder launches', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'codex' });
    await screen.findByTestId('settings-codex');

    const path = screen.getByLabelText('Codex CLI 绝对路径') as HTMLInputElement;
    fireEvent.change(path, { target: { value: '/opt/homebrew/bin/codex' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(client.methodCalls('updateSettings')).toEqual([[{ codexCliPath: '/opt/homebrew/bin/codex' }]])
    );
    expect(await screen.findByText('已保存 CLI 路径：/opt/homebrew/bin/codex')).toBeInTheDocument();
  });

  it('persists the GLM region without touching credentials', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'glm' });
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('button', { name: '国际区' }));

    await waitFor(() => expect(client.methodCalls('updateSettings')).toEqual([[{ glmRegion: 'international' }]]));
    expect(client.methodCalls('validateCredential')).toEqual([]);
    expect(client.methodCalls('deleteCredential')).toEqual([]);
  });

  it('saves a valid DeepSeek key, clears the input and shows only the mask', async () => {
    const settings = defaultPanelSettings();
    const client = clientWith({
      credentials: { ...settings.credentials, deepseek: { configured: false } }
    });
    renderSettings({ client, section: 'deepseek' });

    const input = (await screen.findByLabelText('DeepSeek API Key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-live-7788' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }));

    await waitFor(() => expect(client.methodCalls('validateCredential')).toHaveLength(1));
    expect(client.methodCalls('validateCredential')[0]).toEqual(['deepseek', 'sk-live-7788']);
    // The mask row *is* the confirmation: a save leaves the form looking exactly like
    // the same form at rest, with no extra sentence and no displaced delete button.
    expect(await screen.findByText('已保存 ····7788')).toBeInTheDocument();
    expect(screen.queryByText(/已验证并保存/)).not.toBeInTheDocument();
    expect(input.value).toBe('');
    // Collecting the platform is the host's job on this path (see
    // `panel_validate_credential` in lib.rs), so the window asks for no refresh.
    expect(client.methodCalls('refresh')).toEqual([]);
  });

  it('deletes a platform credential from its own form', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'deepseek' });
    await screen.findByTestId('settings-deepseek');

    fireEvent.click(screen.getByRole('button', { name: '删除 DeepSeek API Key' }));
    await waitFor(() => expect(client.methodCalls('deleteCredential')).toEqual([['deepseek']]));
    expect(await screen.findByText(/已删除该平台账号凭据/)).toBeInTheDocument();
    expect(client.methodCalls('refresh')).toEqual([]);
  });

  it('keeps the previous DeepSeek key when a replacement fails to validate', async () => {
    const client = createFakeUsageClient({
      snapshot: panelSnapshot(),
      validateError: 'DeepSeek rejected the API key'
    });
    renderSettings({ client, section: 'deepseek' });

    const input = (await screen.findByLabelText('DeepSeek API Key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并替换' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('DeepSeek rejected the API key');
    expect(screen.getByText('已保存 ····9012')).toBeInTheDocument();
    expect(client.methodCalls('deleteCredential')).toEqual([]);
  });

  it('keeps the delete button on the status line while a reason fills the row below', async () => {
    const client = createFakeUsageClient({
      snapshot: panelSnapshot(),
      validateError: 'DeepSeek rejected the API key'
    });
    renderSettings({ client, section: 'deepseek' });

    const input = (await screen.findByLabelText('DeepSeek API Key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并替换' }));
    await screen.findByRole('alert');

    // The message claims a full row of its own, so it has to come last: a flex row
    // breaks in DOM order, and a button written after it was pushed onto its own line
    // under the state.
    const row = screen.getByText('已保存 ····9012').parentElement!;
    const children = [...row.children];
    expect(children.map((node) => node.tagName.toLowerCase())).toEqual(['span', 'button', 'span']);
    expect(children[1]).toHaveTextContent('删除');
    expect(children[2]).toHaveClass('credential-feedback');
  });

  it('revokes only the wallet credential from the form delete button', async () => {
    const client = clientWith({ glmWalletEnabled: true });
    renderSettings({ client, section: 'glm' });
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('button', { name: '删除 GLM 钱包账号凭据' }));
    await waitFor(() => expect(client.methodCalls('deleteCredential')).toEqual([['glm-wallet']]));
    // The plan connection is untouched: one credential, one deletion.
    expect(screen.getByLabelText('GLM Coding Plan API Key')).toBeInTheDocument();
  });

  it('keeps the wallet credential when the experimental connection is switched off', async () => {
    const client = clientWith({ glmWalletEnabled: true });
    renderSettings({ client, section: 'glm' });
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('checkbox', { name: '启用实验钱包连接' }));

    await waitFor(() => expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ glmWalletEnabled: false }));
    // Switching a connection off is not deleting its secret: the credential survives
    // for the moment the user switches it back on.
    expect(client.methodCalls('deleteCredential')).toEqual([]);
  });

  it('writes the experimental wallet switch through, and lets the host collect', async () => {
    const client = clientWith({ glmWalletEnabled: false });
    renderSettings({ client, section: 'glm' });
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('checkbox', { name: '启用实验钱包连接' }));

    await waitFor(() => expect(client.methodCalls('updateSettings')).toEqual([[{ glmWalletEnabled: true }]]));
  });

  it('sends every collection-affecting change through, one patch at a time', async () => {
    // Which endpoint answers (region), which CLI collects Codex, and whether an
    // experimental connection is on at all: each is a write the host has to react to.
    // This window's half of that contract is the patch it sends — the reaction itself
    // is pinned in Rust (`only_writes_that_change_what_is_collected_re_collect`).
    const client = clientWith();
    renderSettings({ client, section: 'glm' });
    await screen.findByTestId('settings-glm');
    fireEvent.click(screen.getByRole('button', { name: '国际区' }));
    await waitFor(() => expect(client.methodCalls('updateSettings')).toEqual([[{ glmRegion: 'international' }]]));

    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    await screen.findByTestId('settings-codex');
    const path = screen.getByLabelText('Codex CLI 绝对路径') as HTMLInputElement;
    fireEvent.change(path, { target: { value: '/opt/homebrew/bin/codex' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(client.methodCalls('updateSettings')).toEqual([
        [{ glmRegion: 'international' }],
        [{ codexCliPath: '/opt/homebrew/bin/codex' }]
      ])
    );
  });
});

describe('a change here lands on the panel', () => {
  it('takes the wallet module off the card when its connection is switched off', async () => {
    // The two windows, one client: this is what "the setting applies immediately"
    // means, and it is the arrangement the feature exists for.
    const { client, panel } = renderBothWindows({ client: clientWith({ glmWalletEnabled: true }), section: 'glm' });
    await screen.findByTestId('settings-glm');
    await panel.findByTestId('card-glm');
    expect(within(panel.getByTestId('card-glm')).getByText(/钱包/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '启用实验钱包连接' }));

    await waitFor(() =>
      expect(within(panel.getByTestId('card-glm')).queryByText(/钱包/)).not.toBeInTheDocument()
    );
    expect(client.methodCalls('deleteCredential')).toEqual([]);
  });

  it('hides a platform from the overview the moment its switch goes off', async () => {
    const { client, panel } = renderBothWindows({ client: clientWith(), section: 'platforms' });
    await screen.findByRole('checkbox', { name: '显示 GLM' });
    await panel.findByTestId('card-glm');

    fireEvent.click(screen.getByRole('checkbox', { name: '显示 GLM' }));

    await waitFor(() => expect(panel.queryByTestId('card-glm')).not.toBeInTheDocument());
    // Hiding is display only, and the host owns the re-collection rule: nothing here
    // asks the service to collect GLM again.
    expect(client.methodCalls('refresh')).toEqual([]);
  });
});

describe('per-platform settings stay out of the global ones', () => {
  it('keeps quota value mode out of a platform section', async () => {
    renderSettings({ client: clientWith(), section: 'glm' });
    await screen.findByTestId('settings-glm');

    // 额度数值 is an appearance setting: it belongs to 外观, where it applies to both
    // supported cards, not to one platform's form.
    expect(screen.queryByRole('group', { name: '额度数值' })).not.toBeInTheDocument();
  });

  it('saves the quota value mode once, from 外观', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'appearance' });
    const group = await screen.findByRole('group', { name: '额度数值' });

    fireEvent.click(within(group).getByRole('button', { name: '已用' }));

    await waitFor(() => expect(client.methodCalls('updateSettings')).toEqual([[{ quotaValueMode: 'used' }]]));
  });
});

describe('platform switch disable scope', () => {
  const states: Partial<Record<ProviderId, undefined>> = {};

  it('disables only the switch whose own write is in flight', () => {
    render(
      <PlatformSettings
        settings={defaultPanelSettings({})}
        states={states}
        toggling={new Set<ProviderId>(['glm'])}
        onToggle={vi.fn()}
        onReorder={vi.fn()}
      />
    );

    expect(screen.getByRole('checkbox', { name: '显示 GLM' })).toBeDisabled();
    for (const name of ['显示 Codex', '显示 DeepSeek']) {
      expect(screen.getByRole('checkbox', { name })).not.toBeDisabled();
    }
  });

  it('leaves every switch usable when no visibility write is in flight', () => {
    render(
      <PlatformSettings
        settings={defaultPanelSettings({})}
        states={states}
        toggling={new Set<ProviderId>()}
        onToggle={vi.fn()}
        onReorder={vi.fn()}
      />
    );

    for (const name of ['显示 Codex', '显示 GLM', '显示 DeepSeek']) {
      expect(screen.getByRole('checkbox', { name })).not.toBeDisabled();
    }
  });

  it('dims only the toggled platform switch while its own write is in flight', async () => {
    // An appearance save must not grey the platform switches out: the two are
    // unrelated writes, and the panel's whole point is that only the control being
    // edited blinks (the rule the archived change `unify-switch-disable-scope` set).
    let release: (() => void) | undefined;
    const client = clientWith();
    vi.spyOn(client, 'updateSettings').mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(defaultPanelSettings())))
    );
    renderSettings({ client, section: 'platforms' });
    await screen.findByRole('checkbox', { name: '显示 GLM' });

    fireEvent.click(screen.getByRole('checkbox', { name: '显示 GLM' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '显示 GLM' })).toBeDisabled());
    for (const name of ['显示 Codex', '显示 DeepSeek']) {
      expect(screen.getByRole('checkbox', { name })).not.toBeDisabled();
    }

    release?.();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '显示 GLM' })).not.toBeDisabled());
  });
});

describe('platform settings ordering', () => {
  const ROW_HEIGHT = 40;

  function renderOrdering(onReorder = vi.fn()) {
    // jsdom has no layout: inject a 40px-per-row measurement so the drag's slot
    // detection behaves like the real thing.
    const measureRow = (element: HTMLElement) => {
      const index = ['codex', 'glm', 'deepseek'].indexOf(element.dataset.provider ?? '');
      return { top: index * ROW_HEIGHT, height: ROW_HEIGHT };
    };
    render(
      <PlatformSettings
        settings={defaultPanelSettings({})}
        states={{}}
        onToggle={vi.fn()}
        onReorder={onReorder}
        measureRow={measureRow}
      />
    );
    return onReorder;
  }

  it('writes the new order as soon as the pointer changes the slot', async () => {
    const onReorder = renderOrdering();
    const handle = screen.getByRole('button', { name: '拖动排序 DeepSeek' });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientY: 100 });
    // DeepSeek sits in the third slot (80–120); dragging to 20 targets Codex.
    fireEvent.pointerMove(handle, { pointerId: 7, clientY: 20 });

    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));
    expect(onReorder).toHaveBeenCalledWith(['deepseek', 'codex', 'glm']);

    // Rows moved without a re-render storm: the DOM already reflects the order.
    const rows = screen.getAllByTestId(/^manage-row-/).map((row) => row.getAttribute('data-provider'));
    expect(rows).toEqual(['deepseek', 'codex', 'glm']);
    fireEvent.pointerUp(handle, { pointerId: 7, clientY: 20 });
  });

  it('keeps the lifted row under the pointer without reading layout again', async () => {
    const onReorder = vi.fn();
    let reads = 0;
    const measureRow = (element: HTMLElement) => {
      reads += 1;
      const index = ['codex', 'glm', 'deepseek'].indexOf(element.dataset.provider ?? '');
      return { top: index * ROW_HEIGHT, height: ROW_HEIGHT };
    };
    render(
      <PlatformSettings
        settings={defaultPanelSettings({})}
        states={{}}
        onToggle={vi.fn()}
        onReorder={onReorder}
        measureRow={measureRow}
      />
    );

    const handle = screen.getByRole('button', { name: '拖动排序 GLM' });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientY: 60 });
    // One snapshot of every row plus the grabbed row — and nothing after that.
    const readsAtGrab = reads;
    expect(readsAtGrab).toBeLessThanOrEqual(8);

    const row = screen.getByTestId('manage-row-glm');
    // GLM sits in the second slot (40–80) and is grabbed 20px into it. The pointer
    // moves to 90, whose slot belongs to DeepSeek, so GLM is swapped down one place
    // while still tracking the cursor: its slot moved 40px down, the pointer moved
    // 30px down, so it hangs 10px above the pointer relative to where it started.
    fireEvent.pointerMove(handle, { pointerId: 3, clientY: 90 });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(['codex', 'deepseek', 'glm']));
    expect(row).toHaveClass('is-dragging');
    expect(row.style.transform).toBe('translateY(-10px)');
    expect(reads).toBe(readsAtGrab);

    // Releasing settles the row into the slot it was dropped on.
    fireEvent.pointerUp(handle, { pointerId: 3, clientY: 90 });
    await waitFor(() => expect(row.style.transform).toBe(''));
    expect(row).not.toHaveClass('is-dragging');
  });

  it('never writes the lifted offset against an order the DOM has not adopted', async () => {
    const onReorder = vi.fn();
    const measureRow = (element: HTMLElement) => {
      const index = ['codex', 'glm', 'deepseek'].indexOf(element.dataset.provider ?? '');
      return { top: index * ROW_HEIGHT, height: ROW_HEIGHT };
    };
    render(
      <PlatformSettings
        settings={defaultPanelSettings({})}
        states={{}}
        onToggle={vi.fn()}
        onReorder={onReorder}
        measureRow={measureRow}
      />
    );
    const list = document.querySelector('.manage-list') as HTMLElement;
    const handle = screen.getByRole('button', { name: '拖动排序 GLM' });
    const row = screen.getByTestId('manage-row-glm');
    const domOrder = () => [...list.children].map((child) => (child as HTMLElement).dataset.provider ?? '');

    // Replay the row's style writes and the list's reorders in the order they
    // happened: MutationObserver delivers one batch per observed target in mutation
    // order, so the interleaving below is the real one. A transform is only valid if
    // it matches the slot the *DOM* had at that very moment — writing it a frame before
    // the reorder commits paints the row a row-height away from where it belongs, and
    // that jump is the flash this guards.
    const records: { transform: string; order: string[]; pointerY: number }[] = [];
    let order = ['codex', 'glm', 'deepseek'];
    let pointerY = 60;
    const observer = new MutationObserver((batch) => {
      for (const record of batch) {
        if (record.type === 'childList' && record.target === list) {
          order = domOrder();
          continue;
        }
        if (record.type === 'attributes' && record.target === row) {
          records.push({
            transform: (record.target as HTMLElement).style.transform,
            order: [...order],
            pointerY
          });
        }
      }
    });
    observer.observe(list, { childList: true });
    observer.observe(row, { attributes: true, attributeFilter: ['style'] });

    const GRAB_OFFSET = 20;
    const grabbed = () => records.some((record) => record.transform.startsWith('translateY('));
    fireEvent.pointerDown(handle, { button: 0, pointerId: 11, clientY: pointerY });
    // The grab frame is recorded while the pointer still sits on the grab point.
    await waitFor(() => expect(grabbed()).toBe(true));

    pointerY = 90;
    fireEvent.pointerMove(handle, { pointerId: 11, clientY: pointerY });

    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(['codex', 'deepseek', 'glm']));
    // Wait for the reorder to actually reach the DOM before releasing.
    await waitFor(() => expect(domOrder()).toEqual(['codex', 'deepseek', 'glm']));
    fireEvent.pointerUp(handle, { pointerId: 11, clientY: pointerY });
    await waitFor(() =>
      expect(records.filter((record) => record.transform.startsWith('translateY(')).length).toBeGreaterThan(1)
    );
    observer.disconnect();

    // Measurement writes (`none`, and the value they restore) are not positioning, so
    // only the translate writes are positions.
    const positions = records.filter((record) => record.transform.startsWith('translateY('));
    for (const write of positions) {
      const slot = write.order.indexOf('glm') * ROW_HEIGHT;
      expect(write.transform).toBe(`translateY(${write.pointerY - GRAB_OFFSET - slot}px)`);
    }
    // Both orders were exercised, so the invariant above is not vacuous.
    expect(positions[0]!.order).toEqual(['codex', 'glm', 'deepseek']);
    expect(positions.some((write) => write.order.join(',') === 'codex,deepseek,glm')).toBe(true);
  });

  it('reorders with the keyboard from the same handle', async () => {
    const onReorder = renderOrdering();
    fireEvent.keyDown(screen.getByRole('button', { name: '拖动排序 GLM' }), { key: 'ArrowDown' });
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(['codex', 'deepseek', 'glm']));
  });
});

describe('DeepSeek experimental web usage connection', () => {
  it('keeps credential status and avoids repeating the token instructions', async () => {
    const settings = defaultPanelSettings();
    renderSettings({
      client: clientWith({
        deepseekWebEnabled: true,
        credentials: {
          ...settings.credentials,
          deepseek: { configured: false },
          'deepseek-web': { configured: false }
        }
      }),
      section: 'deepseek'
    });
    const view = await screen.findByTestId('settings-deepseek');
    const webBlock = within(view).getByRole('heading', { name: '网页用量连接' }).closest('section')!;

    expect(within(webBlock).getByText('尚未连接')).toBeInTheDocument();
    expect(within(webBlock).getByText('尚未配置')).toBeInTheDocument();
    expect(within(webBlock).getByLabelText('DeepSeek 网页登录 Token')).toHaveAttribute(
      'placeholder',
      '粘贴 Authorization Token'
    );
    expect(within(webBlock).queryByText(/登录 platform\.deepseek\.com/)).not.toBeInTheDocument();
  });

  it('ships disabled and reveals the paste form only after opt-in', async () => {
    const client = clientWith({ deepseekWebEnabled: false });
    renderSettings({ client, section: 'deepseek' });
    await screen.findByTestId('settings-deepseek');

    // Off by default: the toggle is unchecked and no token form is rendered.
    expect(screen.getByRole('checkbox', { name: '启用网页用量连接' })).not.toBeChecked();
    expect(screen.queryByLabelText('DeepSeek 网页登录 Token')).not.toBeInTheDocument();
    expect(screen.queryByText('按后台账单显示今日消费；非公开接口，可能失效。')).not.toBeInTheDocument();
    expect(screen.queryByText('关闭后改用估算，保留 Token')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '启用网页用量连接' }));
    await waitFor(() =>
      expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ deepseekWebEnabled: true })
    );
    expect(await screen.findByLabelText('DeepSeek 网页登录 Token')).toBeInTheDocument();
    // No credential action happened merely by turning the connection on.
    expect(client.methodCalls('validateCredential')).toHaveLength(0);
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
  });

  it('does not promise an estimated fallback when the web collector is incompatible', async () => {
    const settings = defaultPanelSettings({
      deepseekWebEnabled: true,
      credentials: {
        ...defaultPanelSettings().credentials,
        'deepseek-web': { configured: true, suffix: 'abcd' }
      }
    });
    const client = createFakeUsageClient({
      settings,
      snapshot: snapshotOf([
        ...panelSnapshot().providers,
        // A body the collector could not read at all: the redesigned-endpoint case,
        // which is what the compatibility wording is for.
        failedStateOf(
          'deepseek',
          { kind: 'compatibility', message: 'unsupported endpoint shape', at: '2026-09-10T08:00:00.000Z' },
          { connection: { provider: 'deepseek', connection: 'web' } }
        )
      ])
    });
    renderSettings({ client, section: 'deepseek' });
    const view = await screen.findByTestId('settings-deepseek');
    const webBlock = within(view).getByRole('heading', { name: '网页用量连接' }).closest('section')!;

    expect(within(webBlock).getByText('接口可能已改版，网页用量暂不展示。')).toBeInTheDocument();
    expect(within(webBlock).queryByText(/估算/)).not.toBeInTheDocument();
  });

  it('asks for a fresh paste when the web login token was rejected', async () => {
    const settings = defaultPanelSettings({
      deepseekWebEnabled: true,
      credentials: {
        ...defaultPanelSettings().credentials,
        'deepseek-web': { configured: true, suffix: 'abcd' }
      }
    });
    const client = createFakeUsageClient({
      settings,
      snapshot: snapshotOf([
        ...panelSnapshot().providers,
        // The rejected login token. The connection is named `web`, which is the key
        // the settings form asks for (`view.state('web')`); the status row's own
        // wording is what the assertion below pins, not the service's sentence.
        failedStateOf(
          'deepseek',
          {
            kind: 'authentication',
            message: 'the DeepSeek web login token was rejected as invalid or expired; paste a fresh one',
            at: '2026-09-10T08:00:00.000Z'
          },
          { connection: { provider: 'deepseek', connection: 'web' } }
        )
      ])
    });
    renderSettings({ client, section: 'deepseek' });
    const view = await screen.findByTestId('settings-deepseek');
    const webBlock = within(view).getByRole('heading', { name: '网页用量连接' }).closest('section')!;

    // A rejected token is a paste problem, not a redesign: the block says which, the
    // stored token still shows its mask, and the paste entry is still there.
    expect(within(webBlock).getByText('登录态无效或已过期，请重新粘贴 Token。')).toBeInTheDocument();
    expect(within(webBlock).queryByText('接口可能已改版，网页用量暂不展示。')).not.toBeInTheDocument();
    expect(within(webBlock).getByText('已保存 ····abcd')).toBeInTheDocument();
    expect(within(webBlock).getByPlaceholderText('粘贴 Authorization Token')).toBeInTheDocument();
  });

  it('keeps the stored token when the connection is switched off', async () => {
    const settings = defaultPanelSettings({ deepseekWebEnabled: true });
    const client = clientWith({
      deepseekWebEnabled: true,
      credentials: { ...settings.credentials, 'deepseek-web': { configured: true, suffix: 'ef01' } }
    });
    renderSettings({ client, section: 'deepseek' });
    await screen.findByTestId('settings-deepseek');

    fireEvent.click(screen.getByRole('checkbox', { name: '启用网页用量连接' }));

    await waitFor(() =>
      expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ deepseekWebEnabled: false })
    );
    expect(client.methodCalls('deleteCredential')).toEqual([]);
  });
});


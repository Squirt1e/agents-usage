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
import type { CollectorError } from '../src/shared/contracts';
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

  it('uses the same provider badges as the overview cards', async () => {
    renderSettings();
    const nav = await screen.findByRole('tablist', { name: '设置分类' });

    for (const [name, provider] of [
      ['Codex', 'codex'],
      ['GLM', 'glm'],
      ['DeepSeek', 'deepseek']
    ] as const) {
      const badge = within(nav).getByRole('tab', { name }).firstElementChild;
      expect(badge).toHaveClass('brand-badge', `brand-${provider}`);
      expect(badge).not.toHaveClass('settings-nav-badge');
    }
  });

  it('opens on 平台管理, which is the setting users reach for most', async () => {
    renderSettings();
    expect(await screen.findByTestId('settings-pane-platforms')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '平台管理' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows only one section at a time, and never two platforms together', async () => {
    renderSettings({ client: clientWith(), section: 'glm' });
    const view = await screen.findByTestId('settings-glm');
    expect(within(view).getByLabelText('GLM Coding Plan 密钥')).toBeInTheDocument();

    expect(screen.queryByTestId('settings-codex')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-deepseek')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('DeepSeek 密钥')).not.toBeInTheDocument();
    // The platform manager is a section of its own and never mixes in credentials.
    expect(screen.queryByRole('checkbox', { name: '显示 Codex' })).not.toBeInTheDocument();
  });

  it('keeps 平台管理 free of credential forms', async () => {
    renderSettings({ client: clientWith(), section: 'platforms' });
    await screen.findByRole('checkbox', { name: '显示 Codex' });

    expect(screen.queryByLabelText('GLM Coding Plan 密钥')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('DeepSeek 密钥')).not.toBeInTheDocument();
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

  it('lands on the section the host remembered, not on its own default', async () => {
    // The event (`panel://settings-section`) only reaches a window that is already
    // listening, so a request made while this window was still booting would be lost and
    // the window would sit on 平台管理. The host records the request and the window reads
    // it here — this is what makes "click a card's gear, land on that platform" hold.
    renderSettings({ client: clientWith(), readSection: async () => 'glm' });

    expect(await screen.findByTestId('settings-pane-glm')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'GLM' })).toHaveAttribute('aria-selected', 'true');
  });

  it('lets a later host request move the section, and does not fight it afterwards', async () => {
    // The fast path still works for a window that is up: the event moves the section,
    // and the mount-time read must not drag it back once the reader has navigated by hand.
    let ask: ((section: never) => void) | undefined;
    renderSettings({
      client: clientWith(),
      readSection: async () => 'platforms',
      onSelectSectionRequest: (listener) => {
        ask = listener as (section: never) => void;
        return () => undefined;
      }
    });
    await screen.findByTestId('settings-pane-platforms');

    ask!('deepseek' as never);
    expect(await screen.findByTestId('settings-pane-deepseek')).toBeInTheDocument();

    // Hand navigation is respected: nothing re-reads the host's remembered section.
    fireEvent.click(screen.getByRole('tab', { name: '外观' }));
    expect(await screen.findByTestId('settings-pane-appearance')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '外观' })).toHaveAttribute('aria-selected', 'true');
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
    expect(within(view).getByLabelText('可执行文件路径')).toBeInTheDocument();
  });

  it('saves an absolute Codex CLI path for Finder launches', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'codex' });
    await screen.findByTestId('settings-codex');

    const path = screen.getByLabelText('可执行文件路径') as HTMLInputElement;
    fireEvent.change(path, { target: { value: '/opt/homebrew/bin/codex' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(client.methodCalls('updateSettings')).toEqual([[{ codexCliPath: '/opt/homebrew/bin/codex' }]])
    );
    expect(await screen.findByText('已保存 CLI 路径：/opt/homebrew/bin/codex')).toBeInTheDocument();
  });

  it('reads a stored CLI path back into the field, and cannot clear it by accident', async () => {
    // Opening this pane straight onto Codex (the nav, or a card's gear) mounts the
    // form while the first settings read is still in flight. Seeded once from
    // `props`, the field was born empty and stayed empty: the stored path was
    // invisible, the row beneath it invited 留空保存可清除路径, and one press of 保存
    // erased a value the reader never touched.
    const client = clientWith({ codexCliPath: '/opt/homebrew/bin/codex' });
    renderSettings({ client, section: 'codex' });
    await screen.findByTestId('settings-codex');

    const path = screen.getByLabelText('可执行文件路径') as HTMLInputElement;
    await waitFor(() => expect(path).toHaveValue('/opt/homebrew/bin/codex'));

    // Nothing has been chosen, so there is nothing to write.
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(client.methodCalls('updateSettings')).toEqual([]);
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

    const input = (await screen.findByLabelText('DeepSeek 密钥')) as HTMLInputElement;
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

  it('deletes a platform credential from its own form, behind a confirmation', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'deepseek' });
    await screen.findByTestId('settings-deepseek');

    // The first press opens the confirmation and writes nothing: what is deleted is
    // a secret the reader has to fetch from the provider again, and there is no undo.
    fireEvent.click(screen.getByRole('button', { name: '删除 DeepSeek 密钥' }));
    expect(client.methodCalls('deleteCredential')).toEqual([]);
    const prompt = await screen.findByText(/删除后需重新向平台获取密钥/);
    expect(prompt).toBeInTheDocument();

    // Backing out leaves the credential alone and puts focus back on the link.
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(client.methodCalls('deleteCredential')).toEqual([]);
    const link = screen.getByRole('button', { name: '删除 DeepSeek 密钥' });
    expect(document.activeElement).toBe(link);

    fireEvent.click(link);
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(client.methodCalls('deleteCredential')).toEqual([['deepseek']]));
    expect(await screen.findByText(/已删除该平台账号凭据/)).toBeInTheDocument();
    expect(client.methodCalls('refresh')).toEqual([]);
  });

  it('cancels the delete confirmation with Escape', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'deepseek' });
    await screen.findByTestId('settings-deepseek');

    fireEvent.click(screen.getByRole('button', { name: '删除 DeepSeek 密钥' }));
    const confirmButton = await screen.findByRole('button', { name: '确认删除' });
    // Focus starts on the safe action, so a stray Enter cancels rather than deletes.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
    fireEvent.keyDown(confirmButton, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull());
    expect(client.methodCalls('deleteCredential')).toEqual([]);
  });

  it('keeps the previous DeepSeek key when a replacement fails to validate', async () => {
    const client = createFakeUsageClient({
      snapshot: panelSnapshot(),
      validateError: 'DeepSeek rejected the API key'
    });
    renderSettings({ client, section: 'deepseek' });

    const input = (await screen.findByLabelText('DeepSeek 密钥')) as HTMLInputElement;
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

    const input = (await screen.findByLabelText('DeepSeek 密钥')) as HTMLInputElement;
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
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(client.methodCalls('deleteCredential')).toEqual([['glm-wallet']]));
    // The plan connection is untouched: one credential, one deletion.
    expect(screen.getByLabelText('GLM Coding Plan 密钥')).toBeInTheDocument();
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
    const path = screen.getByLabelText('可执行文件路径') as HTMLInputElement;
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

  it('reorders by pointer only, and does not advertise otherwise', async () => {
    // The arrow-key path was removed on purpose. This pins the decision rather than
    // the mechanics: the handle answers to no key, and no tooltip or line under the
    // list claims otherwise. (A pointer-only reorder is a deliberate trade — see the
    // `polish-settings-window` change's spec delta for what it costs.)
    const onReorder = renderOrdering();
    const handle = screen.getByRole('button', { name: '拖动排序 GLM' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.keyDown(handle, { key: ' ' });
    expect(onReorder).not.toHaveBeenCalled();
    expect(handle.getAttribute('title')).not.toMatch(/方向键|↑|↓/);
    expect(screen.queryByText(/↑↓/)).toBeNull();
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

    // Two different facts, two different sentences: the connection has no data
    // (尚未连接) and this field holds no secret (未保存凭据). They used to be
    // 尚未连接 / 尚未配置 one row apart, which read as the same fact stated twice.
    expect(within(webBlock).getByText('尚未连接')).toBeInTheDocument();
    expect(within(webBlock).getByText('未保存凭据')).toBeInTheDocument();
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

// The status vocabulary is a system, not a per-pane decision
// (refine-peak-window-editor's review): one rendering per fact, one recovery
// sentence per failure, and a control that shows its own write.
describe('how a connection reports itself', () => {
  /** A client whose connections failed in the given ways. */
  function failingClient(states: Array<[ProviderId, CollectorError['kind']]>, settings: Partial<PanelSettings> = {}) {
    return createFakeUsageClient({
      snapshot: snapshotOf(states.map(([provider, kind]) => failedStateOf(provider, { kind, message: kind, at: '2026-09-10T08:00:00.000Z' }))),
      settings
    });
  }

  it('states a connection once, in the same place in every block', async () => {
    // GLM used to say it twice in one pane: a pill beside the Coding Plan title and
    // a dotted row in the wallet block. Both are rows now, and the row has a fixed
    // position: first in the body for a connection that is always on, immediately
    // after the switch for one the switch governs (a status above its own switch
    // reads as "this switch does not work").
    const client = clientWith({ glmWalletEnabled: true, deepseekWebEnabled: true });
    renderSettings({ client, section: 'glm' });
    const glm = await screen.findByTestId('settings-glm');
    const codingPlan = [...glm.querySelectorAll('section.config-block')].find(
      (block) => block.querySelector('h3')?.textContent === 'Coding Plan'
    )!;
    // First body row, right under the title.
    expect(codingPlan.querySelector('.block-head')!.nextElementSibling!.className).toContain('status-row');
    // Never tucked back into the title row.
    expect(codingPlan.querySelector('.block-head .status-row')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'DeepSeek' }));
    const deepseek = await screen.findByTestId('settings-deepseek');
    const web = [...deepseek.querySelectorAll('section.config-block')].find(
      (block) => block.querySelector('h3')?.textContent === '网页用量连接'
    )!;
    const title = web.querySelector('.block-head')!;
    expect(title.nextElementSibling!.tagName).toBe('DIV'); // the switch row
    expect(title.nextElementSibling!.nextElementSibling!.className).toContain('status-row');

    // No second rendering of the same fact anywhere in the window.
    expect(document.querySelector('.status-chip')).toBeNull();
  });

  it('shows the busiest case of all — a first run — with a way out', async () => {
    // missing_config is what an unconfigured connection reports, so it is the first
    // status most readers ever see. It had no advice, on the theory that the form
    // below is self-evidently the answer.
    const client = failingClient([['glm', 'missing_config']]);
    renderSettings({ client, section: 'glm' });
    expect(await screen.findByText('需要配置')).toBeInTheDocument();
    expect(screen.getByText('在下方填入凭据后即可开始采集。')).toBeInTheDocument();
  });

  it('gives every failure a way out, in the shared vocabulary', async () => {
    const client = failingClient([
      ['glm', 'authentication'],
      ['deepseek', 'rate_limit']
    ]);
    renderSettings({ client, section: 'glm' });
    // The connection's own wording wins where it has something more useful to say.
    expect(await screen.findByText('请在 GLM 平台重新生成密钥后替换。')).toBeInTheDocument();
    expect(screen.getByText('认证失败')).toBeInTheDocument();
  });

  it('falls back to the same sentence for a failure the connection has no wording for', async () => {
    const client = failingClient([['glm', 'network']]);
    renderSettings({ client, section: 'glm' });
    // A bare 网络异常 with nothing after it was the old behaviour; the point of the
    // shared table is that a reader is never left without a next step.
    expect(await screen.findByText('网络请求失败，检查网络或代理后重试。')).toBeInTheDocument();
  });

  it('shows each switch its own write', async () => {
    const client = clientWith({ glmWalletEnabled: true, deepseekWebEnabled: true });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = client.updateSettings.bind(client);
    vi.spyOn(client, 'updateSettings').mockImplementation(async (patch) => {
      await held;
      return write(patch);
    });
    renderSettings({ client, section: 'glm' });
    await screen.findByTestId('settings-glm');

    const wallet = screen.getByRole('checkbox', { name: '启用实验钱包连接' });
    expect(wallet).not.toBeDisabled();
    fireEvent.click(wallet);
    // The track is disabled for the length of its own write: previously it sat
    // unchanged until the settings echo landed, and a second click sent a second
    // write.
    await waitFor(() => expect(wallet).toBeDisabled());
    release!();
    await waitFor(() => expect(wallet).not.toBeDisabled());
  });

  it('never leaves an appearance click silently ignored', async () => {
    const client = clientWith();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = client.updateSettings.bind(client);
    vi.spyOn(client, 'updateSettings').mockImplementation(async (patch) => {
      await held;
      return write(patch);
    });
    renderSettings({ client, section: 'appearance' });
    const group = await screen.findByRole('group', { name: '主题' });
    fireEvent.click(within(group).getByRole('button', { name: '浅色' }));

    // Both groups are unavailable while one write is in flight, and *visibly* so:
    // a disabled sliding group deliberately keeps its option text at full opacity
    // (the pill must not dim), so the track is what carries "busy". Asserting only
    // `toBeDisabled()` would pass while the group looked exactly like an enabled one
    // — which is how a click could still be dropped with nothing on screen saying so.
    const quota = await screen.findByRole('group', { name: '额度数值' });
    await waitFor(() => expect(within(quota).getByRole('button', { name: '已用' })).toBeDisabled());
    expect(quota.getAttribute('aria-disabled')).toBeNull();
    expect(quota.className).toContain('segmented');
    // The style rule that makes it visible is pinned in the motion guard; here we
    // assert the element the rule targets exists.
    expect(quota.matches('.segmented:has(.segmented-option:disabled)')).toBe(true);
    release!();
    await waitFor(() => expect(within(quota).getByRole('button', { name: '已用' })).not.toBeDisabled());
  });

  it('names a pane once', async () => {
    renderSettings({ section: 'appearance' });
    const pane = await screen.findByTestId('settings-pane-appearance');
    // 外观 used to appear three times in ninety pixels: the nav row, the pane title
    // and a card heading repeating the title verbatim.
    expect(within(pane).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['外观']);
  });
});

describe('the platform manager says what each row does', () => {
  it('names the switch and marks a hidden platform in words', async () => {
    const client = clientWith({ platformVisibility: { glm: false } });
    renderSettings({ client, section: 'platforms' });
    const view = await screen.findByTestId('platform-settings');

    // The switch's meaning was previously only in an aria-label: the row's text
    // named the platform and its connection, never what the switch does.
    expect(view.querySelectorAll('.manage-switch-label')).toHaveLength(3);
    expect(within(view).getAllByText('显示')).toHaveLength(3);

    // A hidden platform used to look exactly like a visible one apart from the
    // switch's position. Now the row says so, and its name drops a level with it.
    const hidden = within(view).getByTestId('manage-row-glm');
    expect(hidden).toHaveAttribute('data-hidden', 'true');
    expect(within(hidden).getByText('已隐藏')).toBeInTheDocument();
    expect(within(view).getByTestId('manage-row-codex')).not.toHaveAttribute('data-hidden');
  });

});

describe('the section column is a tablist, wired both ways', () => {
  it('points each tab at its panel and each panel back at its tab', async () => {
    renderSettings({ section: 'glm' });
    const tab = await screen.findByRole('tab', { name: 'GLM' });
    const panel = await screen.findByTestId('settings-pane-glm');

    expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    // The panel is the tab's labelled region, so focus can land on it directly.
    expect(panel).toHaveAttribute('role', 'tabpanel');
  });
});

describe('the delete confirmation does not outlive its subject', () => {
  it('closes once the deletion has happened, leaving the result in its place', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'deepseek' });
    await screen.findByTestId('settings-deepseek');

    fireEvent.click(screen.getByRole('button', { name: '删除 DeepSeek 密钥' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));

    // The row becomes the outcome: leaving the prompt open would keep asking
    // "确定删除？" over a credential that is already gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull());
    expect(screen.queryByText(/删除后需重新向平台获取密钥/)).toBeNull();
    expect(await screen.findByText(/已删除该平台账号凭据/)).toBeInTheDocument();
  });

  it('closes when the reader chooses to replace instead', async () => {
    const client = clientWith();
    renderSettings({ client, section: 'deepseek' });
    await screen.findByTestId('settings-deepseek');

    fireEvent.click(screen.getByRole('button', { name: '删除 DeepSeek 密钥' }));
    await screen.findByRole('button', { name: '确认删除' });

    // A confirmation is about the old secret; a replacement makes it meaningless.
    const input = screen.getByLabelText('DeepSeek 密钥');
    fireEvent.change(input, { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并替换' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull());
    expect(client.methodCalls('deleteCredential')).toEqual([]);
  });
});

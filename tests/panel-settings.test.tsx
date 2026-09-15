// @vitest-environment jsdom
// Tasks 7.1 – 7.4: one platform's configuration at a time, back with focus
// restore, Escape precedence, and the credential lifecycle (validate → replace →
// delete) including the wallet display toggle versus disabling the experimental
// connection.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelApp, type PanelHostProps } from '../src/desktop/PanelApp';
import { PlatformSettings } from '../src/desktop/PlatformSettings';
import {
  createFakeUsageClient,
  defaultPanelSettings,
  failedStateOf,
  metricOf,
  providerStateOf,
  snapshotOf,
  type FakeUsageClient
  } from '../src/desktop/fake-client';
import type { PanelSettings, PanelSnapshot } from '../src/shared/desktop-contract';
import type { ProviderId } from '../src/shared/contracts';

const NOW = new Date('2026-09-10T08:00:00.000Z');

function panelSnapshot(): PanelSnapshot {
  return snapshotOf([
    providerStateOf('codex', [
      metricOf({ key: 'codex.primary.used', value: 42, unit: 'percent', direction: 'used', windowSeconds: 18_000, resetAt: '2026-09-10T09:42:18.000Z' })
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
    providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 86.42, unit: 'CNY', direction: 'balance' })])
  ]);
}

function renderPanel(options: { client?: FakeUsageClient; settings?: Partial<PanelSettings>; onRequestHide?: () => void } = {}) {
  const client =
    options.client ?? createFakeUsageClient({ snapshot: panelSnapshot(), settings: options.settings ?? {} });
  const host: PanelHostProps = {
    pinned: false,
    onTogglePin: vi.fn(),
    onRequestHide: options.onRequestHide ?? vi.fn(),
    onSetHeight: vi.fn()
  };
  render(<PanelApp client={client} host={host} now={NOW} />);
  return { client, host };
}

describe('per-platform configuration', () => {
  it('opens only the platform whose gear was clicked', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 GLM' }));

    const view = await screen.findByTestId('settings-glm');
    expect(screen.getByRole('heading', { name: 'GLM 配置' })).toBeInTheDocument();
    expect(within(view).getByLabelText('GLM Coding Plan API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回用量总览' })).toBeInTheDocument();

    // No other platform's form is on screen, and neither is the overview.
    expect(screen.queryByTestId('settings-codex')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-deepseek')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
    expect(screen.queryByTestId('overview')).not.toBeInTheDocument();
    // The header icon row belongs to the overview.
    expect(screen.queryByRole('button', { name: '设置' })).not.toBeInTheDocument();
  });

  it('returns to the overview and restores focus to the gear that opened it', async () => {
    renderPanel();
    const gear = await screen.findByRole('button', { name: '配置 DeepSeek' });
    fireEvent.click(gear);
    await screen.findByTestId('settings-deepseek');

    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));
    const restored = await screen.findByRole('button', { name: '配置 DeepSeek' });
    await waitFor(() => expect(document.activeElement).toBe(restored));
    expect(screen.getByTestId('card-deepseek')).toBeInTheDocument();
    // The overview restored the same visibility selection.
    expect(screen.getByTestId('card-glm')).toBeInTheDocument();
  });

  it('closes the inner overlay on Escape before asking the host to hide the window', async () => {
    const onRequestHide = vi.fn();
    renderPanel({ onRequestHide });
    await screen.findByTestId('card-codex');

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    await screen.findByTestId('app-settings');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('app-settings')).not.toBeInTheDocument());
    expect(onRequestHide).not.toHaveBeenCalled();

    // Escape from the per-platform settings goes back to the overview first.
    fireEvent.click(screen.getByRole('button', { name: '配置 Codex' }));
    await screen.findByTestId('settings-codex');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('settings-codex')).not.toBeInTheDocument());
    expect(onRequestHide).not.toHaveBeenCalled();

    // With nothing open, Escape is handed to the host.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onRequestHide).toHaveBeenCalledTimes(1);
  });

  it('shows Codex managed-login guidance and never a secret form', async () => {
    const snapshot = snapshotOf([
      {
        provider: 'codex',
        error: { kind: 'authentication', message: 'Codex is not signed in', at: '2026-09-10T08:00:00.000Z' }
      }
    ]);
    const client = createFakeUsageClient({ snapshot });
    renderPanel({ client });

    fireEvent.click(await screen.findByRole('button', { name: '配置 Codex' }));
    const view = await screen.findByTestId('settings-codex');
    expect(within(view).getByText(/请在 Codex 应用或 Codex CLI 中完成登录/)).toBeInTheDocument();
    expect(within(view).getByText('Codex 托管登录')).toBeInTheDocument();
    expect(within(view).getByLabelText('Codex CLI 绝对路径')).toBeInTheDocument();
    // No credential input for Codex, and no other platform's key form.
    expect(view.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(screen.queryByLabelText('GLM Coding Plan API Key')).not.toBeInTheDocument();
  });

  it('saves an absolute Codex CLI path for Finder launches', async () => {
    const { client } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 Codex' }));
    await screen.findByTestId('settings-codex');

    const input = screen.getByLabelText('Codex CLI 绝对路径') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/opt/homebrew/bin/codex' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(client.methodCalls('updateSettings')).toHaveLength(1));
    expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ codexCliPath: '/opt/homebrew/bin/codex' });
    expect(await screen.findByText(/已保存 CLI 路径/)).toBeInTheDocument();
    // Clearing the field removes the override again.
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(client.methodCalls('updateSettings')).toHaveLength(2));
    expect(client.methodCalls('updateSettings')[1]?.[0]).toEqual({ codexCliPath: undefined });
  });

  it('saves the quota value mode once from global settings', async () => {
    const { client } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const page = await screen.findByTestId('app-settings');
    const valueMode = within(page).getByRole('group', { name: '额度数值' });
    expect(valueMode.querySelectorAll('.segmented-slider')).toHaveLength(1);
    expect(within(valueMode).getByRole('button', { name: '剩余' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(valueMode).getByRole('button', { name: '已用' }));

    await waitFor(() => expect(client.methodCalls('updateSettings')).toHaveLength(1));
    expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ quotaValueMode: 'used' });
  });

  it.each([
    { changedGroup: '主题', changedOption: '浅色', steadyGroup: '额度数值', steadyOption: '已用' },
    { changedGroup: '额度数值', changedOption: '已用', steadyGroup: '主题', steadyOption: '浅色' }
  ])('does not dim $steadyGroup while $changedGroup is saving', async ({ changedGroup, changedOption, steadyGroup, steadyOption }) => {
    const client = createFakeUsageClient({ snapshot: panelSnapshot() });
    const update = client.updateSettings.bind(client);
    let releaseSave: () => void = () => undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.spyOn(client, 'updateSettings').mockImplementation(async (patch) => {
      await saveGate;
      return update(patch);
    });
    renderPanel({ client });
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const page = await screen.findByTestId('app-settings');
    const changed = within(within(page).getByRole('group', { name: changedGroup })).getByRole('button', {
      name: changedOption
    });
    const steady = within(within(page).getByRole('group', { name: steadyGroup })).getByRole('button', {
      name: steadyOption
    });

    fireEvent.click(changed);
    await waitFor(() => expect(steady).toHaveAttribute('aria-disabled', 'true'));
    expect(steady).not.toBeDisabled();
    fireEvent.click(steady);
    expect(save).toHaveBeenCalledTimes(1);

    releaseSave();
    await waitFor(() => expect(steady).not.toHaveAttribute('aria-disabled'));
  });

  it('keeps the platform switches usable while an appearance save is in flight', async () => {
    const client = createFakeUsageClient({ snapshot: panelSnapshot() });
    const update = client.updateSettings.bind(client);
    let releaseSave: () => void = () => undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.spyOn(client, 'updateSettings').mockImplementation(async (patch) => {
      await saveGate;
      return update(patch);
    });
    renderPanel({ client });
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const page = await screen.findByTestId('app-settings');
    fireEvent.click(within(within(page).getByRole('group', { name: '主题' })).getByRole('button', { name: '深色' }));

    // The write is in flight: the edited group may dim, the platform switches
    // above are not part of this save and must not blink.
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const manage = within(page).getByTestId('platform-settings');
    expect(within(manage).getByRole('checkbox', { name: '显示 Codex' })).not.toBeDisabled();
    expect(within(manage).getByRole('checkbox', { name: '显示 GLM' })).not.toBeDisabled();
    expect(within(manage).getByRole('checkbox', { name: '显示 DeepSeek' })).not.toBeDisabled();

    releaseSave();
    await waitFor(() =>
      expect(within(within(page).getByRole('group', { name: '主题' })).getByRole('button', { name: '深色' })).not.toBeDisabled()
    );
  });

  it('dims only the toggled platform switch while its own write is in flight', async () => {
    const client = createFakeUsageClient({ snapshot: panelSnapshot() });
    const update = client.updateSettings.bind(client);
    let releaseSave: () => void = () => undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.spyOn(client, 'updateSettings').mockImplementation(async (patch) => {
      await saveGate;
      return update(patch);
    });
    renderPanel({ client });
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByTestId('app-settings');
    fireEvent.click(within(screen.getByTestId('platform-settings')).getByRole('checkbox', { name: '显示 GLM' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('checkbox', { name: '显示 GLM' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '显示 Codex' })).not.toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '显示 DeepSeek' })).not.toBeDisabled();

    releaseSave();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '显示 GLM' })).not.toBeDisabled());
  });

  it('keeps quota value mode out of per-platform settings', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 Codex' }));
    await screen.findByTestId('settings-codex');
    expect(screen.queryByRole('group', { name: '额度展示形式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '额度数值' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));
    fireEvent.click(await screen.findByRole('button', { name: '配置 GLM' }));
    await screen.findByTestId('settings-glm');

    expect(screen.getByRole('group', { name: '服务区域' }).querySelectorAll('.segmented-slider')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: '额度展示形式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '额度数值' })).not.toBeInTheDocument();
  });

  it('persists the GLM region without touching credentials', async () => {
    const { client } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 GLM' }));
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('button', { name: '国际区' }));
    await waitFor(() => expect(client.methodCalls('updateSettings')).toHaveLength(1));
    expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ glmRegion: 'international' });
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
  });

  it('keeps the wallet credential when the experimental connection is switched off', async () => {
    // One switch means collect-and-show, and nothing else: switching off hides the
    // module and stops collecting, while the pasted credential stays put — the
    // delete button in the form below is what revokes it. Deleting it here is what
    // used to make "switch off, switch on" look like it had lost the wallet.
    const { client } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 GLM' }));
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('checkbox', { name: '启用实验钱包连接' }));

    await waitFor(() => expect(client.methodCalls('updateSettings')).toHaveLength(1));
    expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ glmWalletEnabled: false });
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
    // The wallet form goes away with the connection; the quota one stays.
    expect(screen.getByLabelText('GLM Coding Plan API Key')).toBeInTheDocument();
    expect(screen.queryByLabelText('GLM 钱包账号凭据')).not.toBeInTheDocument();
  });

  it('revokes only the wallet credential from the form delete button', async () => {
    const { client } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 GLM' }));
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('button', { name: '删除 GLM 钱包账号凭据' }));

    await waitFor(() => expect(client.methodCalls('deleteCredential')).toHaveLength(1));
    expect(client.methodCalls('deleteCredential')[0]).toEqual(['glm-wallet']);
    // The switch and the other connections are untouched by a deletion.
    expect(client.methodCalls('updateSettings')).toHaveLength(0);
    expect(client.currentSettings().glmWalletEnabled).toBe(true);
  });

  it('takes the wallet module off the card when its connection is switched off', async () => {
    // One switch, the DeepSeek web interaction: on it shows, off it is gone — and
    // the reading collected before must not stay on screen as if it were live, or
    // the switch looks like it does nothing.
    const client = createFakeUsageClient({
      snapshot: snapshotOf([
        providerStateOf('codex', [metricOf({ key: 'codex.primary.used', value: 42, unit: 'percent', direction: 'used' })]),
        providerStateOf(
          'glm',
          [metricOf({ key: 'quota.5h.used', value: 28, unit: 'percent', direction: 'used', connection: { provider: 'glm', connection: 'quota' } })],
          { connection: { provider: 'glm', connection: 'quota' } }
        ),
        providerStateOf(
          'glm',
          [
            metricOf({
              key: 'wallet.CNY.balance',
              value: 12.5,
              unit: 'CNY',
              direction: 'balance',
              confidence: ['experimental'],
              connection: { provider: 'glm', connection: 'wallet' }
            })
          ],
          { connection: { provider: 'glm', connection: 'wallet' } }
        )
      ]),
      settings: defaultPanelSettings({ glmWalletEnabled: true })
    });
    renderPanel({ client });

    // Enabled: the card shows what the connection collected.
    expect(within(await screen.findByTestId('card-glm')).getByText('¥ 12.50')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '配置 GLM' }));
    await screen.findByTestId('settings-glm');
    fireEvent.click(screen.getByRole('checkbox', { name: '启用实验钱包连接' }));
    await waitFor(() => expect(client.currentSettings().glmWalletEnabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));

    // Off: no wallet module at all, and the quota connection keeps its reading.
    const card = screen.getByTestId('card-glm');
    expect(within(card).queryByTestId('glm-wallet')).not.toBeInTheDocument();
    expect(within(card).queryByText('¥ 12.50')).not.toBeInTheDocument();
    expect(within(card).getByRole('group', { name: /5 小时额度/ })).toBeInTheDocument();
  });

  it('keeps the previous DeepSeek key when a replacement fails to validate', async () => {
    const client = createFakeUsageClient({
      snapshot: panelSnapshot(),
      settings: defaultPanelSettings({ credentials: { ...defaultPanelSettings().credentials, deepseek: { configured: true, suffix: '9012' } } }),
      validateError: 'DeepSeek rejected the API key'
    });
    renderPanel({ client });
    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));

    const input = (await screen.findByLabelText('DeepSeek API Key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并替换' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('DeepSeek rejected the API key');
    expect(screen.queryByText(/密钥已验证并保存/)).not.toBeInTheDocument();
    // The previous credential is still the one in place, and the input keeps the
    // rejected value so it can be corrected.
    expect(screen.getByText('已保存 ····9012')).toBeInTheDocument();
    expect(input.value).toBe('sk-wrong');
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
  });

  it('keeps the DeepSeek wallet connection block free of secondary explanations', async () => {
    const detail = 'the experimental DeepSeek web usage connection is disabled';
    const client = createFakeUsageClient({
      snapshot: snapshotOf([
        {
          provider: 'deepseek',
          error: { kind: 'missing_config', message: detail, at: '2026-09-10T08:00:00.000Z' }
        }
      ])
    });
    renderPanel({ client });
    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));

    const view = await screen.findByTestId('settings-deepseek');
    const walletBlock = within(view).getByRole('heading', { name: '钱包连接' }).closest('section');
    expect(walletBlock).not.toHaveTextContent(detail);
    expect(walletBlock).not.toHaveTextContent('与网页版共用密钥');
  });

  it('saves a valid DeepSeek key, clears the input and shows only the mask', async () => {
    const settings = defaultPanelSettings();
    const client = createFakeUsageClient({
      snapshot: panelSnapshot(),
      settings: { ...settings, credentials: { ...settings.credentials, deepseek: { configured: false } } }
    });
    renderPanel({ client });
    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));

    const input = (await screen.findByLabelText('DeepSeek API Key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-live-7788' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并保存' }));

    await waitFor(() => expect(client.methodCalls('validateCredential')).toHaveLength(1));
    expect(client.methodCalls('validateCredential')[0]).toEqual(['deepseek', 'sk-live-7788']);
    // The mask row *is* the confirmation: a save leaves the form looking exactly
    // like the same form at rest, with no extra sentence and no displaced delete
    // button.
    expect(await screen.findByText('已保存 ····7788')).toBeInTheDocument();
    expect(screen.queryByText(/已验证并保存/)).not.toBeInTheDocument();
    expect(input.value).toBe('');
    // And the freshly configured connection is collected right away, so walking
    // back to the overview shows its data instead of an empty card.
    await waitFor(() => expect(client.methodCalls('refresh')).toEqual([['deepseek']]));
  });

  it('keeps the delete button on the status line while a reason fills the row below', async () => {
    const client = createFakeUsageClient({
      snapshot: panelSnapshot(),
      validateError: 'DeepSeek rejected the API key'
    });
    renderPanel({ client });
    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));

    const input = (await screen.findByLabelText('DeepSeek API Key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并替换' }));
    await screen.findByRole('alert');

    // The message claims a full row of its own, so it has to come last: a flex row
    // breaks in DOM order, and a button written after it was pushed onto its own
    // line under the state.
    const row = screen.getByText('已保存 ····9012').parentElement!;
    const children = [...row.children];
    expect(children.map((node) => node.tagName.toLowerCase())).toEqual(['span', 'button', 'span']);
    expect(children[1]).toHaveTextContent('删除');
    expect(children[2]).toHaveClass('credential-feedback');
  });

  it('collects GLM as soon as the experimental wallet connection is switched on', async () => {
    const { client } = renderPanel({ settings: { glmWalletEnabled: false } });
    fireEvent.click(await screen.findByRole('button', { name: '配置 GLM' }));
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('checkbox', { name: '启用实验钱包连接' }));

    await waitFor(() => expect(client.methodCalls('refresh')).toEqual([['glm']]));
  });

  it('deletes a platform credential from its own form', async () => {
    const { client } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));
    await screen.findByTestId('settings-deepseek');

    fireEvent.click(screen.getByRole('button', { name: '删除 DeepSeek API Key' }));
    await waitFor(() => expect(client.methodCalls('deleteCredential')).toEqual([['deepseek']]));
    expect(await screen.findByText(/已删除该平台账号凭据/)).toBeInTheDocument();
    // And the platform is collected again, so the connection's status stops
    // claiming 数据正常 for a reading whose key no longer exists.
    await waitFor(() => expect(client.methodCalls('refresh')).toEqual([['deepseek']]));
  });

  it('collects the platform again when a setting changes what is collected', async () => {
    // Which endpoint answers (region), which CLI collects Codex, and whether an
    // experimental connection is on at all: each of them invalidates the reading
    // on screen, so the card is refreshed instead of showing the previous answer.
    const { client } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 GLM' }));
    await screen.findByTestId('settings-glm');

    fireEvent.click(screen.getByRole('button', { name: '国际区' }));
    await waitFor(() => expect(client.methodCalls('refresh')).toEqual([['glm']]));

    fireEvent.click(screen.getByRole('button', { name: '返回用量总览' }));
    fireEvent.click(await screen.findByRole('button', { name: '配置 Codex' }));
    await screen.findByTestId('settings-codex');
    const path = screen.getByLabelText('Codex CLI 绝对路径') as HTMLInputElement;
    fireEvent.change(path, { target: { value: '/opt/homebrew/bin/codex' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(client.methodCalls('refresh')).toEqual([['glm'], ['codex']]));
  });
});

describe('platform switch disable scope', () => {
  it('disables only the switch whose own write is in flight', () => {
    render(
      <PlatformSettings
        settings={defaultPanelSettings({})}
        states={{}}
        toggling={new Set<ProviderId>(['glm'])}
        onToggle={vi.fn()}
        onReorder={vi.fn()}
      />
    );

    expect(screen.getByRole('checkbox', { name: '显示 GLM' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '显示 Codex' })).not.toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '显示 DeepSeek' })).not.toBeDisabled();
  });

  it('leaves every switch usable when no visibility write is in flight', () => {
    render(
      <PlatformSettings
        settings={defaultPanelSettings({})}
        states={{}}
        toggling={new Set<ProviderId>()}
        onToggle={vi.fn()}
        onReorder={vi.fn()}
      />
    );

    for (const name of ['显示 Codex', '显示 GLM', '显示 DeepSeek']) {
      expect(screen.getByRole('checkbox', { name })).not.toBeDisabled();
    }
  });
});

describe('platform settings ordering', () => {
  const ROW_HEIGHT = 40;

  function renderOrdering(onReorder = vi.fn()) {
    // jsdom has no layout: inject a 40px-per-row measurement so the drag's
    // slot detection behaves like the real thing.
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
    // GLM sits in the second slot (40–80) and is grabbed 20px into it. The
    // pointer moves to 90, whose slot belongs to DeepSeek, so GLM is swapped
    // down one place while still tracking the cursor: its slot moved 40px down,
    // the pointer moved 30px down, so it hangs 10px above the pointer relative
    // to where it started.
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
    const domOrder = () =>
      [...list.children].map((child) => (child as HTMLElement).dataset.provider ?? '');

    // Replay the row's style writes and the list's reorders in the order they
    // happened: MutationObserver delivers one batch per observed target in
    // mutation order, so the interleaving below is the real one. A transform is
    // only valid if it matches the slot the *DOM* had at that very moment —
    // writing it a frame before the reorder commits paints the row a row-height
    // away from where it belongs, and that jump is the flash this guards.
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
    await waitFor(() => expect(records.filter((record) => record.transform.startsWith('translateY(')).length).toBeGreaterThan(1));
    observer.disconnect();

    // Measurement writes (`none`, and the value they restore) are not positioning,
    // so only the translate writes are positions.
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
    renderPanel({
      settings: {
        deepseekWebEnabled: true,
        credentials: {
          ...settings.credentials,
          deepseek: { configured: false },
          'deepseek-web': { configured: false }
        }
      }
    });
    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));
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
    const { client } = renderPanel({ settings: { deepseekWebEnabled: false } });
    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));
    await screen.findByTestId('settings-deepseek');

    // Off by default: the toggle is unchecked and no token form is rendered.
    expect(screen.getByRole('checkbox', { name: '启用网页用量连接' })).not.toBeChecked();
    expect(screen.queryByLabelText('DeepSeek 网页登录 Token')).not.toBeInTheDocument();
    expect(screen.queryByText('按后台账单显示今日消费；非公开接口，可能失效。')).not.toBeInTheDocument();
    expect(screen.queryByText('关闭后改用估算，保留 Token')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '启用网页用量连接' }));
    await waitFor(() => expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ deepseekWebEnabled: true }));
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
        failedStateOf(
          'deepseek',
          { kind: 'compatibility', message: 'unsupported response', at: '2026-09-10T08:00:00.000Z' },
          { connection: { provider: 'deepseek', connection: 'web' } }
        )
      ])
    });
    renderPanel({ client });

    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));
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
    renderPanel({ client });

    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));
    const view = await screen.findByTestId('settings-deepseek');
    const webBlock = within(view).getByRole('heading', { name: '网页用量连接' }).closest('section')!;

    // A rejected token is a paste problem, not a redesign: the block says which,
    // the stored token still shows its mask, and the paste entry is still there.
    expect(within(webBlock).getByText('登录态无效或已过期，请重新粘贴 Token。')).toBeInTheDocument();
    expect(within(webBlock).queryByText('接口可能已改版，网页用量暂不展示。')).not.toBeInTheDocument();
    expect(within(webBlock).getByText('已保存 ····abcd')).toBeInTheDocument();
    expect(within(webBlock).getByPlaceholderText('粘贴 Authorization Token')).toBeInTheDocument();
  });

  it('keeps the stored token when the connection is switched off', async () => {
    const { client } = renderPanel({
      settings: {
        deepseekWebEnabled: true,
        credentials: { ...defaultPanelSettings().credentials, 'deepseek-web': { configured: true, suffix: 'abcd' } }
      }
    });
    fireEvent.click(await screen.findByRole('button', { name: '配置 DeepSeek' }));
    await screen.findByTestId('settings-deepseek');

    expect(screen.getByText('已保存 ····abcd')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '启用网页用量连接' }));

    // The main card hides web usage again, but the token itself is kept for a
    // later re-enable: only `updateSettings` runs, never a credential delete.
    await waitFor(() => expect(client.methodCalls('updateSettings')[0]?.[0]).toEqual({ deepseekWebEnabled: false }));
    expect(client.methodCalls('deleteCredential')).toHaveLength(0);
  });
});

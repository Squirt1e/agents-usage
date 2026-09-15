// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PanelApp } from '../src/desktop/PanelApp';
import { createFakeUsageClient, failedStateOf, metricOf, providerStateOf, snapshotOf } from '../src/desktop/fake-client';
import { parsePanelSnapshot, type PanelSettings, type PanelSnapshot } from '../src/shared/desktop-contract';
import { defaultPanelSettings } from '../src/desktop/fake-client';
import { connectionIssues, issueHeading } from '../src/desktop/connection-issues';

const NOW = new Date('2026-09-10T08:00:00.000Z');
const LONG_ERROR = 'Codex app-server error -32603: failed to refresh quota because the upstream connection was interrupted';
const WEB_DETAIL = 'the experimental DeepSeek web usage credential is not configured';
const WALLET_DETAIL = 'the experimental GLM wallet connection is disabled';

function show(snapshot: PanelSnapshot, settings: Partial<PanelSettings> = {}) {
  const client = createFakeUsageClient({ snapshot, settings });
  render(
    <PanelApp
      client={client}
      host={{ pinned: false, onTogglePin: vi.fn(), onRequestHide: vi.fn(), onSetHeight: vi.fn() }}
      now={NOW}
    />
  );
  return client;
}

/**
 * What the service really publishes for an optional connection that has never
 * captured anything: the identity exists only in `connections` — a state-level
 * `connection` and the snapshot that would carry one both arrive with the first
 * successful capture, which a switched-off or unconfigured connection never has.
 */
function neverSucceededSnapshot(): PanelSnapshot {
  return parsePanelSnapshot({
    providers: [
      {
        provider: 'glm',
        error: { kind: 'missing_config', message: WALLET_DETAIL, at: '2026-09-10T08:05:00.000Z' },
        connections: [{ provider: 'glm', connection: 'wallet' }]
      },
      {
        provider: 'deepseek',
        error: { kind: 'missing_config', message: WEB_DETAIL, at: '2026-09-10T08:05:00.000Z' },
        connections: [{ provider: 'deepseek', connection: 'web' }]
      }
    ]
  });
}

describe('connection details outside cards', () => {
  it('keeps a failed card free of error text and recovery buttons while exposing the full reason in a floating detail', async () => {
    const cached = providerStateOf('codex', [
      metricOf({ key: 'codex.primary.used', value: 42, unit: 'percent', direction: 'used', windowSeconds: 18_000 })
    ], { status: 'degraded' });
    show(snapshotOf([
      failedStateOf('codex', { kind: 'network', message: LONG_ERROR, at: '2026-09-10T08:05:00.000Z' }, { snapshot: cached.snapshot }),
      providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 45.34, unit: 'CNY', direction: 'balance' })])
    ]));

    const card = await screen.findByTestId('card-codex');
    expect(within(card).queryByText(LONG_ERROR)).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument();
    expect(within(card).queryByTestId('state-codex')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '配置 Codex' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '连接异常 1' }));
    const detail = screen.getByRole('dialog', { name: '连接状态' });
    expect(detail.closest('.panel-bottom')).not.toBeNull();
    expect(detail.closest('.panel-body')).toBeNull();
    expect(within(detail).getByText(LONG_ERROR)).toBeInTheDocument();
    expect(within(detail).getByText('网络异常')).toBeInTheDocument();
    expect(within(detail).queryByRole('button')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '连接状态' })).not.toBeInTheDocument();
  });

  it('removes a recovered connection from the footer and open detail', async () => {
    const client = show(snapshotOf([
      failedStateOf('deepseek', { kind: 'network', message: 'temporary outage', at: '2026-09-10T08:05:00.000Z' })
    ]));
    fireEvent.click(await screen.findByRole('button', { name: '连接异常 1' }));
    expect(screen.getByText('temporary outage')).toBeInTheDocument();

    client.emit({ type: 'snapshot', snapshot: snapshotOf([
      providerStateOf('deepseek', [metricOf({ key: 'wallet.CNY.total', value: 45.34, unit: 'CNY', direction: 'balance' })])
    ]) });
    await waitFor(() => expect(screen.queryByRole('button', { name: '连接异常 1' })).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: '连接状态' })).not.toBeInTheDocument();
  });

  it('counts only visible, enabled connections whose error is newer than success', () => {
    const staleError = failedStateOf('codex', {
      kind: 'network', message: 'old failure', at: '2026-09-10T08:00:00.000Z'
    }, {
      snapshot: providerStateOf('codex', [], { capturedAt: '2026-09-10T08:10:00.000Z' }).snapshot
    });
    const hidden = failedStateOf('deepseek', {
      kind: 'network', message: 'hidden failure', at: '2026-09-10T08:05:00.000Z'
    });
    const disabled = failedStateOf('glm', {
      kind: 'compatibility', message: 'wallet failure', at: '2026-09-10T08:05:00.000Z'
    }, { connection: { provider: 'glm', connection: 'wallet' } });
    const active = failedStateOf('glm', {
      kind: 'authentication', message: 'quota failure', at: '2026-09-10T08:05:00.000Z'
    }, { connection: { provider: 'glm', connection: 'quota' } });
    const settings = defaultPanelSettings({ platformVisibility: { deepseek: false }, glmWalletEnabled: false });
    const issues = connectionIssues(snapshotOf([staleError, hidden, disabled, active]), settings);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ provider: 'glm', connection: 'Coding Plan', status: '认证失败', message: 'quota failure' });
  });

  it('files a never-succeeded optional connection under the name the service reported', () => {
    const settings = defaultPanelSettings({ deepseekWebEnabled: true, glmWalletEnabled: true });
    const issues = connectionIssues(neverSucceededSnapshot(), settings);
    // The wallet failure is the wallet's and the web failure is the web's: a
    // connection with no snapshot yet must not be filed as the plan/balance one.
    expect(issues.map(issueHeading)).toEqual(['GLM · 钱包', 'DeepSeek · 网页用量']);
    expect(issues.map((issue) => issue.message)).toEqual([WALLET_DETAIL, WEB_DETAIL]);
  });

  it('follows each optional connection switch even before its first success', () => {
    const snapshot = neverSucceededSnapshot();
    expect(
      connectionIssues(snapshot, defaultPanelSettings({ deepseekWebEnabled: false, glmWalletEnabled: false }))
    ).toEqual([]);
    expect(
      connectionIssues(snapshot, defaultPanelSettings({ deepseekWebEnabled: true, glmWalletEnabled: false })).map(issueHeading)
    ).toEqual(['DeepSeek · 网页用量']);
    expect(
      connectionIssues(snapshot, defaultPanelSettings({ deepseekWebEnabled: false, glmWalletEnabled: true })).map(issueHeading)
    ).toEqual(['GLM · 钱包']);
  });

  it('leaves the footer and its detail empty while every optional connection is off', async () => {
    show(neverSucceededSnapshot(), { deepseekWebEnabled: false, glmWalletEnabled: false });

    expect(await screen.findByTestId('overview')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^连接异常/ })).not.toBeInTheDocument();
    expect(screen.queryByText(WEB_DETAIL)).not.toBeInTheDocument();
    expect(screen.queryByText(WALLET_DETAIL)).not.toBeInTheDocument();
  });

  it('lists each enabled optional connection under its own name', async () => {
    show(neverSucceededSnapshot(), { deepseekWebEnabled: true, glmWalletEnabled: true });

    fireEvent.click(await screen.findByRole('button', { name: '连接异常 2' }));
    const detail = screen.getByRole('dialog', { name: '连接状态' });
    expect(within(detail).getByText('GLM · 钱包')).toBeInTheDocument();
    expect(within(detail).getByText('DeepSeek · 网页用量')).toBeInTheDocument();
    expect(within(detail).getByText(WEB_DETAIL)).toBeInTheDocument();
    // The balance connection never carries the web connection's failure.
    expect(within(detail).queryByText('DeepSeek · 余额')).not.toBeInTheDocument();
  });

  it('never appends failure messages or recovery entries to any provider card', async () => {
    show(snapshotOf([
      failedStateOf('codex', { kind: 'network', message: 'codex service failure', at: '2026-09-10T08:05:00.000Z' }),
      failedStateOf('glm', { kind: 'authentication', message: 'glm service failure', at: '2026-09-10T08:05:00.000Z' },
        { connection: { provider: 'glm', connection: 'quota' } }),
      failedStateOf('deepseek', { kind: 'compatibility', message: 'deepseek service failure', at: '2026-09-10T08:05:00.000Z' })
    ]));
    for (const provider of ['codex', 'glm', 'deepseek'] as const) {
      const card = await screen.findByTestId(`card-${provider}`);
      expect(card.querySelector('.connection-state')).toBeNull();
      expect(within(card).queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: '前往配置' })).not.toBeInTheDocument();
      expect(card).not.toHaveTextContent(`${provider} service failure`);
    }
    expect(screen.getByRole('button', { name: '连接异常 3' })).toBeInTheDocument();
  });
});

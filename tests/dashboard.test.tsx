// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderSnapshot } from '../src/shared/contracts';
import { Dashboard, formatCountdown, type ProviderViewState } from '../src/client/Dashboard';
import { SettingsPanel, type DashboardSettings } from '../src/client/SettingsPanel';

const now = new Date('2026-09-10T08:00:00.000Z');

function provider(provider: 'codex' | 'glm' | 'deepseek', metrics: ProviderSnapshot['metrics'], status: ProviderSnapshot['status'] = 'connected'): ProviderViewState {
  const snapshot: ProviderSnapshot = {
    provider, status, capturedAt: now.toISOString(), lastSuccessAt: now.toISOString(), source: 'fixture', metrics
  };
  return { provider, snapshot };
}

describe('unified usage dashboard', () => {
  it('keeps all providers visible and gives disconnected providers actionable guidance', () => {
    render(<Dashboard providers={[
      provider('codex', []),
      { provider: 'glm', error: { kind: 'missing_config', message: 'GLM key missing', at: now.toISOString() } },
      { provider: 'deepseek' }
    ]} now={now} onRefresh={vi.fn()} refreshing={new Set()} />);

    expect(screen.getByRole('heading', { name: 'Codex' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'GLM Coding Plan' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'DeepSeek' })).toBeVisible();
    expect(screen.getAllByText('需要配置').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /前往设置/ }).length).toBeGreaterThan(0);
  });

  it('preserves used/remaining semantics and keeps currencies separate', () => {
    render(<Dashboard providers={[
      provider('codex', [
        { key: 'codex.primary.used', label: '5 小时', value: 15, unit: 'percent', direction: 'used', confidence: ['authoritative'], source: 'fixture', resetAt: '2026-09-10T09:00:00.000Z' },
        { key: 'codex.primary.remaining', label: '5 小时', value: 85, unit: 'percent', direction: 'remaining', confidence: ['authoritative'], source: 'fixture' }
      ]),
      provider('glm', []),
      provider('deepseek', [
        { key: 'wallet.USD.total', label: '总余额', value: 12.5, unit: 'USD', direction: 'balance', confidence: ['authoritative'], source: 'fixture' },
        { key: 'wallet.CNY.total', label: '总余额', value: 88, unit: 'CNY', direction: 'balance', confidence: ['authoritative'], source: 'fixture' },
        { key: 'spend.CNY.daily', label: '今日消费', value: 3.2, unit: 'CNY', direction: 'spend', confidence: ['estimated', 'partial'], source: 'fixture' }
      ])
    ]} now={now} onRefresh={vi.fn()} refreshing={new Set()} />);

    const codex = screen.getByTestId('provider-codex');
    expect(within(codex).getByText('已用 15%')).toBeVisible();
    expect(within(codex).getByText('剩余 85%')).toBeVisible();
    const deepseek = screen.getByTestId('provider-deepseek');
    expect(within(deepseek).getByText('US$12.50')).toBeVisible();
    expect(within(deepseek).getByText('¥88.00')).toBeVisible();
    expect(within(deepseek).getByText('估算')).toBeVisible();
    expect(within(deepseek).getByText('部分数据')).toBeVisible();
  });

  it('shows localized reset time and waits for refresh after the countdown expires', () => {
    expect(formatCountdown('2026-09-10T09:00:00.000Z', now)).toBe('1 小时');
    expect(formatCountdown('2026-09-10T07:59:00.000Z', now)).toBe('等待刷新');
  });

  it('reports in-progress refresh state without reloading the page', () => {
    const refresh = vi.fn();
    const { rerender } = render(<Dashboard providers={[provider('codex', []), provider('glm', []), provider('deepseek', [])]} now={now} onRefresh={refresh} refreshing={new Set()} />);
    fireEvent.click(screen.getByRole('button', { name: '刷新 Codex' }));
    expect(refresh).toHaveBeenCalledWith('codex');
    rerender(<Dashboard providers={[provider('codex', []), provider('glm', []), provider('deepseek', [])]} now={now} onRefresh={refresh} refreshing={new Set(['codex'])} />);
    expect(screen.getByRole('button', { name: '正在刷新 Codex' })).toBeDisabled();
  });
});

describe('provider settings', () => {
  const settings: DashboardSettings = {
    glmRegion: 'china', timezone: 'Asia/Shanghai', experimental: { glmWallet: false },
    credentials: { glm: { configured: true, suffix: '1234' }, deepseek: { configured: false }, glmWallet: { configured: false }, codex: { delegated: true } }
  };

  it('never pre-fills secrets and requires explicit experimental opt-in', () => {
    render(<SettingsPanel settings={settings} onSaveCredential={vi.fn()} onDeleteCredential={vi.fn()} onSaveSettings={vi.fn()} />);
    expect(screen.getByLabelText('GLM Coding Plan API Key')).toHaveValue('');
    expect(screen.getByText(/已保存.*1234/)).toBeVisible();
    expect(screen.getByText(/稳定性和凭据风险/)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /启用 GLM 钱包/ })).not.toBeChecked();
  });

  it('shows in-place progress and success while saving a DeepSeek key', async () => {
    let finish!: () => void;
    const saving = new Promise<void>((resolve) => { finish = resolve; });
    const save = vi.fn(() => saving);
    render(<SettingsPanel settings={settings} onSaveCredential={save} onDeleteCredential={vi.fn()} onSaveSettings={vi.fn()} />);
    const input = screen.getByLabelText('DeepSeek API Key');
    const form = input.closest('form')!;

    fireEvent.change(input, { target: { value: 'temporary-deepseek-key' } });
    fireEvent.click(within(form).getByRole('button', { name: '验证并保存' }));

    expect(within(form).getByRole('button', { name: '正在验证…' })).toBeDisabled();
    expect(within(form).getByRole('status')).toHaveTextContent('正在验证并保存…');
    finish();
    await waitFor(() => expect(within(form).getByRole('status')).toHaveTextContent('密钥已验证并保存'));
    expect(input).toHaveValue('');
  });

  it('shows a DeepSeek validation failure beside the form and keeps the entered key', async () => {
    const save = vi.fn(async () => { throw new Error('DeepSeek 拒绝了该 API Key'); });
    render(<SettingsPanel settings={settings} onSaveCredential={save} onDeleteCredential={vi.fn()} onSaveSettings={vi.fn()} />);
    const input = screen.getByLabelText('DeepSeek API Key');
    const form = input.closest('form')!;

    fireEvent.change(input, { target: { value: 'temporary-deepseek-key' } });
    fireEvent.click(within(form).getByRole('button', { name: '验证并保存' }));

    await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('DeepSeek 拒绝了该 API Key'));
    expect(input).toHaveValue('temporary-deepseek-key');
  });
});

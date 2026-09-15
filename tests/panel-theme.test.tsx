// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelApp } from '../src/desktop/PanelApp';
import { createFakeUsageClient } from '../src/desktop/fake-client';
import { parsePanelSettings } from '../src/shared/desktop-contract';

const host = { pinned: false, onTogglePin() {}, onRequestHide() {}, onSetHeight() {} };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('panel theme', () => {
  it('keeps older settings dark and accepts all three preferences', () => {
    expect(parsePanelSettings({}).theme).toBe('dark');
    expect(parsePanelSettings({ theme: 'invalid' }).theme).toBe('dark');
    for (const theme of ['light', 'dark', 'system']) {
      expect(parsePanelSettings({ theme }).theme).toBe(theme);
    }
  });

  it('saves a selection and restores it when the panel is reopened', async () => {
    const client = createFakeUsageClient();
    const panel = render(<PanelApp client={client} host={host} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    // The three theme choices are laid out flat; the active one is pressed.
    const group = await screen.findByRole('group', { name: '主题' });
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '浅色',
      '深色',
      '跟随系统'
    ]);
    expect(within(group).getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: '浅色' }));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
    panel.unmount();
    render(<PanelApp client={client} host={host} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const reopened = await screen.findByRole('group', { name: '主题' });
    expect(within(reopened).getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves one selected pill between theme choices instead of replacing it', async () => {
    const left: Record<string, number> = { '浅色': 3, '深色': 44, '跟随系统': 85 };
    const width: Record<string, number> = { '浅色': 39, '深色': 39, '跟随系统': 72 };
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return left[this.textContent ?? ''] ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return width[this.textContent ?? ''] ?? 0;
    });

    render(<PanelApp client={createFakeUsageClient()} host={host} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const group = await screen.findByRole('group', { name: '主题' });
    const pill = group.querySelector('.segmented-slider') as HTMLElement | null;
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(pill?.style.transform).toBe('translateX(44px)');
    expect(pill?.style.width).toBe('39px');

    fireEvent.click(within(group).getByRole('button', { name: '跟随系统' }));
    await waitFor(() => expect(pill?.style.transform).toBe('translateX(85px)'));
    expect(pill?.style.width).toBe('72px');
    expect(group.querySelector('.segmented-slider')).toBe(pill);
  });

  it('reacts to system changes only while following the system', async () => {
    const media = new EventTarget();
    Object.assign(media, { matches: false });
    vi.stubGlobal('matchMedia', () => media);
    const client = createFakeUsageClient({ settings: { theme: 'system' } });
    const panel = render(<PanelApp client={client} host={host} />);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
    act(() => { Object.assign(media, { matches: true }); media.dispatchEvent(new Event('change')); });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const group = await screen.findByRole('group', { name: '主题' });
    fireEvent.click(within(group).getByRole('button', { name: '浅色' }));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
    act(() => media.dispatchEvent(new Event('change')));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    panel.unmount();
    act(() => media.dispatchEvent(new Event('change')));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('retains the active theme and reports a failed save', async () => {
    const client = createFakeUsageClient();
    vi.spyOn(client, 'updateSettings').mockRejectedValue(new Error('设置保存失败'));
    render(<PanelApp client={client} host={host} />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    const group = await screen.findByRole('group', { name: '主题' });
    fireEvent.click(within(group).getByRole('button', { name: '浅色' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('设置保存失败');
    expect(within(group).getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });
});

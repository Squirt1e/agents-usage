// @vitest-environment jsdom
// The theme preference. It is a *setting*, so the controls live in the settings
// window's 外观 section — but the theme itself is worn by both windows, so this file
// drives the setting through the settings window and watches `document.documentElement`
// (which each document resolves for itself, from the same store).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeUsageClient } from '../../src/desktop/lib/fake-client';
import { parsePanelSettings } from '../../src/shared/desktop-contract';
import { renderSettings } from '../helpers/windows';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const themeGroup = async () => screen.findByRole('group', { name: '主题' });

describe('theme preference', () => {
  it('keeps older settings dark and accepts all three preferences', () => {
    expect(parsePanelSettings({}).theme).toBe('dark');
    expect(parsePanelSettings({ theme: 'invalid' }).theme).toBe('dark');
    for (const theme of ['light', 'dark', 'system']) {
      expect(parsePanelSettings({ theme }).theme).toBe(theme);
    }
  });

  it('saves a selection and restores it when the window is reopened', async () => {
    const client = createFakeUsageClient();
    const first = renderSettings({ client, section: 'appearance' });
    const group = await themeGroup();
    // The three theme choices are laid out flat; the active one is pressed.
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '浅色',
      '深色',
      '跟随系统'
    ]);
    expect(within(group).getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(group).getByRole('button', { name: '浅色' }));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));

    // Reopening reads the stored preference: the save went to the service, not just
    // to this window's memory.
    first.unmount();
    renderSettings({ client, section: 'appearance' });
    const reopened = await themeGroup();
    expect(within(reopened).getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves one selected pill between theme choices instead of replacing it', async () => {
    const left: Record<string, number> = { 浅色: 3, 深色: 44, 跟随系统: 85 };
    const width: Record<string, number> = { 浅色: 39, 深色: 39, 跟随系统: 72 };
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return left[this.textContent ?? ''] ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return width[this.textContent ?? ''] ?? 0;
    });

    renderSettings({ section: 'appearance' });
    const group = await themeGroup();
    const pill = group.querySelector('.segmented-slider') as HTMLElement | null;
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(pill?.style.transform).toBe('translateX(44px)');
    expect(pill?.style.width).toBe('39px');

    fireEvent.click(within(group).getByRole('button', { name: '跟随系统' }));
    await waitFor(() => expect(pill?.style.transform).toBe('translateX(85px)'));
    expect(pill?.style.width).toBe('72px');
    // The same element travelled: a replaced pill would restart the transition.
    expect(group.querySelector('.segmented-slider')).toBe(pill);
  });

  it('reacts to system changes only while following the system', async () => {
    const media = new EventTarget();
    Object.assign(media, { matches: false });
    vi.stubGlobal('matchMedia', () => media);
    const client = createFakeUsageClient({ settings: { theme: 'system' } });
    const window = renderSettings({ client, section: 'appearance' });
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
    act(() => {
      Object.assign(media, { matches: true });
      media.dispatchEvent(new Event('change'));
    });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    const group = await themeGroup();
    fireEvent.click(within(group).getByRole('button', { name: '浅色' }));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'));
    act(() => media.dispatchEvent(new Event('change')));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    // A closed window stops listening: the preference is the theme now, and the
    // system's opinion is not even being asked for.
    window.unmount();
    act(() => media.dispatchEvent(new Event('change')));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('retains the active theme when the save fails', async () => {
    const client = createFakeUsageClient();
    const updateSettings = vi.spyOn(client, 'updateSettings').mockRejectedValue(new Error('设置保存失败'));
    renderSettings({ client, section: 'appearance' });
    const group = await themeGroup();
    fireEvent.click(within(group).getByRole('button', { name: '浅色' }));

    // The selection did not take: the store still holds the stored theme, so the
    // control and the document both stay on it. (Where the failure is *said* is the
    // panel's business — it owns the message stack; see panel-settings.test.tsx.)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ theme: 'light' }));
    expect(within(group).getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });
});

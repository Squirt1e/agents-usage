// @vitest-environment jsdom
// The panel's half of the settings contract.
//
// The panel no longer *contains* any settings: every entry point asks the host for a
// section, and the host turns that into the settings window. What this file pins is
// therefore the mapping — which control asks for which section — plus the frame's own
// behaviour that used to be tangled up with the page swaps: Escape, and the settings
// the panel *wears* rather than edits (the theme, the visible platforms, the order).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPanelSettings } from '../src/desktop/fake-client';
import { renderPanel } from './helpers/windows';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the panel opens the settings window', () => {
  it('asks for 外观 from the header button', async () => {
    const { onOpenSettings } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(onOpenSettings).toHaveBeenCalledWith('appearance');
    // Nothing was swapped out: the overview is the panel's only page, and the
    // settings surface is not rendered here at all.
    expect(screen.getByTestId('overview')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-window')).not.toBeInTheDocument();
  });

  it('asks for the platform whose card gear was clicked', async () => {
    const { onOpenSettings } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '配置 GLM' }));

    expect(onOpenSettings).toHaveBeenCalledWith('glm');
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('asks for 平台管理 from the empty state, which is the way back', async () => {
    const { onOpenSettings } = renderPanel({
      settings: { platformVisibility: { codex: false, glm: false, deepseek: false } }
    });
    const empty = await screen.findByTestId('empty-selection');
    fireEvent.click(within(empty).getByRole('button', { name: '管理平台' }));

    expect(onOpenSettings).toHaveBeenCalledWith('platforms');
  });

  it('keeps the frame own Escape behaviour', async () => {
    // With no connection issue there is no detail layer to close, so Escape is the
    // host's hide — and the settings window, which has its own rule for it, is not
    // involved.
    const onRequestHide = vi.fn();
    renderPanel({ onRequestHide });
    await screen.findByTestId('overview');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onRequestHide).toHaveBeenCalledTimes(1);
  });
});

describe('the panel wears settings it does not edit', () => {
  it('applies a setting written in the other window without a re-open', async () => {
    const { client } = renderPanel();
    await screen.findByTestId('card-codex');

    client.emit({ type: 'settings', settings: { ...defaultPanelSettings(), theme: 'light' } });

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
  });

  it('takes a platform off the overview when the other window hides it', async () => {
    const { client } = renderPanel();
    await screen.findByTestId('card-glm');

    client.emit({
      type: 'settings',
      settings: { ...defaultPanelSettings(), platformVisibility: { glm: false } }
    });

    await waitFor(() => expect(screen.queryByTestId('card-glm')).not.toBeInTheDocument());
    // Hiding is display only: the other cards are untouched and nothing is collected.
    expect(screen.getByTestId('card-codex')).toBeInTheDocument();
    expect(client.methodCalls('refresh')).toEqual([]);
  });

  it('puts a platform back when the other window shows it again', async () => {
    const { client } = renderPanel({ settings: { platformVisibility: { glm: false } } });
    await screen.findByTestId('card-codex');
    expect(screen.queryByTestId('card-glm')).not.toBeInTheDocument();

    client.emit({
      type: 'settings',
      settings: { ...defaultPanelSettings(), platformVisibility: { glm: true } }
    });

    expect(await screen.findByTestId('card-glm')).toBeInTheDocument();
  });

  it('reorders the cards when the other window writes a new order', async () => {
    const { client } = renderPanel();
    await screen.findByTestId('card-codex');

    client.emit({
      type: 'settings',
      settings: { ...defaultPanelSettings(), platformOrder: ['deepseek', 'glm', 'codex'] }
    });

    await waitFor(() => {
      const cards = [...document.querySelectorAll('.provider-card')].map((card) =>
        card.getAttribute('data-testid')
      );
      expect(cards).toEqual(['card-deepseek', 'card-glm', 'card-codex']);
    });
  });
});

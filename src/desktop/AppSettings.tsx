/**
 * The panel's settings page.
 *
 * Opened from the header's settings (gear) button. Platform management is the
 * first section, because choosing which platforms the overview shows — and in
 * which order — is the setting users reach for most; per-platform connections
 * stay on their own card's gear, so this page never mixes in credentials.
 */

import { useState } from 'react';
import type { DesktopProviderState, PanelSettings } from '../shared/desktop-contract';
import type { ProviderId } from '../shared/contracts';
import { PlatformSettings } from './PlatformSettings';
import { SegmentedGroup } from './SegmentedGroup';

const THEME_OPTIONS: Array<{ value: PanelSettings['theme']; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' }
];

const QUOTA_VALUE_OPTIONS: Array<{ value: PanelSettings['quotaValueMode']; label: string }> = [
  { value: 'remaining', label: '剩余' },
  { value: 'used', label: '已用' }
];

export interface AppSettingsProps {
  settings: PanelSettings;
  states: Partial<Record<ProviderId, DesktopProviderState | undefined>>;
  busy?: boolean;
  /** Platforms with a visibility write in flight; only their own switch dims. */
  togglingVisibility: ReadonlySet<ProviderId>;
  onToggleVisibility(provider: ProviderId, visible: boolean): void;
  onReorder(order: ProviderId[]): void;
  onThemeChange(theme: PanelSettings['theme']): Promise<void>;
  onQuotaValueModeChange(mode: PanelSettings['quotaValueMode']): Promise<void>;
}

export function AppSettings(props: AppSettingsProps) {
  const [savingAppearance, setSavingAppearance] = useState<'theme' | 'quota' | null>(null);
  // Settings writes remain serialized; only the edited control is ever disabled
  // — the group being saved here, the platform switch being toggled there — so
  // an unrelated choice never blinks during a save.
  const saveAppearance = async (kind: 'theme' | 'quota', save: () => Promise<void>) => {
    if (props.busy) return;
    setSavingAppearance(kind);
    try {
      await save();
    } finally {
      setSavingAppearance(null);
    }
  };

  return (
    <div className="app-settings" data-testid="app-settings">
      <PlatformSettings
        settings={props.settings}
        states={props.states}
        toggling={props.togglingVisibility}
        onToggle={props.onToggleVisibility}
        onReorder={props.onReorder}
      />
      <section className="config-block" data-panel-block="section" aria-labelledby="appearance-heading">
        <h3 id="appearance-heading">外观</h3>
        <div className="setting-row">
          <span className="setting-label">主题</span>
          <SegmentedGroup label="主题">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segmented-option${props.settings.theme === option.value ? ' is-active' : ''}`}
                aria-pressed={props.settings.theme === option.value}
                disabled={props.busy && savingAppearance === 'theme'}
                aria-disabled={props.busy && savingAppearance !== 'theme' ? true : undefined}
                onClick={() => void saveAppearance('theme', () => props.onThemeChange(option.value))}
              >
                {option.label}
              </button>
            ))}
          </SegmentedGroup>
        </div>
        <div className="setting-row">
          <span className="setting-label">额度数值</span>
          <SegmentedGroup label="额度数值">
            {QUOTA_VALUE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`segmented-option${props.settings.quotaValueMode === option.value ? ' is-active' : ''}`}
                aria-pressed={props.settings.quotaValueMode === option.value}
                disabled={props.busy && savingAppearance === 'quota'}
                aria-disabled={props.busy && savingAppearance !== 'quota' ? true : undefined}
                onClick={() => void saveAppearance('quota', () => props.onQuotaValueModeChange(option.value))}
              >
                {option.label}
              </button>
            ))}
          </SegmentedGroup>
        </div>
      </section>
    </div>
  );
}

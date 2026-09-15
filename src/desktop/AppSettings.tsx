/**
 * The panel-level settings, split into the two sections the settings window shows.
 *
 * `part` decides which half is rendered: the settings window gives 平台管理 and 外观
 * their own sections, while the overview's own entry points only ever need one of
 * them. Both halves stay in this one file because they share the busy bookkeeping
 * and the wording; only their placement differs.
 *
 * Platform management is the first section of the settings window, because choosing
 * which platforms the overview shows — and in which order — is the setting users
 * reach for most; per-platform connections stay in their own platform's section, so
 * this component never mixes in credentials.
 */

import { useEffect, useRef, useState } from 'react';
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
  /** Which half to render. The settings window renders one per section. */
  part?: 'platforms' | 'appearance' | 'both';
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
  const part = props.part ?? 'both';
  const [savingAppearance, setSavingAppearance] = useState<'theme' | 'quota' | null>(null);
  /**
   * Whether this half is still on screen. The settings window unmounts a section
   * when the reader moves to another one, and a write that lands afterwards would
   * otherwise set state on a component nobody renders — the classic React warning,
   * and in the panel's history a stale `disabled` that survived a page swap.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Settings writes remain serialized; only the edited control is ever disabled
  // — the group being saved here, the platform switch being toggled there — so
  // an unrelated choice never blinks during a save.
  const saveAppearance = async (kind: 'theme' | 'quota', save: () => Promise<void>) => {
    if (props.busy) return;
    setSavingAppearance(kind);
    try {
      await save();
    } finally {
      if (mounted.current) setSavingAppearance(null);
    }
  };

  return (
    <div className="app-settings" data-testid="app-settings">
      {part === 'appearance' ? null : (
        <PlatformSettings
          settings={props.settings}
          states={props.states}
          toggling={props.togglingVisibility}
          onToggle={props.onToggleVisibility}
          onReorder={props.onReorder}
        />
      )}
      {part === 'platforms' ? null : (
        <section className="config-block" aria-labelledby="appearance-heading">
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
      )}
    </div>
  );
}

/**
 * The panel-level settings, split into the two sections the settings window shows.
 *
 * `part` decides which half is rendered: the settings window gives 平台管理 and 外观
 * their own sections. It is always exactly one of them today — the "both" default is
 * what the panel's own entry points used before the settings window existed, and the
 * two halves stay in this file because they are the same surface's two sections
 * rather than two features.
 *
 * Each half owns its own in-flight bookkeeping: 平台管理 dims only the row whose
 * visibility is being written, 外观 disables its own two groups while either is
 * saving. Nothing here waits on a flag from another section — a busy signal that
 * only moves in the platform panes is a busy signal that is permanently false in
 * this one, which is exactly the bug the appearance controls shipped with.
 *
 * Platform management is the first section of the settings window, because choosing
 * which platforms the overview shows — and in which order — is the setting users
 * reach for most; per-platform connections stay in their own platform's section, so
 * this component never mixes in credentials.
 */

import { useEffect, useRef, useState } from 'react';
import type { DesktopProviderState, PanelSettings } from '../../shared/desktop-contract';
import type { ProviderId } from '../../shared/contracts';
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
  /** Platforms with a visibility write in flight; only their own switch dims. */
  togglingVisibility: ReadonlySet<ProviderId>;
  onToggleVisibility(provider: ProviderId, visible: boolean): void;
  onReorder(order: ProviderId[]): void;
  onThemeChange(theme: PanelSettings['theme']): Promise<void>;
  onQuotaValueModeChange(mode: PanelSettings['quotaValueMode']): Promise<void>;
  onQuotaWarningThresholdChange(threshold: number): Promise<void>;
  onBalanceWarningThresholdChange(threshold: number): Promise<void>;
}

export function AppSettings(props: AppSettingsProps) {
  const part = props.part ?? 'both';
  /**
   * Which appearance write is in flight, or null.
   *
   * This used to be gated on a `busy` prop the pane handed down from its own
   * provider-write counter — a counter that only moves inside the platform
   * sections, so in 平台管理 and 外观 it was permanently false. The result was a
   * guard that never fired, a `disabled` that never applied, and `aria-disabled`
   * on the wrong control; the one visible consequence was that choosing a theme
   * produced no feedback at all, and a second click sent a second write. This
   * state is the real one, and it disables both groups while either is saving:
   * something visibly unavailable beats something silently ignored.
   */
  const [savingAppearance, setSavingAppearance] = useState<'theme' | 'quota' | null>(null);
  const [thresholdDraft, setThresholdDraft] = useState(String(props.settings.quotaWarningThreshold));
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [thresholdFeedback, setThresholdFeedback] = useState('');
  const [balanceThresholdDraft, setBalanceThresholdDraft] = useState(
    String(props.settings.balanceWarningThreshold)
  );
  const [savingBalanceThreshold, setSavingBalanceThreshold] = useState(false);
  const [balanceThresholdFeedback, setBalanceThresholdFeedback] = useState('');
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

  useEffect(() => {
    if (!savingThreshold) setThresholdDraft(String(props.settings.quotaWarningThreshold));
  }, [props.settings.quotaWarningThreshold, savingThreshold]);

  useEffect(() => {
    if (!savingBalanceThreshold) setBalanceThresholdDraft(String(props.settings.balanceWarningThreshold));
  }, [props.settings.balanceWarningThreshold, savingBalanceThreshold]);

  const saveAppearance = async (kind: 'theme' | 'quota', save: () => Promise<void>) => {
    if (savingAppearance !== null) return;
    setSavingAppearance(kind);
    try {
      await save();
    } catch {
      // A failed appearance write is said where the message stack lives — the panel
      // owns it, and this window's half of the contract is only "the selection does
      // not take". Swallowing it here is the point: the store keeps the persisted
      // value, so both controls stay on it, and what the reader sees is that nothing
      // changed. Letting it escape would surface as an unhandled rejection in a
      // window whose visible state is already correct.
    } finally {
      if (mounted.current) setSavingAppearance(null);
    }
  };

  const commitQuotaWarningThreshold = async () => {
    if (savingThreshold) return;
    const parsed = Number(thresholdDraft);
    if (!/^\d+$/.test(thresholdDraft) || !Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setThresholdFeedback('请输入 0–100 的整数');
      return;
    }
    if (parsed === props.settings.quotaWarningThreshold) {
      setThresholdDraft(String(parsed));
      setThresholdFeedback('');
      return;
    }
    setSavingThreshold(true);
    setThresholdFeedback('');
    try {
      await props.onQuotaWarningThresholdChange(parsed);
    } catch {
      setThresholdDraft(String(props.settings.quotaWarningThreshold));
      setThresholdFeedback('保存失败，已恢复上一个值');
    } finally {
      if (mounted.current) setSavingThreshold(false);
    }
  };

  const commitBalanceWarningThreshold = async () => {
    if (savingBalanceThreshold) return;
    const parsed = Number(balanceThresholdDraft);
    if (balanceThresholdDraft.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
      setBalanceThresholdFeedback('请输入不小于 0 的数字');
      return;
    }
    if (parsed === props.settings.balanceWarningThreshold) {
      setBalanceThresholdDraft(String(parsed));
      setBalanceThresholdFeedback('');
      return;
    }
    setSavingBalanceThreshold(true);
    setBalanceThresholdFeedback('');
    try {
      await props.onBalanceWarningThresholdChange(parsed);
    } catch {
      setBalanceThresholdDraft(String(props.settings.balanceWarningThreshold));
      setBalanceThresholdFeedback('保存失败，已恢复上一个值');
    } finally {
      if (mounted.current) setSavingBalanceThreshold(false);
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
        /* No h3: the pane's own title is 外观 and its note already says what these
           two rows are for. The heading used to repeat the title verbatim, three
           lines apart. */
        <section className="config-block" data-testid="appearance-settings">
          <div className="setting-row">
            <span className="setting-label">主题</span>
            <SegmentedGroup label="主题">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`segmented-option${props.settings.theme === option.value ? ' is-active' : ''}`}
                  aria-pressed={props.settings.theme === option.value}
                  disabled={savingAppearance !== null}
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
                  disabled={savingAppearance !== null}
                  onClick={() => void saveAppearance('quota', () => props.onQuotaValueModeChange(option.value))}
                >
                  {option.label}
                </button>
              ))}
            </SegmentedGroup>
          </div>
          <div className="setting-row quota-threshold-setting">
            <div className="setting-text">
              <label className="setting-label" htmlFor="quota-warning-threshold">
                低额度提醒
              </label>
              <span className="setting-desc" id="quota-warning-threshold-help">
                剩余额度不高于该百分比时标红；0 为关闭。
              </span>
            </div>
            <div className="quota-threshold-control">
              <div className="quota-threshold-input">
                <input
                  id="quota-warning-threshold"
                  className={`text-input${thresholdFeedback === '请输入 0–100 的整数' ? ' is-invalid' : ''}`}
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={thresholdDraft}
                  disabled={savingThreshold}
                  aria-label="低额度提醒"
                  aria-describedby="quota-warning-threshold-help quota-warning-threshold-feedback"
                  aria-invalid={thresholdFeedback === '请输入 0–100 的整数'}
                  onChange={(event) => {
                    setThresholdDraft(event.currentTarget.value);
                    setThresholdFeedback('');
                  }}
                  onBlur={() => void commitQuotaWarningThreshold()}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    event.currentTarget.blur();
                  }}
                />
                <span className="quota-threshold-suffix" aria-hidden="true">%</span>
              </div>
              <span
                id="quota-warning-threshold-feedback"
                className="quota-threshold-feedback"
                aria-live="polite"
              >
                {thresholdFeedback}
              </span>
            </div>
          </div>
          <div className="setting-row quota-threshold-setting">
            <div className="setting-text">
              <label className="setting-label" htmlFor="balance-warning-threshold">
                低余额提醒
              </label>
              <span className="setting-desc" id="balance-warning-threshold-help">
                余额不高于该金额时标红；0 为关闭，各币种按原始金额判断。
              </span>
            </div>
            <div className="quota-threshold-control">
              <div className="quota-threshold-input">
                <input
                  id="balance-warning-threshold"
                  className={`text-input${balanceThresholdFeedback === '请输入不小于 0 的数字' ? ' is-invalid' : ''}`}
                  type="number"
                  min="0"
                  step="any"
                  value={balanceThresholdDraft}
                  disabled={savingBalanceThreshold}
                  aria-label="低余额提醒"
                  aria-describedby="balance-warning-threshold-help balance-warning-threshold-feedback"
                  aria-invalid={balanceThresholdFeedback === '请输入不小于 0 的数字'}
                  onChange={(event) => {
                    setBalanceThresholdDraft(event.currentTarget.value);
                    setBalanceThresholdFeedback('');
                  }}
                  onBlur={() => void commitBalanceWarningThreshold()}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    event.currentTarget.blur();
                  }}
                />
              </div>
              <span
                id="balance-warning-threshold-feedback"
                className="quota-threshold-feedback"
                aria-live="polite"
              >
                {balanceThresholdFeedback}
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

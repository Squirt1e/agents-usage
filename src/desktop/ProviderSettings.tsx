/**
 * Per-platform configuration (tasks 7.1 – 7.4).
 *
 * One platform at a time: the gear on a card opens exactly that platform's form,
 * "返回用量总览" restores the overview (and the focus lands back on the gear that
 * opened it, handled by `PanelApp`), and no other platform's form is ever on
 * screen.
 *
 * Connection lifecycles stay separate, which is what the specs require:
 * - Codex uses the local managed login; the panel never asks for its auth files,
 *   it only reports the connection state and offers CLI recovery guidance.
 * - GLM manages the Coding Plan quota connection and the experimental wallet
 *   connection independently, each behind one switch. The wallet switch means
 *   "collect and show": on it appears on the card, off it disappears and keeps its
 *   credential, and revoking that credential is the delete button in its own form.
 *   Neither ever touches the quota connection.
 * - DeepSeek keeps one API key. A replacement is validated with a read-only query
 *   first: an invalid key leaves the working credential in place, and a valid one
 *   clears the input and returns only the masked status. The experimental web
 *   usage connection is separate: disabling it stops collection and the card
 *   falls back to the estimate, but the pasted login token is kept.
 */

import { useState, type FormEvent } from 'react';
import type { ProviderId } from '../shared/contracts';
import {
  isValidHHmm,
  isValidTimezone,
  type CredentialStatus,
  type CredentialTarget,
  type DesktopProviderState,
  type PanelSettings,
  type PanelSettingsPatch,
  type PeakReminderMode,
  type PeakWindow
} from '../shared/desktop-contract';
import type { ProviderView } from './metrics';
import { BUILTIN_PEAK_DEFS } from './peak-windows';
import { ConfidenceTag, statusFor, StatusDot, StatusRow } from './StatusRow';
import { SegmentedGroup } from './SegmentedGroup';

export interface ProviderSettingsProps {
  provider: ProviderId;
  view: ProviderView;
  settings: PanelSettings;
  onUpdateSettings(patch: PanelSettingsPatch): Promise<void>;
  onValidateCredential(target: CredentialTarget, secret: string): Promise<CredentialStatus>;
  onDeleteCredential(target: CredentialTarget): Promise<void>;
}

type Feedback = { tone: 'progress' | 'success' | 'error'; text: string };

const TARGET_LABELS: Record<CredentialTarget, string> = {
  glm: 'GLM Coding Plan API Key',
  deepseek: 'DeepSeek API Key',
  'glm-wallet': 'GLM 钱包账号凭据',
  'deepseek-web': 'DeepSeek 网页登录 Token'
};

/** Credential form with validate → replace → delete feedback (task 7.4). */
function CredentialForm(props: {
  target: CredentialTarget;
  label: string;
  status: CredentialStatus;
  hint?: string;
  placeholder?: string;
  onValidateCredential(target: CredentialTarget, secret: string): Promise<CredentialStatus>;
  onDeleteCredential(target: CredentialTarget): Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | undefined>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const secret = value.trim();
    if (secret === '' || pending) return;
    setPending(true);
    setFeedback({ tone: 'progress', text: '正在验证并保存…' });
    try {
      await props.onValidateCredential(props.target, secret);
      // A validated key is saved: clear the input and say nothing else. The status
      // line below now reads 已保存 ····mask, and that *is* the confirmation — the
      // old success sentence repeated it, claimed a row of its own and pushed the
      // delete button off the status line, so a successful save looked nothing like
      // the state it produced. The stored-state row is the whole answer, which is
      // also what "成功清空输入并仅返回掩码状态" asks for.
      setValue('');
      setFeedback(undefined);
    } catch (error) {
      // The previous credential is still in place; say so instead of pretending.
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '密钥验证失败' });
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setPending(true);
    try {
      await props.onDeleteCredential(props.target);
      setValue('');
      setFeedback({ tone: 'success', text: '已删除该平台账号凭据，需重新配置后才能采集' });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '删除失败' });
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="credential-form" onSubmit={submit}>
      <label className="field-label" htmlFor={`${props.target}-key`}>
        {props.label}
      </label>
      <div className="input-row">
        <input
          id={`${props.target}-key`}
          className="text-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={pending}
          onChange={(event) => setValue(event.target.value)}
          placeholder={props.placeholder ?? (props.status.configured ? '输入新密钥以替换' : '仅保存在 macOS Keychain')}
        />
        <button type="submit" className="primary-button" disabled={pending || value.trim() === ''}>
          {pending ? '正在验证…' : props.status.configured ? '验证并替换' : '验证并保存'}
        </button>
      </div>
      <div className="credential-status">
        {/* The stored status stays visible beside validation feedback so a
            failed replacement cannot look like it removed the credential, and the
            delete button stays on the status line: the feedback element claims a
            full row of its own, so anything after it in this flex row would be
            pushed below the button instead of beside the state (see panel.css). */}
        <span>{props.status.configured ? `已保存 ····${props.status.suffix}` : '尚未配置'}</span>
        {props.status.configured ? (
          <button
            type="button"
            className="link-button"
            aria-label={`删除 ${props.label}`}
            disabled={pending}
            onClick={remove}
          >
            删除
          </button>
        ) : null}
        {feedback ? (
          <span role={feedback.tone === 'error' ? 'alert' : 'status'} className={`credential-feedback feedback-${feedback.tone}`}>
            {feedback.text}
          </span>
        ) : null}
      </div>
      {props.hint ? <p className="field-hint">{props.hint}</p> : null}
    </form>
  );
}

function Switch(props: {
  label: string;
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
  description?: string;
}) {
  return (
    <div className="setting-row">
      <span className="setting-text">
        <span className="setting-label">{props.label}</span>
        {props.description ? <span className="setting-desc">{props.description}</span> : null}
      </span>
      <input
        type="checkbox"
        className="switch"
        aria-label={props.ariaLabel}
        checked={props.checked}
        disabled={props.disabled === true}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </div>
  );
}

function CodexSection(props: { view: ProviderView; settings: PanelSettings; onUpdateSettings(p: PanelSettingsPatch): Promise<void> }) {
  const state = props.view.primary;
  const presentation = statusFor(state);
  const kind = (state?.error ?? state?.snapshot?.error)?.kind;
  const [path, setPath] = useState(props.settings.codexCliPath ?? '');
  const [saved, setSaved] = useState<string | undefined>();

  const guidance =
    kind === 'authentication'
      ? '请在 Codex 应用或 Codex CLI 中完成登录后重试。'
      : kind === 'process' || kind === 'missing_config'
        ? '请安装 Codex，或填写 CLI 绝对路径。'
        : kind === 'compatibility'
          ? '请更新 Codex 后重试。'
          : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = path.trim();
    await props.onUpdateSettings({ codexCliPath: next === '' ? undefined : next });
    setSaved(next === '' ? '已清除 CLI 路径设置' : `已保存 CLI 路径：${next}`);
  };

  return (
    <>
      <section className="config-block">
        <header className="block-head">
          <h3>账号连接</h3>
          <ConfidenceTag>Codex 托管登录</ConfidenceTag>
        </header>
        {/* `detail` is advice only. The provider's own message is English plumbing
            ("… is not configured"), not something to read: a page that has advice
            gives it here, and a page that has none says nothing. */}
        <StatusRow tone={presentation.tone} label={presentation.label} detail={guidance} />
      </section>
      <section className="config-block">
        <h3>CLI 路径</h3>
        <form className="credential-form" onSubmit={submit}>
          <label className="field-label" htmlFor="codex-cli-path">
            Codex CLI 绝对路径
          </label>
          <div className="input-row">
            <input
              id="codex-cli-path"
              className="text-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={path}
              placeholder="/opt/homebrew/bin/codex"
              onChange={(event) => setPath(event.target.value)}
            />
            <button type="submit" className="primary-button">
              保存
            </button>
          </div>
          <div className="credential-status">{saved ? <span role="status">{saved}</span> : <span>留空保存可清除路径</span>}</div>
        </form>
      </section>
    </>
  );
}

/** Compact connection status shown beside a section title. */
function ConnectionChip(props: { state: DesktopProviderState | undefined }) {
  const presentation = statusFor(props.state);
  return (
    <span className={`status-chip status-chip-${presentation.tone}`} role="status">
      <StatusDot tone={presentation.tone} />
      {presentation.label}
    </span>
  );
}

function GlmSection(props: {
  view: ProviderView;
  settings: PanelSettings;
  onUpdateSettings(p: PanelSettingsPatch): Promise<void>;
  onValidateCredential(target: CredentialTarget, secret: string): Promise<CredentialStatus>;
  onDeleteCredential(target: CredentialTarget): Promise<void>;
}) {
  const quotaState = props.view.state('quota') ?? props.view.primary;
  const walletState = props.view.state('wallet');
  const walletPresentation = statusFor(walletState);
  const [regionBusy, setRegionBusy] = useState(false);

  const setRegion = async (region: PanelSettings['glmRegion']) => {
    setRegionBusy(true);
    try {
      await props.onUpdateSettings({ glmRegion: region });
    } finally {
      setRegionBusy(false);
    }
  };

  const setWalletEnabled = async (enabled: boolean) => {
    // One switch, one meaning — the same interaction the DeepSeek web connection
    // uses: switching off stops collecting and takes the module off the card, and
    // that is all it does. Revoking the credential is the delete button inside the
    // form below, never a side effect of the switch: the old behaviour threw the
    // pasted credential away, so turning the switch back on showed nothing and the
    // user had to paste it again.
    await props.onUpdateSettings({ glmWalletEnabled: enabled });
  };

  return (
    <>
      <section className="config-block">
        <header className="block-head">
          <h3>Coding Plan</h3>
          <ConnectionChip state={quotaState} />
        </header>
        <div className="setting-row">
          <span className="setting-text">
            <span className="setting-label">服务区域</span>
          </span>
          {/* Two choices: a segmented row reads at a glance and matches the
              theme switch, a dropdown would hide both options behind a click. */}
          <SegmentedGroup label="服务区域">
            {(['china', 'international'] as const).map((region) => (
              <button
                key={region}
                type="button"
                className={`segmented-option${props.settings.glmRegion === region ? ' is-active' : ''}`}
                aria-pressed={props.settings.glmRegion === region}
                disabled={regionBusy}
                onClick={() => void setRegion(region)}
              >
                {region === 'china' ? '中国区' : '国际区'}
              </button>
            ))}
          </SegmentedGroup>
        </div>
        <CredentialForm
          target="glm"
          label={TARGET_LABELS.glm}
          status={props.settings.credentials.glm}
          onValidateCredential={props.onValidateCredential}
          onDeleteCredential={props.onDeleteCredential}
        />
      </section>

      <section className="config-block">
        <header className="block-head">
          <h3>钱包连接</h3>
          <ConfidenceTag>实验功能</ConfidenceTag>
        </header>
        <p className="field-hint">非公开接口，可能失效。</p>
        <Switch
          label="启用实验钱包连接"
          ariaLabel="启用实验钱包连接"
          checked={props.settings.glmWalletEnabled}
          onChange={(checked) => void setWalletEnabled(checked)}
          description="开启即采集并在主面板展示，关闭即隐藏；凭据保留，删除用下方按钮"
        />
        {props.settings.glmWalletEnabled ? (
          <>
            {/* No detail: the row names the state, and the provider's own message
                is English plumbing the user cannot act on. */}
            <StatusRow tone={walletPresentation.tone} label={walletPresentation.label} />
            <CredentialForm
              target="glm-wallet"
              label={TARGET_LABELS['glm-wallet']}
              status={props.settings.credentials['glm-wallet']}
              onValidateCredential={props.onValidateCredential}
              onDeleteCredential={props.onDeleteCredential}
            />
          </>
        ) : null}
      </section>
    </>
  );
}

function DeepSeekSection(props: {  view: ProviderView;
  settings: PanelSettings;
  onUpdateSettings(p: PanelSettingsPatch): Promise<void>;
  onValidateCredential(target: CredentialTarget, secret: string): Promise<CredentialStatus>;
  onDeleteCredential(target: CredentialTarget): Promise<void>;
}) {
  const presentation = statusFor(props.view.primary);
  const webState = props.view.state('web');
  const webPresentation = statusFor(webState);
  const webKind = (webState?.error ?? webState?.snapshot?.error)?.kind;
  // A rejected login token — missing (40002) or invalid/expired (40003) — is the
  // expected failure of this connection; say so instead of leaving a bare 认证失败
  // the user cannot act on. Only a body the collector could not read at all is a
  // redesign, which is the case the compatibility wording is for.
  const webGuidance =
    webKind === 'authentication'
      ? '登录态无效或已过期，请重新粘贴 Token。'
      : webKind === 'compatibility'
        ? '接口可能已改版，网页用量暂不展示。'
        : undefined;
  return (
    <>
      <section className="config-block">
        <header className="block-head">
          <h3>钱包连接</h3>
        </header>
        <StatusRow
          tone={presentation.tone}
          label={presentation.label}
        />
        <CredentialForm
          target="deepseek"
          label={TARGET_LABELS.deepseek}
          status={props.settings.credentials.deepseek}
          onValidateCredential={props.onValidateCredential}
          onDeleteCredential={props.onDeleteCredential}
        />
      </section>
      <section className="config-block">
        <header className="block-head">
          <h3>网页用量连接</h3>
        </header>
        <Switch
          label="启用网页用量连接"
          ariaLabel="启用网页用量连接"
          checked={props.settings.deepseekWebEnabled}
          onChange={(checked) => void props.onUpdateSettings({ deepseekWebEnabled: checked })}
        />
        {props.settings.deepseekWebEnabled ? (
          <>
            <StatusRow
              tone={webPresentation.tone}
              label={webPresentation.label}
              detail={webGuidance}
            />
            <CredentialForm
              target="deepseek-web"
              label={TARGET_LABELS['deepseek-web']}
              status={props.settings.credentials['deepseek-web']}
              placeholder="粘贴 Authorization Token"
              onValidateCredential={props.onValidateCredential}
              onDeleteCredential={props.onDeleteCredential}
            />
          </>
        ) : null}
      </section>
    </>
  );
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

/**
 * `0930` / `9:30` / `930` → `09:30`: the editor takes digits in any shape and
 * normalizes when the field is left, so typing stays fast. Anything it cannot
 * confidently shape passes through untouched for the save validation to name.
 */
function normalizeHHmm(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  if (digits.length === 3) return `0${digits.slice(0, 1)}:${digits.slice(1)}`;
  return raw.trim();
}

/** `周一至周五` for a run, `、`-joined names otherwise — the builtin table's own wording. */
function weekdayLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === day - 1) last.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) =>
      run.length >= 3
        ? `${WEEKDAY_LABELS[run[0]! - 1]}至${WEEKDAY_LABELS[run[run.length - 1]! - 1]}`
        : run.map((day) => WEEKDAY_LABELS[day - 1]).join('、')
    )
    .join('、');
}

function PeakSection(props: {
  provider: ProviderId;
  settings: PanelSettings;
  onUpdateSettings(p: PanelSettingsPatch): Promise<void>;
}) {
  const builtin = BUILTIN_PEAK_DEFS[props.provider];
  const stored = props.settings.peakReminder?.[props.provider];
  // The select is what the user is editing; a custom choice only lands with the
  // save below, so the choice lives in state and the stored setting stays put
  // until then. Default is 关闭 — the reminder never runs on an untouched
  // provider, builtin table or not.
  const [modeChoice, setModeChoice] = useState<PeakReminderMode>(() => stored?.mode ?? 'off');
  const [draft, setDraft] = useState<{ windows: PeakWindow[]; timezone: string }>(() => ({
    windows: stored?.windows ? stored.windows.map((window) => ({ ...window, weekdays: [...window.weekdays] })) : [],
    timezone: stored?.timezone ?? props.settings.timezone
  }));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | undefined>();

  /** Builtin/off keep the stored windows so switching back restores them. */
  const persistMode = async (mode: PeakReminderMode) => {
    setBusy(true);
    try {
      await props.onUpdateSettings({
        peakReminder: {
          ...props.settings.peakReminder,
          [props.provider]: {
            mode,
            ...(stored?.windows?.length ? { windows: stored.windows } : {}),
            ...(stored?.timezone ? { timezone: stored.timezone } : {})
          }
        }
      });
      setFeedback(undefined);
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (next: PeakReminderMode) => {
    setModeChoice(next);
    setFeedback(undefined);
    if (next !== 'custom') void persistMode(next);
  };

  const addWindow = () =>
    setDraft((current) => ({
      ...current,
      windows: [...current.windows, { weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }]
    }));

  const updateWindow = (index: number, patch: Partial<PeakWindow>) =>
    setDraft((current) => ({
      ...current,
      windows: current.windows.map((window, at) => (at === index ? { ...window, ...patch } : window))
    }));

  const removeWindow = (index: number) =>
    setDraft((current) => ({ ...current, windows: current.windows.filter((_, at) => at !== index) }));

  /** The spec's rule: an unusable schedule is blocked with a reason, not repaired. */
  const validateDraft = (): string | undefined => {
    if (draft.windows.length === 0) return '至少需要一条时段';
    for (const [index, window] of draft.windows.entries()) {
      if (window.weekdays.length === 0) return `第 ${index + 1} 条时段未选择星期`;
      if (window.start === window.end) return `第 ${index + 1} 条时段起止时间相同`;
      if (!isValidHHmm(window.start) || !isValidHHmm(window.end)) return `第 ${index + 1} 条时段的时间不完整`;
    }
    if (!isValidTimezone(draft.timezone)) return '时区无法解析，请填写 IANA 名称（如 Asia/Shanghai）';
    return undefined;
  };

  const saveCustom = async () => {
    const problem = validateDraft();
    if (problem) {
      setFeedback({ tone: 'error', text: problem });
      return;
    }
    setBusy(true);
    try {
      await props.onUpdateSettings({
        peakReminder: {
          ...props.settings.peakReminder,
          [props.provider]: { mode: 'custom', windows: draft.windows, timezone: draft.timezone }
        }
      });
      setFeedback({ tone: 'success', text: '已保存自定义时段' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="config-block" data-testid={`peak-settings-${props.provider}`}>
      <header className="block-head">
        <h3>高峰时段提醒</h3>
      </header>
      <div className="setting-row">
        <span className="setting-text">
          <span className="setting-label">时段来源</span>
        </span>
        {/* ≤3 choices travel as a segmented row (same as the theme switch) —
            a dropdown would hide them behind a click for no reason. */}
        <SegmentedGroup label="时段来源">
          {((builtin ? ['builtin'] : []) as PeakReminderMode[])
            .concat(['custom', 'off'])
            .map((mode) => (
              <button
                key={mode}
                type="button"
                className={`segmented-option${modeChoice === mode ? ' is-active' : ''}`}
                aria-pressed={modeChoice === mode}
                disabled={busy}
                onClick={() => changeMode(mode)}
              >
                {mode === 'builtin' ? '内置时段' : mode === 'custom' ? '自定义' : '关闭'}
              </button>
            ))}
        </SegmentedGroup>
      </div>
      {builtin && modeChoice === 'builtin' ? (
        <div className="peak-builtin">
          {builtin.windows.map((window, index) => (
            <div key={`${window.start}-${window.end}-${index}`} className="peak-builtin-row">
              <span>{weekdayLabel(window.weekdays)}</span>
              <span className="peak-builtin-time">
                {window.start} – {window.end}
              </span>
            </div>
          ))}
          <p className="field-hint">
            来源：{builtin.sourceLabel}
            {builtin.asOf ? ` · 核实于 ${builtin.asOf}` : null}
            {builtin.offPeakNote ? ` · ${builtin.offPeakNote}` : ''}
          </p>
        </div>
      ) : null}
      {modeChoice === 'custom' ? (
        <div className="peak-editor">
          {draft.windows.map((window, index) => (
            <div key={index} className="peak-window-row">
              <div className="segmented peak-weekdays" role="group" aria-label={`第 ${index + 1} 条时段的星期`}>
                {WEEKDAY_LABELS.map((label, at) => {
                  const day = at + 1;
                  const on = window.weekdays.includes(day);
                  return (
                    <button
                      key={label}
                      type="button"
                      className={`segmented-option${on ? ' is-active' : ''}`}
                      aria-pressed={on}
                      aria-label={label}
                      disabled={busy}
                      onClick={() =>
                        updateWindow(index, {
                          weekdays: on ? window.weekdays.filter((day_) => day_ !== day) : [...window.weekdays, day]
                        })
                      }
                    >
                      {label.slice(1)}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                className="text-input peak-time"
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                placeholder="09:00"
                aria-label={`第 ${index + 1} 条时段开始`}
                value={window.start}
                disabled={busy}
                onChange={(event) => updateWindow(index, { start: event.target.value })}
                onBlur={(event) => updateWindow(index, { start: normalizeHHmm(event.target.value) })}
              />
              <span className="peak-dash">–</span>
              <input
                type="text"
                className="text-input peak-time"
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                placeholder="18:00"
                aria-label={`第 ${index + 1} 条时段结束`}
                value={window.end}
                disabled={busy}
                onChange={(event) => updateWindow(index, { end: event.target.value })}
                onBlur={(event) => updateWindow(index, { end: normalizeHHmm(event.target.value) })}
              />
              <button
                type="button"
                className="peak-remove"
                aria-label={`删除第 ${index + 1} 条时段`}
                disabled={busy}
                onClick={() => removeWindow(index)}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="peak-editor-actions">
            <button type="button" className="link-button" disabled={busy} onClick={addWindow}>
              添加时段
            </button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void saveCustom()}>
              {busy ? '正在保存…' : '保存'}
            </button>
          </div>
          <div className="setting-row peak-timezone-row">
            <span className="setting-text">
              <span className="setting-label">判定时区</span>
              <span className="setting-desc">结束早于开始表示跨天</span>
            </span>
            <input
              className="text-input peak-timezone"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={draft.timezone}
              disabled={busy}
              placeholder="Asia/Shanghai"
              aria-label="判定时区"
              onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))}
            />
          </div>
        </div>
      ) : null}
      {feedback ? (
        <span role={feedback.tone === 'error' ? 'alert' : 'status'} className={`credential-feedback feedback-${feedback.tone === 'error' ? 'error' : 'success'}`}>
          {feedback.text}
        </span>
      ) : null}
    </section>
  );
}

export function ProviderSettings(props: ProviderSettingsProps) {
  return (
    <div className="settings-view" data-testid={`settings-${props.provider}`}>
      {props.provider === 'codex' ? (
        <CodexSection view={props.view} settings={props.settings} onUpdateSettings={props.onUpdateSettings} />
      ) : props.provider === 'glm' ? (
        <GlmSection
          view={props.view}
          settings={props.settings}
          onUpdateSettings={props.onUpdateSettings}
          onValidateCredential={props.onValidateCredential}
          onDeleteCredential={props.onDeleteCredential}
        />
      ) : (
        <DeepSeekSection
          view={props.view}
          settings={props.settings}
          onUpdateSettings={props.onUpdateSettings}
          onValidateCredential={props.onValidateCredential}
          onDeleteCredential={props.onDeleteCredential}
        />
      )}
      <PeakSection provider={props.provider} settings={props.settings} onUpdateSettings={props.onUpdateSettings} />
    </div>
  );
}

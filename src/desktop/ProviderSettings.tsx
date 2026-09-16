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

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ProviderId } from '../shared/contracts';
import {
  isValidHHmm,
  isValidTimezone,
  type CredentialStatus,
  type CredentialTarget,
  type PanelSettings,
  type PanelSettingsPatch,
  type PeakReminderMode,
  type PeakWindow
} from '../shared/desktop-contract';
import type { ProviderView } from './metrics';
import { BUILTIN_PEAK_DEFS, peakPreviewOf } from './peak-windows';
import { ConfidenceTag, stateAdvice, statusFor, StatusRow } from './StatusRow';
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

/**
 * What each credential field holds, in the app's own words.
 *
 * The interface is Chinese, so the field names are too, with the product's own
 * term kept where it is a proper noun (Coding Plan) and the secret's kind named in
 * Chinese rather than borrowed: 密钥 for a key, Token for a browser login. Before
 * this the four fields used three different conventions — "API Key", "Token" and
 * 凭据 — and the labels disagreed with their own placeholders ("输入新密钥以替换"
 * under a field called API Key).
 */
const TARGET_LABELS: Record<CredentialTarget, string> = {
  glm: 'GLM Coding Plan 密钥',
  deepseek: 'DeepSeek 密钥',
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
  /**
   * The delete link opens a confirmation in place; it never deletes on the first
   * press.
   *
   * What is being deleted is a secret the reader has to obtain from the provider
   * again — there is no undo and nothing on this machine can restore it. The
   * confirmation is in the status row rather than a dialog because an ordinary
   * settings page is not a modal (see the style guide), and because the row is
   * already the place that names what would go.
   */
  const [confirming, setConfirming] = useState(false);
  /** Focus lands on the safe action, and returns to the link that opened it. */
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      deleteRef.current?.focus();
    }
  }, [confirming]);

  const cancelConfirm = () => {
    restoreFocus.current = true;
    setConfirming(false);
  };

  /**
   * Escape cancels from anywhere in the form, not only from the two buttons.
   *
   * The handler used to sit on the confirmation's own wrapper, so it worked exactly
   * as long as focus stayed on 取消 or 确认删除 — tab into the password field (which
   * is the natural next move while deciding) and Escape did nothing at all. An open
   * question about deleting a secret has to be dismissable from wherever the reader
   * happens to be.
   */
  useEffect(() => {
    if (!confirming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelConfirm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirming]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const secret = value.trim();
    if (secret === '' || pending) return;
    // Choosing to replace is choosing not to delete: an open confirmation is about
    // the old secret and has no meaning once a new one is going in.
    setConfirming(false);
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
    // The confirmation has done its job either way: a success turns the row into the
    // result, and a failure turns it into the reason. Leaving it open would have kept
    // asking "确定删除？" over a credential that is already gone.
    restoreFocus.current = true;
    setConfirming(false);
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
        {confirming ? (
          <>
            <span className="credential-confirm-prompt" role="status">
              删除后需重新向平台获取密钥，确定删除？
            </span>
            <span className="credential-confirm">
              <button type="button" className="ghost-button" ref={cancelRef} onClick={cancelConfirm}>
                取消
              </button>
              <button type="button" className="danger-button" disabled={pending} onClick={remove}>
                {pending ? '正在删除…' : '确认删除'}
              </button>
            </span>
          </>
        ) : (
          <>
            {/* The stored-secret fact, named as a secret: this line sits one row
                under a connection status that says 尚未连接, and the two used to
                read as variations of the same sentence. 未保存凭据 is about *this
                field*; 尚未连接 is about the collector. */}
            <span>{props.status.configured ? `已保存 ····${props.status.suffix}` : '未保存凭据'}</span>
            {props.status.configured ? (
              <button
                type="button"
                className="link-button"
                ref={deleteRef}
                aria-label={`删除 ${props.label}`}
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                删除
              </button>
            ) : null}
          </>
        )}
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

  /**
   * The path field follows the settings until the reader types in it.
   *
   * Seeding it once from `props` is what made this field dangerous: the settings
   * window renders before its first read lands, so the field was born empty and
   * stayed empty — a stored path was invisible, and the row underneath invites
   * "留空保存可清除路径". Opening this pane and pressing 保存 therefore erased a
   * path the reader never touched. The same rule now applies here as in the peak
   * editor: adopt what is stored, stop adopting the moment the reader edits, and
   * never write back a value nobody chose.
   */
  const storedCliPath = props.settings.codexCliPath ?? '';
  const [path, setPath] = useState(storedCliPath);
  const [saved, setSaved] = useState<string | undefined>();
  const pathEdited = useRef(false);
  useEffect(() => {
    if (pathEdited.current) return;
    setPath((current) => (current === storedCliPath ? current : storedCliPath));
  }, [storedCliPath]);
  const dirty = path.trim() !== storedCliPath;

  /* Codex's own answers, which are more specific than the vocabulary's defaults:
     its login is managed by the Codex app and its collector is a CLI binary. */
  const advice = stateAdvice(state, {
    authentication: '请在 Codex 应用或 Codex CLI 中完成登录后重试。',
    process: '请安装 Codex，或填写 CLI 绝对路径。',
    missing_config: '请安装 Codex，或填写 CLI 绝对路径。',
    compatibility: '请更新 Codex 后重试。'
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
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
        <StatusRow tone={presentation.tone} label={presentation.label} detail={advice} />
      </section>
      <section className="config-block">
        <header className="block-head">
          {/* The block holds one field, so the heading *is* the field's label: the
              accessible name comes from here by `aria-labelledby`, and no second
              label repeats it. It used to read "CLI 路径" over a field labelled
              "Codex CLI 绝对路径" inside a pane already titled Codex — the same
              thing named three times, twice with words the interface never uses
              elsewhere. */}
          <h3 id="codex-cli-path-label">可执行文件路径</h3>
        </header>
        <form className="credential-form" onSubmit={submit}>
          <div className="input-row">
            <input
              id="codex-cli-path"
              className="text-input"
              type="text"
              aria-labelledby="codex-cli-path-label"
              autoComplete="off"
              spellCheck={false}
              value={path}
              placeholder="/opt/homebrew/bin/codex"
              onChange={(event) => {
                pathEdited.current = true;
                setSaved(undefined);
                setPath(event.target.value);
              }}
            />
            {/* Nothing to write is nothing to press: the same rule the peak
                editor's save follows. Leaving the field untouched can no longer
                clear the stored path by accident, and this is what makes that
                visible instead of silent. */}
            <button type="submit" className="primary-button" disabled={!dirty}>
              保存
            </button>
          </div>
          <div className="credential-status">
            {saved ? (
              <span role="status">{saved}</span>
            ) : (
              <span>{dirty ? '尚未保存' : '留空保存可清除路径'}</span>
            )}
          </div>
        </form>
      </section>
    </>
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
  const quotaPresentation = statusFor(quotaState);
  const walletState = props.view.state('wallet');
  const walletPresentation = statusFor(walletState);
  const [regionBusy, setRegionBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);

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
    //
    // The switch now shows its own write: without this the track sat unchanged
    // until the settings echo landed, and a second click in that window sent a
    // second write. The visibility switches in 平台管理 have always dimmed their
    // own row; these two were the ones that did not.
    setWalletBusy(true);
    try {
      await props.onUpdateSettings({ glmWalletEnabled: enabled });
    } finally {
      setWalletBusy(false);
    }
  };

  return (
    <>
      <section className="config-block">
        <header className="block-head">
          <h3>Coding Plan</h3>
        </header>
        {/* Every connection states its health in one place — the first row of its
            own block. This one used to put the same words in a pill beside the
            title instead, so GLM showed two different renderings of one fact
            within a single pane. */}
        <StatusRow
          tone={quotaPresentation.tone}
          label={quotaPresentation.label}
          detail={stateAdvice(quotaState, {
            authentication: '请在 GLM 平台重新生成密钥后替换。'
          })}
        />
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
          disabled={walletBusy}
          onChange={(checked) => void setWalletEnabled(checked)}
          description="开启即采集并在主面板展示，关闭即隐藏；凭据保留，删除用下方按钮"
        />
        {props.settings.glmWalletEnabled ? (
          <>
            <StatusRow
              tone={walletPresentation.tone}
              label={walletPresentation.label}
              detail={stateAdvice(walletState)}
            />
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
  const [webBusy, setWebBusy] = useState(false);
  // A rejected login token — missing (40002) or invalid/expired (40003) — is the
  // expected failure of this connection, and only this one can be fixed by pasting
  // something again; a body the collector could not read at all is a redesign,
  // which is what the compatibility wording is for. The other failures fall back to
  // the shared vocabulary rather than saying nothing.
  const webAdvice = stateAdvice(webState, {
    authentication: '登录态无效或已过期，请重新粘贴 Token。',
    compatibility: '接口可能已改版，网页用量暂不展示。'
  });
  const setWebEnabled = async (enabled: boolean) => {
    setWebBusy(true);
    try {
      await props.onUpdateSettings({ deepseekWebEnabled: enabled });
    } finally {
      setWebBusy(false);
    }
  };
  return (
    <>
      <section className="config-block">
        <header className="block-head">
          <h3>钱包连接</h3>
        </header>
        <StatusRow
          tone={presentation.tone}
          label={presentation.label}
          detail={stateAdvice(props.view.primary)}
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
          disabled={webBusy}
          onChange={(checked) => void setWebEnabled(checked)}
        />
        {props.settings.deepseekWebEnabled ? (
          <>
            <StatusRow
              tone={webPresentation.tone}
              label={webPresentation.label}
              detail={webAdvice}
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

/** The weekday keys' visible glyphs; the full names live in `aria-label` and the read-back. */
const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'] as const;

/**
 * `↑↓` moves a field this far, and `⇧↑↓` moves it by an hour.
 *
 * The arrows are for the small correction (the meeting starts at 09:30, not
 * 09:00) and for fixing a typo without selecting the text. Anything larger is
 * faster typed, so there is no third step to remember.
 */
const STEP_MINUTES = 1;
const STEP_MINUTES_COARSE = 60;

/** Wraps inside the day, so a field can never be pushed out of `HH:mm`. */
function stepHHmm(value: string, deltaMinutes: number): string {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  const base = match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  const wrapped = (((base + deltaMinutes) % 1440) + 1440) % 1440;
  const hour = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const minute = String(wrapped % 60).padStart(2, '0');
  return `${hour}:${minute}`;
}

/**
 * Whether the end time is behind the start, i.e. the window runs past midnight.
 *
 * Judged on the two strings rather than on minutes so a half-typed field never
 * claims to wrap: only two complete `HH:mm` values can be compared, and an
 * incomplete one is already covered by the save validation.
 */
function wrapsMidnight(window: PeakWindow): boolean {
  if (!isValidHHmm(window.start) || !isValidHHmm(window.end)) return false;
  return window.end <= window.start;
}

/**
 * A draft row carries its own identity.
 *
 * The exit is component state (`is-leaving`), so an index-keyed list passes a
 * leaving row's state to whichever window slides up into its slot: with
 * `key={index}`, removing the first of two rows leaves the *second* wearing the
 * first one's `is-leaving` — dimmed, disabled, and permanently stuck, because the
 * exit timer belongs to the instance that already ran it. The id is draft-only:
 * it never reaches the stored setting.
 */
interface PeakDraftRow extends PeakWindow {
  id: number;
}

/** The custom schedule while it is being edited: the windows plus the zone they are judged in. */
interface PeakDraft {
  windows: PeakDraftRow[];
  timezone: string;
}

/** Value equality for one schedule, so an adopted draft that changes nothing keeps its identity. */
function sameSchedule(
  left: { windows: readonly PeakWindow[]; timezone: string },
  right: { windows: readonly PeakWindow[]; timezone: string }
): boolean {
  if (left.timezone !== right.timezone) return false;
  if (left.windows.length !== right.windows.length) return false;
  return left.windows.every((window, index) => {
    const other = right.windows[index]!;
    return (
      window.start === other.start &&
      window.end === other.end &&
      [...window.weekdays].sort().join(',') === [...other.weekdays].sort().join(',')
    );
  });
}

/**
 * The preview's clock.
 *
 * The settings window has no clock of its own — nothing on this chain passes a
 * `now` down — so the section keeps one. Ten seconds is chosen against the
 * preview's own resolution: it counts in minutes, so a stale read can move the
 * text by at most one minute, and six renders a minute is not worth optimising.
 * The interval only exists while a mode that has a schedule is selected.
 */
const PEAK_PREVIEW_TICK_MS = 10_000;

function usePreviewClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), PEAK_PREVIEW_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * How long a removed row takes to close and lift out of the list.
 *
 * Kept in step with the transitions on `.peak-window-card` (opacity/transform)
 * and `.peak-window-item` (the collapse): dropping the row any earlier would cut
 * its own exit short, and leaving it any later would keep a dead row in the
 * document. Same contract as `PANEL_TOAST_EXIT_MS`.
 */
export const PEAK_ROW_EXIT_MS = 180;

/**
 * The timezone's current wall clock, for the row that names it.
 *
 * A zone name is the one field here that cannot be checked by reading it back:
 * `Asia/Shanghai` looks right whether or not it is the zone the user meant. Its
 * current time can be checked at a glance — and it is the number the schedule is
 * judged against, so showing it is showing the thing that matters.
 */
function zonedClock(timezone: string, now: Date): string | undefined {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(now);
  } catch {
    return undefined;
  }
}

/**
 * One window in the custom schedule: which days, and which hours.
 *
 * Two rows, one question each — the width here is 366 pixels, so a form that
 * puts a label beside a control beside another control is what produced the
 * cramped strip this replaces. The row reads `开始 [09:00] → 结束 [18:00]`,
 * with the labels as dim prefixes: they keep the range on one line while still
 * naming both ends, which the previous version left to `aria-label` alone.
 *
 * Removal is a state before it is an unmount (the message stack works the same
 * way): the row marks itself `is-leaving`, CSS plays the exit, and only then
 * does the parent drop it from the schedule.
 */
function PeakWindowCard(props: {
  index: number;
  window: PeakWindow;
  busy: boolean;
  onChange(patch: Partial<PeakWindow>): void;
  onRemove(): void;
}) {
  const { index, window: slot } = props;
  const [leaving, setLeaving] = useState(false);
  /** The exit timer must not restart when the parent re-renders with a new closure. */
  const removeRef = useRef(props.onRemove);
  useEffect(() => {
    removeRef.current = props.onRemove;
  }, [props.onRemove]);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => removeRef.current(), PEAK_ROW_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const toggleDay = (day: number) =>
    props.onChange({
      weekdays: slot.weekdays.includes(day)
        ? slot.weekdays.filter((value) => value !== day)
        : [...slot.weekdays, day]
    });

  /** Both fields share this: the arrows step, everything else is typing. */
  const timeField = (field: 'start' | 'end', label: string, placeholder: string) => (
    <label className="peak-time-field">
      <span className="peak-time-label">{label}</span>
      <input
        type="text"
        className="text-input peak-time"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={5}
        placeholder={placeholder}
        aria-label={`第 ${index + 1} 条时段${label}`}
        value={slot[field]}
        disabled={props.busy || leaving}
        onChange={(event) => props.onChange({ [field]: event.target.value })}
        onBlur={(event) => props.onChange({ [field]: normalizeHHmm(event.target.value) })}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          // The browser would otherwise move the caret (and Shift would select).
          event.preventDefault();
          const step = event.shiftKey ? STEP_MINUTES_COARSE : STEP_MINUTES;
          const delta = event.key === 'ArrowUp' ? step : -step;
          props.onChange({ [field]: stepHHmm(slot[field], delta) });
        }}
      />
    </label>
  );

  return (
    <li className={`peak-window-item${leaving ? ' is-leaving' : ''}`}>
      {/* The clip exists to collapse: `padding` and `border` are a border-box's
          floor, so the card itself can never reach zero height. A zero-padding
          box around it can, and it hides nothing while the row is at rest. */}
      <div className="peak-window-clip">
        <div className={`peak-window-card${wrapsMidnight(slot) ? ' is-overnight' : ''}`}>
          <div className="peak-window-days">
            <div className="segmented peak-weekdays" role="group" aria-label={`第 ${index + 1} 条时段的星期`}>
              {WEEKDAY_SHORT.map((glyph, at) => {
                const day = at + 1;
                const on = slot.weekdays.includes(day);
                return (
                  <button
                    key={glyph}
                    type="button"
                    className={`segmented-option${on ? ' is-active' : ''}`}
                    aria-pressed={on}
                    aria-label={WEEKDAY_LABELS[at]}
                    disabled={props.busy || leaving}
                    onClick={() => toggleDay(day)}
                  >
                    {glyph}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="peak-remove"
              aria-label={`删除第 ${index + 1} 条时段`}
              title="删除这条时段"
              disabled={props.busy || leaving}
              onClick={() => setLeaving(true)}
            >
              ✕
            </button>
          </div>
          <div className="peak-times">
            {timeField('start', '开始', '09:00')}
            <span className="peak-times-arrow" aria-hidden="true">
              →
            </span>
            {timeField('end', '结束', '18:00')}
            {/* Always rendered, revealed by `.is-overnight` on the card: it is
                pushed left by `margin-left: auto`, so mounting it on demand would
                shove the two time fields sideways instead of fading the marker in.
                The previous version explained wrapping in a footnote at the bottom
                of the block, three controls away from the fields it described. */}
            <span
              className="peak-overnight"
              title="结束时间早于开始时间，这条时段跨过午夜，到次日结束"
            >
              跨天
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

function PeakSection(props: {
  provider: ProviderId;
  settings: PanelSettings;
  onUpdateSettings(p: PanelSettingsPatch): Promise<void>;
}) {
  const builtin = BUILTIN_PEAK_DEFS[props.provider];
  const stored = props.settings.peakReminder?.[props.provider];
  const settingsTimezone = props.settings.timezone;

  /**
   * The mode the user is editing, and the two flags that say whether they have
   * touched it.
   *
   * Both the mode and the draft have to follow the settings *until the reader
   * chooses*, because this window renders while its first read is still in
   * flight: seeded once from `props`, they hold the parser's defaults for the
   * rest of the session — which is how a saved schedule came to look like it had
   * never existed (the mode read 关闭, and 自定义 opened an empty list). "The
   * reader chose" is tracked explicitly rather than inferred from a comparison:
   * once the settings land, a stale draft and a deliberate choice are the same
   * value.
   */
  const storedMode = stored?.mode;
  const [modeChoice, setModeChoice] = useState<PeakReminderMode | undefined>(storedMode);
  const mode: PeakReminderMode = modeChoice ?? storedMode ?? 'off';
  /** Draft-only identities, handed out in order and never reused. */
  const nextRowId = useRef(0);
  const asRow = (window: PeakWindow): PeakDraftRow => ({ ...window, weekdays: [...window.weekdays], id: nextRowId.current++ });
  const [draft, setDraft] = useState<PeakDraft>(() => ({
    windows: (stored?.windows ?? []).map((window) => ({ ...window, weekdays: [...window.weekdays], id: nextRowId.current++ })),
    timezone: stored?.timezone ?? settingsTimezone
  }));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | undefined>();
  const scheduleEdited = useRef(false);
  const now = usePreviewClock();

  /**
   * Adopt the stored schedule until the reader edits it. The state is only
   * replaced when the values actually differ — returning the same object makes
   * React bail out, and without that every store notification (and every tick of
   * the preview clock) would re-seed this form.
   */
  const storedWindows = stored?.windows;
  const storedTimezone = stored?.timezone;
  useEffect(() => {
    if (scheduleEdited.current) return;
    const next = {
      windows: (storedWindows ?? []).map((window) => ({ ...window, weekdays: [...window.weekdays], id: nextRowId.current++ })),
      timezone: storedTimezone ?? settingsTimezone
    };
    setDraft((current) => (sameSchedule(current, next) ? current : next));
  }, [storedWindows, storedTimezone, settingsTimezone]);

  useEffect(() => {
    if (storedMode === undefined) return;
    setModeChoice(storedMode);
  }, [storedMode]);

  /** Builtin/off keep the stored windows so switching back restores them. */
  const persistMode = async (next: PeakReminderMode) => {
    setBusy(true);
    try {
      await props.onUpdateSettings({
        peakReminder: {
          ...props.settings.peakReminder,
          [props.provider]: {
            mode: next,
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

  /** Every edit invalidates the last verdict: the reason may no longer hold. */
  const editDraft = (next: (current: PeakDraft) => PeakDraft) => {
    scheduleEdited.current = true;
    setFeedback(undefined);
    setDraft(next);
  };

  const addWindow = () =>
    editDraft((current) => ({
      ...current,
      windows: [...current.windows, asRow({ weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' })]
    }));

  const updateWindow = (index: number, patch: Partial<PeakWindow>) =>
    editDraft((current) => ({
      ...current,
      windows: current.windows.map((window, at) => (at === index ? { ...window, ...patch } : window))
    }));

  const removeWindow = (index: number) =>
    editDraft((current) => ({ ...current, windows: current.windows.filter((_, at) => at !== index) }));

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
          [props.provider]: {
            mode: 'custom',
            // The row ids are the editor's own; the stored window is the three
            // fields the contract names.
            windows: draft.windows.map(({ weekdays, start, end }) => ({ weekdays, start, end })),
            timezone: draft.timezone
          }
        }
      });
      setFeedback({ tone: 'success', text: '已保存自定义时段' });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Whether the editor holds anything the settings do not.
   *
   * Only shown in custom mode — the other two modes write on the click, so there
   * is never a pending choice to report.
   */
  const dirty =
    mode !== (storedMode ?? 'off') ||
    !sameSchedule(draft, {
      windows: storedWindows ?? [],
      timezone: storedTimezone ?? settingsTimezone
    });

  /**
   * The schedule the read-back judges.
   *
   * `undefined` when the mode has no definition at all, which is not the same as
   * a definition that cannot be judged: the contract does not forbid a stored
   * `builtin` choice on a provider that publishes no table (only the editor
   * refuses to offer one), and there is nothing to say about a table that does
   * not exist. The strip stays away in that case rather than announcing that a
   * schedule it never had is incomplete.
   */
  const previewSource =
    mode === 'custom'
      ? { windows: draft.windows, timezone: draft.timezone }
      : mode === 'builtin' && builtin
        ? { windows: builtin.windows, timezone: builtin.timezone }
        : undefined;
  const preview = previewSource ? peakPreviewOf(previewSource.windows, previewSource.timezone, now) : undefined;
  const timezoneValid = isValidTimezone(draft.timezone);
  const localClock = timezoneValid ? zonedClock(draft.timezone, now) : undefined;

  /**
   * One message slot above the save button, so a failure is named beside the
   * action that produced it rather than at the bottom of the block.
   */
  const status = feedback
    ? { tone: feedback.tone, text: feedback.text }
    : mode === 'custom' && dirty
      ? { tone: 'progress' as const, text: '有未保存的改动' }
      : mode === 'custom'
        ? { tone: 'success' as const, text: '已保存' }
        : undefined;

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
            .map((choice) => (
              <button
                key={choice}
                type="button"
                className={`segmented-option${mode === choice ? ' is-active' : ''}`}
                aria-pressed={mode === choice}
                disabled={busy}
                onClick={() => changeMode(choice)}
              >
                {choice === 'builtin' ? '内置时段' : choice === 'custom' ? '自定义' : '关闭'}
              </button>
            ))}
        </SegmentedGroup>
      </div>
      {builtin && mode === 'builtin' ? (
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
            {builtin.offPeakNote ? ` · ${builtin.offPeakNote}` : null}
          </p>
        </div>
      ) : null}
      {mode === 'custom' ? (
        <div className="peak-editor">
          {draft.windows.length === 0 ? (
            <p className="peak-empty">还没有时段，至少添加一条才能保存</p>
          ) : (
            <ul className="peak-window-list">
              {draft.windows.map((window, index) => (
                <PeakWindowCard
                  /* The draft's own id, not the index: `is-leaving` is component
                     state, and an index key hands it to the row that takes the
                     removed one's place (see `PeakDraftRow`). */
                  key={window.id}
                  index={index}
                  window={window}
                  busy={busy}
                  onChange={(patch) => updateWindow(index, patch)}
                  onRemove={() => removeWindow(index)}
                />
              ))}
            </ul>
          )}
          <div className="peak-add-row">
            <button type="button" className="peak-add" disabled={busy} onClick={addWindow}>
              <span aria-hidden="true">＋</span> 添加时段
            </button>
            {/* Two steps are worth a line of text; a control that only answers to
                the arrow keys is a control nobody knows about. */}
            <span className="peak-keyhint">↑↓ 调分钟 · ⇧↑↓ 调小时</span>
          </div>
          <div className="setting-row peak-timezone-row">
            <span className="setting-text">
              <span className="setting-label">判定时区</span>
              <span className={`setting-desc${timezoneValid ? '' : ' is-invalid'}`}>
                {timezoneValid ? `该时区现在 ${localClock}` : '无法解析，请填 IANA 名称'}
              </span>
            </span>
            <input
              className={`text-input peak-timezone${timezoneValid ? '' : ' is-invalid'}`}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={draft.timezone}
              disabled={busy}
              placeholder="Asia/Shanghai"
              aria-label="判定时区"
              aria-invalid={timezoneValid ? undefined : true}
              onChange={(event) => editDraft((current) => ({ ...current, timezone: event.target.value }))}
            />
          </div>
        </div>
      ) : null}
      {/*
        The read-back: what the schedule in the editor means *now*, judged by the
        same `peakStateAt` the overview cards use. Editing used to end at the save
        button — the only way to learn what a schedule did was to save it, leave
        for the overview and read the card.
      */}
      {previewSource ? (
        <div
          className={`peak-verdict${preview ? '' : ' is-unknown'}`}
          {...(preview ? { 'data-period': preview.period } : {})}
          data-testid={`peak-verdict-${props.provider}`}
        >
          <span className="peak-verdict-dot" aria-hidden="true" />
          <span className="peak-verdict-text">
            {preview ? (
              <>
                现在{' '}
                <strong className="peak-verdict-period">
                  {preview.period === 'peak' ? '高峰' : '错峰'}
                </strong>
                {preview.gap ? ` · 距${preview.period === 'peak' ? '错峰' : '高峰'} ${preview.gap}` : ''}
              </>
            ) : (
              '时段不完整，无法判定'
            )}
          </span>
        </div>
      ) : null}
      {mode === 'custom' || status ? (
        <div className="peak-save-row">
          <span
            role={feedback?.tone === 'error' ? 'alert' : 'status'}
            className={`credential-feedback feedback-${status?.tone ?? 'success'}${
              status ? '' : ' is-empty'
            }`}
          >
            {status?.text ?? ''}
          </span>
          {/* The button only exists in custom mode; the other two write on the
              click, so the row is just the message there. */}
          {mode === 'custom' ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !dirty}
              onClick={() => void saveCustom()}
            >
              {busy ? '正在保存…' : '保存'}
            </button>
          ) : null}
        </div>
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

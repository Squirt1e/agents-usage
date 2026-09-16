/**
 * Status vocabulary of the panel.
 *
 * The Chinese wording (需要配置 / 认证失败 / 请求受限 / 接口不兼容 / 网络异常) is the
 * vocabulary this project has always used, extended with 等待刷新 for an elapsed
 * quota reset and 采集进程异常 / 存储异常 / 状态未知 for the remaining error kinds.
 * One vocabulary means the panel and the companion web page describe the same
 * failure the same way.
 *
 * A cached reading carries no notice of its own. It is still shown — dropping it
 * would turn a half-hour-old number into a blank card — but the panel does not
 * tell the user it is old, so the wording for that state is the failure behind it
 * (or 尚未连接 when there is none).
 */

import type { ReactNode } from 'react';
import type { CollectorError } from '../../shared/contracts';
import type { DesktopProviderState } from '../../shared/desktop-contract';

export type StatusTone = 'healthy' | 'warning' | 'danger' | 'neutral';

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
}

const ERROR_LABELS: Record<CollectorError['kind'], StatusPresentation> = {
  missing_config: { label: '需要配置', tone: 'neutral' },
  authentication: { label: '认证失败', tone: 'danger' },
  rate_limit: { label: '请求受限', tone: 'warning' },
  compatibility: { label: '接口不兼容', tone: 'danger' },
  network: { label: '网络异常', tone: 'warning' },
  process: { label: '采集进程异常', tone: 'danger' },
  storage: { label: '存储异常', tone: 'danger' },
  unknown: { label: '状态未知', tone: 'neutral' }
};

export function errorLabel(kind: CollectorError['kind']): StatusPresentation {
  return ERROR_LABELS[kind] ?? ERROR_LABELS.unknown;
}

/**
 * What to do about a failure, in one sentence.
 *
 * The settings panes used to answer this inconsistently: Codex's connection told
 * the reader how to recover, GLM's and DeepSeek's said nothing, and the one place
 * that did have an answer (the web-usage token) wrote a second, private mapping.
 * A status that names a failure without naming a way out is a dead end, so the
 * wording lives beside the vocabulary it belongs to and every connection asks the
 * same function.
 *
 * **Every kind has a sentence**, including the two that look self-evident:
 * `missing_config` is what a first-run connection reports (the collectors emit it
 * for an empty credential), and the form below the row is only an answer if the
 * reader is told to look there. `unknown` says to retry because that is genuinely
 * all there is to do. `tests/status-vocabulary.test.ts` iterates the kinds, so a
 * new one cannot arrive without wording.
 *
 * A connection with something more specific to say — "install Codex", "paste the
 * token again" — passes it as an override.
 */
const DEFAULT_ADVICE: Record<CollectorError['kind'], string> = {
  missing_config: '在下方填入凭据后即可开始采集。',
  authentication: '凭据已失效，请重新获取后替换。',
  rate_limit: '请求受限，稍后会自动重试。',
  network: '网络请求失败，检查网络或代理后重试。',
  compatibility: '接口可能已改版，请更新应用后重试。',
  process: '采集进程未能启动，请检查安装。',
  storage: '本地数据读写失败，重启应用后再试。',
  unknown: '原因未知，请刷新一次后重试。'
};

export type RecoveryAdvice = Partial<Record<CollectorError['kind'], string>>;

export function recoveryAdvice(
  kind: CollectorError['kind'] | undefined,
  overrides: RecoveryAdvice = {}
): string | undefined {
  if (!kind) return undefined;
  return overrides[kind] ?? DEFAULT_ADVICE[kind];
}

/** The failure kind a connection state carries, error first and cached snapshot second. */
export function failureKind(state: DesktopProviderState | undefined): CollectorError['kind'] | undefined {
  return (state?.error ?? state?.snapshot?.error)?.kind;
}

/** Recovery advice for a connection state, with the connection's own wording on top. */
export function stateAdvice(
  state: DesktopProviderState | undefined,
  overrides: RecoveryAdvice = {}
): string | undefined {
  return recoveryAdvice(failureKind(state), overrides);
}

/**
 * Presentation of one provider or connection state.
 *
 * A degraded (cached) snapshot is named after the failure that made it stale, so
 * the line says why rather than that time has passed; a connection with neither
 * snapshot nor error is simply 尚未连接, never an error.
 */
export function statusFor(state: DesktopProviderState | undefined): StatusPresentation {
  if (!state) return { label: '尚未连接', tone: 'neutral' };
  const error = state.error ?? state.snapshot?.error;
  const status = state.snapshot?.status;
  if (error) return errorLabel(error.kind);
  if (status === 'connected' || status === 'degraded') return { label: '数据正常', tone: 'healthy' };
  if (status === 'unavailable') return { label: '暂不可用', tone: 'warning' };
  return { label: '尚未连接', tone: 'neutral' };
}

export function StatusDot({ tone }: { tone: StatusTone }) {
  return <i className={`status-dot status-dot-${tone}`} aria-hidden="true" />;
}

/** One connection's status line with its recovery entry. */
export function StatusRow(props: {
  tone: StatusTone;
  label: string;
  detail?: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <div className={`status-row status-row-${props.tone}`} role="status" {...(props.testId ? { 'data-testid': props.testId } : {})}>
      <StatusDot tone={props.tone} />
      <span className="status-label">{props.label}</span>
      {props.detail ? <span className="status-detail">{props.detail}</span> : null}
      {props.actions ? <span className="status-actions">{props.actions}</span> : null}
    </div>
  );
}

/**
 * The estimate tone is reserved for values the provider does not bill
 * authoritatively; informational tags (实验数据源 / Codex 托管登录) stay neutral.
 */
export function ConfidenceTag({ children, tone }: { children: ReactNode; tone?: 'estimate' }) {
  const className = tone === 'estimate' ? 'tag tag-confidence tag-estimate' : 'tag tag-confidence';
  return <span className={className}>{children}</span>;
}

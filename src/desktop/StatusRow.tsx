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
import type { CollectorError } from '../shared/contracts';
import type { DesktopProviderState } from '../shared/desktop-contract';

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

import type { CollectorError, Confidence, ProviderId, ProviderSnapshot, UsageMetric } from '../shared/contracts';

export interface ProviderViewState {
  provider: ProviderId;
  snapshot?: ProviderSnapshot;
  error?: CollectorError;
}

const providerNames: Record<ProviderId, string> = { codex: 'Codex', glm: 'GLM Coding Plan', deepseek: 'DeepSeek' };
const confidenceNames: Record<Confidence, string> = { authoritative: '平台数据', experimental: '实验功能', estimated: '估算', partial: '部分数据', stale: '已过期', unavailable: '不可用' };

export function formatCountdown(resetAt: string, now: Date) {
  const remaining = new Date(resetAt).getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return '等待刷新';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function formatValue(metric: UsageMetric) {
  if (metric.value === null) return '不可用';
  if (typeof metric.value === 'string') return metric.value;
  if (metric.unit === 'percent') return `${metric.value}%`;
  if (metric.direction === 'balance' || metric.direction === 'spend') {
    try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: metric.unit, minimumFractionDigits: 2 }).format(metric.value); }
    catch { return `${metric.value.toFixed(2)} ${metric.unit}`; }
  }
  return `${new Intl.NumberFormat('zh-CN').format(metric.value)} ${metric.unit}`;
}

function statusFor(state: ProviderViewState) {
  const error = state.snapshot?.error ?? state.error;
  if (state.snapshot?.status === 'connected') return { label: '数据正常', tone: 'healthy' };
  if (state.snapshot?.status === 'degraded') return { label: '数据已过期', tone: 'warning' };
  if (error?.kind === 'missing_config') return { label: '需要配置', tone: 'neutral' };
  if (error?.kind === 'authentication') return { label: '认证失败', tone: 'danger' };
  if (error?.kind === 'rate_limit') return { label: '请求受限', tone: 'warning' };
  if (error?.kind === 'compatibility') return { label: '接口不兼容', tone: 'danger' };
  if (error?.kind === 'network') return { label: '网络异常', tone: 'warning' };
  return { label: '尚未连接', tone: 'neutral' };
}

function ConfidenceBadges({ confidence }: { confidence: Confidence[] }) {
  return <span className="badges">{confidence.map((value) => <span className={`badge badge-${value}`} key={value}>{confidenceNames[value]}</span>)}</span>;
}

function QuotaMetric({ metric, metrics, now }: { metric: UsageMetric; metrics: UsageMetric[]; now: Date }) {
  const remaining = metrics.find((candidate) => candidate.key === metric.key.replace(/\.used$/, '.remaining'));
  const used = typeof metric.value === 'number' ? metric.value : 0;
  return <article className="metric quota-metric">
    <div className="metric-heading"><span>{metric.label ?? metric.key}</span><ConfidenceBadges confidence={metric.confidence} /></div>
    <div className="quota-values"><strong>已用 {formatValue(metric)}</strong><span>剩余 {remaining ? formatValue(remaining) : '不可用'}</span></div>
    <div className="progress-track" role="progressbar" aria-label={`${metric.label ?? metric.key} 已用`} aria-valuenow={used} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.max(0, Math.min(100, used))}%` }} /></div>
    {metric.resetAt && <div className="reset-row"><span>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(metric.resetAt))}</span><span>{formatCountdown(metric.resetAt, now)}</span></div>}
  </article>;
}

function StandardMetric({ metric }: { metric: UsageMetric }) {
  return <article className="metric standard-metric">
    <div className="metric-heading"><span>{metric.label ?? metric.key}</span><ConfidenceBadges confidence={metric.confidence} /></div>
    <strong>{formatValue(metric)}</strong>
    {metric.confidence.includes('estimated') && <p className="metric-note">根据本地余额变化估算；充值、退款或采集间隔可能影响准确性。</p>}
  </article>;
}

function ProviderCard({ state, now, onRefresh, refreshing }: { state: ProviderViewState; now: Date; onRefresh: (provider: ProviderId) => void; refreshing: boolean }) {
  const status = statusFor(state);
  const metrics = state.snapshot?.metrics ?? [];
  const shown = metrics.filter((metric) => metric.direction !== 'remaining');
  const error = state.snapshot?.error ?? state.error;
  return <section className="provider-card" data-testid={`provider-${state.provider}`} aria-labelledby={`heading-${state.provider}`}>
    <header className="provider-header"><div><span className="provider-kicker">{state.provider.toUpperCase()}</span><h2 id={`heading-${state.provider}`}>{providerNames[state.provider]}</h2></div><span className={`status status-${status.tone}`}>{status.label}</span></header>
    <div className="metric-list">
      {shown.map((metric) => metric.unit === 'percent' && metric.direction === 'used' ? <QuotaMetric key={metric.key} metric={metric} metrics={metrics} now={now} /> : <StandardMetric key={metric.key} metric={metric} />)}
      {!shown.length && <div className="empty-state"><p>{error?.message ?? '连接后将在这里显示最新用量。'}</p><a href="#settings">前往设置</a></div>}
    </div>
    {error && <div className="provider-error" role="status"><strong>{status.label}</strong><span>{error.message}</span></div>}
    <footer className="provider-footer"><span>{state.snapshot?.lastSuccessAt ? `最后更新 ${new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium' }).format(new Date(state.snapshot.lastSuccessAt))}` : '暂无成功数据'}</span><button type="button" className="secondary-button" disabled={refreshing} aria-label={refreshing ? `正在刷新 ${providerNames[state.provider]}` : `刷新 ${providerNames[state.provider]}`} onClick={() => onRefresh(state.provider)}>{refreshing ? '刷新中…' : '刷新'}</button></footer>
  </section>;
}

export function Dashboard(props: {
  providers: ProviderViewState[];
  now: Date;
  onRefresh: (provider: ProviderId) => void;
  refreshing: Set<ProviderId>;
}) {
  const ordered = (['codex', 'glm', 'deepseek'] as const).map((provider) => props.providers.find((entry) => entry.provider === provider) ?? { provider });
  return <div className="provider-grid">{ordered.map((state) => <ProviderCard key={state.provider} state={state} now={props.now} onRefresh={props.onRefresh} refreshing={props.refreshing.has(state.provider)} />)}</div>;
}

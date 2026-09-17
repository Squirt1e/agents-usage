/**
 * Panel metric rules: which metrics may be rendered at all, how the platform
 * cards derive their values from a snapshot, and how numbers are formatted.
 *
 * Everything here is pure so it can be unit tested without a DOM. The rules come
 * from the `desktop-usage-dashboard` spec, section by section:
 *
 * - capability `unsupported` / `unknown` → the whole metric is hidden,
 * - a `null` value → the metric is hidden (never rendered as `0` or 暂不可用),
 * - a reliable `0` → rendered,
 * - a same-day cached value that went stale → rendered and marked,
 * - a value from another day or another confirmed range → hidden,
 * - a Codex window that was not returned → not replaced by another window or by
 *   zero,
 * - GLM quota and wallet are independent: one failing never hides the other.
 */

import type { CollectorError, Confidence, MetricDirection, ProviderId } from '../../shared/contracts';
import {
  connectionKey,
  localDayIn,
  stateConnection,
  type ConnectionId,
  type DesktopProviderState,
  type DesktopUsageMetric,
  type PanelSnapshot,
  type ResetTimeFormat
} from '../../shared/desktop-contract';

// ---------------------------------------------------------------------------
// Rendering gate (task 6.6)
// ---------------------------------------------------------------------------

export type MetricHideReason =
  /** No metric at all for this slot. */
  | 'absent'
  /** The value is `null`: unknown, and not to be shown as zero. */
  | 'hidden-value'
  /** The source cannot produce this metric. */
  | 'unsupported'
  /** The source did not say whether it can produce this metric. */
  | 'unknown'
  /** The metric belongs to a different local day than the one being displayed. */
  | 'other-day'
  /** The confirmed range does not match today. */
  | 'stale-range'
  /** A daily metric without a statistic scope cannot be attributed to today. */
  | 'missing-scope';

export type MetricGate = { render: false; reason: MetricHideReason } | { render: true; stale: boolean };

export interface MetricGateOptions {
  /** Current instant. */
  now: Date;
  /** Local day of the configured timezone; computed from `timezone` when absent. */
  localDay?: string;
  /** IANA timezone used to compute `localDay`. */
  timezone?: string;
  /**
   * Daily metrics (today's tokens, today's spend): require a scope that confirms
   * the range matches today. A rolling window is never relabelled as today.
   */
  rangeRequired?: boolean;
}

/**
 * Decide whether a metric may be rendered.
 *
 * A missing metric, a missing value and an unsupported capability all hide the
 * metric *and its label*: the panel shows neither a zero nor a 暂不可用
 * placeholder. A value the source really reported as zero is rendered.
 */
export function shouldRenderMetric(
  metric: DesktopUsageMetric | undefined | null,
  options: MetricGateOptions
): MetricGate {
  if (!metric) return { render: false, reason: 'absent' };
  // A producer that predates the capability field is not claiming the feature is
  // absent; the value it sent is the evidence. Only an explicit
  // `unsupported`/`unknown` hides the metric.
  const capability = metric.capability ?? 'supported';
  if (capability === 'unsupported') return { render: false, reason: 'unsupported' };
  if (capability === 'unknown') return { render: false, reason: 'unknown' };
  if (metric.value === null) return { render: false, reason: 'hidden-value' };

  const localDay = options.localDay ?? localDayIn(options.timezone ?? 'UTC', options.now);
  const scope = metric.scope;
  if (scope && scope.localDay !== localDay) return { render: false, reason: 'other-day' };
  if (options.rangeRequired === true) {
    if (!scope) return { render: false, reason: 'missing-scope' };
    // `rangeConfirmed` is only true when the source confirmed the range matches
    // the local day; anything else means the value cannot be called "today".
    if (scope.rangeConfirmed !== true) return { render: false, reason: 'stale-range' };
  }
  return { render: true, stale: metric.confidence.includes('stale') };
}

// ---------------------------------------------------------------------------
// Provider view: one provider, all of its connections merged
// ---------------------------------------------------------------------------

export interface ProviderView {
  provider: ProviderId;
  states: DesktopProviderState[];
  metrics: DesktopUsageMetric[];
  connections: ConnectionId[];
  /** The state that represents the provider as a whole (quota for GLM). */
  primary?: DesktopProviderState;
  /** Newest successful capture across the connections. */
  lastSuccessAt?: string;
  /** Error of one connection, or of the primary connection when omitted. */
  error(connection?: string): CollectorError | undefined;
  /** Health of one connection. */
  state(connection?: string): DesktopProviderState | undefined;
}

const PRIMARY_CONNECTIONS = ['quota', 'account', 'default', 'wallet'];

/**
 * The same snapshot with one connection's states removed.
 *
 * The DeepSeek card uses this to pretend the experimental web connection does
 * not exist while its settings switch is off: no metrics, no error, no entry in
 * the connection list — a disabled feature leaves no trace on the main panel.
 * The state is recognised through the shared resolver, so a web connection that
 * has never succeeded (no snapshot to carry its identity) is removed too.
 */
export function withoutConnection(snapshot: PanelSnapshot, provider: ProviderId, connection: string): PanelSnapshot {
  return {
    ...snapshot,
    providers: snapshot.providers.filter((state) => {
      if (state.provider !== provider) return true;
      return stateConnection(state)?.connection !== connection;
    })
  };
}

/**
 * Merge every state reported for one provider.
 *
 * The service may report GLM as one entry whose metrics carry the connection, or
 * as two entries (`glm:quota` and `glm:wallet`). Both are handled here so a
 * failure of the wallet can never be read as a failure of the quota.
 */
export function providerView(snapshot: PanelSnapshot | undefined, provider: ProviderId): ProviderView {
  const states = (snapshot?.providers ?? []).filter((state) => state.provider === provider);
  const metrics: DesktopUsageMetric[] = [];
  const seen = new Set<string>();
  for (const state of states) {
    for (const metric of state.snapshot?.metrics ?? []) {
      const connection = metric.connection ?? stateConnection(state);
      const id = `${connection ? connectionKey(connection) : '-'}:${metric.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      metrics.push(metric);
    }
  }

  const connections: ConnectionId[] = [];
  for (const state of states) {
    const candidates = [...(state.connections ?? []), ...(state.connection ? [state.connection] : []), ...(state.snapshot?.connection ? [state.snapshot.connection] : [])];
    for (const candidate of candidates) {
      if (!connections.some((entry) => connectionKey(entry) === connectionKey(candidate))) connections.push(candidate);
    }
  }
  for (const metric of metrics) {
    if (metric.connection && !connections.some((entry) => connectionKey(entry) === connectionKey(metric.connection!))) {
      connections.push(metric.connection);
    }
  }

  const primary =
    states.find((state) => {
      const name = stateConnection(state)?.connection;
      return name !== undefined && PRIMARY_CONNECTIONS.includes(name);
    }) ??
    states.find((state) => stateConnection(state) === undefined) ??
    states[0];

  const state = (connection?: string) => {
    if (connection === undefined) return primary;
    return states.find((entry) => stateConnection(entry)?.connection === connection);
  };

  let lastSuccessAt: string | undefined;
  for (const entry of states) {
    const candidate = entry.snapshot?.lastSuccessAt ?? entry.snapshot?.capturedAt;
    if (!candidate) continue;
    if (!lastSuccessAt || new Date(candidate).getTime() > new Date(lastSuccessAt).getTime()) lastSuccessAt = candidate;
  }

  return {
    provider,
    states,
    metrics,
    connections,
    lastSuccessAt,
    ...(primary ? { primary } : {}),
    state,
    error(connection?: string) {
      if (connection === undefined) return primary?.error ?? primary?.snapshot?.error;
      const entry = state(connection);
      return entry?.error ?? entry?.snapshot?.error;
    }
  };
}

/**
 * Whether a platform's newest attempt failed, read from the state the service
 * published.
 *
 * A manual refresh comes back acknowledged but without a verdict (see
 * `RefreshStatus`), so the answer has to come from the same place the card reads:
 * the primary connection's own error against that connection's own last
 * successful capture. An error that is newer than the last success — or a
 * connection with no successful capture, or no published state at all — is a
 * failure; anything else is an update. The message and the status word next to it
 * must never disagree, which is why this compares the two facts the card already
 * shows instead of deriving a third one.
 */
export function latestAttemptFailed(view: ProviderView): boolean {
  const state = view.primary;
  // Nothing published for this platform at all: the refresh brought nothing back.
  if (!state) return true;
  const error = view.error();
  const succeededAt = state.snapshot?.lastSuccessAt ?? state.snapshot?.capturedAt;
  if (!error) return succeededAt === undefined;
  const failedAt = Date.parse(error.at);
  const succeeded = succeededAt === undefined ? Number.NaN : Date.parse(succeededAt);
  // An error stands unless a successful capture is provably newer than it.
  return !Number.isFinite(failedAt) || !Number.isFinite(succeeded) || failedAt >= succeeded;
}

/** Metrics of one connection (or of the provider-wide metrics when omitted). */
export function connectionMetrics(view: ProviderView, connection?: string): DesktopUsageMetric[] {
  if (connection === undefined) return view.metrics;
  return view.metrics.filter((metric) => {
    const name = metric.connection?.connection;
    return name === undefined || name === connection;
  });
}

// ---------------------------------------------------------------------------
// Codex: five-hour and weekly windows
// ---------------------------------------------------------------------------

export const FIVE_HOUR_SECONDS = 18_000;
export const WEEKLY_SECONDS = 604_800;

/** The two Codex windows the panel renders. */
export type QuotaWindowKind = 'five-hour' | 'weekly';

export interface QuotaWindow {
  id: QuotaWindowKind;
  label: string;
  used?: DesktopUsageMetric;
  remaining?: DesktopUsageMetric;
}

interface WindowSelector {
  id: QuotaWindow['id'];
  label: string;
  seconds: number;
  keyHints: RegExp;
}

const CODEX_WINDOWS: WindowSelector[] = [
  { id: 'five-hour', label: '5小时', seconds: FIVE_HOUR_SECONDS, keyHints: /(^|\.)5h(\.|$)|\.primary$/ },
  { id: 'weekly', label: '7天', seconds: WEEKLY_SECONDS, keyHints: /weekly|7d|\.secondary$/ }
];

function bucketOf(metric: DesktopUsageMetric): string | undefined {
  const value = metric.details?.bucketId;
  return typeof value === 'string' ? value : undefined;
}

function pickWindowMetric(
  metrics: DesktopUsageMetric[],
  selector: WindowSelector,
  direction: MetricDirection
): DesktopUsageMetric | undefined {
  const candidates = metrics.filter((metric) => metric.unit === 'percent' && metric.direction === direction);
  // The window length is metadata, so it decides even when the provider returns
  // the buckets in a different order. The `codex` bucket is preferred when two
  // buckets share a window length.
  const byLength = candidates
    .filter((metric) => metric.windowSeconds === selector.seconds)
    .sort((a, b) => Number(bucketOf(b) === 'codex') - Number(bucketOf(a) === 'codex'));
  if (byLength.length > 0) return byLength[0];
  // Documented last resort: the Codex convention (primary = 5h, secondary =
  // weekly) applies only when the payload carried no window length at all.
  return candidates.find((metric) => metric.windowSeconds === undefined && selector.keyHints.test(metric.key));
}

/**
 * The two Codex gauges.
 *
 * A window the provider did not return stays `undefined`: the card shows the
 * gauge's label with an explicit "未返回" note and never substitutes the other
 * window or a zero.
 */
export function codexWindows(view: ProviderView): QuotaWindow[] {
  return CODEX_WINDOWS.map((selector) => ({
    id: selector.id,
    label: selector.label,
    used: pickWindowMetric(view.metrics, selector, 'used'),
    remaining: pickWindowMetric(view.metrics, selector, 'remaining')
  }));
}

// ---------------------------------------------------------------------------
// GLM: quota windows, wallet balance and wallet spend
// ---------------------------------------------------------------------------

export interface QuotaBar {
  id: string;
  label: string;
  used?: DesktopUsageMetric;
  remaining?: DesktopUsageMetric;
}

const GLM_BAR_LABELS: Record<string, string> = {
  '5h': '5小时',
  weekly: '7天',
  'tools.monthly': '月度'
};

const GLM_BAR_ORDER = ['5h', 'weekly', 'tools.monthly'];

/** GLM quota bars, in a stable order regardless of the response order. */
export function glmQuotaWindows(view: ProviderView): QuotaBar[] {
  const found = new Map<string, { used?: DesktopUsageMetric; remaining?: DesktopUsageMetric }>();
  for (const metric of connectionMetrics(view, 'quota')) {
    const match = /^quota\.(.+)\.(used|remaining)$/.exec(metric.key);
    if (!match) continue;
    const id = match[1];
    const direction = match[2] as 'used' | 'remaining' | undefined;
    if (id === undefined || direction === undefined) continue;
    const window = found.get(id) ?? {};
    if (window[direction] === undefined) window[direction] = metric;
    found.set(id, window);
  }
  // The plan has two primary windows. A partial response must leave the absent
  // one visible as missing rather than making the whole card look single-window.
  const ids = [...new Set(['5h', 'weekly', ...found.keys()])].sort((a, b) => {
    const left = GLM_BAR_ORDER.indexOf(a);
    const right = GLM_BAR_ORDER.indexOf(b);
    return (left === -1 ? GLM_BAR_ORDER.length : left) - (right === -1 ? GLM_BAR_ORDER.length : right);
  });
  return ids.map((id) => ({
    id,
    label: GLM_BAR_LABELS[id] ?? id,
    ...found.get(id)
  }));
}

export interface WalletValue {
  currency: string;
  metric: DesktopUsageMetric;
}

function currencyOf(metric: DesktopUsageMetric, suffix: string): string | undefined {
  const match = new RegExp(`^wallet\\.([A-Za-z]{2,5})\\.${suffix}$`).exec(metric.key);
  return match?.[1];
}

/** GLM wallet balance metrics (`wallet.<CUR>.balance`), one per currency. */
export function walletBalances(view: ProviderView, connection = 'wallet'): WalletValue[] {
  const values: WalletValue[] = [];
  for (const metric of connectionMetrics(view, connection)) {
    const currency = currencyOf(metric, 'balance');
    if (!currency) continue;
    if (values.some((entry) => entry.currency === currency)) continue;
    values.push({ currency, metric });
  }
  return values;
}

/** DeepSeek total balances (`wallet.<CUR>.total`), one per currency. */
export function totalBalances(view: ProviderView): WalletValue[] {
  const values: WalletValue[] = [];
  for (const metric of view.metrics) {
    const currency = currencyOf(metric, 'total');
    if (!currency) continue;
    if (values.some((entry) => entry.currency === currency)) continue;
    values.push({ currency, metric });
  }
  return values;
}

/** Today's billed spend (`spend.<CUR>.daily.billed`), one per currency. */
export function dailyBilledSpends(view: ProviderView, connection?: string): WalletValue[] {
  const values: WalletValue[] = [];
  for (const metric of connectionMetrics(view, connection)) {
    const match = /^spend\.([A-Za-z]{2,5})\.daily\.billed$/.exec(metric.key);
    const currency = match?.[1];
    if (!currency) continue;
    if (values.some((entry) => entry.currency === currency)) continue;
    values.push({ currency, metric });
  }
  return values;
}

/** Today's request count (`activity.daily.requests`), from a billed source. */
export function dailyRequests(view: ProviderView, connection?: string): DesktopUsageMetric | undefined {
  return connectionMetrics(view, connection).find((metric) => metric.key === 'activity.daily.requests');
}

/** Today's estimated spend (`spend.<CUR>.daily`), one per currency. */
export function dailySpends(view: ProviderView, connection?: string): WalletValue[] {
  const values: WalletValue[] = [];
  for (const metric of connectionMetrics(view, connection)) {
    const match = /^spend\.([A-Za-z]{2,5})\.daily$/.exec(metric.key);
    const currency = match?.[1];
    if (!currency) continue;
    if (values.some((entry) => entry.currency === currency)) continue;
    values.push({ currency, metric });
  }
  return values;
}

/** Today's tokens (`activity.daily.tokens`), optionally scoped to a connection. */
export function dailyTokens(view: ProviderView, connection?: string): DesktopUsageMetric | undefined {
  return connectionMetrics(view, connection).find((metric) => metric.key === 'activity.daily.tokens');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Numeric value of a metric; `null` when it carries no usable number. */
export function metricNumber(metric: DesktopUsageMetric | undefined): number | null {
  if (!metric) return null;
  if (typeof metric.value === 'number') return Number.isFinite(metric.value) ? metric.value : null;
  if (typeof metric.value === 'string') {
    const parsed = Number(metric.value);
    return metric.value.trim() !== '' && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Live countdown to an absolute reset time.
 *
 * Once the reset time has passed the panel shows 等待刷新: the quota itself is
 * kept (a reset is not an observed zero) until a refresh produces a new window.
 */
export function formatCountdown(resetAt: string | undefined, now: Date, precision: 'second' | 'minute' = 'second'): string {
  if (!resetAt) return '等待刷新';
  const remaining = new Date(resetAt).getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return '等待刷新';
  const totalSeconds = Math.floor(remaining / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} 天 ${pad(hours % 24)}:${pad(minutes)}`;
  }
  return `${pad(hours)}:${pad(minutes)}${precision === 'second' ? `:${pad(seconds)}` : ''}`;
}

/** Absolute reset time in the configured timezone, e.g. `09-10 18:42`. */
export function formatAbsoluteReset(resetAt: string | undefined, timeZone?: string): string | undefined {
  if (!resetAt) return undefined;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const options: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  try {
    return new Intl.DateTimeFormat('zh-CN', { ...options, ...(timeZone ? { timeZone } : {}) })
      .format(date)
      .replace(/\//g, '-');
  } catch {
    return new Intl.DateTimeFormat('zh-CN', options).format(date).replace(/\//g, '-');
  }
}

/**
 * Currency amount as `symbol + space + two decimals` (`¥ 86.42`) — the format
 * the confirmed design uses — built without Intl: engines disagree on the
 * zh-CN currency pattern (some drop the space or widen ¥ to CN¥), which made
 * the same value render differently across the Node tests and the WebKit panel.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  HKD: 'HK$',
  TWD: 'NT$',
  KRW: '₩',
  SGD: 'S$'
};

export function formatMoney(value: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  const amount = value.toFixed(2);
  return symbol === undefined ? `${currency} ${amount}` : `${symbol} ${amount}`;
}

/** Compact token counts, e.g. `86.2 K`. */
export function formatTokens(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)} K`;
  return String(value);
}

/** `HH:mm` of an instant in the configured timezone. */
export function formatClockTime(value: string | Date | undefined, timeZone?: string): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat('zh-CN', { ...options, ...(timeZone ? { timeZone } : {}) }).format(date);
  } catch {
    return new Intl.DateTimeFormat('zh-CN', options).format(date);
  }
}

/** Zoned calendar parts of an instant, falling back to the local zone. */
function zonedParts(
  date: Date,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions
): Record<string, string> {
  const build = (zone?: string) =>
    new Intl.DateTimeFormat('en-CA', { ...options, ...(zone ? { timeZone: zone } : {}) })
      .formatToParts(date)
      .reduce<Record<string, string>>((parts, part) => {
        if (part.type !== 'literal') parts[part.type] = part.value;
        return parts;
      }, {});
  try {
    return build(timeZone);
  } catch {
    // An unknown timezone must not break the card.
    return build();
  }
}

/**
 * Countdown to a reset in the units that suit the window:
 *
 * - a five-hour window counts in hours and minutes (`2 小时 15 分钟`), dropping
 *   the hours once they reach zero (`15 分钟`),
 * - a weekly window counts in days and hours (`3 天 8 小时`), dropping the
 *   days once they reach zero (`8 小时`).
 *
 * `等待刷新` means the reset has already passed; the panel keeps the last value
 * until the scheduler refreshes.
 */
export function formatResetCountdown(
  resetAt: string | undefined,
  now: Date,
  kind: QuotaWindowKind
): string {
  if (!resetAt) return '等待刷新';
  const remaining = new Date(resetAt).getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return '等待刷新';
  const totalMinutes = Math.floor(remaining / 60_000);
  if (kind === 'weekly') {
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

/**
 * Absolute reset time in the configured timezone:
 *
 * - a five-hour window shows the zero-padded 24-hour clock (`20:20`),
 * - a weekly window shows the date with spaced numerals (`09 月 17 日`).
 */
export function formatResetAbsolute(
  resetAt: string | undefined,
  timeZone: string | undefined,
  kind: QuotaWindowKind
): string {
  if (!resetAt) return '等待刷新';
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return '等待刷新';
  if (kind === 'weekly') {
    const parts = zonedParts(date, timeZone, { month: '2-digit', day: '2-digit' });
    if (!parts.month || !parts.day) return '等待刷新';
    return `${parts.month} 月 ${parts.day} 日`;
  }
  // h23 pins midnight to `00` (hour12: false alone can yield `24` in some
  // engines), and zonedParts keeps the padding deterministic across runtimes.
  const parts = zonedParts(date, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (!parts.hour || !parts.minute) return '等待刷新';
  return `${parts.hour}:${parts.minute}`;
}

/**
 * The single line a gauge shows under its ring: either the live countdown
 * (`2 小时 15 分钟后重置`) or the absolute reset time (`20:20 重置` /
 * `09 月 17 日 重置`), depending on the user's chosen format.
 */
export function formatResetLabel(
  resetAt: string | undefined,
  now: Date,
  options: { format: ResetTimeFormat; kind: QuotaWindowKind; timezone?: string }
): string {
  if (options.format === 'absolute') {
    const value = formatResetAbsolute(resetAt, options.timezone, options.kind);
    if (value === '等待刷新') return value;
    return `${value} 重置`;
  }
  const value = formatResetCountdown(resetAt, now, options.kind);
  return value === '等待刷新' ? value : `${value}后重置`;
}

export type VisibleSyncSummary =
  | { state: 'none' }
  | { state: 'partial' }
  | { state: 'complete'; oldestSuccessAt: string };

/**
 * A conservative answer to "how fresh are all cards on screen?".
 *
 * The newest provider cannot stand in for the others: the footer says "全部同步"
 * only when every visible provider has succeeded, and then reports the oldest of
 * those successes — the instant by which the whole set was known to be current.
 */
export function visibleSyncSummary(views: ProviderView[]): VisibleSyncSummary {
  if (views.length === 0) return { state: 'none' };
  if (views.some((view) => !view.lastSuccessAt)) return { state: 'partial' };

  let oldestSuccessAt = views[0]!.lastSuccessAt!;
  for (const view of views.slice(1)) {
    if (new Date(view.lastSuccessAt!).getTime() < new Date(oldestSuccessAt).getTime()) {
      oldestSuccessAt = view.lastSuccessAt!;
    }
  }
  return { state: 'complete', oldestSuccessAt };
}

/** Confidence markers the panel shows next to a value. */
export function confidenceNote(confidence: Confidence[] | undefined): string | undefined {
  if (!confidence) return undefined;
  if (confidence.includes('estimated')) return '估算';
  if (confidence.includes('experimental')) return '实验数据源';
  if (confidence.includes('partial')) return '部分数据';
  return undefined;
}

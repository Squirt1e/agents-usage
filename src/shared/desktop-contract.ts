/**
 * Panel-facing contract shared by the desktop panel, the companion web page and
 * the local Rust service.
 *
 * The base vocabulary (provider, confidence, direction, status, error kind,
 * metric) lives in `./contracts.ts` and is re-used here, never redefined. This
 * module only adds what the panel needs on top of it:
 *
 * - per-connection identity (`glm:quota` vs `glm:wallet`),
 * - the capability marker that decides whether a metric can be rendered at all,
 * - the statistic scope (local day / timezone / confirmed range) that keeps a
 *   cached value from being shown as "today",
 * - the non-sensitive desktop settings (platform visibility, GLM region, wallet
 *   enable/visible, quota value mode, Codex CLI path) and masked credential status.
 *
 * Serialization matches `crates/usage-core/src/contracts.rs` field by field
 * (camelCase, `null` for an absent value, ISO-8601 timestamps).
 *
 * ## The one rule the validators exist for
 *
 * **A missing value stays missing.** The parsers here never turn an absent,
 * empty or unparsable value into `0`, `false` or `"暂不可用"`: an absent metric
 * value becomes `null`, an absent capability stays `undefined` (which the panel
 * treats as "unknown" and therefore hides), and an absent range confirmation is
 * `false` rather than an assumed "yes". Only values the platform actually
 * reported as zero are carried through as zero.
 */

import type {
  CollectorError,
  Confidence,
  MetricDirection,
  ProviderId,
  ProviderSnapshot,
  UsageMetric
} from './contracts';

/**
 * Connection health, derived from the base contract's snapshot so the enum has a
 * single definition (`src/shared/contracts.ts`) and the spellings cannot drift.
 */
export type ConnectionStatus = ProviderSnapshot['status'];

export const PROVIDER_IDS: readonly ProviderId[] = ['codex', 'glm', 'deepseek'];
export const METRIC_CAPABILITIES = ['supported', 'unsupported', 'unknown'] as const;
export const CONFIDENCE_VALUES: readonly Confidence[] = [
  'authoritative',
  'experimental',
  'estimated',
  'partial',
  'stale',
  'unavailable'
];
export const METRIC_DIRECTIONS: readonly MetricDirection[] = ['used', 'remaining', 'balance', 'spend', 'activity'];
export const CONNECTION_STATUSES: readonly ConnectionStatus[] = ['connected', 'degraded', 'disconnected', 'unavailable'];
export const ERROR_KINDS = [
  'missing_config',
  'authentication',
  'compatibility',
  'network',
  'rate_limit',
  'process',
  'storage',
  'unknown'
] as const;
export const GLM_REGIONS = ['china', 'international'] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];
export type GlmRegion = (typeof GLM_REGIONS)[number];
/** Whether the platform can produce a metric at all. */
export type MetricCapability = (typeof METRIC_CAPABILITIES)[number];

/** Credential targets the panel can validate, save and delete. */
export type CredentialTarget = 'glm' | 'deepseek' | 'glm-wallet' | 'deepseek-web';

/** Which connection inside a provider produced a value. */
export interface ConnectionId {
  provider: ProviderId;
  /** Stable machine identifier: `quota`, `wallet`, `account`. */
  connection: string;
  /** Human readable label, e.g. `Coding Plan` or `钱包`. */
  label?: string;
}

/**
 * Date and range a metric was computed for.
 *
 * `rangeConfirmed` is `true` only when the source itself confirmed that the
 * queried range matches `localDay`; it never defaults to `true`.
 */
export interface StatisticScope {
  /** Local date in the configured timezone, `YYYY-MM-DD`. */
  localDay: string;
  /** IANA timezone the local day was computed in. */
  timezone?: string;
  rangeStart?: string;
  rangeEnd?: string;
  rangeConfirmed: boolean;
}

/** A usage metric plus the panel-facing extras. */
export interface DesktopUsageMetric extends Omit<UsageMetric, 'value'> {
  /** `null` means the value is unknown; it must not be rendered as `0`. */
  value: number | string | null;
  connection?: ConnectionId;
  capability?: MetricCapability;
  scope?: StatisticScope;
}

export interface DesktopProviderSnapshot extends Omit<ProviderSnapshot, 'metrics'> {
  connection?: ConnectionId;
  metrics: DesktopUsageMetric[];
}

/**
 * One connection's state. A provider with two independent connections (GLM
 * quota and GLM wallet) is reported either as two entries carrying different
 * `connection` values, or as a single entry whose metrics carry the connection
 * — both shapes are accepted and merged by `providerView`.
 */
export interface DesktopProviderState {
  provider: ProviderId;
  connection?: ConnectionId;
  snapshot?: DesktopProviderSnapshot;
  error?: CollectorError;
  /** Connections the provider is configured for, as reported by the service. */
  connections?: ConnectionId[];
}

export interface PanelServiceInfo {
  origin?: string;
  protocol?: string;
  version?: string;
  instance?: string;
}

/** Everything the panel renders from. */
export interface PanelSnapshot {
  providers: DesktopProviderState[];
  generatedAt?: string;
  service?: PanelServiceInfo;
}

/** Masked credential status. The raw secret never reaches the front end. */
export interface CredentialStatus {
  configured: boolean;
  /** Last characters the service chose to reveal, for display only. */
  suffix?: string;
  validatedAt?: string;
  message?: string;
}

export interface PanelCredentials {
  glm: CredentialStatus;
  deepseek: CredentialStatus;
  'glm-wallet': CredentialStatus;
  /** DeepSeek web usage login token (experimental connection). */
  'deepseek-web': CredentialStatus;
  /** Codex authentication is delegated to the local Codex login. */
  codex?: { delegated: boolean };
}

/**
 * Non-sensitive desktop settings.
 *
 * Field names match `DesktopSettings` in `crates/usage-core/src/contracts.rs`.
 * A missing `platformVisibility` entry means "not set", which the panel resolves
 * to visible (see `platformVisible`), so a fresh install still shows the default
 * three-platform overview.
 */
export interface PanelSettings {
  theme: ThemePreference;
  timezone: string;
  glmRegion: GlmRegion;
  /** Whether the experimental GLM wallet connection is enabled at all. On means
   *  it collects *and* shows: one switch, the same interaction as the DeepSeek web
   *  connection. Revoking the credential is a separate, explicit deletion. */
  glmWalletEnabled: boolean;
  /** Whether the experimental DeepSeek web usage connection is enabled at all. */
  deepseekWebEnabled: boolean;
  platformVisibility: Partial<Record<ProviderId, boolean>>;
  /** Display order of the platform cards. */
  platformOrder?: ProviderId[];
  /** Absolute Codex CLI path, needed when the app is launched from Finder. */
  codexCliPath?: string;
  /** Optional host-provided probe result for the CLI path. */
  codexCliFound?: boolean;
  /**
   * How a provider card's reset lines render: a live countdown, or the
   * absolute reset clock/date. Clicking any reset line flips the whole card;
   * cards never affect each other.
   */
  codexResetFormat: ResetTimeFormat;
  glmResetFormat: ResetTimeFormat;
  /** Quota visualization selected independently for each supported platform. */
  codexQuotaDisplay: QuotaDisplayMode;
  glmQuotaDisplay: QuotaDisplayMode;
  /** Whether every quota card presents the reported remaining or used percentage. */
  quotaValueMode: QuotaValueMode;
  /**
   * Per-provider peak/off-peak reminder settings (add-peak-window-reminder).
   * An absent provider falls back to the builtin official table when one
   * exists; the field is absent on settings written before the feature.
   */
  peakReminder?: PeakReminderMap;
  credentials: PanelCredentials;
}

export type QuotaDisplayMode = 'ring' | 'bar';

export type QuotaValueMode = 'remaining' | 'used';

export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export const QUOTA_DISPLAY_MODES: readonly QuotaDisplayMode[] = ['ring', 'bar'];
export const QUOTA_VALUE_MODES: readonly QuotaValueMode[] = ['remaining', 'used'];

/**
 * Reset-time presentation. `countdown` counts down in the units that suit the
 * window; `absolute` shows the reset clock (`HH:mm`) or date (`MM月DD日`).
 */
export type ResetTimeFormat = 'countdown' | 'absolute';

export const RESET_TIME_FORMATS: readonly ResetTimeFormat[] = ['countdown', 'absolute'];

// ---------------------------------------------------------------------------
// Peak / off-peak reminder
// ---------------------------------------------------------------------------

export const PEAK_REMINDER_MODES = ['builtin', 'custom', 'off'] as const;

/** How one provider's period reminder is sourced: the builtin official table, a user schedule, or off. */
export type PeakReminderMode = (typeof PEAK_REMINDER_MODES)[number];

/**
 * One weekly period window. Times are `HH:mm` in the setting's own timezone;
 * the window starts on `weekdays` (ISO, 1 = Monday … 7 = Sunday) at `start`
 * (inclusive) and ends at `end` (exclusive). `start >= end` wraps past
 * midnight into the next day.
 */
export interface PeakWindow {
  weekdays: number[];
  start: string;
  end: string;
}

export interface PeakReminderSetting {
  mode: PeakReminderMode;
  /**
   * The custom schedule. Carried while `off` (inert) so switching back to
   * `custom` restores it instead of making the user re-enter it.
   */
  windows?: PeakWindow[];
  /** IANA timezone the windows are evaluated in; required while `custom`. */
  timezone?: string;
}

/** Per-provider reminder settings; an absent provider means "use the builtin table if one exists". */
export type PeakReminderMap = Partial<Record<ProviderId, PeakReminderSetting>>;

/** `HH:mm` wall time, zero-padded 24-hour clock. */
export function isValidHHmm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Whether the IANA timezone name can be used for zoned formatting. */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Whether one window is a usable schedule: real times, at least one weekday, non-zero length. */
export function isValidPeakWindow(window: PeakWindow): boolean {
  const weekdays = window.weekdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return (
    weekdays.length > 0 &&
    isValidHHmm(window.start) &&
    isValidHHmm(window.end) &&
    // A zero-length window is a mistake, not "all day": the editor blocks it.
    window.start !== window.end
  );
}

/** The subset of settings a mutation may change. */
export type PanelSettingsPatch = Partial<
  Pick<
    PanelSettings,
    | 'timezone'
    | 'theme'
    | 'glmRegion'
    | 'glmWalletEnabled'
    | 'deepseekWebEnabled'
    | 'platformVisibility'
    | 'platformOrder'
    | 'codexCliPath'
    | 'codexResetFormat'
    | 'glmResetFormat'
    | 'codexQuotaDisplay'
    | 'glmQuotaDisplay'
    | 'quotaValueMode'
    | 'peakReminder'
  >
>;

// ---------------------------------------------------------------------------
// Parsing helpers. Every one of them keeps "absent" absent.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/**
 * Normalize an untrusted metric value.
 *
 * Numbers and strings pass through; anything else — including `undefined`,
 * `NaN` and `Infinity` — becomes `null`, which the panel hides. It is never
 * coerced to `0`.
 */
export function normalizeMetricValue(value: unknown): number | string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return null;
}

function parseConnectionId(value: unknown): ConnectionId | undefined {
  if (!isRecord(value)) return undefined;
  if (!isProviderId(value.provider)) return undefined;
  const connection = text(value.connection);
  if (!connection) return undefined;
  const label = text(value.label);
  return { provider: value.provider, connection, ...(label ? { label } : {}) };
}

function parseScope(value: unknown): StatisticScope | undefined {
  if (!isRecord(value)) return undefined;
  const localDay = text(value.localDay);
  if (!localDay) return undefined;
  const timezone = text(value.timezone);
  const rangeStart = text(value.rangeStart);
  const rangeEnd = text(value.rangeEnd);
  return {
    localDay,
    ...(timezone ? { timezone } : {}),
    ...(rangeStart ? { rangeStart } : {}),
    ...(rangeEnd ? { rangeEnd } : {}),
    // Only an explicit confirmation counts as confirmed.
    rangeConfirmed: value.rangeConfirmed === true
  };
}

function parseConfidence(value: unknown): Confidence[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<Confidence>();
  for (const entry of value) {
    if (isOneOf(CONFIDENCE_VALUES, entry)) seen.add(entry);
  }
  return [...seen];
}

/**
 * Parse one metric.
 *
 * A metric without a key, unit, source or a valid direction is dropped: the
 * panel would not know what it is, and inventing a default direction would put
 * the value in the wrong place. Dropping is always safer than guessing.
 *
 * A daily metric that carries no `scope` but does carry `details.localDay` (the
 * shape an earlier service version used) gets a
 * derived scope: the producer explicitly attributed the value to that local day,
 * which is what the daily gate asks for. A metric with neither stays unscoped and
 * is therefore hidden by a daily gate instead of being relabelled as today.
 */
export function parseUsageMetric(value: unknown): DesktopUsageMetric | undefined {
  if (!isRecord(value)) return undefined;
  const key = text(value.key);
  const unit = text(value.unit);
  const source = text(value.source);
  if (!key || !unit || !source) return undefined;
  if (!isOneOf(METRIC_DIRECTIONS, value.direction)) return undefined;

  const label = text(value.label);
  const limit = finiteNumber(value.limit);
  const resetAt = text(value.resetAt);
  const windowSeconds = finiteNumber(value.windowSeconds);
  const connection = parseConnectionId(value.connection);
  const capability = isOneOf(METRIC_CAPABILITIES, value.capability) ? value.capability : undefined;
  const details = isRecord(value.details) ? value.details : undefined;
  const scope = parseScope(value.scope) ?? scopeFromDetails(details);
  const confidence = parseConfidence(value.confidence);

  return {
    key,
    unit,
    direction: value.direction,
    // A missing confidence is not a claim of authority; `unavailable` is added
    // only by the service. The panel treats an empty list as "no claim".
    confidence: confidence.length > 0 ? confidence : ['unavailable'],
    source,
    value: normalizeMetricValue(value.value),
    ...(label ? { label } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds: Math.trunc(windowSeconds) } : {}),
    ...(details ? { details } : {}),
    ...(connection ? { connection } : {}),
    ...(capability ? { capability } : {}),
    ...(scope ? { scope } : {})
  };
}

/** `details.localDay` as an explicit day attribution, when present and valid. */
function scopeFromDetails(details: Record<string, unknown> | undefined): StatisticScope | undefined {
  if (!details) return undefined;
  const localDay = text(details.localDay);
  if (!localDay || !/^\d{4}-\d{2}-\d{2}$/.test(localDay)) return undefined;
  const timezone = text(details.timezone);
  return {
    localDay,
    ...(timezone ? { timezone } : {}),
    // The producer attributed the value to this local day; that is exactly the
    // confirmation the daily gate requires.
    rangeConfirmed: true
  };
}

export function parseCollectorError(value: unknown): CollectorError | undefined {
  if (!isRecord(value)) return undefined;
  const message = text(value.message);
  const at = text(value.at);
  if (!message || !at) return undefined;
  const retryAt = text(value.retryAt);
  return {
    kind: isOneOf(ERROR_KINDS, value.kind) ? value.kind : 'unknown',
    message: message.slice(0, 500),
    at,
    ...(retryAt ? { retryAt } : {}),
    ...(isRecord(value.diagnostic) ? { diagnostic: value.diagnostic } : {})
  };
}

export function parseProviderSnapshot(value: unknown): DesktopProviderSnapshot | undefined {
  if (!isRecord(value) || !isProviderId(value.provider)) return undefined;
  const status = isOneOf(CONNECTION_STATUSES, value.status) ? value.status : 'unavailable';
  const capturedAt = text(value.capturedAt);
  const source = text(value.source);
  if (!capturedAt || !source) return undefined;
  const lastSuccessAt = text(value.lastSuccessAt);
  const connection = parseConnectionId(value.connection);
  const error = parseCollectorError(value.error);
  const metrics = Array.isArray(value.metrics)
    ? value.metrics.map(parseUsageMetric).filter((metric): metric is DesktopUsageMetric => metric !== undefined)
    : [];
  return {
    provider: value.provider,
    status,
    capturedAt,
    source,
    metrics,
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(connection ? { connection } : {}),
    ...(error ? { error } : {}),
    ...(isRecord(value.diagnostic) ? { diagnostic: value.diagnostic } : {})
  };
}

export function parseProviderState(value: unknown): DesktopProviderState | undefined {
  if (!isRecord(value) || !isProviderId(value.provider)) return undefined;
  const snapshot = parseProviderSnapshot(value.snapshot);
  const connection = parseConnectionId(value.connection) ?? snapshot?.connection;
  const connections = Array.isArray(value.connections)
    ? value.connections.map(parseConnectionId).filter((entry): entry is ConnectionId => entry !== undefined)
    : undefined;
  return {
    provider: value.provider,
    // The state-level error is the last refresh failure; the snapshot keeps the
    // error that produced its (possibly cached) data.
    error: parseCollectorError(value.error) ?? snapshot?.error,
    ...(snapshot ? { snapshot } : {}),
    ...(connection ? { connection } : {}),
    ...(connections && connections.length > 0 ? { connections } : {})
  };
}

export function parsePanelSnapshot(value: unknown): PanelSnapshot {
  if (!isRecord(value)) return { providers: [] };
  const providers = Array.isArray(value.providers)
    ? value.providers.map(parseProviderState).filter((state): state is DesktopProviderState => state !== undefined)
    : [];
  const generatedAt = text(value.generatedAt);
  const service = isRecord(value.service)
    ? {
        ...(text(value.service.origin) ? { origin: text(value.service.origin)! } : {}),
        ...(text(value.service.protocol) ? { protocol: text(value.service.protocol)! } : {}),
        ...(text(value.service.version) ? { version: text(value.service.version)! } : {}),
        ...(text(value.service.instance) ? { instance: text(value.service.instance)! } : {})
      }
    : undefined;
  return {
    providers,
    ...(generatedAt ? { generatedAt } : {}),
    ...(service && Object.keys(service).length > 0 ? { service } : {})
  };
}

export const EMPTY_CREDENTIAL_STATUS: CredentialStatus = { configured: false };

/**
 * Parse a masked credential status.
 *
 * A status without an explicit `configured: true` counts as not configured: the
 * panel must not claim a credential exists when the service did not say so.
 */
export function parseCredentialStatus(value: unknown): CredentialStatus {
  if (!isRecord(value)) return { ...EMPTY_CREDENTIAL_STATUS };
  const suffix = text(value.suffix);
  const validatedAt = text(value.validatedAt);
  const message = text(value.message);
  return {
    configured: value.configured === true,
    ...(suffix ? { suffix } : {}),
    ...(validatedAt ? { validatedAt } : {}),
    ...(message ? { message } : {})
  };
}

/**
 * Credential states as the service reports them, in either shape it has used.
 *
 * The desktop service answers `/api/settings` with an array of statuses carrying
 * their own `target` (`CredentialStatus` in Rust serializes one per managed
 * target), and an earlier version answered with an object keyed by target —
 * under `glmWallet` rather than `glm-wallet`. Reading only the object form made
 * every credential look unconfigured in the panel, so both shapes are read here
 * and the array is the primary one.
 */
function parseCredentials(value: unknown): PanelCredentials {
  const byTarget = new Map<string, unknown>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const target = text(entry.target);
      if (target) byTarget.set(target, entry);
    }
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) byTarget.set(key, entry);
  }
  // `glmWallet` is the key an earlier version used for the same account.
  const read = (...keys: string[]): unknown => {
    for (const key of keys) {
      const entry = byTarget.get(key);
      if (entry !== undefined) return entry;
    }
    return undefined;
  };
  const codexValue = read('codex');
  const codex = isRecord(codexValue) ? { delegated: codexValue.delegated !== false } : undefined;
  return {
    glm: parseCredentialStatus(read('glm')),
    deepseek: parseCredentialStatus(read('deepseek')),
    'glm-wallet': parseCredentialStatus(read('glm-wallet', 'glmWallet')),
    'deepseek-web': parseCredentialStatus(read('deepseek-web')),
    ...(codex ? { codex } : {})
  };
}

function parseVisibility(value: unknown): Partial<Record<ProviderId, boolean>> {
  if (!isRecord(value)) return {};
  const visibility: Partial<Record<ProviderId, boolean>> = {};
  for (const provider of PROVIDER_IDS) {
    const entry = optionalBoolean(value[provider]);
    if (entry !== undefined) visibility[provider] = entry;
  }
  return visibility;
}

function parseOrder(value: unknown): ProviderId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const order: ProviderId[] = [];
  for (const entry of value) {
    if (isProviderId(entry) && !order.includes(entry)) order.push(entry);
  }
  return order.length > 0 ? order : undefined;
}

/**
 * Parse the per-provider reminder map leniently: a provider entry whose shape
 * or values cannot be trusted is dropped whole (the panel falls back to the
 * builtin table for it) rather than guessed at. Windows and timezone ride
 * along on `builtin`/`off` entries when valid — they are inert there, but
 * dropping them would erase the user's schedule on a later save.
 */
function parsePeakReminder(value: unknown): PeakReminderMap | undefined {
  if (!isRecord(value)) return undefined;
  const parsed: PeakReminderMap = {};
  for (const provider of PROVIDER_IDS) {
    const entry = value[provider];
    if (!isRecord(entry)) continue;
    const mode = isOneOf(PEAK_REMINDER_MODES, entry.mode) ? entry.mode : undefined;
    if (!mode) continue;
    const windows = parsePeakWindows(entry.windows);
    const timezone = text(entry.timezone);
    if (mode === 'custom' && (!windows || !timezone || !isValidTimezone(timezone))) continue;
    parsed[provider] = {
      mode,
      ...(windows ? { windows } : {}),
      ...(timezone && isValidTimezone(timezone) ? { timezone } : {})
    };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/** Valid windows only; `undefined` when there is nothing usable at all. */
function parsePeakWindows(value: unknown): PeakWindow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const windows: PeakWindow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const start = text(entry.start);
    const end = text(entry.end);
    const weekdays = Array.isArray(entry.weekdays)
      ? [...new Set(entry.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 1 && day <= 7))]
      : [];
    if (!start || !end) continue;
    const window: PeakWindow = { weekdays, start, end };
    if (isValidPeakWindow(window)) windows.push(window);
  }
  return windows.length > 0 ? windows : undefined;
}

/**
 * Parse settings.
 *
 * Documented defaults, all of them "show what exists" rather than "assume data":
 * - `timezone` falls back to `UTC` (a display hint, never a data claim),
 * - `glmRegion` falls back to `china` (the region this project has always
 *   defaulted to),
 * - `glmWalletEnabled` falls back to `false` (the experimental connection needs
 *   an explicit opt-in),
 * - `deepseekWebEnabled` falls back to `false` for the same reason,
 * - quota value modes fall back to `remaining`, so a fresh card answers how
 *   much capacity is still available,
 * - platform visibility defaults to visible (see `platformVisible`).
 */
export function parsePanelSettings(value: unknown): PanelSettings {
  const record = isRecord(value) ? value : {};
  const order = parseOrder(record.platformOrder);
  const codexCliPath = text(record.codexCliPath);
  const codexCliFound = optionalBoolean(record.codexCliFound);
  const peakReminder = parsePeakReminder(record.peakReminder);
  return {
    timezone: text(record.timezone) ?? 'UTC',
    theme: isOneOf(THEME_PREFERENCES, record.theme) ? record.theme : 'dark',
    glmRegion: isOneOf(GLM_REGIONS, record.glmRegion) ? record.glmRegion : 'china',
    glmWalletEnabled: record.glmWalletEnabled === true,
    deepseekWebEnabled: record.deepseekWebEnabled === true,
    platformVisibility: parseVisibility(record.platformVisibility),
    codexResetFormat: isOneOf(RESET_TIME_FORMATS, record.codexResetFormat) ? record.codexResetFormat : 'countdown',
    glmResetFormat: isOneOf(RESET_TIME_FORMATS, record.glmResetFormat) ? record.glmResetFormat : 'countdown',
    codexQuotaDisplay: isOneOf(QUOTA_DISPLAY_MODES, record.codexQuotaDisplay)
      ? record.codexQuotaDisplay
      : 'ring',
    glmQuotaDisplay: isOneOf(QUOTA_DISPLAY_MODES, record.glmQuotaDisplay)
      ? record.glmQuotaDisplay
      : 'ring',
    quotaValueMode: isOneOf(QUOTA_VALUE_MODES, record.quotaValueMode)
      ? record.quotaValueMode
      : 'remaining',
    credentials: parseCredentials(record.credentials),
    ...(order ? { platformOrder: order } : {}),
    ...(codexCliPath ? { codexCliPath } : {}),
    ...(codexCliFound !== undefined ? { codexCliFound } : {}),
    ...(peakReminder ? { peakReminder } : {})
  };
}

// ---------------------------------------------------------------------------
// Small derivations the views share
// ---------------------------------------------------------------------------

/** Local `YYYY-MM-DD` for an instant in a timezone, matching the service's rule. */
export function localDayIn(timeZone: string, instant: Date = new Date()): string {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-CA', { ...options, timeZone }).format(instant);
  } catch {
    // An unknown timezone must not throw; the panel still needs a local day.
    return new Intl.DateTimeFormat('en-CA', options).format(instant);
  }
}

/**
 * Whether a platform is displayed. A provider with no stored preference is
 * visible, so a fresh install shows the confirmed three-platform overview; an
 * explicit `false` from the user always wins.
 */
export function platformVisible(settings: PanelSettings, provider: ProviderId): boolean {
  return settings.platformVisibility[provider] !== false;
}

/** Visible platforms in display order (stored order first, then the default). */
export function visibleProviders(settings: PanelSettings): ProviderId[] {
  const ordered: ProviderId[] = [];
  for (const provider of [...(settings.platformOrder ?? []), ...PROVIDER_IDS]) {
    if (!ordered.includes(provider)) ordered.push(provider);
  }
  return ordered.filter((provider) => platformVisible(settings, provider));
}

export function providerDisplayName(provider: ProviderId): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'glm') return 'GLM';
  return 'DeepSeek';
}

/**
 * Short plan/subtitle shown next to the platform name.
 *
 * Only values the service actually reported are shown: the Codex plan type comes
 * from the collector's metric details, and DeepSeek's "按量付费" is shown only
 * when a balance metric exists. Nothing is invented for a platform without data.
 */
export function providerPlanLabel(provider: ProviderId, state?: DesktopProviderState): string | undefined {
  const metrics = state?.snapshot?.metrics ?? [];
  if (provider === 'codex') {
    const planType = metrics
      .map((metric) => metric.details?.planType)
      .find((value): value is string => typeof value === 'string' && value.trim() !== '');
    return planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : undefined;
  }
  if (provider === 'glm') {
    return metrics.some((metric) => metric.key.startsWith('quota.')) ? 'Coding Plan' : undefined;
  }
  return metrics.some((metric) => metric.direction === 'balance') ? '按量付费' : undefined;
}

/** `glm:quota`-style stable key for a connection, used for lookups and tests. */
export function connectionKey(connection: ConnectionId): string {
  return `${connection.provider}:${connection.connection}`;
}

/**
 * Which connection one published state belongs to.
 *
 * The service reports its identity in `connections`; the state-level
 * `connection` (and the copy on its snapshot) only exists once that connection
 * has captured something successfully. A connection that has never succeeded —
 * an experimental one that is switched off, or one whose credential has not been
 * pasted yet — therefore carries neither, and the panel used to read it as the
 * provider's *primary* connection: its failure was filed under the wrong
 * connection name and the enable-switch filter (`web` / `wallet`) never matched,
 * so a switched-off connection kept showing up.
 *
 * Only an unambiguous, single-entry `connections` list is used as a fallback: a
 * state that genuinely covers several connections keeps reporting no single
 * identity, because guessing the first entry would put one connection's failure
 * on another's name — worse than not deciding. Callers share this resolver so the
 * footer and the cards can never disagree about which connection they see.
 */
export function stateConnection(state: DesktopProviderState): ConnectionId | undefined {
  const declared = state.connection ?? state.snapshot?.connection;
  if (declared) return declared;
  const connections = state.connections ?? [];
  return connections.length === 1 ? connections[0] : undefined;
}

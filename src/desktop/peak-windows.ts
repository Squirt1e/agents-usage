/**
 * Peak / off-peak period judgement (add-peak-window-reminder).
 *
 * The schedule is local static data — the builtin official table plus whatever
 * the user configured — and the judgement maps "now" onto it with Intl. Nothing
 * here collects, fetches or caches: every answer is derivable from a schedule
 * and an instant, which is what makes it unit-testable with fixed clocks.
 *
 * Semantics the spec pins:
 * - windows are evaluated in the definition's own timezone, never the panel's
 *   (DeepSeek's official table lives in Asia/Shanghai),
 * - `start` is inclusive, `end` exclusive, and `start >= end` wraps past
 *   midnight into the next day,
 * - a provider without an effective definition has no answer at all: the panel
 *   shows nothing rather than inventing a period.
 */

import type { ProviderId } from '../shared/contracts';
import type { PanelSettings, PeakReminderSetting, PeakWindow } from '../shared/desktop-contract';
import { isValidPeakWindow } from '../shared/desktop-contract';

/** The panel's name for the two halves of a provider's pricing day. */
export type PeakPeriod = 'peak' | 'offpeak';

/**
 * A schedule the panel can judge against the clock. Builtin definitions carry
 * their source and the date the times were last verified against it, so a
 * stale table can be recognised in the UI instead of silently pretending.
 */
export interface PeakWindowDef {
  timezone: string;
  windows: PeakWindow[];
  sourceLabel?: string;
  sourceUrl?: string;
  /** `YYYY-MM-DD`: when the times were last checked against the source. */
  asOf?: string;
  /** Pricing hint shown beside the tag, e.g. DeepSeek's off-peak half price. */
  offPeakNote?: string;
}

/**
 * DeepSeek's officially published peak hours, verified against the pricing page
 * on 2026-09-11: Monday–Friday 09:00–12:00 and 14:00–18:00 (Beijing time,
 * matching 01:00–04:00 and 06:00–10:00 UTC), everything else off-peak at half
 * price. The times live on the provider's pricing page and may change; the
 * asOf date says how fresh this table is, and a user schedule overrides it.
 */
export const DEEPSEEK_PEAK_DEF: PeakWindowDef = {
  timezone: 'Asia/Shanghai',
  windows: [
    { weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
    { weekdays: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }
  ],
  sourceLabel: 'DeepSeek 官方定价页',
  sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  asOf: '2026-09-11',
  offPeakNote: '错峰半价计费'
};

/** The shipped official tables. GLM and Codex publish no peak hours — no entry means no reminder. */
export const BUILTIN_PEAK_DEFS: Partial<Record<ProviderId, PeakWindowDef>> = {
  deepseek: DEEPSEEK_PEAK_DEF
};

/** The schedule a provider's reminder runs on, honouring the user's mode choice. */
export function effectivePeakDef(
  settings: PanelSettings,
  provider: ProviderId
): PeakWindowDef | undefined {
  const setting: PeakReminderSetting | undefined = settings.peakReminder?.[provider];
  // Default is OFF: only an explicit choice turns the reminder on, so the
  // builtin table never colors a card the user has not opted in with. An
  // absent entry and an explicit `off` are the same thing to the card,
  // however the setting reached us.
  if (!setting || setting.mode === 'off') return undefined;
  if (setting.mode === 'custom') {
    const windows = (setting.windows ?? []).filter(isValidPeakWindow);
    if (windows.length === 0 || !setting.timezone) return undefined;
    return { timezone: setting.timezone, windows };
  }
  return BUILTIN_PEAK_DEFS[provider];
}

// ---------------------------------------------------------------------------
// Zoned time helpers. The panel already formats zones through Intl (see
// `localDayIn`); these add the two directions the judgement needs: reading the
// wall clock of a zone, and building an instant from a wall clock.
// ---------------------------------------------------------------------------

/** ISO weekday (1 = Monday … 7 = Sunday) and wall-clock minutes of the instant. */
function zonedWeekdayAndMinute(
  timeZone: string,
  instant: Date
): { weekday: number; minutes: number } | undefined {
  const parts = zonedParts(timeZone, instant, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const weekday = WEEKDAY_SHORT.indexOf(parts.weekday ?? '');
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (weekday === -1 || !Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  return { weekday: weekday === 0 ? 7 : weekday, minutes: hour * 60 + minute };
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `formatToParts` with a fallback to the host zone, matching the contract module's rule. */
function zonedParts(
  timeZone: string,
  instant: Date,
  options: Intl.DateTimeFormatOptions
): Record<string, string> {
  const build = (zone?: string) =>
    new Intl.DateTimeFormat('en-US', { ...options, ...(zone ? { timeZone: zone } : {}) })
      .formatToParts(instant)
      .reduce<Record<string, string>>((parts, part) => {
        if (part.type !== 'literal') parts[part.type] = part.value;
        return parts;
      }, {});
  try {
    return build(timeZone);
  } catch {
    // An unparseable zone must not break the card; judge in the host zone.
    return build();
  }
}

/** Minutes east of UTC for a zone at an instant (the Intl two-read trick). */
function zonedOffsetMinutes(timeZone: string, instant: Date): number {
  const parts = zonedParts(timeZone, instant, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  if (!Number.isFinite(asUtc)) return 0;
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * The instant a wall time occurs at in a zone, on a given calendar date.
 *
 * Built by guessing with the current offset and correcting once: two reads make
 * DST transitions land on the right side to the minute, which is all a period
 * boundary needs. Calendar fields are 1-based here.
 */
export function instantForWallTime(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = zonedOffsetMinutes(timeZone, new Date(wallAsUtc));
  const first = wallAsUtc - firstOffset * 60_000;
  const secondOffset = zonedOffsetMinutes(timeZone, new Date(first));
  return secondOffset === firstOffset ? new Date(first) : new Date(wallAsUtc - secondOffset * 60_000);
}

function parseHHmm(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Whether `instant` falls inside one of the windows, judged in the definition's zone. */
function insideWindows(windows: PeakWindow[], timeZone: string, instant: Date): boolean {
  const parts = zonedWeekdayAndMinute(timeZone, instant);
  if (!parts) return false;
  const { weekday, minutes } = parts;
  for (const window of windows) {
    const start = parseHHmm(window.start);
    const end = parseHHmm(window.end);
    if (start === undefined || end === undefined) continue;
    const startsToday = window.weekdays.includes(weekday);
    const startedYesterday = window.weekdays.includes(((weekday + 5) % 7) + 1);
    if (start < end) {
      if (startsToday && minutes >= start && minutes < end) return true;
    } else {
      // Wrapping window: its tail belongs to the day it started on.
      if (startsToday && minutes >= start) return true;
      if (startedYesterday && minutes < end) return true;
    }
  }
  return false;
}

export interface PeakState {
  period: PeakPeriod;
  /** When the current period ends; absent when no boundary exists ahead. */
  nextBoundaryAt?: Date;
  /** The period the next boundary leads into. */
  nextPeriod?: PeakPeriod;
}

/** Boundaries of one window on one date its weekday names: entry, and exit (the next day when wrapping). */
function boundariesOf(window: PeakWindow, timeZone: string, year: number, month: number, day: number): Array<{ at: Date; enters: PeakPeriod }> {
  const start = parseHHmm(window.start);
  const end = parseHHmm(window.end);
  if (start === undefined || end === undefined) return [];
  const startHour = Math.floor(start / 60);
  const startMinute = start % 60;
  const endHour = Math.floor(end / 60);
  const endMinute = end % 60;
  const entry = { at: instantForWallTime(timeZone, year, month, day, startHour, startMinute), enters: 'peak' as const };
  if (start < end) {
    return [entry, { at: instantForWallTime(timeZone, year, month, day, endHour, endMinute), enters: 'offpeak' as const }];
  }
  const exitDate = new Date(Date.UTC(year, month - 1, day + 1));
  return [
    entry,
    {
      at: instantForWallTime(timeZone, exitDate.getUTCFullYear(), exitDate.getUTCMonth() + 1, exitDate.getUTCDate(), endHour, endMinute),
      enters: 'offpeak' as const
    }
  ];
}

/** The period state at `now`: which half, and when it flips next. */
export function peakStateAt(def: PeakWindowDef, now: Date): PeakState {
  const period: PeakPeriod = insideWindows(def.windows, def.timezone, now) ? 'peak' : 'offpeak';
  // Today's calendar date in the definition's zone seeds the scan; a week of
  // forward days covers every weekly schedule including wrapped tails.
  const today = zonedParts(def.timezone, now, { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const baseYear = Number(today.year);
  const baseMonth = Number(today.month);
  const baseDay = Number(today.day);
  const baseWeekday = WEEKDAY_SHORT.indexOf(today.weekday ?? '');
  let best: { at: Date; enters: PeakPeriod } | undefined;
  if (Number.isFinite(baseYear) && baseWeekday !== -1) {
    for (let dayOffset = 0; dayOffset < 8 && !best; dayOffset += 1) {
      const date = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay + dayOffset));
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      const weekday = ((baseWeekday - 1 + dayOffset) % 7) + 1;
      const candidates = def.windows
        .filter((window) => window.weekdays.includes(weekday))
        .flatMap((window) => boundariesOf(window, def.timezone, year, month, day))
        .filter((boundary) => boundary.at.getTime() > now.getTime())
        .sort((left, right) => left.at.getTime() - right.at.getTime());
      // The first day that offers a boundary wins; within a day the earliest.
      if (candidates.length > 0) best = candidates[0];
    }
  }
  return {
    period,
    ...(best
      ? { nextBoundaryAt: best.at, nextPeriod: best.enters }
      : {})
  };
}

// ---------------------------------------------------------------------------
// Boundary-crossing announcements. Pure so the toast wording test needs no DOM:
// the caller hands in the periods it last saw and gets back what to say.
// ---------------------------------------------------------------------------

export interface PeakTransition {
  provider: ProviderId;
  period: PeakPeriod;
}

/**
 * Which providers flipped period between `previous` and `now`.
 *
 * The first observation of a definition is never a flip: the panel was closed
 * (or the reminder was just enabled), so there is nothing to announce. A
 * provider whose definition disappeared forgets its period, so re-enabling it
 * later does not replay an old boundary either.
 */
export function collectPeakTransitions(
  providers: readonly ProviderId[],
  settings: PanelSettings,
  now: Date,
  previous: Partial<Record<ProviderId, PeakPeriod>>
): { next: Partial<Record<ProviderId, PeakPeriod>>; transitions: PeakTransition[] } {
  const next: Partial<Record<ProviderId, PeakPeriod>> = {};
  const transitions: PeakTransition[] = [];
  for (const provider of providers) {
    const def = effectivePeakDef(settings, provider);
    if (!def) continue;
    const period = peakStateAt(def, now).period;
    next[provider] = period;
    const before = previous[provider];
    if (before !== undefined && before !== period) transitions.push({ provider, period });
  }
  return { next, transitions };
}

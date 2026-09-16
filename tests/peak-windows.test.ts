// The period judgement is pure: fixed instants in, period and boundary out.
// These tests pin the shipped DeepSeek table, the boundary rules (inclusive
// start, exclusive end, midnight wrap), the "own timezone, not the panel's"
// rule, a DST crossing for the wall-time inversion, and the override matrix.
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PEAK_DEFS,
  DEEPSEEK_PEAK_DEF,
  collectPeakTransitions,
  effectivePeakDef,
  formatPeakGap,
  instantForWallTime,
  peakPreviewOf,
  peakStateAt,
  type PeakWindowDef
} from '../src/desktop/lib/peak-windows';
import { parsePanelSettings, type PanelSettings } from '../src/shared/desktop-contract';

const settings = (value: unknown): PanelSettings => parsePanelSettings(value);

describe('builtin table', () => {
  it('ships the officially published DeepSeek hours', () => {
    expect(DEEPSEEK_PEAK_DEF.timezone).toBe('Asia/Shanghai');
    expect(DEEPSEEK_PEAK_DEF.windows).toEqual([
      { weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
      { weekdays: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }
    ]);
    expect(DEEPSEEK_PEAK_DEF.asOf).toBe('2026-09-11');
    expect(DEEPSEEK_PEAK_DEF.sourceUrl).toContain('deepseek');
  });

  it('has no invented tables for providers without official hours', () => {
    expect(BUILTIN_PEAK_DEFS.codex).toBeUndefined();
    expect(BUILTIN_PEAK_DEFS.glm).toBeUndefined();
  });
});

describe('peakStateAt in Asia/Shanghai (2026-09-10 is a Thursday)', () => {
  const def = DEEPSEEK_PEAK_DEF;

  it('keeps the window start inclusive and the end exclusive', () => {
    expect(peakStateAt(def, new Date('2026-09-10T00:59:00.000Z')).period).toBe('offpeak'); // 08:59
    expect(peakStateAt(def, new Date('2026-09-10T01:00:00.000Z')).period).toBe('peak'); // 09:00
    expect(peakStateAt(def, new Date('2026-09-10T03:59:00.000Z')).period).toBe('peak'); // 11:59
    expect(peakStateAt(def, new Date('2026-09-10T04:00:00.000Z')).period).toBe('offpeak'); // 12:00
  });

  it('covers the afternoon window and the weekday edge', () => {
    expect(peakStateAt(def, new Date('2026-09-10T06:30:00.000Z')).period).toBe('peak'); // Fri? no: Thu 14:30
    expect(peakStateAt(def, new Date('2026-09-11T09:59:00.000Z')).period).toBe('peak'); // Fri 17:59
    expect(peakStateAt(def, new Date('2026-09-11T10:00:00.000Z')).period).toBe('offpeak'); // Fri 18:00
  });

  it('keeps the whole weekend off-peak', () => {
    expect(peakStateAt(def, new Date('2026-09-12T02:00:00.000Z')).period).toBe('offpeak'); // Sat 10:00
    expect(peakStateAt(def, new Date('2026-09-13T06:00:00.000Z')).period).toBe('offpeak'); // Sun 14:00
  });

  it('names the boundary that ends the current period', () => {
    const state = peakStateAt(def, new Date('2026-09-10T01:30:00.000Z')); // Thu 09:30
    expect(state.nextBoundaryAt?.toISOString()).toBe('2026-09-10T04:00:00.000Z'); // 12:00 local
    expect(state.nextPeriod).toBe('offpeak');
  });

  it('scans across the weekend for the next boundary', () => {
    const state = peakStateAt(def, new Date('2026-09-11T10:00:00.000Z')); // Fri 18:00, just past the end
    expect(state.nextBoundaryAt?.toISOString()).toBe('2026-09-14T01:00:00.000Z'); // Mon 09:00 local
    expect(state.nextPeriod).toBe('peak');
  });

  it('judges in the definition timezone, whatever the panel displays', () => {
    // 2026-09-10T01:30Z is 09:30 in Shanghai (peak) and 21:30 on Wednesday in
    // New York. The definition carries its own zone, so the answer is peak —
    // the panel's display zone never enters the judgement.
    expect(peakStateAt(def, new Date('2026-09-10T01:30:00.000Z')).period).toBe('peak');
  });
});

describe('peakStateAt with a midnight-wrapping custom window', () => {
  // Monday 2026-09-14, 22:00–01:00 in Shanghai.
  const def: PeakWindowDef = {
    timezone: 'Asia/Shanghai',
    windows: [{ weekdays: [1], start: '22:00', end: '01:00' }]
  };

  it('keeps the wrapped tail in the period on the next day', () => {
    expect(peakStateAt(def, new Date('2026-09-14T14:00:00.000Z')).period).toBe('peak'); // Mon 22:00
    expect(peakStateAt(def, new Date('2026-09-14T15:00:00.000Z')).period).toBe('peak'); // Mon 23:00
    expect(peakStateAt(def, new Date('2026-09-14T16:30:00.000Z')).period).toBe('peak'); // Tue 00:30 (tail)
    expect(peakStateAt(def, new Date('2026-09-14T17:00:00.000Z')).period).toBe('offpeak'); // Tue 01:00 (end)
  });

  it('places the exit boundary on the following day', () => {
    const state = peakStateAt(def, new Date('2026-09-14T15:00:00.000Z')); // Mon 23:00
    expect(state.nextBoundaryAt?.toISOString()).toBe('2026-09-14T17:00:00.000Z'); // Tue 01:00 local
    expect(state.nextPeriod).toBe('offpeak');
  });

  it('finds the next entry from before the window starts', () => {
    const state = peakStateAt(def, new Date('2026-09-13T13:00:00.000Z')); // Sun 21:00 local
    expect(state.nextBoundaryAt?.toISOString()).toBe('2026-09-14T14:00:00.000Z'); // Mon 22:00 local
    expect(state.nextPeriod).toBe('peak');
  });
});

describe('wall-time inversion across a DST jump', () => {
  it('lands the boundary on the wall clock, not on the offset guess', () => {
    // US DST starts 2026-03-08; Monday 09:00 in New York is then 13:00Z (EDT),
    // not the 14:00Z an EST-based guess would produce.
    const def: PeakWindowDef = {
      timezone: 'America/New_York',
      windows: [{ weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }]
    };
    const state = peakStateAt(def, new Date('2026-03-08T12:00:00.000Z'));
    expect(state.nextBoundaryAt?.toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('builds an instant from wall time in a fixed-offset zone', () => {
    expect(instantForWallTime('Asia/Shanghai', 2026, 9, 10, 9, 0).toISOString()).toBe('2026-09-10T01:00:00.000Z');
  });
});

describe('effectivePeakDef', () => {
  it('stays off for providers the user has never chosen for', () => {
    // Default off: the builtin table never colors a card uninvited.
    expect(effectivePeakDef(settings({}), 'deepseek')).toBeUndefined();
  });

  it('runs the builtin table once the user explicitly chooses it', () => {
    const value = settings({ peakReminder: { deepseek: { mode: 'builtin' } } });
    expect(effectivePeakDef(value, 'deepseek')).toEqual(DEEPSEEK_PEAK_DEF);
  });

  it('gives providers without a builtin table nothing', () => {
    expect(effectivePeakDef(settings({ peakReminder: { codex: { mode: 'builtin' } } }), 'codex')).toBeUndefined();
    expect(effectivePeakDef(settings({}), 'codex')).toBeUndefined();
    expect(effectivePeakDef(settings({}), 'glm')).toBeUndefined();
  });

  it('lets the user switch a builtin provider off', () => {
    const value = settings({ peakReminder: { deepseek: { mode: 'off' } } });
    expect(effectivePeakDef(value, 'deepseek')).toBeUndefined();
  });

  it('keeps the custom schedule authoritative while it is valid', () => {
    const value = settings({
      peakReminder: {
        codex: {
          mode: 'custom',
          timezone: 'UTC',
          windows: [{ weekdays: [2], start: '10:00', end: '11:00' }]
        }
      }
    });
    expect(effectivePeakDef(value, 'codex')).toEqual({
      timezone: 'UTC',
      windows: [{ weekdays: [2], start: '10:00', end: '11:00' }]
    });
  });

  it('falls back to off when the stored custom schedule is unusable', () => {
    const broken = {
      peakReminder: {
        deepseek: { mode: 'custom', timezone: 'Not/AZone', windows: [{ weekdays: [9], start: 'aa', end: 'bb' }] }
      }
    };
    expect(effectivePeakDef(settings(broken), 'deepseek')).toBeUndefined();
  });
});

describe('collectPeakTransitions', () => {
  const now = new Date('2026-09-10T01:30:00.000Z'); // DeepSeek peak
  const builtin = settings({ peakReminder: { deepseek: { mode: 'builtin' } } });

  it('never announces the first observation of a definition', () => {
    const { next, transitions } = collectPeakTransitions(['deepseek'], builtin, now, {});
    expect(next).toEqual({ deepseek: 'peak' });
    expect(transitions).toEqual([]);
  });

  it('announces exactly the providers that flipped', () => {
    const { transitions } = collectPeakTransitions(['deepseek'], builtin, now, { deepseek: 'offpeak' });
    expect(transitions).toEqual([{ provider: 'deepseek', period: 'peak' }]);
  });

  it('skips providers whose reminder was never chosen', () => {
    const { next, transitions } = collectPeakTransitions(['deepseek'], settings({}), now, {});
    expect(next).toEqual({});
    expect(transitions).toEqual([]);
  });

  it('forgets the last period when the definition goes away, so re-enabling stays quiet', () => {
    const off = settings({ peakReminder: { deepseek: { mode: 'off' } } });
    const { next, transitions } = collectPeakTransitions(['deepseek'], off, now, { deepseek: 'peak' });
    expect(next).toEqual({});
    expect(transitions).toEqual([]);
  });
});

// The editor's read-back (refine-peak-window-editor): the schedule it shows
// before saving is judged by `peakStateAt`, the same call the cards use, so the
// preview can never disagree with the panel. Pure, so every branch is pinned
// with a fixed clock.
describe('the editor preview', () => {
  const now = new Date('2026-09-10T01:30:00.000Z'); // 09:30 in Shanghai, inside the morning window

  it('reads the draft in the draft\u2019s own timezone', () => {
    const preview = peakPreviewOf([{ weekdays: [4], start: '09:00', end: '12:00' }], 'Asia/Shanghai', now);
    expect(preview?.period).toBe('peak');
    // 09:30 → 12:00 is two and a half hours.
    expect(preview?.gap).toBe('2 小时 30 分钟');
  });

  it('judges a wrapped window from the day it started on', () => {
    // Thursday 22:00 – 02:00: 09:30 is outside it, and the next boundary is
    // tonight's start.
    const preview = peakPreviewOf([{ weekdays: [4], start: '22:00', end: '02:00' }], 'Asia/Shanghai', now);
    expect(preview?.period).toBe('offpeak');
    expect(preview?.gap).toBe('12 小时 30 分钟');
  });

  it('refuses to judge a draft that cannot be used', () => {
    expect(peakPreviewOf([], 'Asia/Shanghai', now)).toBeUndefined();
    expect(peakPreviewOf(undefined, 'Asia/Shanghai', now)).toBeUndefined();
    expect(peakPreviewOf([{ weekdays: [], start: '09:00', end: '12:00' }], 'Asia/Shanghai', now)).toBeUndefined();
    expect(peakPreviewOf([{ weekdays: [4], start: '09:00', end: '09:00' }], 'Asia/Shanghai', now)).toBeUndefined();
    expect(peakPreviewOf([{ weekdays: [4], start: '09:00', end: '12:00' }], 'Not/AZone', now)).toBeUndefined();
    expect(peakPreviewOf([{ weekdays: [4], start: '09:00', end: '12:00' }], undefined, now)).toBeUndefined();
  });

  it('ignores the unusable entries of a partly valid draft', () => {
    const preview = peakPreviewOf(
      [
        { weekdays: [4], start: '09:00', end: '09:00' }, // start === end: dropped
        { weekdays: [4], start: '09:00', end: '12:00' }
      ],
      'Asia/Shanghai',
      now
    );
    expect(preview?.period).toBe('peak');
  });
});

describe('the gap to the next boundary', () => {
  const from = new Date('2026-09-10T01:30:00.000Z');

  it('counts in minutes under an hour, and rounds down', () => {
    expect(formatPeakGap(new Date(from.getTime() + 30_000), from)).toBe('不到 1 分钟');
    expect(formatPeakGap(new Date(from.getTime() + 60_000), from)).toBe('1 分钟');
    expect(formatPeakGap(new Date(from.getTime() + 59 * 60_000), from)).toBe('59 分钟');
  });

  it('counts hours and minutes past that', () => {
    expect(formatPeakGap(new Date(from.getTime() + 60 * 60_000), from)).toBe('1 小时 0 分钟');
    expect(formatPeakGap(new Date(from.getTime() + (2 * 60 + 5) * 60_000), from)).toBe('2 小时 5 分钟');
    expect(formatPeakGap(new Date(from.getTime() + 26 * 60 * 60_000), from)).toBe('1 天 2 小时');
  });

  it('has no answer for a boundary that is absent or already behind', () => {
    expect(formatPeakGap(undefined, from)).toBeUndefined();
    expect(formatPeakGap(new Date(from.getTime()), from)).toBeUndefined();
    expect(formatPeakGap(new Date(from.getTime() - 60_000), from)).toBeUndefined();
  });
});

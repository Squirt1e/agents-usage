// The status vocabulary, as a system.
//
// Two failure modes this file exists to prevent, both of which shipped:
//
// 1. A status that names a failure and says nothing about what to do about it. The
//    panes answered this inconsistently (Codex gave advice, GLM and DeepSeek gave
//    none), and the first version of the shared table left `missing_config` out on
//    the grounds that the form below the row "is the answer" — but `missing_config`
//    is exactly what a first-run connection reports, and a form is only an answer
//    if the reader is told to look there.
// 2. A new error kind arriving with no wording at all. The table is typed as a
//    complete `Record`, and the loop below walks every kind, so adding one to the
//    contract fails here until it has a sentence.
import { describe, expect, it } from 'vitest';
import type { CollectorError } from '../src/shared/contracts';
import { errorLabel, recoveryAdvice, statusFor } from '../src/desktop/components/StatusRow';

/** Every failure kind the contract defines, spelled out so a new one is caught. */
const KINDS: Array<CollectorError['kind']> = [
  'missing_config',
  'authentication',
  'rate_limit',
  'compatibility',
  'network',
  'process',
  'storage',
  'unknown'
];

describe('the failure vocabulary', () => {
  it('names every kind', () => {
    for (const kind of KINDS) {
      expect(errorLabel(kind).label, `${kind} has no label`).toBeTruthy();
      expect(['healthy', 'warning', 'danger', 'neutral']).toContain(errorLabel(kind).tone);
    }
  });

  it('gives every kind something to do about it', () => {
    for (const kind of KINDS) {
      const advice = recoveryAdvice(kind);
      expect(advice, `${kind} names a failure with no way out`).toBeTruthy();
      // A sentence, not a fragment: the row reads as "认证失败 <advice>".
      expect(advice!.length, `${kind}'s advice is too short to act on`).toBeGreaterThan(6);
    }
  });

  it('lets a connection say something more specific', () => {
    expect(recoveryAdvice('process', { process: '请安装 Codex，或填写可执行文件路径。' })).toBe(
      '请安装 Codex，或填写可执行文件路径。'
    );
    // An override for a different kind does not leak into this one.
    expect(recoveryAdvice('process', { network: '别的说法' })).toBe(recoveryAdvice('process'));
  });

  it('has no advice when there is no failure', () => {
    expect(recoveryAdvice(undefined)).toBeUndefined();
  });
});

describe('a connection state becomes one line and one sentence', () => {
  it('reads a cached snapshot as the failure that made it stale', () => {
    const state = {
      provider: 'glm' as const,
      error: { kind: 'network' as const, message: 'timed out', at: '2026-09-10T08:00:00.000Z' },
      snapshot: {
        provider: 'glm' as const,
        status: 'degraded' as const,
        capturedAt: '2026-09-10T08:00:00.000Z',
        lastSuccessAt: '2026-09-10T08:00:00.000Z',
        source: 'fixture',
        metrics: []
      }
    };
    expect(statusFor(state)).toEqual({ label: '网络异常', tone: 'warning' });
  });

  it('never invents a failure for a connection that simply has no data', () => {
    // A state with neither snapshot nor error is 尚未连接 — never an error, and the
    // neutral tone keeps it out of the danger vocabulary.
    expect(statusFor(undefined)).toEqual({ label: '尚未连接', tone: 'neutral' });
    expect(statusFor({ provider: 'codex' })).toEqual({ label: '尚未连接', tone: 'neutral' });
  });
});

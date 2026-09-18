import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_WARNING_THRESHOLD,
  parsePanelSettings
} from '../../src/shared/desktop-contract';

describe('quota warning threshold settings contract', () => {
  it('defaults missing and untrusted stored values to ten percent', () => {
    expect(parsePanelSettings({}).quotaWarningThreshold).toBe(DEFAULT_QUOTA_WARNING_THRESHOLD);

    for (const quotaWarningThreshold of [-1, 101, 10.5, '10', null, Number.NaN]) {
      expect(parsePanelSettings({ quotaWarningThreshold }).quotaWarningThreshold).toBe(
        DEFAULT_QUOTA_WARNING_THRESHOLD
      );
    }
  });

  it('keeps every legal integer including the disabled zero value', () => {
    for (const quotaWarningThreshold of [0, 1, 10, 100]) {
      expect(parsePanelSettings({ quotaWarningThreshold }).quotaWarningThreshold).toBe(
        quotaWarningThreshold
      );
    }
  });
});

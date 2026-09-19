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

describe('balance warning threshold settings contract', () => {
  it('defaults missing and untrusted stored values to ten currency units', () => {
    expect(parsePanelSettings({}).balanceWarningThreshold).toBe(10);

    for (const balanceWarningThreshold of [-1, '10', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parsePanelSettings({ balanceWarningThreshold }).balanceWarningThreshold).toBe(
        10
      );
    }
  });

  it('keeps zero, decimals and large non-negative values without inventing a currency cap', () => {
    for (const balanceWarningThreshold of [0, 0.01, 10, 12.5, 1_000_000]) {
      expect(parsePanelSettings({ balanceWarningThreshold }).balanceWarningThreshold).toBe(
        balanceWarningThreshold
      );
    }
  });
});

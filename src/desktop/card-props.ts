/**
 * Props shared by the three platform cards.
 *
 * Kept in its own module so `OverviewView` and the cards can share the type
 * without importing each other.
 */

import type { ProviderId } from '../shared/contracts';
import type { ResetTimeFormat } from '../shared/desktop-contract';
import type { PeakPeriod } from './peak-windows';
import type { MetricGateOptions, ProviderView } from './metrics';

/** The provider's current period state, as the card frame presents it. */
export interface PeakCardState {
  period: PeakPeriod;
  /** Next boundary's clock time, already formatted in the panel's timezone. */
  boundaryClock?: string;
}

export interface PlatformCardViewProps {
  view: ProviderView;
  /** Live clock used by every countdown in the card. */
  now: Date;
  /** Gate options: the local day and timezone "today" is resolved against. */
  gate: MetricGateOptions;
  /**
   * The provider's peak/off-peak state. Absent when the provider has no
   * schedule (no builtin table, no valid custom schedule): the card then
   * renders no period presentation at all.
   */
  peak?: PeakCardState;
  /** How this card's reset lines render (countdown or absolute): one choice
      per card, so every window on it flips together. Cards without reset
      lines don't use it. */
  resetTimeFormat?: ResetTimeFormat;
  /** Flip the card's reset-time format; bound to clicking any of its reset lines. */
  onToggleResetTimeFormat?(): void;
  /** Clicking the ring or the bar itself flips this card's quota display mode. */
  onToggleQuotaDisplay?(): void;
  registerGear?(provider: ProviderId, node: HTMLButtonElement | null): void;
  onOpenSettings(provider: ProviderId): void;
  /** The latest successful manual refresh to replay this card's readings. */
  replayKey?: number;
}

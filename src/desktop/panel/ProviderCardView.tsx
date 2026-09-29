/**
 * One platform's card, for whichever surface is showing it.
 *
 * The overview renders three of these; the minimal rail renders one, in the card
 * that follows the pointer. It exists as its own component so the two surfaces
 * cannot drift: the detail is *the card*, not a second presentation of the same
 * numbers — same sections, same labels, same ring behaviour, same settings hooks.
 *
 * Everything provider-specific (which card, which settings feed it, which
 * connection its switch turns off) lives here, so a new provider or a new card
 * prop reaches both surfaces at once.
 */

import type { ProviderId } from '../../shared/contracts';
import { localDayIn, type PanelSettings, type PanelSnapshot } from '../../shared/desktop-contract';
import { CodexCard } from './CodexCard';
import { DeepSeekCard } from './DeepSeekCard';
import { GlmCard } from './GlmCard';
import { formatClockTime, providerView, withoutConnection, type MetricGateOptions } from '../lib/metrics';
import { effectivePeakDef, peakStateAt } from '../lib/peak-windows';

/**
 * The experimental connection a provider's own settings switch has turned off.
 *
 * A switched-off connection must leave no trace on the card — no metrics, no error,
 * no entry in the connection list — and the snapshot has to be filtered here rather
 * than inside the card: the service stops *collecting*, but the reading it persisted
 * while the connection was on is still published, so an unfiltered card kept
 * rendering a balance for a connection the user had just switched off. That is what
 * made the GLM wallet look unconnected to its switch.
 */
export function switchedOffConnection(provider: ProviderId, settings: PanelSettings): string | undefined {
  if (provider === 'deepseek' && !settings.deepseekWebEnabled) return 'web';
  if (provider === 'glm' && !settings.glmWalletEnabled) return 'wallet';
  return undefined;
}

export interface ProviderCardViewProps {
  provider: ProviderId;
  snapshot?: PanelSnapshot;
  settings: PanelSettings;
  now: Date;
  onOpenSettings(provider: ProviderId): void;
  /**
   * Hand over a card's configuration button.
   *
   * The card never opens an in-panel page, so there is no "return" step to restore
   * focus from — but the cards still register their node, because a card replaced
   * while the settings window is open (its platform hidden from there) must not drop
   * focus to the document body. Optional: a static preview or a test that does not
   * care about focus can leave it out.
   */
  registerGear?(provider: ProviderId, node: HTMLButtonElement | null): void;
  /** Flip one card's reset-time format; the whole card flips, other cards never do. */
  onToggleResetTimeFormat(provider: ProviderId): void;
  /** Clicking a card's ring or bar flips that card's quota display mode. */
  onToggleQuotaDisplay(provider: ProviderId): void;
  replayKeys?: Partial<Record<ProviderId, number>>;
}

export function ProviderCardView(props: ProviderCardViewProps) {
  const { provider, settings } = props;
  const gate: MetricGateOptions = {
    now: props.now,
    timezone: settings.timezone,
    localDay: localDayIn(settings.timezone, props.now)
  };
  const off = switchedOffConnection(provider, settings);
  const snapshot = props.snapshot ?? { providers: [] };
  const view = providerView(off ? withoutConnection(snapshot, provider, off) : snapshot, provider);
  // The schedule follows the settings, the period follows the clock. The card frame
  // carries the presentation: border/background tint by period, a header corner
  // naming the next boundary.
  const def = effectivePeakDef(settings, provider);
  const peak = def
    ? (() => {
        const state = peakStateAt(def, props.now);
        return {
          period: state.period,
          boundaryClock: formatClockTime(state.nextBoundaryAt, settings.timezone)
        };
      })()
    : undefined;
  const cardProps = {
    view,
    peak,
    gate,
    now: props.now,
    registerGear: props.registerGear,
    onOpenSettings: props.onOpenSettings
  };

  if (provider === 'codex') {
    return (
      <CodexCard
        {...cardProps}
        quotaDisplayMode={settings.codexQuotaDisplay}
        quotaValueMode={settings.quotaValueMode}
        quotaWarningThreshold={settings.quotaWarningThreshold}
        resetTimeFormat={settings.codexResetFormat}
        onToggleResetTimeFormat={() => props.onToggleResetTimeFormat('codex')}
        onToggleQuotaDisplay={() => props.onToggleQuotaDisplay('codex')}
        replayKey={props.replayKeys?.codex}
      />
    );
  }
  if (provider === 'glm') {
    return (
      <GlmCard
        {...cardProps}
        quotaConfigured={settings.credentials.glm.configured === true}
        walletEnabled={settings.glmWalletEnabled}
        walletConfigured={settings.credentials['glm-wallet'].configured === true}
        quotaDisplayMode={settings.glmQuotaDisplay}
        quotaValueMode={settings.quotaValueMode}
        quotaWarningThreshold={settings.quotaWarningThreshold}
        balanceWarningThreshold={settings.balanceWarningThreshold}
        resetTimeFormat={settings.glmResetFormat}
        onToggleResetTimeFormat={() => props.onToggleResetTimeFormat('glm')}
        onToggleQuotaDisplay={() => props.onToggleQuotaDisplay('glm')}
        replayKey={props.replayKeys?.glm}
      />
    );
  }
  return (
    <DeepSeekCard
      {...cardProps}
      balanceConfigured={settings.credentials.deepseek.configured === true}
      balanceWarningThreshold={settings.balanceWarningThreshold}
      webEnabled={settings.deepseekWebEnabled}
      webConfigured={settings.credentials['deepseek-web'].configured === true}
      replayKey={props.replayKeys?.deepseek}
    />
  );
}

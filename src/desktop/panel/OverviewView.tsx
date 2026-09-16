/**
 * Overview: the three platform cards, or the state that replaces them.
 *
 * The overview never shows a platform picker: visibility lives in the platform
 * management overlay, and the cards that are displayed come straight from the
 * persisted settings. All three platforms are shown by default, in the confirmed
 * Codex → GLM → DeepSeek order.
 */

import type { ProviderId } from '../../shared/contracts';
import { localDayIn, visibleProviders, type PanelSettings, type PanelSnapshot } from '../../shared/desktop-contract';
import { CodexCard } from './CodexCard';
import { DeepSeekCard } from './DeepSeekCard';
import { EmptySelectionState, LoadingState } from './MetricStates';
import { formatClockTime } from '../lib/metrics';
import { GlmCard } from './GlmCard';
import { providerView, withoutConnection, type MetricGateOptions } from '../lib/metrics';
import { effectivePeakDef, peakStateAt } from '../lib/peak-windows';

/**
 * The experimental connection a provider's own settings switch has turned off.
 *
 * A switched-off connection must leave no trace on the main panel — no metrics, no
 * error, no entry in the connection list — and the snapshot has to be filtered
 * here rather than inside the card: the service stops *collecting*, but the
 * reading it persisted while the connection was on is still published, so an
 * unfiltered card kept rendering a balance for a connection the user had just
 * switched off. That is what made the GLM wallet look unconnected to its switch.
 */
function switchedOffConnection(provider: ProviderId, settings: PanelSettings): string | undefined {
  if (provider === 'deepseek' && !settings.deepseekWebEnabled) return 'web';
  if (provider === 'glm' && !settings.glmWalletEnabled) return 'wallet';
  return undefined;
}

export interface OverviewViewProps {
  snapshot?: PanelSnapshot;
  settings: PanelSettings;
  now: Date;
  loading: boolean;
  onOpenSettings(provider: ProviderId): void;
  /** Open the settings window on 平台管理, where visibility and order live. */
  onOpenAppSettings(): void;
  /**
   * Hand over a card's configuration button.
   *
   * The card no longer opens an in-panel page, so there is no "return" step to
   * restore focus from — but the cards still register their node, because a card
   * replaced while the settings window is open (its platform hidden from there)
   * must not drop focus to the document body. Optional: a static preview or a test
   * that does not care about focus can leave it out.
   */
  registerGear?(provider: ProviderId, node: HTMLButtonElement | null): void;
  /** Flip one card's reset-time format; the whole card flips, other cards never do. */
  onToggleResetTimeFormat(provider: ProviderId): void;
  /** Clicking a card's ring or bar flips that card's quota display mode. */
  onToggleQuotaDisplay(provider: ProviderId): void;
  replayKeys?: Partial<Record<ProviderId, number>>;
}

export function OverviewView(props: OverviewViewProps) {
  const providers = visibleProviders(props.settings);
  const gate: MetricGateOptions = {
    now: props.now,
    timezone: props.settings.timezone,
    localDay: localDayIn(props.settings.timezone, props.now)
  };
  const cardProps = {
    gate,
    now: props.now,
    registerGear: props.registerGear,
    onOpenSettings: props.onOpenSettings
  };

  const loadingOnly = props.loading && !props.snapshot;
  const snapshot = props.snapshot ?? { providers: [] };

  return (
    <div className="overview" data-testid="overview">
      {loadingOnly ? <LoadingState /> : null}
      {!loadingOnly && providers.length === 0 ? <EmptySelectionState onOpenManager={props.onOpenAppSettings} /> : null}
      {loadingOnly
        ? null
        : providers.map((provider) => {
            const off = switchedOffConnection(provider, props.settings);
            const view = providerView(off ? withoutConnection(snapshot, provider, off) : snapshot, provider);
            // The schedule follows the settings, the period follows the clock.
            // The card frame carries the presentation: border/background tint by
            // period, a header corner naming the next boundary.
            const def = effectivePeakDef(props.settings, provider);
            const peak = def
              ? (() => {
                  const state = peakStateAt(def, props.now);
                  return { period: state.period, boundaryClock: formatClockTime(state.nextBoundaryAt, props.settings.timezone) };
                })()
              : undefined;
            if (provider === 'codex') {
              return (
                <CodexCard
                  key={provider}
                  view={view}
                  peak={peak}
                  quotaDisplayMode={props.settings.codexQuotaDisplay}
                  quotaValueMode={props.settings.quotaValueMode}
                  resetTimeFormat={props.settings.codexResetFormat}
                  onToggleResetTimeFormat={() => props.onToggleResetTimeFormat('codex')}
                  onToggleQuotaDisplay={() => props.onToggleQuotaDisplay('codex')}
                  replayKey={props.replayKeys?.codex}
                  {...cardProps}
                />
              );
            }
            if (provider === 'glm') {
              return (
                <GlmCard
                  key={provider}
                  view={view}
                  peak={peak}
                  quotaConfigured={props.settings.credentials.glm.configured === true}
                  walletEnabled={props.settings.glmWalletEnabled}
                  walletConfigured={props.settings.credentials['glm-wallet'].configured === true}
                  quotaDisplayMode={props.settings.glmQuotaDisplay}
                  quotaValueMode={props.settings.quotaValueMode}
                  resetTimeFormat={props.settings.glmResetFormat}
                  onToggleResetTimeFormat={() => props.onToggleResetTimeFormat('glm')}
                  onToggleQuotaDisplay={() => props.onToggleQuotaDisplay('glm')}
                  replayKey={props.replayKeys?.glm}
                  {...cardProps}
                />
              );
            }
            return (
              <DeepSeekCard
                key={provider}
                view={view}
                peak={peak}
                balanceConfigured={props.settings.credentials.deepseek.configured === true}
                webEnabled={props.settings.deepseekWebEnabled}
                webConfigured={props.settings.credentials['deepseek-web'].configured === true}
                replayKey={props.replayKeys?.deepseek}
                {...cardProps}
              />
            );
          })}
    </div>
  );
}

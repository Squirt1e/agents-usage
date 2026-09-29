/**
 * Overview: the three platform cards, or the state that replaces them.
 *
 * The overview never shows a platform picker: visibility lives in the platform
 * management overlay, and the cards that are displayed come straight from the
 * persisted settings. All three platforms are shown by default, in the confirmed
 * Codex → GLM → DeepSeek order.
 *
 * Which card a platform gets, and which settings feed it, live in
 * `ProviderCardView` — the minimal rail renders one of the same cards in its
 * pointer-following detail, so neither surface owns a second presentation.
 */

import { visibleProviders, type PanelSettings, type PanelSnapshot } from '../../shared/desktop-contract';
import type { ProviderId } from '../../shared/contracts';
import { EmptySelectionState, LoadingState } from './MetricStates';
import { ProviderCardView } from './ProviderCardView';

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
  const loadingOnly = props.loading && !props.snapshot;

  return (
    <div className="overview" data-testid="overview">
      {loadingOnly ? <LoadingState /> : null}
      {!loadingOnly && providers.length === 0 ? <EmptySelectionState onOpenManager={props.onOpenAppSettings} /> : null}
      {loadingOnly
        ? null
        : providers.map((provider) => (
            <ProviderCardView
              key={provider}
              provider={provider}
              snapshot={props.snapshot}
              settings={props.settings}
              now={props.now}
              onOpenSettings={props.onOpenSettings}
              {...(props.registerGear ? { registerGear: props.registerGear } : {})}
              onToggleResetTimeFormat={props.onToggleResetTimeFormat}
              onToggleQuotaDisplay={props.onToggleQuotaDisplay}
              {...(props.replayKeys ? { replayKeys: props.replayKeys } : {})}
            />
          ))}
    </div>
  );
}

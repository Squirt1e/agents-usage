/**
 * Codex card: the five-hour and weekly quota views.
 *
 * Behaviour pinned by the spec (task 6.4):
 * - the two windows are identified by their metadata (`windowSeconds`), so a
 *   provider that returns them in another order still gets them right,
 * - each gauge shows its window category, the card-selected quota percentage
 *   (remaining by default) and minute countdown,
 * - once the reset time has passed the countdown says 等待刷新 and the last
 *   percentage is kept — a reached reset is not an observed zero,
 * - a window the provider did not return is shown as missing and is never
 *   replaced by the other window or by zero,
 * - today's Tokens are gated: unsupported, unknown or out-of-range values hide
 *   the entire row instead of showing a placeholder.
 */

import { localDayIn, providerPlanLabel } from '../../shared/desktop-contract';
import type { QuotaDisplayMode, QuotaValueMode, ResetTimeFormat } from '../../shared/desktop-contract';
import type { PlatformCardViewProps } from './card-props';
import { MetricRow } from './MetricRow';
import { PlatformCard } from './PlatformCard';
import { QuotaDisplay } from './QuotaDisplay';
import {
  codexWindows,
  confidenceNote,
  dailyTokens,
  formatTokens,
  metricNumber,
  shouldRenderMetric
} from '../lib/metrics';

export interface CodexCardProps extends PlatformCardViewProps {
  quotaDisplayMode: QuotaDisplayMode;
  quotaValueMode: QuotaValueMode;
  resetTimeFormat: ResetTimeFormat;
}

export function CodexCard(props: CodexCardProps) {
  const { view, now, gate } = props;
  const windows = codexWindows(view);
  const tokens = dailyTokens(view);
  // Codex defines its daily usage buckets in UTC. Gate this provider-owned
  // statistic against the timezone recorded in its scope, while the rest of
  // the card (including reset clocks) continues to use the macOS timezone.
  const tokenTimezone = tokens?.scope?.timezone ?? gate.timezone ?? 'UTC';
  const tokensGate = shouldRenderMetric(tokens, {
    now: gate.now,
    timezone: tokenTimezone,
    localDay: localDayIn(tokenTimezone, gate.now),
    rangeRequired: true
  });
  const tokensValue = tokensGate.render ? metricNumber(tokens) : null;

  return (
    <PlatformCard
      provider="codex"
      plan={providerPlanLabel('codex', view.primary)}
      peak={props.peak}
      registerGear={props.registerGear}
      onOpenSettings={props.onOpenSettings}
    >
      <QuotaDisplay
        mode={props.quotaDisplayMode}
        valueMode={props.quotaValueMode}
        items={windows.map((window) => ({
          id: window.id,
          label: window.label,
          kind: window.id,
          percent: metricNumber(props.quotaValueMode === 'remaining' ? window.remaining : window.used),
          resetAt: window.used?.resetAt ?? window.remaining?.resetAt,
          stale: window.used?.confidence.includes('stale') === true
        }))}
        now={now}
        timezone={gate.timezone}
        resetTimeFormat={props.resetTimeFormat}
        onToggleResetTimeFormat={props.onToggleResetTimeFormat}
        onToggleDisplayMode={props.onToggleQuotaDisplay}
        replayKey={props.replayKey}
        testId="codex-quota-display"
      />
      {tokensGate.render && tokens ? (
        <MetricRow
          label="今日 Tokens"
          note={confidenceNote(tokens.confidence)}
          noteTone={tokens.confidence?.includes('estimated') ? 'estimate' : undefined}
          value={tokensValue === null ? String(tokens.value) : formatTokens(tokensValue)}
          replayKey={props.replayKey}
          testId="metric-codex-tokens"
        />
      ) : null}
    </PlatformCard>
  );
}

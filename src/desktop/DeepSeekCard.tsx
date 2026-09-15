/**
 * DeepSeek card: available balance and opt-in web usage.
 *
 * Behaviour pinned by the spec (task 6.5, extended by the web usage collector):
 * - each currency is displayed on its own; currencies are never added together
 *   and no exchange rate is invented,
 * - daily spend is shown only from the enabled experimental web connection; the
 *   balance-delta estimate is deliberately omitted,
 * - a balance the API did not report stays hidden: only a real zero is shown as
 *   zero,
 * - today's spend, tokens and requests follow the same day/range gate as every
 *   other daily metric,
 * - the experimental web connection never surfaces its own configuration
 *   reminders on the main panel: with the feature off the card shows no trace
 *   of it (the view is filtered before rendering), and with the feature on but
 *   no token pasted the billed area renders as a frosted placeholder — the
 *   same pattern as the GLM wallet.
 */

import { providerPlanLabel } from '../shared/desktop-contract';
import type { PlatformCardViewProps } from './card-props';
import { FrostedHint } from './MetricStates';
import { MetricRow } from './MetricRow';
import { PlatformCard } from './PlatformCard';
import {
  dailyBilledSpends,
  dailyRequests,
  dailyTokens,
  formatMoney,
  formatTokens,
  metricNumber,
  shouldRenderMetric,
  totalBalances
} from './metrics';

export interface DeepSeekCardProps extends PlatformCardViewProps {
  /** `settings.deepseekWebEnabled`: the experimental web usage connection. */
  webEnabled: boolean;
  /** Whether a web login token is stored (`credentials['deepseek-web'].configured`). */
  webConfigured: boolean;
}

export function DeepSeekCard(props: DeepSeekCardProps) {
  const { view, now, gate, webEnabled, webConfigured } = props;
  void now;
  const balances = totalBalances(view);
  // A stored token is part of the display gate, not just the collector gate:
  // cached web rows must not leak around the cover after the token is removed.
  const webReady = webEnabled && webConfigured;
  const spends = webReady ? dailyBilledSpends(view) : [];
  const tokens = webReady ? dailyTokens(view) : undefined;
  const requests = webReady ? dailyRequests(view) : undefined;
  const tokensGate = shouldRenderMetric(tokens, { ...gate, rangeRequired: true });
  const tokensValue = tokensGate.render ? metricNumber(tokens) : null;
  const requestsGate = shouldRenderMetric(requests, { ...gate, rangeRequired: true });
  const requestsValue = requestsGate.render ? metricNumber(requests) : null;
  const multipleCurrencies = balances.length > 1;
  // The frosted placeholder belongs to the module without a token; once a
  // token is stored (collecting, failing or succeeding) the plain rows render.
  const webCovered = webEnabled && !webConfigured;

  return (
    <PlatformCard
      provider="deepseek"
      plan={providerPlanLabel('deepseek', view.primary)}
      peak={props.peak}
      registerGear={props.registerGear}
      onOpenSettings={props.onOpenSettings}
    >
      {balances.map(({ currency, metric }) => {
        const gateResult = shouldRenderMetric(metric, gate);
        if (!gateResult.render) return null;
        const value = metricNumber(metric);
        return (
          <MetricRow
            key={`balance-${currency}`}
            label={multipleCurrencies ? `剩余余额（${currency}）` : '剩余余额'}
            strong
            value={value === null ? String(metric.value) : formatMoney(value, currency)}
            replayKey={props.replayKey}
          />
        );
      })}
      {spends.map(({ currency, metric }) => {
        const gateResult = shouldRenderMetric(metric, { ...gate, rangeRequired: true });
        if (!gateResult.render) return null;
        const value = metricNumber(metric);
        // One reading among the others: label left, amount right, the same row the
        // tokens and requests below it use. The web bill is not marked as an
        // experiment on the card — the connection is opted into on its own page.
        return (
          <MetricRow
            key={`spend-${currency}`}
            label={spends.length > 1 ? `今日消费（${currency}）` : '今日消费'}
            value={value === null ? String(metric.value) : formatMoney(value, currency)}
            replayKey={props.replayKey}
            testId={`metric-deepseek-spend-${currency}`}
          />
        );
      })}
      {webCovered ? (
        <div className="glm-wallet deepseek-web is-covered" data-testid="deepseek-web">
          <div className="wallet-spend">
            <span className="metric-label">今日消费（账单）</span>
            <span className="wallet-spend-value">--</span>
          </div>
          <FrostedHint
            testId="deepseek-web-mask"
            label="配置网页 Token 后显示今日用量"
            onActivate={() => props.onOpenSettings('deepseek')}
          />
        </div>
      ) : null}
      {tokensGate.render && tokens ? (
        <MetricRow
          label="今日 Tokens"
          value={tokensValue === null ? String(tokens.value) : formatTokens(tokensValue)}
          replayKey={props.replayKey}
          testId="metric-deepseek-tokens"
        />
      ) : null}
      {requestsGate.render && requests ? (
        <MetricRow
          label="今日请求"
          value={requestsValue === null ? String(requests.value) : String(requestsValue)}
          replayKey={props.replayKey}
          testId="metric-deepseek-requests"
        />
      ) : null}
    </PlatformCard>
  );
}

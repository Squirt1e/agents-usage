/**
 * DeepSeek card: available balance and opt-in web usage.
 *
 * Behaviour pinned by the spec (task 6.5, extended by the web usage collector):
 * - each currency is displayed on its own; currencies are never added together
 *   and no exchange rate is invented,
 * - the balance module is the platform's *official* data (the answer to its API
 *   key), so it always renders its formal layout: with no reading the placeholder
 *   row stays and the frosted cover carries the way to configure it, the same
 *   shape the GLM quota and wallet modules have. A card that emptied itself
 *   instead left the user a bare header and nothing to act on,
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

import { providerPlanLabel } from '../../shared/desktop-contract';
import type { PlatformCardViewProps } from './card-props';
import { CardSection } from './CardSection';
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
} from '../lib/metrics';

export interface DeepSeekCardProps extends PlatformCardViewProps {
  /** Whether a balance API key is stored (`credentials.deepseek.configured`).
   *  Without one the balance module is a placeholder under the cover: the reading
   *  collected before the key was deleted must not keep standing in for a live
   *  balance. */
  balanceConfigured: boolean;
  /** `settings.deepseekWebEnabled`: the experimental web usage connection. */
  webEnabled: boolean;
  /** Whether a web login token is stored (`credentials['deepseek-web'].configured`). */
  webConfigured: boolean;
}

/**
 * Placeholder balance for the frosted cover, the figure the confirmed design
 * draft uses: a card with no API key still has the shape of a real one under the
 * glass, and the cover hides this row on the very first frame.
 */
const PLACEHOLDER_BALANCE = { currency: 'CNY', amount: 86.42 };

export function DeepSeekCard(props: DeepSeekCardProps) {
  const { view, now, gate, balanceConfigured, webEnabled, webConfigured } = props;
  void now;
  const balances = totalBalances(view);
  // A stored key is part of the display gate, not just the collector gate — the
  // same rule the web rows below already follow. The service goes on publishing
  // the last persisted snapshot after a credential is deleted, so reading the view
  // alone kept a deleted key's balance on the card.
  const renderedBalances = balanceConfigured
    ? balances.filter(({ metric }) => shouldRenderMetric(metric, gate).render)
    : [];
  // The balance connection's own error decides the cover's wording. The primary
  // state is the fallback for a service that publishes one merged balance state
  // without a connection identity — the same shape the GLM quota module reads.
  const balanceState = view.state('wallet') ?? view.primary;
  const balanceError = balanceState?.error ?? balanceState?.snapshot?.error;
  // The balance module always renders its formal layout; only the *reading* can be
  // missing, and that is what the cover is for. `multipleCurrencies` keeps reading
  // the full list so the labels of real rows do not change with the gate.
  const balanceEmpty = renderedBalances.length === 0;
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
  const renderedSpends = spends.filter(({ metric }) =>
    shouldRenderMetric(metric, { ...gate, rangeRequired: true }).render
  );
  const hasTodayUsage =
    renderedSpends.length > 0 ||
    webCovered ||
    (tokensGate.render && tokens !== undefined) ||
    (requestsGate.render && requests !== undefined);

  return (
    <PlatformCard
      provider="deepseek"
      plan={providerPlanLabel('deepseek', view.primary)}
      peak={props.peak}
      registerGear={props.registerGear}
      onOpenSettings={props.onOpenSettings}
    >
      <CardSection kind="primary" label="主要指标">
        <div className={`card-module${balanceEmpty ? ' is-covered' : ''}`} data-testid="deepseek-balance">
          {renderedBalances.map(({ currency, metric }) => {
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
          {balanceEmpty ? (
            <>
              <MetricRow
                label="剩余余额"
                strong
                value={formatMoney(PLACEHOLDER_BALANCE.amount, PLACEHOLDER_BALANCE.currency)}
              />
              <FrostedHint
                testId="deepseek-balance-mask"
                label={
                  !balanceConfigured || balanceError?.kind === 'missing_config'
                    ? '配置 API Key 后显示余额'
                    : '暂无余额数据'
                }
                onActivate={() => props.onOpenSettings('deepseek')}
              />
            </>
          ) : null}
        </div>
      </CardSection>
      {hasTodayUsage ? (
        <CardSection kind="secondary" label="今日用量">
          {renderedSpends.map(({ currency, metric }) => {
            const value = metricNumber(metric);
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
            <div className="card-module deepseek-web is-covered" data-testid="deepseek-web">
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
        </CardSection>
      ) : null}
    </PlatformCard>
  );
}

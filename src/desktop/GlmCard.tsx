/**
 * GLM card: two switchable quota windows on top, wallet block below.
 *
 * Both modules always render the formal configured layout. A module that has no
 * data at all keeps that layout — filled with the stable placeholder values
 * below so the frosted cover blurs a realistic-looking card — and gains the
 * translucent hint instead of switching to a dedicated empty-state block.
 *
 * Behaviour pinned by the spec (task 6.5):
 * - the Coding Plan quota and the experimental wallet are *separate*
 *   connections: each renders what it has, and a failure of one never hides
 *   the other,
 * - the wallet module exists exactly while its connection is switched on: off, it
 *   and everything the connection collected disappear from the card (the switch is
 *   the only display condition, the same interaction the DeepSeek web module has),
 * - switched on without a credential the module keeps its formal layout under the
 *   配置钱包凭据后显示用量 hint, so the door to configuring it is visible rather
 *   than the module simply vanishing,
 * - the wallet carries the 实验数据源 marker because its endpoint is not a stable
 *   public API; the quota is never converted into a wallet balance.
 *
 * Reset lines behave like Codex: countdown by default, clicking one
 * flips that window kind between countdown and absolute time (the choice is
 * remembered per window kind), 等待刷新 once the reset has passed.
 */

import {
  providerPlanLabel,
  type DesktopUsageMetric,
  type QuotaDisplayMode,
  type QuotaValueMode,
  type ResetTimeFormat
} from '../shared/desktop-contract';
import type { PlatformCardViewProps } from './card-props';
import { FrostedHint } from './MetricStates';
import { MetricRow } from './MetricRow';
import { PlatformCard } from './PlatformCard';
import { QuotaDisplay } from './QuotaDisplay';
import { ReplayNumber } from './ReplayNumber';
import { ConfidenceTag } from './StatusRow';
import {
  formatMoney,
  glmQuotaWindows,
  metricNumber,
  shouldRenderMetric,
  walletBalances,
  dailySpends,
  type QuotaBar,
  type QuotaWindowKind
} from './metrics';

/**
 * Placeholder quota values for a module without data, mirroring the confirmed
 * design draft: the frosted hint blurs a realistic-looking pair of windows
 * instead of empty dashes.
 */
const PLACEHOLDER_QUOTA: Array<{ id: string; label: string; percent: number; offsetSeconds: number }> = [
  { id: '5h', label: '5 小时额度', percent: 28, offsetSeconds: 2 * 3600 + 18 * 60 + 45 },
  { id: 'weekly', label: '每周额度', percent: 16, offsetSeconds: 5 * 86_400 + 6 * 3600 + 12 * 60 }
];

/** Placeholder wallet values for the frosted wallet cover. */
const PLACEHOLDER_WALLET = { currency: 'CNY', balance: 42.6, spend: 1.28 };

function placeholderMetric(key: string, percent: number, resetAt: string): DesktopUsageMetric {
  const direction = key.endsWith('.remaining') ? 'remaining' : 'used';
  return { key, value: percent, unit: 'percent', direction, confidence: ['authoritative'], source: 'glm-placeholder', resetAt };
}

/** GLM window ids share the Codex reset-time formats via the window kind. */
function windowKindOf(bar: QuotaBar): QuotaWindowKind {
  return bar.id === '5h' ? 'five-hour' : 'weekly';
}

export interface GlmCardProps extends PlatformCardViewProps {
  quotaDisplayMode: QuotaDisplayMode;
  quotaValueMode: QuotaValueMode;
  resetTimeFormat: ResetTimeFormat;
  /** `settings.glmWalletEnabled`: the experimental connection's own switch — it
   *  decides both collecting and showing. Off, the wallet module does not exist;
   *  on, it renders what the connection has (or the credential prompt when it has
   *  no credential yet). */
  walletEnabled: boolean;
}

export function GlmCard(props: GlmCardProps) {
  const { view, now, gate, walletEnabled, resetTimeFormat, onToggleResetTimeFormat } = props;
  const quotaWindows = glmQuotaWindows(view);
  const returnedBars = quotaWindows.filter(
    (bar) => shouldRenderMetric(bar.used, gate).render || shouldRenderMetric(bar.remaining, gate).render
  );
  const bars: QuotaBar[] =
    returnedBars.length > 0
      ? quotaWindows
      : PLACEHOLDER_QUOTA.map(({ id, label, percent, offsetSeconds }) => ({
          id,
          label,
          used: placeholderMetric(`quota.${id}.used`, percent, new Date(now.getTime() + offsetSeconds * 1000).toISOString()),
          remaining: placeholderMetric(`quota.${id}.remaining`, 100 - percent, new Date(now.getTime() + offsetSeconds * 1000).toISOString())
        }));
  const wallets = walletEnabled
    ? walletBalances(view).filter(({ metric }) => shouldRenderMetric(metric, gate).render)
    : [];
  const spends = walletEnabled
    ? dailySpends(view, 'wallet').filter(({ metric }) =>
        shouldRenderMetric(metric, { ...gate, rangeRequired: true }).render
      )
    : [];
  const quotaState = view.state('quota') ?? view.primary;
  const walletState = view.state('wallet');
  const quotaError = quotaState?.error ?? quotaState?.snapshot?.error;
  // The connection switch is a display gate as well as a collector gate, the same
  // way the DeepSeek card gates its web rows on `webEnabled && webConfigured`: a
  // switched-off connection stops being collected but keeps being *published* from
  // the last persisted snapshot, so reading it here would show a balance that can
  // never change again, and its failure would be reported for a connection the
  // user has deliberately turned off. The view is normally filtered upstream too;
  // this is what makes the card itself follow the switch.
  const walletError = walletEnabled ? walletState?.error ?? walletState?.snapshot?.error : undefined;
  // The frosted cover belongs to a module without any data; a connection that
  // has data (cached included) always keeps the plain formal layout.
  const walletEmpty = wallets.length === 0 && spends.length === 0;

  return (
    <PlatformCard
      provider="glm"
      plan={providerPlanLabel('glm', view.primary)}
      peak={props.peak}
      registerGear={props.registerGear}
      onOpenSettings={props.onOpenSettings}
    >
      <QuotaDisplay
        mode={props.quotaDisplayMode}
        valueMode={props.quotaValueMode}
        items={bars.map((bar) => ({
          id: bar.id,
          label: bar.label,
          kind: windowKindOf(bar),
          percent: metricNumber(props.quotaValueMode === 'remaining' ? bar.remaining : bar.used),
          resetAt: bar.used?.resetAt ?? bar.remaining?.resetAt,
          stale: (props.quotaValueMode === 'remaining' ? bar.remaining : bar.used)?.confidence.includes('stale') === true
        }))}
        now={now}
        timezone={gate.timezone}
        resetTimeFormat={resetTimeFormat}
        onToggleResetTimeFormat={onToggleResetTimeFormat}
        onToggleDisplayMode={props.onToggleQuotaDisplay}
        replayKey={props.replayKey}
        testId="glm-quota-list"
        /* Only when the columns are placeholders: the cover blurs the content it
           sits on, and there is nothing to blur over real data. */
        covered={returnedBars.length === 0}
        overlay={returnedBars.length === 0 ? (
          <FrostedHint
            testId="glm-quota-mask"
            label={quotaError?.kind === 'missing_config' ? '配置 API Key 后显示额度' : '暂无额度数据'}
            onActivate={() => props.onOpenSettings('glm')}
          />
        ) : null}
      />

      {walletEnabled ? (
        <div className={`glm-wallet${walletEmpty ? ' is-covered' : ''}`} data-testid="glm-wallet">
          {wallets.map(({ currency, metric }) => {
            const value = metricNumber(metric);
            return (
              <MetricRow
                key={`balance-${currency}`}
                label="钱包余额"
                note="实验数据源"
                strong
                value={value === null ? String(metric.value) : formatMoney(value, currency)}
                replayKey={props.replayKey}
              />
            );
          })}
          {spends.map(({ currency, metric }) => {
            const value = metricNumber(metric);
            return (
              <div className="wallet-spend" key={`spend-${currency}`}>
                <span className="metric-label">
                  今日钱包消费
                  <ConfidenceTag tone="estimate">估算</ConfidenceTag>
                </span>
                <span className="wallet-spend-value">
                  <ReplayNumber key={props.replayKey} text={value === null ? String(metric.value) : formatMoney(value, currency)} replay={!!props.replayKey} />
                </span>
              </div>
            );
          })}
          {walletEmpty ? (
            <>
              <MetricRow label="钱包余额" note="实验数据源" strong value={formatMoney(PLACEHOLDER_WALLET.balance, PLACEHOLDER_WALLET.currency)} />
              <div className="wallet-spend">
                <span className="metric-label">
                  今日钱包消费
                  <ConfidenceTag tone="estimate">估算</ConfidenceTag>
                </span>
                <span className="wallet-spend-value">{formatMoney(PLACEHOLDER_WALLET.spend, PLACEHOLDER_WALLET.currency)}</span>
              </div>
              <FrostedHint
                testId="glm-wallet-mask"
                label={walletError?.kind === 'missing_config' ? '配置钱包凭据后显示用量' : '暂无钱包数据'}
                onActivate={() => props.onOpenSettings('glm')}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </PlatformCard>
  );
}

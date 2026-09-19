/**
 * Compact label/value row used by the wallet, spend and token metrics.
 *
 * The label keeps its confidence marker (估算 / 实验数据源 / 部分数据) next to it,
 * because an estimated value must never look like a billed one. A cached value
 * keeps its number; the panel states no "out of date" notice beside it.
 */

import type { ReactNode } from 'react';
import { ConfidenceTag } from '../components/StatusRow';
import { ReplayNumber } from './ReplayNumber';

export interface MetricRowProps {
  label: string;
  note?: string;
  noteTone?: 'estimate';
  value: ReactNode;
  strong?: boolean;
  testId?: string;
  /** Marks only a real balance amount that has crossed the configured reminder. */
  lowBalance?: boolean;
  /** Incremented after a successful manual refresh of this row's platform. */
  replayKey?: number;
}

export function MetricRow(props: MetricRowProps) {
  const accessibleValue = typeof props.value === 'string' ? props.value : '';
  return (
    <div
      className={`metric-row${props.strong ? ' metric-row-strong' : ''}${props.lowBalance ? ' is-low-balance' : ''}`}
      data-low-balance={props.lowBalance === true}
      {...(props.lowBalance
        ? { role: 'group', 'aria-label': `${props.label} ${accessibleValue} 低余额提醒` }
        : {})}
      {...(props.testId ? { 'data-testid': props.testId } : {})}
    >
      <span className="metric-label">
        {props.label}
        {props.note ? <ConfidenceTag tone={props.noteTone}>{props.note}</ConfidenceTag> : null}
      </span>
      <span className="metric-value">
        {typeof props.value === 'string' && props.replayKey ? <ReplayNumber key={props.replayKey} text={props.value} replay /> : props.value}
      </span>
    </div>
  );
}

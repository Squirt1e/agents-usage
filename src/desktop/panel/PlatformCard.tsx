/**
 * The compact platform card frame: monogram badge, platform name, plan tag and
 * the tune entry that opens *that* platform's configuration.
 *
 * The card owns no data rules; the platform cards only fill `children`.
 */

import type { ReactNode } from 'react';
import type { ProviderId } from '../../shared/contracts';
import { providerDisplayName } from '../../shared/desktop-contract';
import type { PeakPeriod } from '../lib/peak-windows';
import { TuneIcon } from '../components/icons';

const MONOGRAMS: Record<ProviderId, string> = { codex: 'CX', glm: 'GL', deepseek: 'DS' };

export interface PlatformCardProps {
  provider: ProviderId;
  /** Short plan/subtitle, only shown when the service reported one. */
  plan?: string;
  /**
   * The provider's current peak/off-peak state (local clock data). Only peak is
   * presented; off-peak keeps the ordinary card and hides the retained corner.
   * The value is absent entirely for providers without a schedule.
   */
  peak?: { period: PeakPeriod; boundaryClock?: string };
  /** Registers the tune button so the overview can restore focus after "返回". */
  registerGear?(provider: ProviderId, node: HTMLButtonElement | null): void;
  onOpenSettings(provider: ProviderId): void;
  children: ReactNode;
}

export function PlatformCard(props: PlatformCardProps) {
  const name = providerDisplayName(props.provider);
  const isPeak = props.peak?.period === 'peak';
  return (
    <section
      className="provider-card"
      data-testid={`card-${props.provider}`}
      data-provider={props.provider}
      {...(isPeak ? { 'data-period': 'peak' } : {})}
      aria-labelledby={`card-title-${props.provider}`}
    >
      <header className="provider-head">
        <span className={`brand-badge brand-${props.provider}`} aria-hidden="true">
          {MONOGRAMS[props.provider]}
        </span>
        <h2 className="provider-name" id={`card-title-${props.provider}`}>
          {name}
        </h2>
        {props.plan ? <span className="plan-tag">{props.plan}</span> : null}
        {props.peak ? (
          <span
            className="peak-corner"
            aria-hidden={isPeak ? undefined : true}
            {...(isPeak ? { 'aria-label': `高峰时段，下一边界 ${props.peak.boundaryClock ?? '未知'}` } : {})}
          >
            高峰
            {props.peak.boundaryClock ? ` · ${props.peak.boundaryClock}` : ''}
          </span>
        ) : null}
        <span className="provider-head-spacer" />
        <button
          type="button"
          className="icon-button gear-button"
          aria-label={`配置 ${name}`}
          ref={(node) => props.registerGear?.(props.provider, node)}
          onClick={() => props.onOpenSettings(props.provider)}
        >
          <TuneIcon />
        </button>
      </header>
      <div className="provider-body">{props.children}</div>
    </section>
  );
}

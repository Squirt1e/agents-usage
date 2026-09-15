import type { UsageDatabase } from '../persistence/database';

export interface DailySpendEstimate {
  currency: string;
  localDay: string;
  estimatedSpend: number;
  adjustmentCount: number;
  partial: boolean;
}

export class DailySpendEstimator {
  constructor(private readonly database: UsageDatabase, private readonly timezone: string) {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format();
  }

  record(currency: string, total: number, observedAt: Date): DailySpendEstimate {
    if (!Number.isFinite(total) || total < 0) throw new Error('Balance total must be a non-negative finite number');
    const local = this.localParts(observedAt);
    const latest = this.database.getLatestBalanceObservation('deepseek', currency);
    if (latest && latest.localDay !== local.day) this.closeDay(currency, latest.localDay);
    const existing = this.database.listBalanceObservations('deepseek', currency, local.day);
    const previous = existing.at(-1);
    this.database.addBalanceObservation({
      provider: 'deepseek', currency, total, observedAt: observedAt.toISOString(), localDay: local.day,
      adjustment: Boolean(previous && total > previous.total)
    });
    const samples = this.database.listBalanceObservations('deepseek', currency, local.day);
    const { estimatedSpend, adjustmentCount, partial } = this.summarize(samples);
    return { currency, localDay: local.day, estimatedSpend, adjustmentCount, partial };
  }

  private closeDay(currency: string, localDay: string) {
    const samples = this.database.listBalanceObservations('deepseek', currency, localDay);
    if (!samples.length) return;
    const summary = this.summarize(samples);
    this.database.saveDailySummary('deepseek', currency, localDay, summary.estimatedSpend, summary.partial, summary.adjustmentCount);
  }

  private summarize(samples: ReturnType<UsageDatabase['listBalanceObservations']>) {
    let estimatedSpend = 0;
    let adjustmentCount = 0;
    for (let index = 1; index < samples.length; index += 1) {
      const difference = samples[index - 1].total - samples[index].total;
      if (difference > 0) estimatedSpend += difference;
      if (difference < 0 || samples[index].adjustment) adjustmentCount += 1;
    }
    const first = new Date(samples[0].observedAt);
    const firstParts = this.localParts(first);
    const partial = firstParts.hour !== 0 || firstParts.minute !== 0 || firstParts.second !== 0;
    return {
      estimatedSpend: Number(estimatedSpend.toFixed(12)),
      adjustmentCount,
      partial
    };
  }

  private localParts(date: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const year = get('year');
    const month = get('month');
    const day = get('day');
    return {
      day: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
      hour: get('hour'), minute: get('minute'), second: get('second')
    };
  }
}

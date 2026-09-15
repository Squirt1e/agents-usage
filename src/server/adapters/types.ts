import type { ProviderId, ProviderSnapshot } from '../../shared/contracts';

export type CollectorChannel = 'stable' | 'experimental';

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly channel: CollectorChannel;
  enabled?(): boolean;
  refresh(signal?: AbortSignal): Promise<ProviderSnapshot>;
}

export class CollectorFailure extends Error {
  constructor(
    readonly kind: 'missing_config' | 'authentication' | 'compatibility' | 'network' | 'rate_limit' | 'process' | 'storage' | 'unknown',
    message: string,
    readonly diagnostic?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CollectorFailure';
  }
}

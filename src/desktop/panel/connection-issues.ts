import type { CollectorError, ProviderId } from '../../shared/contracts';
import { providerDisplayName, stateConnection, visibleProviders, type DesktopProviderState, type PanelSettings, type PanelSnapshot } from '../../shared/desktop-contract';
import { errorLabel } from '../components/StatusRow';

export interface ConnectionIssue {
  key: string;
  provider: ProviderId;
  connection: string;
  status: string;
  message: string;
}

function activeError(state: DesktopProviderState): CollectorError | undefined {
  const error = state.error ?? state.snapshot?.error;
  if (!error) return undefined;
  const successAt = state.snapshot?.lastSuccessAt ?? state.snapshot?.capturedAt;
  const failed = Date.parse(error.at);
  const succeeded = successAt === undefined ? Number.NaN : Date.parse(successAt);
  // The service may retain the last failure after a newer successful capture.
  // Keep the detail only while that failure is still the latest known attempt.
  if (Number.isFinite(failed) && Number.isFinite(succeeded) && succeeded > failed) return undefined;
  return error;
}

function connectionName(provider: ProviderId, connection: string): string {
  if (provider === 'glm') return connection === 'wallet' ? '钱包' : 'Coding Plan';
  if (provider === 'deepseek') return connection === 'web' ? '网页用量' : '余额';
  return '额度';
}

/** Current, visible connection failures for the footer; never alters card data. */
export function connectionIssues(snapshot: PanelSnapshot | undefined, settings: PanelSettings): ConnectionIssue[] {
  const visible = new Set(visibleProviders(settings));
  const issues = new Map<string, ConnectionIssue>();
  for (const state of snapshot?.providers ?? []) {
    if (!visible.has(state.provider)) continue;
    // The identity has to come from the shared resolver: a connection that has
    // never succeeded has no state-level `connection` and no snapshot, and only
    // its `connections` entry says which connection this really is. Reading it as
    // the primary connection would both misname the row and let a switched-off
    // experimental connection past the gates below.
    const declared = stateConnection(state);
    // `primary` only remains for a state that reports no identity at all.
    const connection = declared?.connection ?? 'primary';
    if (state.provider === 'glm' && connection === 'wallet' && !settings.glmWalletEnabled) continue;
    if (state.provider === 'deepseek' && connection === 'web' && !settings.deepseekWebEnabled) continue;
    const error = activeError(state);
    if (!error) continue;
    const key = `${state.provider}:${connection}`;
    issues.set(key, {
      key,
      provider: state.provider,
      connection: declared?.label ?? connectionName(state.provider, connection),
      status: errorLabel(error.kind).label,
      message: error.message
    });
  }
  const order = visibleProviders(settings);
  return [...issues.values()].sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
}

export function issueHeading(issue: ConnectionIssue): string {
  return `${providerDisplayName(issue.provider)} · ${issue.connection}`;
}

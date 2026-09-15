/**
 * The panel container: data loading, live events, view state and the window-level
 * keyboard behaviour.
 *
 * Responsibilities pinned by the specs:
 * - reads the snapshot and the settings once, then keeps them fresh through
 *   `subscribe` (a dropped stream is reported, and the transport reconnects and
 *   re-reads on its own),
 * - one platform's configuration at a time; "返回用量总览" restores the overview
 *   *and* the focus to the gear that opened it,
 * - Escape closes the inner overlay first (platform management, then the
 *   per-platform settings) and only then asks the host to collapse the window,
 * - the pin state is host-driven: this component renders what the host reports
 *   and never keeps a private copy,
 * - hiding a platform only writes `platformVisibility`: no credential is deleted
 *   and collection keeps running.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '../shared/contracts';
import {
  parsePanelSettings,
  providerDisplayName,
  visibleProviders,
  type CredentialStatus,
  type CredentialTarget,
  type PanelSettings,
  type PanelSettingsPatch,
  type PanelSnapshot
} from '../shared/desktop-contract';
import { UsageClientError, type UsageClient } from '../shared/usage-client';
import { OverviewView } from './OverviewView';
import { Panel, PanelIconButton, type PanelDirection } from './Panel';
import { requestPanelHeightMeasure, usePanelHeight } from './panel-height';
import { AppSettings } from './AppSettings';
import { usePanelTheme } from './theme';
import { ProviderSettings } from './ProviderSettings';
import { ServiceUnavailableState } from './MetricStates';
import { PanelToasts } from './PanelToasts';
import { ConnectionDetails } from './ConnectionDetails';
import { connectionIssues } from './connection-issues';
import { collectPeakTransitions, effectivePeakDef, type PeakPeriod } from './peak-windows';
import {
  dropToast,
  dropToastsTagged,
  pushToast,
  type PanelNotice,
  type PanelToast
} from './panel-toasts';
import type { StatusTone } from './StatusRow';
import { GearIcon, PinIcon, RefreshIcon } from './icons';
import { formatClockTime, latestAttemptFailed, latestSync, providerView } from './metrics';

/** Tag of the live-connection warning, so reopening the stream can take it back. */
const CONNECTION_TAG = 'connection';

/** The empty answer to "which cards are on screen", shared so a panel with none reuses one set. */
const NO_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>();

/** Window controls the panel asks the host for; the host owns the real state. */
export interface PanelHostProps {
  /** Current pinned state as reported by the host. */
  pinned: boolean;
  /**
   * Whether the panel's header should be on screen, as reported by the host
   * (a pinned panel's header settles away while the panel is out of focus).
   * Absent/`undefined` reads as visible, so existing callers stay valid.
   */
  headerVisible?: boolean;
  onTogglePin(): void;
  /** Ask the host to collapse the panel (Escape with no overlay open). */
  onRequestHide(): void;
  /** Ask the host to size the window to the panel's content. Must be stable. */
  onSetHeight(height: number): void;
}

export interface PanelAppProps {
  client: UsageClient;
  host: PanelHostProps;
  /** Fixed clock for tests and static previews; otherwise the panel ticks. */
  now?: Date;
  tickMs?: number;
}

type PanelView =
  | { kind: 'overview' }
  | { kind: 'settings'; provider: ProviderId }
  /** The panel's own settings page (platform management first). */
  | { kind: 'app-settings' };

type PendingFocus = { kind: 'gear'; provider: ProviderId } | { kind: 'settings' } | undefined;

export function PanelApp(props: PanelAppProps) {
  const { client, host } = props;
  const [snapshot, setSnapshot] = useState<PanelSnapshot | undefined>();
  const [settings, setSettings] = useState<PanelSettings>(() => parsePanelSettings({}));
  usePanelTheme(settings.theme);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [view, setView] = useState<PanelView>({ kind: 'overview' });
  // Which way the last page swap travelled; the transition animates along it.
  const [direction, setDirection] = useState<PanelDirection>('forward');
  const [refreshing, setRefreshing] = useState<Set<ProviderId>>(new Set());
  const [replayKeys, setReplayKeys] = useState<Partial<Record<ProviderId, number>>>({});
  const [toasts, setToasts] = useState<PanelToast[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [clock, setClock] = useState<Date>(() => props.now ?? new Date());

  const gearRefs = useRef<Partial<Record<ProviderId, HTMLButtonElement | null>>>({});
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<PendingFocus>(undefined);
  /** Ids for the message stack; a ref because an id is not part of the view. */
  const toastId = useRef(1);
  // Latest settings for event handlers that must not close over a stale copy
  // (two visibility toggles in quick succession, for instance).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** Report something that just happened, as a message on the bottom of the panel. */
  const announce = useCallback((notice: PanelNotice) => {
    setToasts((current) => pushToast(current, notice, toastId.current++));
  }, []);

  /** Stack bookkeeping, once a message has played its exit. Not a user action. */
  const removeToast = useCallback((id: number) => {
    setToasts((current) => dropToast(current, id));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSnapshot, nextSettings] = await Promise.all([client.readSnapshot(), client.readSettings()]);
      setSnapshot(nextSnapshot);
      setSettings(nextSettings);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '本地服务不可用');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    void load();
    const unsubscribe = client.subscribe((event) => {
      if (!active) return;
      if (event.type === 'snapshot') {
        setSnapshot(event.snapshot);
        setLoadError(undefined);
        return;
      }
      if (event.type === 'provider' && event.state && (event.state.snapshot || event.state.error)) {
        // A pushed state must carry something: an empty state would blank a card
        // that the cache still has data for.
        const state = event.state;
        setSnapshot((current) => {
          const providers = [...(current?.providers ?? [])];
          const index = providers.findIndex((entry) => entry.provider === state.provider);
          if (index === -1) providers.push(state);
          else providers[index] = state;
          return { ...(current ?? {}), providers };
        });
        return;
      }
      if (event.type === 'settings') {
        setSettings(event.settings);
        return;
      }
      if (event.type === 'connection') {
        // The warning is tagged rather than timed: it is a condition, and it ends
        // when the stream reopens, not when a clock runs out.
        if (event.status === 'reconnecting') {
          announce({ tone: 'warning', tag: CONNECTION_TAG, text: event.message ?? '实时连接中断，正在使用缓存数据' });
        } else if (event.status === 'open') {
          setToasts((current) => dropToastsTagged(current, CONNECTION_TAG));
        }
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, load, announce]);

  // Safety-net refresh: the panel re-reads the snapshot on a fixed cadence so it
  // always recovers from the initial "not connected" state, even if the host's
  // event stream is not delivered. The loopback read is cheap and local.
  useEffect(() => {
    let active = true;
    const interval = window.setInterval(() => {
      void client
        .readSnapshot()
        .then((next) => {
          if (active) {
            setSnapshot(next);
            setLoadError(undefined);
          }
        })
        .catch(() => undefined);
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [client]);

  useEffect(() => {
    if (props.now) {
      // A fixed clock (tests, static previews): adopt it only when the instant
      // really changed, so a fresh Date object per render cannot loop.
      const fixed = props.now;
      setClock((current) => (current.getTime() === fixed.getTime() ? current : fixed));
      return;
    }
    const interval = window.setInterval(() => setClock(new Date()), props.tickMs ?? 1_000);
    return () => window.clearInterval(interval);
  }, [props.now, props.tickMs]);

  /**
   * The identity of the page on screen. It keys the view inside `Panel` — which is
   * what replays the page transition — and re-attaches the height measurement to
   * the new content.
   */
  const viewKey = view.kind === 'settings' ? `settings:${view.provider}` : view.kind;

  /**
   * Every view change goes through here, so the direction is set in the same update
   * as the view it describes: a swap must never animate along the direction of the
   * one before it.
   */
  const navigate = useCallback((next: PanelView, motion: PanelDirection) => {
    setDetailsOpen(false);
    setDirection(motion);
    setView(next);
  }, []);

  /** Return to the overview, restoring focus to the button that opened a view. */
  const backToOverview = useCallback(
    (provider?: ProviderId) => {
      pendingFocus.current = provider === undefined ? { kind: 'settings' } : { kind: 'gear', provider };
      navigate({ kind: 'overview' }, 'back');
    },
    [navigate]
  );

  // Restores focus after the view swaps back, using the gear ref the card
  // registered. Runs after every render and clears itself once it succeeded.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    if (view.kind !== 'overview') return;
    if (target.kind === 'settings') settingsButtonRef.current?.focus();
    else gearRefs.current[target.provider]?.focus();
    pendingFocus.current = undefined;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (detailsOpen) {
        setDetailsOpen(false);
        return;
      }
      // A sub-page wins: Escape returns to the overview before it collapses the
      // window.
      if (view.kind === 'settings') {
        backToOverview(view.provider);
        return;
      }
      if (view.kind === 'app-settings') {
        backToOverview();
        return;
      }
      host.onRequestHide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [view, host, backToOverview, detailsOpen]);

  const registerGear = useCallback((provider: ProviderId, node: HTMLButtonElement | null) => {
    gearRefs.current[provider] = node;
  }, []);

  const describeError = useCallback((error: unknown, fallback: string) => {
    if (error instanceof UsageClientError && error.kind === 'session') return error.message;
    return error instanceof Error && error.message !== '' ? error.message : fallback;
  }, []);

  /** The platforms the overview displays, in display order. */
  const displayed = useMemo(() => visibleProviders(settings), [settings]);

  /**
   * The periods the visible providers are in, judged on every clock tick.
   *
   * `collectPeakTransitions` compares against the periods last seen, so a
   * boundary crossed while the panel was open is announced once; the first
   * observation (panel just opened, reminder just enabled) is never one. The
   * result lives in a ref because the judgement must survive re-renders that
   * have nothing to do with the clock.
   */
  const peakPeriods = useRef<Partial<Record<ProviderId, PeakPeriod>>>({});
  useEffect(() => {
    const { next, transitions } = collectPeakTransitions(displayed, settings, clock, peakPeriods.current);
    peakPeriods.current = next;
    for (const { provider, period } of transitions) {
      const note = period === 'offpeak' ? effectivePeakDef(settings, provider)?.offPeakNote : undefined;
      announce({
        tone: 'info',
        text: `${providerDisplayName(provider)} 已进入${period === 'peak' ? '高峰' : '错峰'}时段${note ? `（${note}）` : ''}`
      });
    }
  }, [clock, displayed, settings, announce]);

  /**
   * The platforms whose cards the user can see *right now*.
   *
   * A refresh verdict arrives seconds after the click that asked for it — a failed
   * collection can take that long — so it is gated on the screen as it is when the
   * result lands, not as it was at the click: the platform may have been hidden in
   * the meantime, the user may have walked into a sub-page, or the panel may still
   * be showing the loading state (where `settings` are still the defaults, so being
   * "visible" there does not mean a card exists). A message about a card that is
   * not on screen is noise.
   *
   * Written to a ref as well because `refresh` reads it from the closure it was
   * created in, which is the same reason `settingsRef` exists.
   */
  const cardsOnScreen = useMemo(() => {
    if (view.kind !== 'overview' || (loading && !snapshot) || (loadError && !snapshot)) return NO_PROVIDERS;
    return new Set(displayed);
  }, [view.kind, loading, loadError, snapshot, displayed]);
  const cardsOnScreenRef = useRef(cardsOnScreen);
  cardsOnScreenRef.current = cardsOnScreen;

  const refresh = useCallback(
    async (provider: ProviderId) => {
      setRefreshing((current) => new Set(current).add(provider));
      const name = providerDisplayName(provider);
      /** A verdict is only worth saying out loud for a card that is on screen. */
      const report = (notice: PanelNotice) => {
        if (cardsOnScreenRef.current.has(provider)) announce(notice);
      };
      try {
        const result = await client.refresh(provider);
        if (result.status === 'cooldown') {
          // Panel-level news: it says the click did not go out, not what happened
          // to a platform, so there is no card for it to belong to.
          const at = formatClockTime(result.nextEligibleAt);
          announce({ tone: 'warning', text: at ? `刷新冷却中，可于 ${at} 后重试` : '刷新冷却中，请稍后重试' });
          return;
        }
        // The service acknowledges a manual refresh without reporting how it went
        // (`RefreshStatus.requested`), so the verdict is read from the state it
        // published next — the same facts the card's status line is built from.
        const next = await client.readSnapshot();
        setSnapshot(next);
        if (latestAttemptFailed(providerView(next, provider))) {
          // The persistent reason is in the footer detail; the toast only names
          // the platform whose manual refresh failed.
          report({ tone: 'warning', text: `${name} 刷新失败` });
        } else if (cardsOnScreenRef.current.has(provider)) {
          setReplayKeys((current) => ({ ...current, [provider]: (current[provider] ?? 0) + 1 }));
        }
      } catch (error) {
        // A lost session is the one failure the platform name cannot explain: it is
        // about the panel's own connection, and its message says what to do, so it
        // is said even when no card is on screen.
        if (error instanceof UsageClientError && error.kind === 'session') {
          announce({ tone: 'danger', text: error.message });
          return;
        }
        report({ tone: 'danger', text: `${name} 刷新失败` });
      } finally {
        setRefreshing((current) => {
          const next = new Set(current);
          next.delete(provider);
          return next;
        });
      }
    },
    [client, announce]
  );

  const refreshingAll = useMemo(() => [...refreshing].length > 0, [refreshing]);

  const refreshDisplayed = useCallback(() => {
    for (const provider of displayed) void refresh(provider);
  }, [refresh, displayed]);

  const updateSettings = useCallback(
    async (patch: PanelSettingsPatch) => {
      setSettingsBusy(true);
      try {
        const next = await client.updateSettings(patch);
        setSettings(next);
        // No clearing here: a message reports the moment it describes and leaves on
        // its own clock, so a successful save does not sweep away a refresh verdict.
      } catch (error) {
        announce({ tone: 'danger', text: describeError(error, '设置保存失败') });
      } finally {
        setSettingsBusy(false);
      }
    },
    [client, describeError, announce]
  );

  const validateCredential = useCallback(
    async (target: CredentialTarget, secret: string): Promise<CredentialStatus> => {
      const status = await client.validateCredential(target, secret);
      // The service returns the mask; re-read the settings so every view sees it.
      setSettings(await client.readSettings());
      return status;
    },
    [client]
  );

  const deleteCredential = useCallback(
    async (target: CredentialTarget) => {
      await client.deleteCredential(target);
      setSettings(await client.readSettings());
    },
    [client]
  );

  // A switch is disabled only by its own write: tracking the platforms with a
  // visibility write in flight lets an unrelated save (theme, quota value,
  // reorder) leave every switch exactly as it was instead of grey-listing all.
  const [togglingVisibility, setTogglingVisibility] = useState<ReadonlySet<ProviderId>>(new Set());

  const setVisibility = useCallback(
    (provider: ProviderId, visible: boolean) => {
      // Visibility is display only: no connection is stopped and no credential is
      // deleted. The service keeps collecting hidden platforms.
      //
      // The checkbox is controlled, so update it optimistically; the settings the
      // service returns afterwards win if the write fails.
      const next = { ...settingsRef.current.platformVisibility, [provider]: visible };
      setSettings((current) => ({ ...current, platformVisibility: next }));
      setTogglingVisibility((current) => new Set(current).add(provider));
      void updateSettings({ platformVisibility: next })
        .then(() => {
          if (!visible && visibleProviders({ ...settingsRef.current, platformVisibility: next }).length === 0) {
            announce({ tone: 'info', text: '已隐藏全部平台，可在“设置”中重新启用。' });
          }
        })
        .finally(() => {
          setTogglingVisibility((current) => {
            const rest = new Set(current);
            rest.delete(provider);
            return rest;
          });
        });
    },
    [updateSettings, announce]
  );

  // The overview owns the window height: it follows its cards, or the minimum when
  // it has none. Every other page inherits that height and scrolls inside it (see
  // panel-height.ts), so opening a form neither stretches nor shrinks the panel.
  usePanelHeight({
    viewKey,
    isMain: view.kind === 'overview',
    onSetHeight: props.host.onSetHeight
  });

  // The height hook's ResizeObserver watches the body's content element, but a
  // load or a retry swaps that element without a view-key change (the loading and
  // error states share `viewKey="overview"` with the overview), which the observer
  // never sees. Re-measuring when the snapshot changes shape keeps the window on
  // the cards the moment they appear, instead of waiting for the safety tick.
  useEffect(() => {
    requestPanelHeightMeasure();
  }, [snapshot]);

  const currentView = view.kind === 'settings' ? view : undefined;
  const onSettingsPage = view.kind === 'app-settings';
  const onSubPage = currentView !== undefined || onSettingsPage;
  const title = currentView
    ? `${providerDisplayName(currentView.provider)} 配置`
    : onSettingsPage
      ? '设置'
      : '用量总览';
  const lastSyncAt = latestSync(displayed.map((provider) => providerView(snapshot, provider)));
  const issues = useMemo(() => connectionIssues(snapshot, settings), [snapshot, settings]);
  // The bottom status module carries the sync line on every page: it is frame
  // furniture, so it neither scrolls with the body nor disappears in a sub-page.
  // A missing sync time is reported as missing, never as a zero or a time.
  const syncText = lastSyncAt
    ? `最近同步于 ${formatClockTime(lastSyncAt, settings.timezone)}`
    : loading
      ? '正在读取本地缓存'
      : '尚未同步';
  const leaveSubPage = currentView ? () => backToOverview(currentView.provider) : onSettingsPage ? () => backToOverview() : undefined;

  const states = useMemo(() => {
    const entries: Partial<Record<ProviderId, PanelSnapshot['providers'][number] | undefined>> = {};
    for (const provider of ['codex', 'glm', 'deepseek'] as const) {
      entries[provider] = providerView(snapshot, provider).primary;
    }
    return entries;
  }, [snapshot]);

  return (
    <Panel
      title={title}
      viewKey={viewKey}
      direction={direction}
      onBack={leaveSubPage}
      headerVisible={props.host.headerVisible}
      footer={
        <>
          <span className={`panel-footer-dot${lastSyncAt ? ' is-live' : ''}`} aria-hidden="true" />
          <span>{syncText}</span>
          <button
            type="button"
            className={`connection-trigger${issues.length > 0 ? ' is-visible' : ''}`}
            aria-label={issues.length > 0 ? `连接异常 ${issues.length}` : '连接正常'}
            aria-controls="connection-details"
            aria-expanded={issues.length > 0 && detailsOpen}
            aria-hidden={issues.length === 0}
            tabIndex={issues.length === 0 ? -1 : 0}
            disabled={issues.length === 0}
            onClick={() => setDetailsOpen((current) => !current)}
          >
            连接异常 {issues.length}
          </button>
        </>
      }
      details={<ConnectionDetails issues={issues} open={detailsOpen} />}
      tools={
        <>
          <PanelIconButton
            label={refreshingAll ? '正在刷新' : '刷新全部平台'}
            disabled={refreshingAll || displayed.length === 0}
            onClick={refreshDisplayed}
          >
            <RefreshIcon />
          </PanelIconButton>
          <PanelIconButton
            label="设置"
            onClick={() => navigate({ kind: 'app-settings' }, 'forward')}
            buttonRef={(node) => {
              settingsButtonRef.current = node;
            }}
          >
            <GearIcon />
          </PanelIconButton>
          <PanelIconButton label={host.pinned ? '取消置顶' : '置顶面板'} pressed={host.pinned} active={host.pinned} onClick={host.onTogglePin}>
            <PinIcon />
          </PanelIconButton>
        </>
      }
      /* Always handed over, hidden on the pages that do not own the row: it fades
         out instead of blinking away, and `aria-hidden` keeps it out of queries. */
      toolsVisible={!onSubPage}
      toasts={<PanelToasts toasts={toasts} onDone={removeToast} />}
    >
      {loadError && !snapshot ? (
        <ServiceUnavailableState message={loadError} onRetry={() => void load()} />
      ) : onSettingsPage ? (
        <AppSettings
          settings={settings}
          states={states}
          busy={settingsBusy}
          togglingVisibility={togglingVisibility}
          onToggleVisibility={setVisibility}
          onReorder={(order) => void updateSettings({ platformOrder: order })}
          onThemeChange={(theme) => updateSettings({ theme })}
          onQuotaValueModeChange={(quotaValueMode) => updateSettings({ quotaValueMode })}
        />
      ) : currentView ? (
        <ProviderSettings
          provider={currentView.provider}
          view={providerView(snapshot, currentView.provider)}
          settings={settings}
          onUpdateSettings={updateSettings}
          onValidateCredential={validateCredential}
          onDeleteCredential={deleteCredential}
        />
      ) : (
        <OverviewView
          snapshot={snapshot}
          settings={settings}
          replayKeys={replayKeys}
          now={clock}
          loading={loading}
          onOpenSettings={(provider) => navigate({ kind: 'settings', provider }, 'forward')}
          onOpenAppSettings={() => navigate({ kind: 'app-settings' }, 'forward')}
          registerGear={registerGear}
          onToggleResetTimeFormat={(provider) =>
            void updateSettings(
              provider === 'codex'
                ? { codexResetFormat: settings.codexResetFormat === 'countdown' ? 'absolute' : 'countdown' }
                : { glmResetFormat: settings.glmResetFormat === 'countdown' ? 'absolute' : 'countdown' }
            )
          }
          onToggleQuotaDisplay={(provider) =>
            void updateSettings(
              provider === 'codex'
                ? { codexQuotaDisplay: settings.codexQuotaDisplay === 'ring' ? 'bar' : 'ring' }
                : { glmQuotaDisplay: settings.glmQuotaDisplay === 'ring' ? 'bar' : 'ring' }
            )
          }
        />
      )}
    </Panel>
  );
}

export type { StatusTone };

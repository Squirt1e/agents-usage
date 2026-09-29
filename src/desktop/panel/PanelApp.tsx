/**
 * The panel: data loading, live events and the window-level keyboard behaviour.
 *
 * The panel is the *overview* and nothing else. Every settings surface lives in the
 * settings window, so this component has no page state: it renders the cards, the
 * frame's status module and the messages, and every entry point that used to swap
 * the body out for a form now asks the host to open that window on a named section
 * (`onOpenSettings`).
 *
 * Responsibilities pinned by the specs:
 * - reads the snapshot and the settings once, then keeps them fresh through
 *   `subscribe` (a dropped stream is reported, and the transport reconnects and
 *   re-reads on its own); the settings themselves live in a store, because the
 *   settings window writes them too,
 * - Escape closes the connection detail first and only then asks the host to
 *   collapse the window,
 * - the pin state is host-driven: this component renders what the host reports
 *   and never keeps a private copy,
 * - hiding a platform only writes `platformVisibility`: no credential is deleted
 *   and collection keeps running.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '../../shared/contracts';
import {
  parsePanelSettings,
  providerDisplayName,
  visibleProviders,
  type PanelSettings,
  type PanelSettingsPatch,
  type PanelSnapshot
} from '../../shared/desktop-contract';
import { UsageClientError, type UsageClient } from '../../shared/usage-client';
import { createSettingsStore, type SettingsStore } from '../settings/settings-store';
import type { SettingsSection } from '../settings/SettingsPanel';
import { OverviewView } from './OverviewView';
import { Panel, PanelIconButton } from './Panel';
import { usePanelHeight } from './panel-height';
import { usePanelTheme } from '../lib/theme';
import { ServiceUnavailableState } from './MetricStates';
import { PanelToasts } from './PanelToasts';
import { ConnectionDetails } from './ConnectionDetails';
import { connectionIssues } from './connection-issues';
import { collectPeakTransitions, effectivePeakDef, type PeakPeriod } from '../lib/peak-windows';
import {
  dropToast,
  dropToastsTagged,
  pushToast,
  type PanelNotice,
  type PanelToast
} from './panel-toasts';
import type { StatusTone } from '../components/StatusRow';
import { GearIcon, PinIcon, RefreshIcon } from '../components/icons';
import { formatClockTime, latestAttemptFailed, providerView, visibleSyncSummary } from '../lib/metrics';
import { minimalSummaries } from './minimal-summary';
import { MINIMAL_RAIL_DETAIL_WIDTH, MINIMAL_RAIL_WIDTH, minimalPanelHeight } from './minimal-layout';
import { MinimalPanel } from './MinimalPanel';
import { detectDesktopBridge } from '../lib/desktop-client';
import { createProbeHover, probePoint } from './probe-hover';

/**
 * The controls the host probe paints in this document.
 *
 * One list for both shapes, because one painter serves both (see `probe-hover.ts`) and a
 * control that exists in only one shape is simply never hit in the other. The platform
 * rings are deliberately absent: their plate is the *selection's* (`is-active`), which
 * `MinimalPanel` drives from the same pointer.
 */
const PROBE_HOVER_TARGETS = [
  '.minimal-tool',
  '.minimal-alert',
  '.minimal-empty button',
  '.icon-button',
  '.connection-trigger',
  '.gear-button',
  '.quota-shape-button',
  '.quota-reset-toggle'
].join(', ');

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
  onSetMinimalLayout?(width: number, height: number, anchor: boolean): void;
  /** The native detail window owns its own content and frame. */
  onSetMinimalDetail?(selection: ProviderId | 'connection' | null, index: number): void;
}

export interface PanelAppProps {
  client: UsageClient;
  host: PanelHostProps;
  /** Fixed clock for tests and static previews; otherwise the panel ticks. */
  now?: Date;
  tickMs?: number;
  /** Starting settings, when the caller already has a cache of them. */
  initialSettings?: PanelSettings;
  /**
   * Show the settings window on a section. Every settings entry point in the panel
   * ends here: the host opens (or focuses) that window, and in a browser the caller
   * renders the same component as a sheet over this document.
   */
  onOpenSettings(section: SettingsSection): void;
}

export function PanelApp(props: PanelAppProps) {
  const { client, host } = props;
  /**
   * The settings live in a store rather than in this component's state: the host
   * writes them in *another* window too (the settings window), and the store is what
   * makes the broadcast that follows a write announce exactly one change here — the
   * same value arriving twice is not a change.
   */
  const storeRef = useRef<SettingsStore | undefined>(undefined);
  storeRef.current ??= createSettingsStore({
    client,
    initial: props.initialSettings ?? parsePanelSettings({})
  });
  const store = storeRef.current;
  useEffect(() => () => store.dispose(), [store]);
  /**
   * The hover the host's pointer probe paints (see `probe-hover.ts`).
   *
   * One painter for the document, installed here because both shapes are rendered from
   * this component: the rail's actions and the full panel's toolbar, footer and card
   * controls all carry `:hover` rules that a window which is not key never triggers.
   */
  const probeHover = useRef<ReturnType<typeof createProbeHover>>(undefined);
  probeHover.current ??= createProbeHover(PROBE_HOVER_TARGETS);
  useEffect(() => {
    const probe = (event: Event) => {
      const point = probePoint(event);
      if (!point) {
        probeHover.current?.clear();
        return;
      }
      probeHover.current?.at(point.x, point.y);
    };
    window.addEventListener('panel:hover-probe', probe);
    return () => window.removeEventListener('panel:hover-probe', probe);
  }, []);
  const [snapshot, setSnapshot] = useState<PanelSnapshot | undefined>();
  const [settings, setSettings] = useState<PanelSettings>(() => store.read());
  usePanelTheme(settings.theme);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [refreshing, setRefreshing] = useState<Set<ProviderId>>(new Set());
  const [replayKeys, setReplayKeys] = useState<Partial<Record<ProviderId, number>>>({});
  const [toasts, setToasts] = useState<PanelToast[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selectedMinimalProvider, setSelectedMinimalProvider] = useState<ProviderId | null>(null);
  /**
   * How many times a ring has asked for its detail.
   *
   * A counter rather than a value because the rail has to be able to re-ask for the
   * platform it already believes is open: the host clears the card on its own when the
   * pointer leaves both windows, and a dismissal the rail did not hear left it
   * believing the card was up — pointing at that ring again then did nothing at all.
   * Identical state does not re-run the effect below, so the request itself is the
   * signal. Host-side, an unchanged selection is a no-op.
   */
  const [minimalRequest, setMinimalRequest] = useState(0);
  const selectMinimal = useCallback((provider: ProviderId | null) => {
    setDetailsOpen(false);
    setSelectedMinimalProvider(provider);
    setMinimalRequest((current) => current + 1);
  }, []);
  /**
   * The pointer is on the rail but not on a platform.
   *
   * The card is about a platform, so it goes — but the connection view does not: that is
   * a click the reader made on the rail, not a hover, and it stays until they dismiss it.
   * The request counter carries the "nothing to show" answer to the host even when the
   * selection was already empty, which is what makes the card window close rather than sit
   * there for as long as the pointer stays on the rail.
   */
  const leavePlatform = useCallback(() => {
    setSelectedMinimalProvider(null);
    setMinimalRequest((current) => current + 1);
  }, []);
  useEffect(() => {
    const dismiss = (payload: unknown) => {
      setSelectedMinimalProvider((current) => {
        if ((payload as { focus?: boolean } | null)?.focus && current) {
          document.querySelector<HTMLElement>(`.minimal-item[data-provider="${current}"]`)?.focus();
        }
        return null;
      });
      setDetailsOpen(false);
    };
    const pushed = (event: Event) => dismiss((event as CustomEvent).detail);
    window.addEventListener('panel:minimal-detail-dismiss', pushed);
    const unlisten = detectDesktopBridge()?.listen?.('panel://minimal-detail-dismiss', dismiss);
    return () => { window.removeEventListener('panel:minimal-detail-dismiss', pushed); unlisten?.(); };
  }, []);
  /**
   * The rail is a desktop-only shape, and this is what makes it one.
   *
   * The companion web page is *this same document*, served over loopback by the
   * Rust service, so a persisted "极简" would otherwise follow the reader into the
   * browser and put a 58-point rail in the middle of a full-size page — where
   * there is no host window to narrow and no left side to expand into. Reshaping
   * a window is the capability that decides it: only the app's host implements
   * `onSetMinimalLayout` (see `createBrowserFallbackHost`), so without it the page
   * stays on the cards whatever the stored preference says.
   */
  const minimalMode =
    settings.panelDisplayMode === 'minimal' && props.host.onSetMinimalLayout !== undefined;
  useEffect(() => {
    if (!minimalMode) setSelectedMinimalProvider(null);
  }, [minimalMode]);
  useEffect(() => {
    const close = () => { setSelectedMinimalProvider(null); setDetailsOpen(false); };
    window.addEventListener('panel:reopened', close);
    return () => window.removeEventListener('panel:reopened', close);
  }, []);
  const [clock, setClock] = useState<Date>(() => props.now ?? new Date());

  /** Ids for the message stack; a ref because an id is not part of the view. */
  const toastId = useRef(1);
  // Latest settings for event handlers that must not close over a stale copy
  // (two visibility toggles in quick succession, for instance). Kept in step with
  // the store rather than assigned during render: the store is the truth, and a
  // render-time assignment would make the ref lag by exactly one write.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /** Adopt whatever the store reports, wherever the change came from. */
  useEffect(() => store.subscribe(setSettings), [store]);

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
      store.adopt(nextSettings);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '本地服务不可用');
    } finally {
      setLoading(false);
    }
  }, [client, store]);

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
        // The store subscribes to the same stream and announces the change; this
        // component adopts it from there, so there is exactly one path in.
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

  // Escape: close the connection detail if it is open, otherwise ask the host to
  // collapse the panel. There is no sub-page to close first any more — the settings
  // surfaces are in their own window, and Escape there closes that window, which is
  // the host's rule for it, not this component's.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (detailsOpen) {
        setDetailsOpen(false);
        return;
      }
      if (selectedMinimalProvider !== null) {
        setSelectedMinimalProvider(null);
        document.querySelector<HTMLElement>(`.minimal-item[data-provider="${selectedMinimalProvider}"]`)?.focus();
        return;
      }
      host.onRequestHide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [host, detailsOpen, selectedMinimalProvider]);

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
   * the meantime, or the panel may still be showing the loading state (where
   * `settings` are still the defaults, so being "visible" there does not mean a card
   * exists). A message about a card that is not on screen is noise.
   *
   * The settings window is not part of this judgement any more: a card that is on
   * screen stays on screen when the settings window opens beside it, so a verdict
   * about it is still worth saying.
   *
   * Written to a ref as well because `refresh` reads it from the closure it was
   * created in, which is the same reason `settingsRef` exists.
   */
  const cardsOnScreen = useMemo(() => {
    if ((loading && !snapshot) || (loadError && !snapshot)) return NO_PROVIDERS;
    return new Set(displayed);
  }, [loading, loadError, snapshot, displayed]);
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
      try {
        await store.write(patch);
        // No re-collection here, and no message to clear. The "which writes change
        // what is collected" judgement moved to the host (`providers_to_recollect`
        // in lib.rs), because the cards that have to answer for such a write are in
        // *this* window while the write itself may be made in the settings one — a
        // rule kept per window would be right in one and quietly missing in the
        // other. The host collects and pushes the snapshot; the store has already
        // announced the new settings, so the cards re-render the moment it lands.
        //
        // A message is not swept away either: it reports the moment it describes and
        // leaves on its own clock, so a successful save does not swallow a refresh
        // verdict.
      } catch (error) {
        announce({ tone: 'danger', text: describeError(error, '设置保存失败') });
      }
    },
    [store, describeError, announce]
  );

  // The panel owns the window height, and it has one page: the overview. The
  // settings surfaces used to be pages that *inherited* this height and scrolled
  // inside it; they are their own window now, with a fixed height of their own, so
  // the panel's height is only ever the overview's business (see panel-height.ts).
  usePanelHeight({
    onSetHeight: props.host.onSetHeight,
    enabled: !minimalMode
  });

  const syncSummary = visibleSyncSummary(displayed.map((provider) => providerView(snapshot, provider)));
  const issues = useMemo(() => connectionIssues(snapshot, settings), [snapshot, settings]);
  useEffect(() => {
    if (issues.length === 0 && minimalMode) setDetailsOpen(false);
  }, [issues.length, minimalMode]);
  // Deliberately no `blur` handler. A focus change is not a dismissal: pointing at a
  // ring is what opens the card and leaving the panel is what closes it, so closing
  // on blur made the card vanish whenever the window lost focus and come straight back
  // when it was clicked again — a disappear-and-reappear with no input behind it. The
  // card is closed by leaving the panel, by Escape, by a tap outside, and by the
  // `panel:reopened` handler below when the host shows a fresh panel.
  const minimal = useMemo(() => minimalSummaries(snapshot, settings, clock), [snapshot, settings, clock]);
  /**
   * The in-document fallback card's measured height.
   *
   * `MinimalPanel` measures the card and hands it over; the window is then sized to
   * hold it. The comparison guard matters more than it looks: a fresh number every
   * render would re-run the layout effect below forever.
   */
  const [detailHeight, setDetailHeight] = useState<number | null>(null);
  const onDetailHeight = useCallback((height: number | null) => {
    setDetailHeight((current) => (current === height ? current : height));
  }, []);
  /**
   * Whether a card is on screen, including the tail of its exit fade.
   *
   * The fallback window must stay wide until the card has finished fading, so this is the
   * *rendered* fact rather than the measured height: the measurement is absent until
   * the card has been laid out, and a clipped frame reports zero.
   */
  const [detailPresent, setDetailPresent] = useState(false);
  const onDetailPresence = useCallback((present: boolean) => {
    setDetailPresent((current) => (current === present ? current : present));
  }, []);
  /**
   * Whether the fallback window needs the detail's space right now.
   *
   * `detailPresent` is the term that outlives the selection. Closing the detail does
   * not unmount the card: it fades out for `DETAIL_FADE_MS`, and narrowing the window
   * the instant the selection cleared would clip the very fade the reader is watching —
   * the fixed-width card sits to the left of the rail, so a rail-width window shows
   * none of it. `MinimalPanel` clears the flag when the card unmounts, which is what
   * makes the one-frame step to the rail happen after the fade rather than under it.
   */
  const expanded = selectedMinimalProvider !== null || detailsOpen || detailPresent;
  useEffect(() => {
    if (!props.host.onSetMinimalDetail) return;
    const selection = minimalMode ? (detailsOpen ? 'connection' : selectedMinimalProvider) : null;
    const index = selection && selection !== 'connection'
      ? Math.max(0, minimal.findIndex((entry) => entry.provider === selection))
      : 0;
    props.host.onSetMinimalDetail(selection, index);
    // `minimalRequest` is a dependency on purpose: it is what lets a second hover of
    // the same ring reach the host, which is how a card the host closed behind the
    // rail's back comes back.
  }, [props.host, minimalMode, detailsOpen, selectedMinimalProvider, minimal, minimalRequest]);
  const wasMinimal = useRef(false);
  useEffect(() => {
    if (!minimalMode) {
      // The next switch into minimal mode anchors again, as a fresh shape should.
      wasMinimal.current = false;
      return;
    }
    props.host.onSetMinimalLayout?.(
      props.host.onSetMinimalDetail ? MINIMAL_RAIL_WIDTH : expanded ? MINIMAL_RAIL_DETAIL_WIDTH : MINIMAL_RAIL_WIDTH,
      minimalPanelHeight(
        minimal.length,
        props.host.onSetMinimalDetail ? null : expanded ? detailHeight : null,
        props.host.headerVisible !== false,
        // The connection badge is rail furniture, so the window has to hold it too —
        // and it is on screen whether or not the pointer is.
        issues.length > 0
      ),
      !wasMinimal.current
    );
    wasMinimal.current = true;
  }, [minimalMode, expanded, detailHeight, minimal.length, props.host, issues.length]);
  useEffect(() => {
    if (selectedMinimalProvider && !minimal.some((entry) => entry.provider === selectedMinimalProvider)) setSelectedMinimalProvider(null);
  }, [minimal, selectedMinimalProvider]);
  // The bottom status module is frame furniture: it neither scrolls with the body
  // nor changes with the page (there is only one). A missing sync time is reported
  // as missing, never as a zero or a time.
  /**
   * The card hooks both surfaces need.
   *
   * The minimal rail renders the very same platform cards in its detail, so a ring
   * tapped there flips the same setting a ring tapped in the overview does. Sharing
   * the handlers (rather than re-deriving them per surface) is what keeps the two
   * presentations of one card from drifting apart.
   */
  const openAppSettings = useCallback(() => props.onOpenSettings('platforms'), [props]);
  const toggleResetTimeFormat = useCallback(
    (provider: ProviderId) => {
      void updateSettings(
        provider === 'codex'
          ? { codexResetFormat: settings.codexResetFormat === 'countdown' ? 'absolute' : 'countdown' }
          : { glmResetFormat: settings.glmResetFormat === 'countdown' ? 'absolute' : 'countdown' }
      );
    },
    [settings.codexResetFormat, settings.glmResetFormat, updateSettings]
  );
  const toggleQuotaDisplay = useCallback(
    (provider: ProviderId) => {
      void updateSettings(
        provider === 'codex'
          ? { codexQuotaDisplay: settings.codexQuotaDisplay === 'ring' ? 'bar' : 'ring' }
          : { glmQuotaDisplay: settings.glmQuotaDisplay === 'ring' ? 'bar' : 'ring' }
      );
    },
    [settings.codexQuotaDisplay, settings.glmQuotaDisplay, updateSettings]
  );

  const syncText = loading && !snapshot
    ? '正在读取本地缓存'
    : syncSummary.state === 'none'
      ? '未展示平台'
      : syncSummary.state === 'partial'
        ? '部分平台尚未同步'
        : `全部同步于 ${formatClockTime(syncSummary.oldestSuccessAt, settings.timezone) ?? '时间未知'}`;

  if (minimalMode) {
    return (
      <MinimalPanel
        summaries={minimal}
        snapshot={snapshot}
        settings={settings}
        now={clock}
        selected={selectedMinimalProvider}
        onSelect={selectMinimal}
        onLeavePlatform={leavePlatform}
        onOpenSettings={props.onOpenSettings}
        onRefresh={refreshDisplayed}
        refreshing={refreshingAll}
        pinned={host.pinned}
        focused={host.headerVisible !== false}
        onTogglePin={host.onTogglePin}
        issues={issues}
        connectionOpen={detailsOpen}
        externalDetail={props.host.onSetMinimalDetail !== undefined}
        onToggleConnection={() => { setSelectedMinimalProvider(null); setDetailsOpen((current) => !current); }}
        onDetailHeight={onDetailHeight}
        onDetailPresence={onDetailPresence}
        onToggleResetTimeFormat={toggleResetTimeFormat}
        onToggleQuotaDisplay={toggleQuotaDisplay}
        onOpenAppSettings={openAppSettings}
      />
    );
  }

  return (
    <Panel
      title="用量总览"
      headerVisible={props.host.headerVisible}
      footer={
        <>
          <span className="panel-footer-sync">
            <span className={`panel-footer-dot${syncSummary.state === 'complete' ? ' is-live' : ''}`} aria-hidden="true" />
            <span>{syncText}</span>
          </span>
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
            busy={refreshingAll}
            onClick={refreshDisplayed}
          >
            <RefreshIcon />
          </PanelIconButton>
          <PanelIconButton label="设置" onClick={() => props.onOpenSettings('appearance')}>
            <GearIcon />
          </PanelIconButton>
          <PanelIconButton label={host.pinned ? '取消置顶' : '置顶面板'} pressed={host.pinned} active={host.pinned} onClick={host.onTogglePin}>
            <PinIcon />
          </PanelIconButton>
        </>
      }
      toasts={<PanelToasts toasts={toasts} onDone={removeToast} />}
    >
      {loadError && !snapshot ? (
        <ServiceUnavailableState message={loadError} onRetry={() => void load()} />
      ) : (
        <OverviewView
          snapshot={snapshot}
          settings={settings}
          replayKeys={replayKeys}
          now={clock}
          loading={loading}
          onOpenSettings={(provider) => props.onOpenSettings(provider)}
          onOpenAppSettings={openAppSettings}
          onToggleResetTimeFormat={toggleResetTimeFormat}
          onToggleQuotaDisplay={toggleQuotaDisplay}
        />
      )}
    </Panel>
  );
}

export type { StatusTone };

/**
 * The minimal rail: one column of platform rings, with a detail card that follows
 * the pointer.
 *
 * ## Why hover, and why the detail is anchored
 *
 * The rail exists to be read at a glance, so pointing at a platform is the whole
 * gesture — there is nothing to commit to and no mode to leave. The detail is
 * therefore not a dialog the reader opens and closes; it is a card that appears
 * beside the ring the pointer is on, with a caret pointing back at it, and leaves
 * when the pointer does. "The pointer" is the pointer *on that platform*: it may travel
 * from the ring into the card it opened (that is the same platform's surface), but the
 * rail's own furniture — the action column, the connection badge, the bands between
 * platforms — is not, and the card goes once the pointer settles there. `Escape` and a tap
 * outside close it for the keyboard and for touch, which have no hover to leave.
 *
 * ## Why the card keeps a fixed width
 *
 * The native card lives in its own window. Its fixed width keeps text wrapping
 * stable while its natural height is measured. The old in-document rendering is
 * retained for the panel harness; it is omitted when `externalDetail` is true.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ProviderId } from '../../shared/contracts';
import { providerDisplayName, type PanelSettings, type PanelSnapshot } from '../../shared/desktop-contract';
import { formatMoney } from '../lib/metrics';
import { effectivePeakDef, peakStateAt } from '../lib/peak-windows';
import { GearIcon, PinIcon, RefreshIcon } from '../components/icons';
import { MetricRow } from './MetricRow';
import { probePoint } from './probe-hover';
import { CardSection } from './CardSection';
import { ProviderCardView } from './ProviderCardView';
import type { ConnectionIssue } from './connection-issues';
import { issueHeading } from './connection-issues';
import type { MinimalSummary } from './minimal-summary';
import {
  MINIMAL_DETAIL_BORDER,
  minimalDetailPlacement,
  minimalPanelHeight
} from './minimal-layout';
import { BRAND_MARKS, brandMaskStyle } from '../components/BrandMark';

/** The ring's circumference at r=17, so a percentage can be written as a dash. */
const RING_LENGTH = 106.8;

/** Must match `.minimal-detail`'s transition duration in `panel.css`. */
const DETAIL_FADE_MS = 170;

/**
 * How often a pointer moving *inside* one ring may re-ask the host for its detail.
 *
 * The request has to be repeatable (see `openFrom`), and a pointer that merely moves
 * within a ring is not news — without this every mouse move would be an IPC call.
 */
const HOVER_REPEAT_MS = 250;

/**
 * How long the pointer may sit on the rail without being on a platform before its card
 * goes.
 *
 * The card is about a platform, so once the pointer is on the rail's *furniture* — the
 * action column, the connection badge, the bands they sit in — there is nothing for it to
 * be about. Closing it on the first such sample would blink it on the way from one ring to
 * the next: those rings are four points apart and the host samples the pointer every
 * 150 ms, so the delay is what tells "passing over" from "stopped there". The host's own
 * rule only covers the pointer leaving the panel entirely, and the card is a window of its
 * own, so without this it stays for as long as the reader stays on the rail.
 */
const OFF_PLATFORM_MS = 200;

/**
 * How often the host's pointer probe may re-ask for the ring it reports.
 *
 * Slower than a real pointer move: the probe is the repair for a webview that sees no
 * pointer events at all, and a repair that lands within a second is a repair. A reader
 * who is moving the mouse is served by the pointer handlers themselves.
 */
const HOVER_PROBE_MS = 1_000;

/**
 * The value under the ring.
 *
 * Only the reading itself is drawn: the window short name (`5h`), the balance caption
 * and the stale/warning words would all have to share a 58-point column with the
 * number, and the reader who wants them has the accessible name and the detail. The
 * prototype's second text line was the first thing to go when the rail got this narrow.
 */
function summaryText(summary: MinimalSummary): string {
  if (summary.kind === 'missing') return '—';
  if (summary.kind === 'quota') return `${Math.round(summary.value)}%`;
  if (summary.kind === 'multi-currency') return '多币种';
  // Above a hundred the cents are what pushes the reading out of the column: `¥1234.56`
  // is nine figures where `¥1235` is five. The sign counts too — a negative balance is
  // wider still — so the test is on the magnitude. The detail card keeps the full
  // figure: it is 330 points wide and is where the reader goes for the exact amount.
  return formatMoney(summary.value, summary.currency, Math.abs(summary.value) > 100 ? 0 : 2);
}

/** Short markers only: a 56-point column will not hold the cards' full phrasing. */
function summaryState(summary: MinimalSummary): string {
  if (summary.kind === 'missing') return '无数据';
  return [
    summary.stale ? '已过期' : '',
    summary.warning ? (summary.kind === 'quota' ? '低额度' : '低余额') : ''
  ].filter(Boolean).join(' ');
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

export interface MinimalPanelProps {
  /** Native app uses a separate webview for the card. */
  externalDetail?: boolean;
  summaries: MinimalSummary[];
  snapshot?: PanelSnapshot;
  settings: PanelSettings;
  now: Date;
  /** Which platform's detail is wanted, or `null`. Owned by `PanelApp`. */
  selected: ProviderId | null;
  onSelect(provider: ProviderId | null): void;
  onOpenSettings(provider: ProviderId | 'appearance' | 'platforms'): void;
  onRefresh(): void;
  refreshing: boolean;
  pinned: boolean;
  focused: boolean;
  onTogglePin(): void;
  issues: ConnectionIssue[];
  connectionOpen: boolean;
  onToggleConnection(): void;
  /**
   * The pointer is on the rail but not on any platform: nothing for a platform card to be
   * about. Separate from `onSelect(null)` because the connection view is a *click* the
   * reader made, not a hover: it stays while the pointer is on the rail.
   */
  onLeavePlatform(): void;
  /** The card's own hooks, passed straight through to the reused card. */
  onToggleResetTimeFormat(provider: ProviderId): void;
  onToggleQuotaDisplay(provider: ProviderId): void;
  onOpenAppSettings(): void;
  /** The measured height of the open card, so `PanelApp` can size the window. */
  onDetailHeight(height: number | null): void;
  /**
   * Whether a detail is on screen *or still fading out*.
   *
   * Separate from the measured height on purpose: the window has to stay wide for the
   * whole exit fade, and a measurement cannot carry that — it is absent until the card
   * has been laid out, and jsdom (or a clipped frame) reports zero. This is the plain
   * fact that a card is rendered, reported while it still is.
   */
  onDetailPresence(present: boolean): void;
}

export function MinimalPanel(props: MinimalPanelProps) {
  const { selected, onSelect, connectionOpen } = props;
  const wanted = selected !== null || connectionOpen;

  /**
   * What is painted, and whether the card is still on its way out.
   *
   * The platform is rendered in the *same* pass as the selection, never through a
   * second state write: a card that mounted empty for one render and filled in on
   * the next was measured twice, and the window resized for both — which is what
   * made pointing at a ring look like a bounce. `exiting` only delays hiding the
   * already-mounted content, so the exit can be a fade.
   */
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [placement, setPlacement] = useState<{ top: number; caret: number } | null>(null);
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  /** True while the pointer is inside the card: a platform must not steal it back. */
  const insideCard = useRef(false);
  /** When the last hover request went out, so a moving pointer cannot spam the host. */
  const lastRequest = useRef(0);
  /** True while real pointer events say the pointer is on the rail. */
  const pointerOnRail = useRef(false);
  /** The pending "the pointer is on the rail, but not on a platform" close. */
  const offPlatform = useRef(0);
  /**
   * The platform whose card the reader closed with the pointer still on its ring.
   *
   * `Escape` closes the card the reader is pointing at, and the host's probe asks again
   * on its own clock with no movement of the reader's: without this the card came back a
   * second after they closed it. Only that platform is remembered — pointing at another
   * ring is a new request — and a real pointer event forgets it, which is why the same
   * dismissal has always reopened on `pointermove` (and still does).
   */
  const closedUnderPointer = useRef<ProviderId | 'connection' | null>(null);
  const card = useRef<HTMLElement | null>(null);
  const lastHeight = useRef<number | null>(null);
  /**
   * What the card was last about, kept only so the exit can be a fade.
   *
   * A union rather than a provider, because the connection view is a card too: after
   * it closed, a remembered platform would flash back for the length of the fade.
   */
  const lastShown = useRef<ProviderId | 'connection' | null>(null);
  const live = connectionOpen ? ('connection' as const) : selected;
  if (live !== null) lastShown.current = live;

  useEffect(() => {
    if (wanted) {
      setExiting(false);
      // Two frames: the card has to be painted at opacity 0 before it can fade in,
      // or the browser collapses the transition into the mount and it appears flat.
      let inner = 0;
      const outer = window.requestAnimationFrame(() => {
        inner = window.requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        window.cancelAnimationFrame(outer);
        window.cancelAnimationFrame(inner);
      };
    }
    setVisible(false);
    const timer = window.setTimeout(
      () => setExiting(true),
      prefersReducedMotion() ? 0 : DETAIL_FADE_MS
    );
    return () => window.clearTimeout(timer);
  }, [wanted, selected]);

  const shown = live ?? (exiting ? null : lastShown.current);
  const showConnection = shown === 'connection';
  const provider = shown !== null && shown !== 'connection' ? shown : null;
  const hasCard = shown !== null;

  /**
   * Measure the card, then place it against the item it belongs to.
   *
   * Read the fixed-width content's natural height, including scroll padding. A
   * narrow WebKit window can temporarily report a clipped scrollHeight while the
   * host is opening; the content box provides the full height in that frame.
   */
  const reportHeight = useCallback(() => {
    const element = card.current?.querySelector<HTMLElement>('.minimal-detail-scroll.is-current');
    const body = element?.querySelector<HTMLElement>('.minimal-detail-content');
    if (!element || !body) return;
    // WebKit can report the clipped scroller's height while its native window is
    // only rail-wide. The fixed-width content itself has the complete height.
    const styles = getComputedStyle(element);
    const padding = (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);
    const height = Math.max(element.scrollHeight, body.offsetHeight + padding) + MINIMAL_DETAIL_BORDER * 2;
    if (height <= MINIMAL_DETAIL_BORDER * 2) return;
    if (lastHeight.current === height) return;
    lastHeight.current = height;
    setCardHeight(height);
    props.onDetailHeight(height);
  }, [props.onDetailHeight]);

  useLayoutEffect(() => {
    // Before the height: presence is what keeps the window wide through the exit fade,
    // and it must not wait on a measurement that may never arrive.
    props.onDetailPresence(!props.externalDetail && hasCard);
    const element = card.current?.querySelector('.minimal-detail-scroll.is-current');
    if (props.externalDetail || !hasCard || !element) {
      lastHeight.current = null;
      setCardHeight(null);
      props.onDetailHeight(null);
      setPlacement(null);
      return;
    }
    reportHeight();
    const height = lastHeight.current ?? 0;
    const index = provider === null ? 0 : Math.max(0, props.summaries.findIndex((entry) => entry.provider === provider));
    /**
     * Placed from the card and the platforms alone — never from the rail's furniture.
     *
     * The clamp is what the card is slid back inside, and it must not include the
     * action column or the connection badge: both change while a card is open (the
     * actions unroll the moment the host reports the pointer, the badge appears with a
     * failing connection), and a clamp that followed them moved the card under the
     * reader's pointer — the jump seen on entering and on leaving the panel. Placing
     * against the shorter, furniture-free window is also always safe: it can only clamp
     * the card *higher*, and the window the host is asked for is never shorter.
     */
    const next = minimalDetailPlacement(
      index,
      height,
      minimalPanelHeight(props.summaries.length, height)
    );
    setPlacement((current) =>
      current !== null && current.top === next.top && current.caret === next.caret ? current : next
    );
  });

  /**
   * Re-fit the window whenever the card's content really changes.
   *
   * A single measurement at mount is not enough: the card is made of components that
   * can settle a frame later (a section appearing, a label wrapping once its font
   * arrives), and the window would stay the size of the *first* reading — which shows
   * up as a card clipped at the bottom edge, exactly where the action row is. The
   * observer watches the content, whose height is its natural height and not the
   * scroller's clamped box, so a window resize cannot make it fire and chase itself.
   */
  useEffect(() => {
    const element = card.current?.querySelector<HTMLElement>('.minimal-detail-scroll.is-current .minimal-detail-content');
    if (!hasCard || !element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => reportHeight());
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasCard, provider, showConnection, reportHeight]);

  /**
   * A ring's own gesture: point at it and its card arrives.
   *
   * `source` says what asked. An entrance is a discrete event — the reader put the
   * pointer on a ring — and it always goes out, which is what brings a card back after
   * the host closed it behind the rail's back. A pointer that merely *moves* within one
   * ring, and the host's probe, are repeats: news at most once per budget.
   */
  function openFrom(provider: ProviderId, source: 'enter' | 'move' | 'probe'): void {
    // A platform is under the pointer: whatever was pending has been answered.
    if (offPlatform.current) window.clearTimeout(offPlatform.current);
    offPlatform.current = 0;
    if (insideCard.current) return;
    if (source === 'probe' && closedUnderPointer.current === provider) return;
    const at = window.performance.now();
    if (selected === provider && source !== 'enter') {
      const budget = source === 'probe' ? HOVER_PROBE_MS : HOVER_REPEAT_MS;
      if (at - lastRequest.current < budget) return;
    }
    lastRequest.current = at;
    onSelect(provider);
  }

  /**
   * The pointer is on the rail, but not on a platform.
   *
   * Delayed, so crossing the gap between two rings does not blink the card (see
   * `OFF_PLATFORM_MS`); cancelled the moment a platform is under the pointer again.
   *
   * A ring that holds the *keyboard's* focus is still "the platform this card is about",
   * wherever the pointer happens to rest: a reader who reached the rail with the keyboard
   * has their pointer wherever it was, and the card they asked for must not be taken away
   * by it.
   */
  function offPlatformSoon(): void {
    if (offPlatform.current) return;
    offPlatform.current = window.setTimeout(() => {
      offPlatform.current = 0;
      if (document.activeElement?.closest('.minimal-item')) return;
      props.onLeavePlatform();
    }, OFF_PLATFORM_MS);
  }

  /** What the pointer is on, from either input: a real event's target, or a probe point. */
  function notePointerOn(under: Element | null | undefined): void {
    const provider = under?.closest<HTMLElement>('.minimal-item')?.dataset.provider as
      | ProviderId
      | undefined;
    if (provider) {
      openFrom(provider, 'probe');
      return;
    }
    // The card is part of the platform's own surface — travelling into it is not leaving
    // the platform — so a point on it answers the same question a ring does.
    if (under?.closest('.minimal-detail')) return;
    if (selected !== null) offPlatformSoon();
  }

  /**
   * The host's pointer probe: which ring is under the pointer.
   *
   * A webview only receives pointer events while its window is key, and the rail's is
   * often not — the reader is working in another app, the settings window holds key, or
   * the panel was pinned and left standing. The host samples the pointer anyway (it
   * needs it for the header), so it forwards the position and this answers the question
   * a real `pointerenter` would: which ring is under it. The selection keeps one owner;
   * the host only supplies the fact the webview cannot get for itself. The same event
   * also paints the controls' hover — `PanelApp` does that, once for both panel shapes.
   */
  const probeRef = useRef(notePointerOn);
  probeRef.current = notePointerOn;

  useEffect(() => {
    const probe = (event: Event) => {
      const point = probePoint(event);
      if (!point) return;
      probeRef.current(document.elementFromPoint(point.x, point.y));
    };
    window.addEventListener('panel:hover-probe', probe);
    return () => window.removeEventListener('panel:hover-probe', probe);
  }, []);

  useEffect(() => {
    if (selected === null) return undefined;
    // The cleanup runs on the way *out* of this selection, so what it records is exactly
    // "this card went away while the pointer was on the rail" — whichever route closed it.
    return () => {
      if (pointerOnRail.current) closedUnderPointer.current = selected;
    };
  }, [selected]);

  const placementStyle = {
    ...(placement ? { top: `${placement.top}px`, '--caret': `${placement.caret}px` } : {}),
    ...(cardHeight !== null ? { height: `${cardHeight}px` } : {})
  } as CSSProperties;

  return (
    <div
      className={`minimal-panel${hasCard ? ' is-expanded' : ''}${props.focused ? ' is-focused' : ''}`}
      data-panel-surface="true"
      data-testid="minimal-panel"
      // Leaving the whole surface closes the card: travelling from a ring into the
      // card itself must not count as leaving, so only the outer box is watched.
      onPointerEnter={(event) => {
        pointerOnRail.current = true;
        closedUnderPointer.current = null;
        notePointerOn(event.target as Element);
      }}
      onPointerMove={(event) => {
        pointerOnRail.current = true;
        closedUnderPointer.current = null;
        notePointerOn(event.target as Element);
      }}
      onPointerLeave={() => {
        pointerOnRail.current = false;
        insideCard.current = false;
        // Leaving the panel is the host's rule, not this one: it waits out the pointer
        // crossing the gap to the card beside the rail.
        if (offPlatform.current) window.clearTimeout(offPlatform.current);
        offPlatform.current = 0;
        if (!props.externalDetail) onSelect(null);
      }}
      onPointerDown={(event) => {
        // Touch and pen have no hover to leave, so a tap outside is their close.
        if (selected !== null && !(event.target as Element).closest('.minimal-detail, .minimal-item')) {
          onSelect(null);
        }
      }}
    >
      {/* Keep detail content mounted between selections; the frame is inert when
          closed. This does not prevent the native width-change blink. */}
      {!props.externalDetail && <section
        className={`minimal-detail${visible ? ' is-visible' : ''}`}
        // The id only exists while a card does: a ring's `aria-controls` may point at a
        // frame that is standing empty, which is exactly what "no detail is shown" is.
        id={hasCard ? (showConnection ? 'minimal-connection-details' : `minimal-detail-${provider}`) : undefined}
        role="dialog"
        aria-hidden={!hasCard}
        aria-label={showConnection || provider === null ? '连接状态' : `${providerDisplayName(provider)} 详情`}
        // `inert` keeps the empty frame out of the tab order and off the pointer; the
        // transparent frame is `pointer-events: none` in the sheet as well, because the
        // pointer must reach whatever is under it when there is no card.
        inert={!hasCard}
        data-testid="minimal-detail"
        ref={card}
        style={placementStyle}
        onPointerEnter={() => { insideCard.current = true; }}
        onPointerLeave={() => { insideCard.current = false; }}
      >
        <div
          className={`minimal-detail-scroll${showConnection ? ' is-current' : ''}`}
          aria-hidden={!showConnection}
          inert={!showConnection}
        >
          <div className="minimal-detail-content">
            {/* Not a platform card, so it carries the card's own inset (see
                `.minimal-detail-connection`): the detail frame pads nothing. */}
            <div className="minimal-detail-connection">
              <header className="provider-head minimal-detail-head">
                <h2 className="provider-name">连接状态</h2>
              </header>
              <ConnectionCard issues={props.issues} />
            </div>
          </div>
        </div>
        {props.summaries.map((summary) => (
          <div
            key={summary.provider}
            className={`minimal-detail-scroll${provider === summary.provider ? ' is-current' : ''}`}
            aria-hidden={provider !== summary.provider}
            inert={provider !== summary.provider}
          >
            <div className="minimal-detail-content">
              <ProviderCardView
                provider={summary.provider}
                snapshot={props.snapshot}
                settings={props.settings}
                now={props.now}
                onOpenSettings={props.onOpenSettings}
                onToggleResetTimeFormat={props.onToggleResetTimeFormat}
                onToggleQuotaDisplay={props.onToggleQuotaDisplay}
              />
            </div>
          </div>
        ))}
      </section>}
      <div
        className="minimal-rail"
        data-testid="minimal-rail"
        // The rail's own padding band is the drag surface. A grip cost a row of its
        // own and pointed at nothing; Tauri walks the event path and a button blocks
        // the drag by itself, so platform taps still land.
        data-tauri-drag-region="deep"
      >
        <div className="minimal-stack">
          {props.summaries.length === 0 ? (
            <div className="minimal-empty">
              <span>暂无平台</span>
              <button type="button" onClick={() => props.onOpenSettings('platforms')}>管理平台</button>
              <button type="button" onClick={() => props.onOpenSettings('appearance')}>设置</button>
            </div>
          ) : props.summaries.map((summary) => {
            const name = providerDisplayName(summary.provider);
            const isQuota = summary.kind === 'quota';
            const state = summaryState(summary);
            const fraction = Math.max(0, Math.min(100, isQuota ? summary.value : 0));
            const peakDef = effectivePeakDef(props.settings, summary.provider);
            const isPeak = peakDef !== undefined && peakStateAt(peakDef, props.now).period === 'peak';
            return (
              <button
                type="button"
                key={summary.provider}
                className={`minimal-item${selected === summary.provider ? ' is-active' : ''}${summary.kind !== 'missing' && summary.warning ? ' is-warning' : ''}${isPeak ? ' is-peak' : ''}`}
                data-provider={summary.provider}
                data-period={isPeak ? 'peak' : undefined}
                aria-label={`${name} 详情，${isQuota ? `${summary.window} ${props.settings.quotaValueMode === 'remaining' ? '剩余' : '已用'}` : '余额'}${summaryText(summary)}${state ? `，${state}` : ''}`}
                aria-expanded={selected === summary.provider}
                aria-controls={props.externalDetail ? undefined : `minimal-detail-${summary.provider}`}
                onPointerEnter={() => openFrom(summary.provider, 'enter')}
                onPointerMove={(event) => { if (event.pointerType !== 'touch') openFrom(summary.provider, 'move'); }}
                // Deliberately not `onFocus`: `PanelApp` restores focus to this ring
                // after Escape, and a focus-driven open would put the card straight
                // back. Keyboard users open it by activating the ring, which is the
                // same `click` a native button fires for Enter and Space.
                onClick={() => onSelect(summary.provider)}
              >
                <span className="minimal-ring">
                  <svg className="minimal-ring-progress" viewBox="0 0 40 40" aria-hidden="true">
                    <circle className="minimal-ring-track" cx="20" cy="20" r="17" />
                    {/* Only a quota has a proportion to draw. A balance keeps the ring's
                        empty track — the frame the other rings share — because any arc
                        here would claim a percentage nothing measures. */}
                    {isQuota ? (
                      <circle
                        className="minimal-ring-arc"
                        cx="20"
                        cy="20"
                        r="17"
                        style={{ strokeDasharray: `${fraction * (RING_LENGTH / 100)} ${RING_LENGTH}` }}
                      />
                    ) : null}
                  </svg>
                  {summary.provider === 'codex' ? (
                    <span className="minimal-brand minimal-brand-original minimal-brand-codex" role="img" aria-label="Codex" style={brandMaskStyle('codex')} />
                  ) : <img className="minimal-brand minimal-brand-original" src={BRAND_MARKS[summary.provider]} alt={name} />}
                  <span className="minimal-brand minimal-brand-peak" aria-hidden="true" style={brandMaskStyle(summary.provider)} />
                </span>
                <span className="minimal-item-value">{summaryText(summary)}</span>
              </button>
            );
          })}
        </div>
        {/*
          * The connection badge. It opens the connection view the same way the full
          * panel's footer trigger does, and it is the only entry to it here — which is
          * why it lives on the rail and not inside the card the reader happens to have
          * open: a failing connection is the panel's business, not a platform's metric.
          */}
        {props.issues.length > 0 ? (
          <button
            type="button"
            className={`minimal-alert${connectionOpen ? ' is-active' : ''}`}
            aria-label={`连接异常 ${props.issues.length}`}
            aria-controls={props.externalDetail ? undefined : 'minimal-connection-details'}
            aria-expanded={connectionOpen}
            onClick={props.onToggleConnection}
          >
            <span className="minimal-alert-dot" aria-hidden="true" />
            <span className="minimal-alert-count">{props.issues.length}</span>
          </button>
        ) : null}
        <div className="minimal-tools" aria-hidden={!props.focused}>
          <button type="button" className="minimal-tool" aria-label={props.refreshing ? '正在刷新' : '刷新全部平台'} disabled={!props.focused || props.refreshing || props.summaries.length === 0} tabIndex={props.focused ? 0 : -1} onClick={props.onRefresh}><RefreshIcon /></button>
          <button type="button" className="minimal-tool" aria-label="设置" disabled={!props.focused} tabIndex={props.focused ? 0 : -1} onClick={() => props.onOpenSettings('appearance')}><GearIcon /></button>
          <button type="button" className={`minimal-tool${props.pinned ? ' is-active' : ''}`} aria-label={props.pinned ? '取消置顶' : '置顶面板'} aria-pressed={props.pinned} disabled={!props.focused} tabIndex={props.focused ? 0 : -1} onClick={props.onTogglePin}><PinIcon /></button>
        </div>
      </div>
    </div>
  );
}

/**
 * The connection's own view, kept out of every platform's card.
 *
 * It replaces the platform card rather than joining it: a failed request is not one
 * of a platform's metrics, and blending the two is exactly what the full panel
 * refuses to do. It borrows the cards' row vocabulary so it still reads as a module.
 */
export function ConnectionCard(props: { issues: ConnectionIssue[] }) {
  return (
    <div className="minimal-detail-body" data-testid="minimal-connection-body">
      <CardSection kind="primary" label="连接状态">
        <div className="card-module">
          {props.issues.map((issue) => (
            <div className="minimal-detail-metric" key={issue.key}>
              <MetricRow label={issueHeading(issue)} value={issue.status} />
              <p className="metric-note">{issue.message}</p>
            </div>
          ))}
        </div>
      </CardSection>
    </div>
  );
}

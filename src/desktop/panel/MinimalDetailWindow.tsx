import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import type { ProviderId } from '../../shared/contracts';
import { parsePanelSettings, providerDisplayName, type PanelSettings, type PanelSnapshot } from '../../shared/desktop-contract';
import type { UsageClient } from '../../shared/usage-client';
import type { DesktopCommandBridge } from '../lib/desktop-client';
import { usePanelTheme } from '../lib/theme';
import { connectionIssues } from './connection-issues';
import { MINIMAL_DETAIL_BORDER } from './minimal-layout';
import { ConnectionCard } from './MinimalPanel';
import { createProbeHover, probePoint } from './probe-hover';
import { ProviderCardView } from './ProviderCardView';

/**
 * The controls the host probe paints in the card.
 *
 * This window can never be key — it is created unfocusable so that showing it cannot
 * take the rail's pointer events (see `build_minimal_detail_window`) — so none of these
 * controls' `:hover` rules can ever fire on their own. The host forwards the pointer
 * instead, and `probe-hover.ts` explains the rest.
 */
const PROBE_HOVER_TARGETS = '.gear-button, .quota-shape-button, .quota-reset-toggle';

type Selection = ProviderId | 'connection' | null;
interface DetailSelection { selection: Selection; index: number }

function validSelection(value: unknown): Selection {
  return value === 'codex' || value === 'glm' || value === 'deepseek' || value === 'connection' ? value : null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

/**
 * How long the reveal waits for the opening read before giving up on it.
 *
 * The read is a local call and lands in a few milliseconds; this is the escape hatch for
 * a service that is slow or gone, because a late theme is a smaller fault than a card
 * that never appears.
 */
const CATCH_UP_GRACE_MS = 150;

/** A separate document shares the service's data, while the rail owns selection. */
export function MinimalDetailWindow(props: { client: UsageClient; bridge: DesktopCommandBridge }) {
  const { client, bridge } = props;
  const [selection, setSelection] = useState<DetailSelection>({ selection: null, index: 0 });
  const [rendered, setRendered] = useState<Selection>(null);
  const [visible, setVisible] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [snapshot, setSnapshot] = useState<PanelSnapshot>();
  const [settings, setSettings] = useState<PanelSettings>(() => parsePanelSettings({}));
  const [now, setNow] = useState(() => new Date());
  const [caret, setCaret] = useState(37);
  const content = useRef<HTMLDivElement>(null);
  /** The document's one probe painter (see `probe-hover.ts`). */
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
  const lastLayout = useRef('');
  const currentHeight = useRef<number | null>(null);
  const heightAnimation = useRef(0);
  const layoutRequest = useRef(0);
  const generation = useRef(-1);
  /** Whether a card is on screen — the fact the re-read below turns on. */
  const open = useRef(false);
  /** Whether this opening has been faded in, so a later answer cannot re-fade it. */
  const revealed = useRef(false);
  const revealFrames = useRef<number[]>([]);
  /** Whether the opening's catch-up read has landed (nothing to wait for before one). */
  const caughtUp = useRef(true);
  const catchUpRun = useRef<Promise<void>>(Promise.resolve());
  usePanelTheme(settings.theme);

  useEffect(() => {
    const follow = (event: Event) => {
      const next = Number((event as CustomEvent).detail);
      if (Number.isFinite(next)) setCaret((current) => current === next ? current : next);
    };
    window.addEventListener('panel:minimal-detail-caret', follow);
    return () => window.removeEventListener('panel:minimal-detail-caret', follow);
  }, []);

  useEffect(() => {
    const adopt = (payload: unknown) => {
      const value = payload as { selection?: unknown; index?: unknown; generation?: unknown } | null;
      const incoming = Number(value?.generation);
      if (!Number.isFinite(incoming) && generation.current >= 0) return;
      if (Number.isFinite(incoming)) {
        if (incoming < generation.current) return;
        generation.current = incoming;
      }
      const next = { selection: validSelection(value?.selection), index: Number(value?.index) || 0 };
      setSelection((current) => current.selection === next.selection && current.index === next.index ? current : next);
    };
    const pushed = (event: Event) => adopt((event as CustomEvent).detail);
    window.addEventListener('panel:minimal-detail-selection', pushed);
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void bridge.invoke('panel_detail_current').then(adopt).catch(() => undefined).finally(() => { pending = false; });
    };
    refresh();
    // Tauri does not deliver events to a hidden child on every WebKit version.
    // Reading host state also recovers a selection made during document load.
    const poll = window.setInterval(refresh, 100);
    return () => { window.clearInterval(poll); window.removeEventListener('panel:minimal-detail-selection', pushed); };
  }, [bridge]);

  /**
   * Read the settings and the snapshot this panel renders from.
   *
   * Called at mount, and again on every opening: the hidden window misses the host's
   * broadcasts (see the effect below), so the values it holds can be an hour old. A
   * failed read leaves what is on screen — an empty card would be a worse answer than a
   * stale one, and the subscription is still there for the next change.
   */
  const readLive = useCallback(async (stillWanted: () => boolean) => {
    try {
      const [nextSnapshot, nextSettings] = await Promise.all([client.readSnapshot(), client.readSettings()]);
      if (!stillWanted()) return;
      setSnapshot(nextSnapshot);
      setSettings(nextSettings);
    } catch {
      // Nothing to report here: the rail owns the connection state.
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    void readLive(() => active);
    const unsubscribe = client.subscribe((event) => {
      if (!active) return;
      if (event.type === 'snapshot') setSnapshot(event.snapshot);
      if (event.type === 'provider' && event.state) {
        setSnapshot((current) => {
          const providers = [...(current?.providers ?? [])];
          const index = providers.findIndex((entry) => entry.provider === event.provider);
          if (index < 0) providers.push(event.state!);
          else providers[index] = event.state!;
          return { ...(current ?? {}), providers };
        });
      }
      if (event.type === 'settings') setSettings(event.settings);
    });
    const ticker = window.setInterval(() => setNow(new Date()), 1_000);
    return () => { active = false; unsubscribe(); window.clearInterval(ticker); };
  }, [client, readLive]);

  /**
   * Catch up on everything this window missed while it was hidden.
   *
   * The selection is recovered by the poll above for the same reason: WebKit drops the
   * broadcasts aimed at a hidden child, so the snapshot stream and `panel://settings`
   * stop arriving and this document only reads them once, at mount. A card opened an
   * hour later therefore showed the theme and the readings of an hour ago — the numbers
   * disagreed with the rail's while the theme ignored a change made in the settings
   * window. The open edge is the moment the reader can see any of it, and it is the
   * only moment that needs a read: while the window is on screen the subscription keeps
   * both current.
   */
  useEffect(() => {
    if (selection.selection === null) {
      open.current = false;
      return;
    }
    if (open.current) return;
    open.current = true;
    let active = true;
    caughtUp.current = false;
    catchUpRun.current = readLive(() => active).then(() => { caughtUp.current = true; });
    return () => { active = false; };
  }, [readLive, selection.selection]);

  /**
   * Bring the card up, but only once the host has really shown its window.
   *
   * The host shows this window while it answers `panel_detail_layout`, so that answer
   * is the first moment the fade can be seen. Revealing two frames after the selection
   * instead — while the window was still hidden — spent the whole transition offscreen
   * and the card then appeared at its final opacity, which is the cut a reader sees as
   * an abrupt pop-in. Two frames *after* the answer are what give the visible window a
   * painted frame at opacity 0 to travel from.
   *
   * The opening read is the other half of "ready": it is what makes the theme current,
   * so the card waits for it too (or for `CATCH_UP_GRACE_MS`, whichever comes first).
   */
  const reveal = useCallback(() => {
    if (revealed.current) return;
    revealed.current = true;
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      if (prefersReducedMotion()) {
        setVisible(true);
        return;
      }
      const outer = window.requestAnimationFrame(() => {
        const inner = window.requestAnimationFrame(() => setVisible(true));
        revealFrames.current = [outer, inner];
      });
      revealFrames.current = [outer];
    };
    // The theme is part of what the opening read carries, so a card revealed before it
    // lands arrives in the *previous* theme and then jumps to the current one — the
    // flicker of the detail panel "switching" right after it appears. The read is what
    // makes the theme current, so the card waits for it.
    if (caughtUp.current) {
      show();
      return;
    }
    const timer = window.setTimeout(show, CATCH_UP_GRACE_MS);
    void catchUpRun.current.then(() => {
      window.clearTimeout(timer);
      show();
    });
  }, []);

  useLayoutEffect(() => {
    if (selection.selection === null) {
      if (heightAnimation.current) window.cancelAnimationFrame(heightAnimation.current);
      heightAnimation.current = 0;
      currentHeight.current = null;
      lastLayout.current = '';
      revealed.current = false;
      setClipped(false);
      setVisible(false);
      const timer = window.setTimeout(() => setRendered(null), prefersReducedMotion() ? 0 : 170);
      return () => window.clearTimeout(timer);
    }
    // A switch between platforms while the window stands is a cross-fade of the
    // content (`.minimal-detail-scroll`), not a second appearance of the card: flipping
    // this frame's own opacity here made every hover blink the whole card.
    setRendered(selection.selection);
    setClipped(false);
  }, [selection.selection]);

  const reportLayout = useCallback(() => {
    if (selection.selection === null || rendered !== selection.selection || !content.current) return;
    // The card's own 10-point padding is inside this box; only the detail's border is
    // added here, because the box below carries no padding of its own.
    const height = Math.ceil(content.current.getBoundingClientRect().height + MINIMAL_DETAIL_BORDER * 2);
    if (height <= MINIMAL_DETAIL_BORDER * 2) return;
    const key = `${selection.selection}:${selection.index}:${height}`;
    if (lastLayout.current === key) return;
    lastLayout.current = key;
    if (heightAnimation.current) window.cancelAnimationFrame(heightAnimation.current);
    const send = (value: number) => {
      currentHeight.current = value;
      const request = ++layoutRequest.current;
      void bridge.invoke<{ caret: number; height: number }>('panel_detail_layout', { height: value }).then((frame) => {
        if (!frame) return;
        // The window is on screen by the time this answer exists — the host shows it
        // while it answers. Checked before the supersede guard below: an answer that a
        // later frame replaced still proves the window is up, and the card waits for an
        // answer that is not coming if that last frame's own call failed.
        reveal();
        if (request !== layoutRequest.current) return;
        setCaret(frame.caret);
        currentHeight.current = frame.height;
        setClipped(frame.height + 0.5 < value);
      });
    };
    const from = currentHeight.current;
    if (from === null || Math.abs(from - height) < 1 || prefersReducedMotion()) {
      send(height);
      return;
    }
    const started = window.performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / 220);
      send(from + (height - from) * (1 - (1 - progress) ** 3));
      heightAnimation.current = progress === 1 ? 0 : window.requestAnimationFrame(step);
    };
    heightAnimation.current = window.requestAnimationFrame(step);
  }, [bridge, selection, rendered, reveal]);

  useEffect(() => () => {
    if (heightAnimation.current) window.cancelAnimationFrame(heightAnimation.current);
    for (const frame of revealFrames.current) window.cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => { reportLayout(); });
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportLayout);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [reportLayout, rendered]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selection.selection !== null) {
        event.preventDefault();
        void bridge.invoke('panel_detail_dismiss', { focus: true });
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [bridge, selection.selection]);

  const update = (patch: Parameters<UsageClient['updateSettings']>[0]) => {
    void client.updateSettings(patch).then(setSettings).catch(() => undefined);
  };
  const openSettings = (provider: ProviderId) => {
    void bridge.invoke('panel_open_settings', { section: provider });
  };
  const issues = connectionIssues(snapshot, settings);
  const label = rendered === 'connection' ? '连接状态' : rendered ? `${providerDisplayName(rendered)} 详情` : '用量详情';
  const style = { '--caret': `${caret}px` } as CSSProperties;

  return (
    <div className={`minimal-detail-window${clipped ? ' is-clipped' : ''}`}>
      <section className={`minimal-detail${visible ? ' is-visible' : ''}`} role="dialog" aria-label={label} aria-hidden={rendered === null} style={style}>
        <div className="minimal-detail-scroll is-current">
          <div className="minimal-detail-content" ref={content}>
            {rendered === 'connection' ? (
              // The connection view is not a platform card, so it carries the card's own
              // ten-point inset (`.minimal-detail-connection`): the detail container pads
              // nothing, and rows without it sat flush against the frame.
              <div className="minimal-detail-connection">
                <header className="provider-head minimal-detail-head"><h2 className="provider-name">连接状态</h2></header>
                <ConnectionCard issues={issues} />
              </div>
            ) : rendered ? (
              <ProviderCardView
                provider={rendered}
                snapshot={snapshot}
                settings={settings}
                now={now}
                onOpenSettings={openSettings}
                onToggleResetTimeFormat={(provider) => update(provider === 'codex'
                  ? { codexResetFormat: settings.codexResetFormat === 'countdown' ? 'absolute' : 'countdown' }
                  : { glmResetFormat: settings.glmResetFormat === 'countdown' ? 'absolute' : 'countdown' })}
                onToggleQuotaDisplay={(provider) => update(provider === 'codex'
                  ? { codexQuotaDisplay: settings.codexQuotaDisplay === 'ring' ? 'bar' : 'ring' }
                  : { glmQuotaDisplay: settings.glmQuotaDisplay === 'ring' ? 'bar' : 'ring' })}
              />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

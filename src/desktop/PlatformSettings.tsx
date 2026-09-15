/**
 * Platform management, as the first section of the settings page.
 *
 * Only visibility and display order live here — no credential forms, so a hide
 * can never be mistaken for a disconnect. Hiding persists through
 * `updateSettings`, keeps the connection and keeps collection running; turning
 * every platform off leaves the overview with an explanation and a way back.
 *
 * ## Why pointer events instead of HTML5 drag-and-drop
 *
 * The HTML5 `draggable` API is asynchronous and throttled by the webview: the
 * dragged element lags the cursor and each `dragover` costs a frame, which reads
 * as stutter. This section therefore drives the reorder from raw pointer events
 * (`pointerdown` on the grip, `pointermove` while captured) with three rules
 * that keep the gesture smooth:
 *
 * - **The lifted row follows the cursor exactly.** Its `translateY` is written
 *   straight to the element once per animation frame, so the row tracks the
 *   pointer at display refresh rate instead of snapping between slots.
 * - **Slots are decided from a cached box list, never from live layout.** Row
 *   boxes are snapshotted once when the drag starts and then shifted
 *   arithmetically as rows trade places, so a move costs no layout reads and
 *   cannot be slowed down by a forced reflow mid-gesture.
 * - **A transform is only ever written against a layout the DOM already has.**
 *   A swap moves the cached boxes first and the DOM on commit, so the frame that
 *   requests one writes no transform at all; the layout effect re-expresses the
 *   lifted row's offset as part of the commit, before the browser paints. Writing
 *   it a frame early paints the row against a slot that does not exist yet, which
 *   reads as the row jumping a row-height away and snapping back.
 * - **Only the other rows animate.** A swap reorders the DOM on the spot and
 *   animates the displaced rows with a FLIP transform; the lifted row is left to
 *   the pointer and settles into its slot on release.
 *
 * Every position change is written right away (no separate save step), and the
 * same grip supports ArrowUp/ArrowDown for keyboard users.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  platformVisible,
  providerDisplayName,
  PROVIDER_IDS,
  type DesktopProviderState,
  type PanelSettings
} from '../shared/desktop-contract';
import type { ProviderId } from '../shared/contracts';
import { GripIcon } from './icons';
import { statusFor } from './StatusRow';

const MONOGRAMS: Record<ProviderId, string> = { codex: 'CX', glm: 'GL', deepseek: 'DS' };

/** Shared by the FLIP animation and the release settle, so both feel the same. */
const ROW_TRANSITION = 'transform 140ms cubic-bezier(0.22, 0.8, 0.24, 1)';

/** The stored order, completed with any platform the record did not mention. */
export function orderedPlatforms(settings: PanelSettings): ProviderId[] {
  const order: ProviderId[] = [];
  for (const provider of [...(settings.platformOrder ?? []), ...PROVIDER_IDS]) {
    if (!order.includes(provider)) order.push(provider);
  }
  return order;
}

/** Move `provider` to `target`'s position, returning a new list. */
export function reorderPlatforms(
  order: ProviderId[],
  provider: ProviderId,
  target: ProviderId
): ProviderId[] {
  const from = order.indexOf(provider);
  const to = order.indexOf(target);
  if (from === -1 || to === -1 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, provider);
  return next;
}

interface DragState {
  provider: ProviderId;
  pointerId: number;
  /** Latest pointer Y, read by the animation-frame callback. */
  pointerY: number;
  /** Grab point inside the row, kept constant so the row does not jump. */
  grabOffset: number;
  frame: number | null;
  /** A reorder this drag asked for has not reached the DOM yet. */
  pending: boolean;
  /** The pointer was released while a reorder was still pending. */
  dropped: boolean;
}

/** A row's vertical box, as far as the drag needs to know it. */
export interface RowBox {
  top: number;
  height: number;
}

/** Reads a row's box from the layout. */
export function measureRowBox(element: HTMLElement): RowBox {
  const box = element.getBoundingClientRect();
  return { top: box.top, height: box.height };
}

/**
 * Re-derives the cached boxes after `provider` traded places with `target`.
 *
 * Rows in between shift by exactly the lifted row's height, and the lifted row
 * travels over their combined heights — pure arithmetic, so no slot decision
 * ever waits on the layout that is still animating.
 */
export function shiftBounds(
  bounds: Map<ProviderId, RowBox>,
  order: ProviderId[],
  provider: ProviderId,
  target: ProviderId
): void {
  const from = order.indexOf(provider);
  const to = order.indexOf(target);
  const moved = bounds.get(provider);
  if (from === -1 || to === -1 || from === to || moved === undefined) return;
  const backwards = to < from;
  let travelled = 0;
  for (let index = backwards ? to : from + 1; index <= (backwards ? from - 1 : to); index += 1) {
    const other = order[index]!;
    const box = bounds.get(other);
    if (box === undefined) continue;
    travelled += box.height;
    bounds.set(other, {
      top: backwards ? box.top + moved.height : box.top - moved.height,
      height: box.height
    });
  }
  bounds.set(provider, {
    top: backwards ? moved.top - travelled : moved.top + travelled,
    height: moved.height
  });
}

export interface PlatformSettingsProps {
  settings: PanelSettings;
  /** Live state per platform, used to show what hiding will keep running. */
  states: Partial<Record<ProviderId, DesktopProviderState | undefined>>;
  /**
   * Platforms whose visibility write is in flight. A switch is disabled only by
   * its own write: an unrelated settings save (theme, quota value, reorder,
   * another platform) must never grey switches it does not own — under the
   * shared busy flag that read as the whole list flashing on every save.
   */
  toggling?: ReadonlySet<ProviderId>;
  onToggle(provider: ProviderId, visible: boolean): void;
  /** Persist a new display order; called on every position change. */
  onReorder(order: ProviderId[]): void;
  /**
   * How a row's box is measured. Overridable so the drag can be exercised
   * without a layout engine; production always uses the real layout.
   */
  measureRow?: (element: HTMLElement) => RowBox;
}

export function PlatformSettings(props: PlatformSettingsProps) {
  const persisted = useMemo(() => orderedPlatforms(props.settings), [props.settings]);
  /** Optimistic order while a drag is in flight (and until the write echoes back). */
  const [dragOrder, setDragOrder] = useState<ProviderId[] | null>(null);
  const order = dragOrder ?? persisted;
  const [dragging, setDragging] = useState<ProviderId | null>(null);

  const measure = props.measureRow ?? measureRowBox;
  const rowRefs = useRef(new Map<ProviderId, HTMLDivElement>());
  const drag = useRef<DragState | null>(null);
  /** Layout boxes of every row, valid while a gesture is in flight. */
  const bounds = useRef(new Map<ProviderId, RowBox>());
  /** Row tops captured before an order change, consumed by the FLIP effect. */
  const flip = useRef<Map<ProviderId, number> | null>(null);

  // Drop the optimistic copy once the service echoes the dragged-to order, so a
  // failed write falls back to the persisted order on the next settings update.
  useEffect(() => {
    if (!dragOrder) return;
    if (persisted.join(',') === dragOrder.join(',')) setDragOrder(null);
  }, [persisted, dragOrder]);

  /** Snapshot every row's resting box, ignoring any settle animation still running. */
  const snapshotBounds = useCallback((): Map<ProviderId, RowBox> => {
    const next = new Map<ProviderId, RowBox>();
    for (const [provider, element] of rowRefs.current) {
      const transform = element.style.transform;
      const transition = element.style.transition;
      // Read the layout position, not where a transition currently shows the row.
      element.style.transition = 'none';
      element.style.transform = 'none';
      next.set(provider, measure(element));
      element.style.transform = transform;
      element.style.transition = transition;
    }
    return next;
  }, [measure]);

  // FLIP: put every row back where it was, then let it run to its new slot.
  //
  // This effect is the *only* place a row is moved to a slot that a reorder
  // created: layout effects run inside the commit and before the paint, so by the
  // time the browser paints, the cached boxes, the DOM order and the lifted row's
  // offset all describe the same layout. Writing that offset a frame earlier —
  // straight from the pointer handler — paints the row against a slot the DOM has
  // not adopted yet, which shows up as the row jumping a row-height away and
  // snapping back.
  useLayoutEffect(() => {
    const before = flip.current;
    flip.current = null;
    if (!before) return;
    const state = drag.current;
    const lifted = state?.provider;

    if (state) {
      const slot = bounds.current.get(state.provider);
      const element = rowRefs.current.get(state.provider);
      if (element && slot) {
        if (state.dropped) {
          // Released mid-swap: settle into the slot it landed on.
          element.style.transition = ROW_TRANSITION;
          element.style.transform = '';
        } else {
          element.style.transition = 'none';
          element.style.transform = `translateY(${state.pointerY - state.grabOffset - slot.top}px)`;
        }
      }
      state.pending = false;
      if (state.dropped) {
        bounds.current.clear();
        drag.current = null;
        setDragging(null);
      }
    }

    for (const [provider, element] of rowRefs.current) {
      if (provider === lifted) continue;
      const from = before.get(provider);
      if (from === undefined) continue;
      const to = bounds.current.get(provider)?.top ?? measure(element).top;
      const delta = from - to;
      if (delta === 0) continue;
      element.style.transition = 'none';
      element.style.transform = `translateY(${delta}px)`;
      // Next frame: release the transform so the transition runs.
      requestAnimationFrame(() => {
        element.style.transition = ROW_TRANSITION;
        element.style.transform = '';
      });
    }
  }, [order, measure]);

  const applyOrder = useCallback(
    (next: ProviderId[], provider: ProviderId, target: ProviderId) => {
      if (bounds.current.size === 0) bounds.current = snapshotBounds();
      flip.current = new Map(
        [...bounds.current].map(([id, box]) => [id, box.top] as const)
      );
      shiftBounds(bounds.current, order, provider, target);
      const state = drag.current;
      // The cached boxes now describe a layout the DOM only adopts on commit, so
      // no transform may be written against them until the layout effect runs.
      if (state && state.provider === provider) state.pending = true;
      setDragOrder(next);
      // Written immediately: the overview order is already correct when the user
      // goes back, so there is no separate commit step.
      props.onReorder(next);
    },
    // Only the callback matters, not the props object the caller recreates on
    // every render, so a drag never re-creates its own frame handler needlessly.
    [order, snapshotBounds, props.onReorder]
  );

  /** Which slot does this point fall in, according to the cached boxes? */
  const slotAt = useCallback((y: number, list: ProviderId[]): ProviderId | undefined => {
    const slots = list
      .map((provider) => ({ provider, box: bounds.current.get(provider) }))
      .filter((entry): entry is { provider: ProviderId; box: RowBox } => entry.box !== undefined);
    if (slots.length === 0) return undefined;
    for (const slot of slots) {
      if (y >= slot.box.top && y <= slot.box.top + slot.box.height) return slot.provider;
    }
    const first = slots[0]!;
    if (y < first.box.top) return first.provider;
    return slots[slots.length - 1]!.provider;
  }, []);

  /** Ease a released row from wherever the pointer left it into its slot. */
  const settle = useCallback((provider: ProviderId) => {
    const element = rowRefs.current.get(provider);
    if (!element) return;
    element.style.transition = ROW_TRANSITION;
    element.style.transform = '';
  }, []);

  const endDrag = useCallback(
    (pointerId?: number) => {
      const state = drag.current;
      if (!state) return;
      if (pointerId !== undefined && pointerId !== state.pointerId) return;
      if (state.frame !== null) {
        cancelAnimationFrame(state.frame);
        state.frame = null;
      }
      if (state.pending) {
        // The swap the pointer asked for is not in the DOM yet. Settling now
        // would animate towards the slot the row is about to leave; let the
        // layout effect settle it once the new order has landed.
        state.dropped = true;
        return;
      }
      settle(state.provider);
      bounds.current.clear();
      drag.current = null;
      setDragging(null);
    },
    [settle]
  );

  useEffect(() => () => endDrag(), [endDrag]);

  /** One drag decision per frame: move the row, then re-slot it if it crossed. */
  const runFrame = useCallback(() => {
    const state = drag.current;
    if (!state) return;
    state.frame = null;
    // A reorder is still on its way to the DOM: the cached boxes describe a
    // layout that does not exist yet, so neither a slot decision nor a transform
    // may use them. The layout effect picks the gesture up again on commit.
    if (state.pending) return;
    const element = rowRefs.current.get(state.provider);
    if (!element) return;
    const box = bounds.current.get(state.provider);
    if (box === undefined) return;

    // The row's own centre decides the slot, so a swap happens once the row has
    // genuinely moved into the next one instead of at the first pixel of overlap.
    const centre = state.pointerY - state.grabOffset + box.height / 2;
    const target = slotAt(centre, order);
    if (target !== undefined && target !== state.provider) {
      const next = reorderPlatforms(order, state.provider, target);
      if (next !== order) {
        // No transform this frame: the cached boxes just moved to the new order,
        // and the layout effect re-expresses the offset once it is real.
        applyOrder(next, state.provider, target);
        return;
      }
    }

    // No reorder, so the cached boxes still match the DOM exactly.
    element.style.transform = `translateY(${state.pointerY - state.grabOffset - box.top}px)`;
  }, [applyOrder, order, slotAt]);

  const onHandlePointerDown = (event: React.PointerEvent<HTMLSpanElement>, provider: ProviderId) => {
    // Only the primary button drags. `button` is absent in test environments
    // without PointerEvent, so accept it when it is unknown.
    if (typeof event.button === 'number' && event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; the drag still works while the pointer
      // stays over the handle.
    }
    try {
      event.currentTarget.focus({ preventScroll: true });
    } catch {
      // Focus is a nicety; a drag must never fail because of it.
    }
    const element = rowRefs.current.get(provider);
    if (!element) return;
    // Snapshot with transforms cleared so a settle animation left over from the
    // previous drag cannot skew the grab offset. Same frame, so nothing flickers.
    const transform = element.style.transform;
    const transition = element.style.transition;
    element.style.transition = 'none';
    element.style.transform = 'none';
    const box = measure(element);
    element.style.transform = transform;
    element.style.transition = transition;

    bounds.current = snapshotBounds();
    bounds.current.set(provider, box);
    drag.current = {
      provider,
      pointerId: event.pointerId,
      pointerY: event.clientY,
      grabOffset: event.clientY - box.top,
      frame: null,
      pending: false,
      dropped: false
    };
    // The row is lifted onto the pointer immediately, without waiting for a move.
    element.style.transition = 'none';
    element.style.transform = 'translateY(0px)';
    setDragging(provider);
    // Start from the persisted order so a previous drag cannot leak in.
    setDragOrder(persisted);
  };

  const onHandlePointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointerId) return;
    state.pointerY = event.clientY;
    if (state.frame !== null) return;
    // Moves are coalesced into one update per frame: a burst of pointer events
    // cannot reorder the list or touch the DOM more than once per frame.
    state.frame = requestAnimationFrame(runFrame);
  };

  const onHandleKeyDown = (event: React.KeyboardEvent, provider: ProviderId) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const index = order.indexOf(provider);
    const target = order[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (target === undefined) return;
    applyOrder(reorderPlatforms(order, provider, target), provider, target);
  };

  return (
    <section className="config-block" data-testid="platform-settings" data-panel-block="section">
      <header className="block-head">
        <h3>平台管理</h3>
      </header>
      <p className="field-hint">
        拖动排序；隐藏仍保留配置并继续采集。
      </p>
      <div className={`manage-list${dragging ? ' is-sorting' : ''}`}>
        {order.map((provider) => {
          const name = providerDisplayName(provider);
          const presentation = statusFor(props.states[provider]);
          return (
            <div
              className={`manage-row${dragging === provider ? ' is-dragging' : ''}`}
              key={provider}
              data-provider={provider}
              data-testid={`manage-row-${provider}`}
              ref={(node) => {
                if (node) rowRefs.current.set(provider, node);
                else rowRefs.current.delete(provider);
              }}
            >
              <span
                className="drag-handle"
                role="button"
                tabIndex={0}
                aria-label={`拖动排序 ${name}`}
                title="拖动排序（也可用上下方向键）"
                onPointerDown={(event) => onHandlePointerDown(event, provider)}
                onPointerMove={onHandlePointerMove}
                onPointerUp={(event) => endDrag(event.pointerId)}
                onPointerCancel={(event) => endDrag(event.pointerId)}
                onKeyDown={(event) => onHandleKeyDown(event, provider)}
              >
                <GripIcon />
              </span>
              <span className={`brand-badge brand-${provider}`} aria-hidden="true">
                {MONOGRAMS[provider]}
              </span>
              <span className="manage-text">
                <strong>{name}</strong>
                <span className="manage-desc">
                  {presentation.label}
                </span>
              </span>
              <input
                type="checkbox"
                className="switch"
                aria-label={`显示 ${name}`}
                checked={platformVisible(props.settings, provider)}
                disabled={props.toggling?.has(provider) ?? false}
                onChange={(event) => props.onToggle(provider, event.target.checked)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

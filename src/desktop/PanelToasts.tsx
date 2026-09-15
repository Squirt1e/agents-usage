/**
 * The panel's message stack: bottom centre, newest nearest the bottom edge.
 *
 * Why a stack rather than one message: "刷新全部" reports one result per platform,
 * and those arrive together. Replacing the previous message meant a user who
 * looked away for a second saw only the last one; a stack shows what happened,
 * with the oldest leaving first.
 *
 * A message is text and nothing else — no icon, no close button. It is a note
 * about something that already happened, so there is nothing to press: it reads
 * and then leaves on its own clock. Each item runs that clock (and its own exit),
 * so nothing here needs to know how many messages are on screen or when the
 * others were announced.
 */

import { useEffect, useState } from 'react';
import { noticeTimeoutMs, PANEL_TOAST_EXIT_MS, type PanelToast } from './panel-toasts';

export function PanelToasts(props: { toasts: PanelToast[]; onDone(id: number): void }) {
  if (props.toasts.length === 0) return null;
  return (
    <div className="panel-toasts" data-testid="panel-toasts">
      {props.toasts.map((toast) => (
        <PanelToastItem key={toast.id} toast={toast} onDone={props.onDone} />
      ))}
    </div>
  );
}

export function PanelToastItem(props: { toast: PanelToast; onDone(id: number): void }) {
  const { toast, onDone } = props;
  const [leaving, setLeaving] = useState(false);

  // The dwell. A repeat of the same message starts a fresh one — and pulls the
  // item back if it had already begun to leave.
  useEffect(() => {
    setLeaving(false);
    const timer = window.setTimeout(() => setLeaving(true), noticeTimeoutMs(toast.tone));
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.repeat, toast.tone]);

  // Leaving is a state, not an unmount: the exit plays first, then the stack drops
  // the item. A message disappearing on a cut is exactly the jolt the panel's
  // motion rules exist to avoid.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => onDone(toast.id), PANEL_TOAST_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, toast.id, onDone]);

  // The tone still decides how long the message stays and whether a screen reader
  // treats it as an alert; nothing on screen wears it.
  return (
    <div
      className={`panel-toast${leaving ? ' is-leaving' : ''}`}
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      data-testid="panel-toast"
    >
      {toast.text}
    </div>
  );
}

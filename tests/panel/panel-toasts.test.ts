// The panel's message stack, as data. The stack is what lets "刷新全部" report
// three results without the last one erasing the others, and the rules that keep
// it from growing past the panel are plain functions here so they can be pinned
// without a layout engine (the rendering is covered in panel-toast-stack.test.tsx).
import { describe, expect, it } from 'vitest';
import {
  dropToast,
  dropToastsTagged,
  NOTICE_ERROR_TIMEOUT_MS,
  NOTICE_TIMEOUT_MS,
  noticeTimeoutMs,
  PANEL_TOAST_EXIT_MS,
  PANEL_TOAST_LIMIT,
  pushToast,
  type PanelToast
} from '../../src/desktop/panel/panel-toasts';

/** Announce a series of messages, ids handed out the way `PanelApp` hands them out. */
function announce(...texts: string[]): PanelToast[] {
  return texts.reduce<PanelToast[]>(
    (stack, text, index) => pushToast(stack, { tone: 'healthy', text }, index + 1),
    []
  );
}

describe('panel message stack', () => {
  it('keeps every message, oldest first, so a second one does not erase the first', () => {
    const stack = announce('Codex 已更新', 'GLM 已更新', 'DeepSeek 已更新');

    expect(stack.map((toast) => toast.text)).toEqual(['Codex 已更新', 'GLM 已更新', 'DeepSeek 已更新']);
    expect(stack.map((toast) => toast.id)).toEqual([1, 2, 3]);
  });

  it('treats the same text again as the same message, restarted rather than duplicated', () => {
    // A flapping connection re-announces its warning; the stack must not gain a
    // second identical row, and the countdown must start over.
    const first = pushToast([], { tone: 'warning', text: '实时连接中断，正在使用缓存数据' }, 1);
    const again = pushToast(first, { tone: 'warning', text: '实时连接中断，正在使用缓存数据' }, 2);

    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(1);
    expect(again[0]!.repeat).toBe(1);
  });

  it('lets a repeat take the new tone and keep its place in the stack', () => {
    const stack = announce('刷新失败', 'Codex 已更新');
    const updated = pushToast(stack, { tone: 'danger', text: '刷新失败' }, 3);

    expect(updated.map((toast) => toast.text)).toEqual(['刷新失败', 'Codex 已更新']);
    expect(updated[0]).toMatchObject({ tone: 'danger', id: 1, repeat: 1 });
  });

  it('drops the oldest message rather than growing past what the panel can show', () => {
    const stack = announce('一', '二', '三', '四');

    expect(stack).toHaveLength(PANEL_TOAST_LIMIT);
    expect(stack.map((toast) => toast.text)).toEqual(['二', '三', '四']);
  });

  it('drops one message by id, leaving the rest in place', () => {
    const stack = announce('一', '二', '三');

    expect(dropToast(stack, 2).map((toast) => toast.text)).toEqual(['一', '三']);
    // An id that already left changes nothing: two exits cannot race into a
    // stack that lost an unrelated message.
    expect(dropToast(stack, 99)).toHaveLength(3);
  });

  it('takes back a message the panel itself invalidates, and only that one', () => {
    // The connection warning ends when the stream reopens, which is a fact the
    // panel learns from an event, not from a clock.
    const stack = [
      ...pushToast([], { tone: 'healthy', text: 'Codex 已更新' }, 1),
      ...pushToast([], { tone: 'warning', tag: 'connection', text: '实时连接中断，正在使用缓存数据' }, 2)
    ];

    expect(dropToastsTagged(stack, 'connection').map((toast) => toast.text)).toEqual(['Codex 已更新']);
    expect(dropToastsTagged(stack, 'nothing')).toHaveLength(2);
  });

  it('gives a failure longer on screen than a result', () => {
    expect(noticeTimeoutMs('healthy')).toBe(NOTICE_TIMEOUT_MS);
    expect(noticeTimeoutMs('info')).toBe(NOTICE_TIMEOUT_MS);
    expect(noticeTimeoutMs('warning')).toBe(NOTICE_ERROR_TIMEOUT_MS);
    expect(noticeTimeoutMs('danger')).toBe(NOTICE_ERROR_TIMEOUT_MS);
    expect(NOTICE_ERROR_TIMEOUT_MS).toBeGreaterThan(NOTICE_TIMEOUT_MS);
  });

  it('keeps the exit short, because the dwell is what the user is reading', () => {
    expect(PANEL_TOAST_EXIT_MS).toBeGreaterThan(0);
    expect(PANEL_TOAST_EXIT_MS).toBeLessThan(NOTICE_TIMEOUT_MS);
  });
});

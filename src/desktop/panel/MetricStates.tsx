/**
 * Empty and loading states for the panel and metric modules.
 */


/** Initial load: the local cache is being read. */
export function LoadingState({ text = '正在读取本地缓存…' }: { text?: string }) {
  return (
    <div className="state-block state-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

/** The service itself could not be reached; nothing else can be shown. */
export function ServiceUnavailableState({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="state-block state-error" role="alert">
      <strong>本地服务不可用</strong>
      <p>{message}</p>
      <button type="button" className="ghost-button" onClick={onRetry}>
        重新读取
      </button>
    </div>
  );
}

/**
 * Frosted-glass hint laid over one card module that is not configured yet.
 *
 * The module underneath keeps rendering its formal layout; the hint replaces
 * the old dedicated empty-state blocks, so a card never switches between
 * layouts — it only gains this translucent cover with the hint text.
 */
export function FrostedHint(props: { label: string; detail?: string; testId?: string; onActivate(): void }) {
  return (
    <button
      type="button"
      className="frost-hint"
      onClick={props.onActivate}
      {...(props.testId ? { 'data-testid': props.testId } : {})}
    >
      <span className="frost-hint-label">{props.label}</span>
      {props.detail ? <span className="frost-hint-detail">{props.detail}</span> : null}
    </button>
  );
}

/**
 * Empty state for "every platform hidden".
 *
 * The panel never shows a blank window: the user gets an explanation and the way
 * back to the platform manager.
 */
export function EmptySelectionState({ onOpenManager }: { onOpenManager(): void }) {
  return (
    <div className="state-block state-empty" data-testid="empty-selection">
      <strong>尚未选择展示的平台</strong>
      <p>隐藏只影响显示，账号配置与采集会继续保留。</p>
      <button type="button" className="ghost-button" onClick={onOpenManager}>
        管理平台
      </button>
    </div>
  );
}

/**
 * A Codex quota window the provider did not return.
 *
 * The window is *not* replaced by the other window or by zero; it is reported as
 * missing so the two gauges keep their meaning.
 */
export function MissingWindowNote({ label }: { label: string }) {
  return (
    <p className="metric-note metric-note-missing" data-testid="missing-window">
      {label} 本次未返回，不使用其他窗口或零值替代。
    </p>
  );
}

import { useInk, useSessionValue, useUi } from "./context.tsx";

/** Current document/live history. Jumping uses the same undo/redo operations. */
export function HistoryPanel() {
  const ink = useInk();
  const history = useSessionValue(
    (s) => s.history(),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  const target = useSessionValue((s) => s.mode);
  const travel = (count: number) => {
    for (let i = 0; i < Math.abs(count); i++) {
      if (count < 0) ink.session.undo();
      else ink.session.redo();
    }
  };
  return (
    <div style={{ overflow: "auto", padding: 8 }}>
      <p style={{ color: "var(--ink-muted)" }}>
        {target === "play" ? "Live play edits" : "Scene edits"}
      </p>
      <button
        type="button"
        className="ink-menu-item"
        onClick={() => travel(-history.undo.length)}
      >
        Before recorded edits
      </button>
      {history.undo.map((label, i) => (
        <button
          type="button"
          className="ink-menu-item"
          key={`undo-${i}`}
          aria-current={i === history.undo.length - 1 ? "step" : undefined}
          onClick={() => travel(i + 1 - history.undo.length)}
        >
          <span>{label}</span>
          {i === history.undo.length - 1 && (
            <span className="ink-row-meta">Current</span>
          )}
        </button>
      ))}
      {history.redo.map((label, i) => (
        <button
          type="button"
          className="ink-menu-item"
          key={`redo-${i}`}
          style={{ opacity: 0.55 }}
          onClick={() => travel(i + 1)}
        >
          {label}
        </button>
      ))}
      {!history.undo.length && !history.redo.length && (
        <p className="ink-empty">Edits appear here as you work.</p>
      )}
    </div>
  );
}

export function HistoryWindow() {
  const ink = useInk();
  const open = useUi((u) => u.history);
  if (!open) return null;
  return (
    <aside
      className="ink-comment-queue"
      role="dialog"
      aria-label="Edit history"
      style={{ width: 320, left: 12, right: "auto" }}
    >
      <header className="ink-panel-header">
        <b>History</b>
        <span className="ink-bar-spacer" />
        <button
          type="button"
          className="ink-button"
          onClick={() => ink.ui.set({ history: false })}
        >
          Close
        </button>
      </header>
      <HistoryPanel />
    </aside>
  );
}

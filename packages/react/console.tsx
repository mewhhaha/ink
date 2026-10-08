/** The console (session log, game messages, build errors) and the build
 * error overlay shown over a view while the game does not compile. */
import { useEffect, useRef, useState } from "react";
import type { Diagnostic, LogEntry } from "@ink/core";
import { useSession, useSessionValue } from "./context.tsx";
import { Icon } from "./icons.tsx";

/** Open a file in the editor that started the dev server. */
export function openInEditor(file: string, line?: number, column?: number) {
  const target = `${file}${
    line ? `:${line}${column ? `:${column}` : ""}` : ""
  }`;
  fetch(`/__open-in-editor?file=${encodeURIComponent(target)}`).catch(() => {});
}

type Filter = "all" | "game" | "problems";

export function Console() {
  const session = useSession();
  const log = useSessionValue((s) => s.log);
  const [filter, setFilter] = useState<Filter>("all");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = log.filter((e) =>
    filter === "all" ||
    (filter === "game"
      ? e.source === "game"
      : e.level === "error" || e.level === "warn")
  );
  useEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [shown.length]);
  const problems =
    log.filter((e) => e.level === "error" || e.level === "warn").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: "4px 6px",
          borderBottom: "1px solid var(--ink-border)",
        }}
      >
        <button
          type="button"
          className="ink-button"
          aria-pressed={filter === "all"}
          onClick={() =>
            setFilter("all")}
        >
          All
        </button>
        <button
          type="button"
          className="ink-button"
          aria-pressed={filter === "game"}
          onClick={() => setFilter("game")}
        >
          Game
        </button>
        <button
          type="button"
          className="ink-button"
          aria-pressed={filter === "problems"}
          onClick={() => setFilter("problems")}
        >
          Problems{" "}
          {problems > 0 && <span className="ink-chip">{problems}</span>}
        </button>
        <span className="ink-bar-spacer" />
        <button
          type="button"
          className="ink-button"
          data-icon-only="true"
          title="Clear"
          onClick={() => session.clearLog()}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
      <div
        ref={scroller}
        className="ink-console"
        style={{ overflow: "auto", flex: 1 }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        }}
      >
        {shown.map((entry) => <LogLine key={entry.id} entry={entry} />)}
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.time).toLocaleTimeString([], { hour12: false });
  const location = entry.source === "build"
    ? /^(\S+?):(\d+):(\d+)/.exec(entry.text)
    : null;
  return (
    <div className="ink-log" data-level={entry.level}>
      <time title={`${entry.mode} tick ${entry.tick}`}>{time}</time>
      <span className="ink-log-source">{entry.source}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {location
          ? (
            <a
              href="#"
              style={{ color: "inherit" }}
              onClick={(e) => {
                e.preventDefault();
                openInEditor(
                  location[1],
                  Number(location[2]),
                  Number(location[3]),
                );
              }}
            >
              {entry.text}
            </a>
          )
          : entry.text}
        {entry.detail && <pre>{entry.detail}</pre>}
      </div>
    </div>
  );
}

/** Compile errors over a view; the last good game keeps running beneath. */
export function BuildErrors() {
  const status = useSessionValue((s) => s.status);
  const [hidden, setHidden] = useState<Diagnostic[] | null>(null);
  if (status.kind !== "error" || hidden === status.diagnostics) return null;
  return (
    <div
      className="ink-diagnostics"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header>
        <span>
          <Icon name="alert" size={13} /> Blot does not compile{status.revision
            ? ` — still running rev ${status.revision}`
            : ""}
        </span>
        <button
          type="button"
          className="ink-button"
          data-icon-only="true"
          onClick={() => setHidden(status.diagnostics)}
        >
          <Icon name="x" size={12} />
        </button>
      </header>
      {status.diagnostics.map((d, i) => (
        <div key={i} className="ink-diagnostic">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              openInEditor(d.file, d.line, d.column);
            }}
          >
            {d.file}:{d.line}:{d.column}
          </a>{" "}
          <span style={{ color: "var(--ink-muted)" }}>{d.code}</span>
          <pre>{d.message}</pre>
          {d.excerpt && (
            <pre
              style={{ color: "var(--ink-muted)" }}
            >  {d.excerpt.trim()}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

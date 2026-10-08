/** Scrub through the recorded play session. Seeking pauses and replays
 * inputs from the nearest keyframe; resuming from the past branches. */
import { useRef, useState } from "react";
import type { TimelineMark } from "@ink/core";
import { useSession, useSessionValue } from "./context.tsx";
import { Icon } from "./icons.tsx";

export function Timeline() {
  const session = useSession();
  const state = useSessionValue(
    (s) => ({
      mode: s.mode,
      paused: s.paused,
      tick: s.tick,
      first: s.timeline.first,
      last: Math.max(s.timeline.last, s.tick),
      marks: s.timeline.marks.length,
    }),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  const track = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<TimelineMark | null>(null);
  if (state.mode !== "play") {
    return (
      <div className="ink-timeline" style={{ color: "var(--ink-faint)" }}>
        <Icon name="clock" />{" "}
        Play to record a timeline you can scrub back through.
      </div>
    );
  }
  const span = Math.max(1, state.last - state.first);
  const at = (tick: number) => `${((tick - state.first) / span) * 100}%`;
  const seekTo = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    const t = Math.round(
      state.first + ((clientX - rect.left) / rect.width) * span,
    );
    session.seek(Math.max(state.first, Math.min(state.last, t)));
  };
  return (
    <div className="ink-timeline">
      <button
        type="button"
        className="ink-button"
        data-icon-only="true"
        title="Back one second"
        onClick={() =>
          session.seek(Math.max(state.first, state.tick - session.tickRate))}
      >
        <Icon name="undo" size={13} />
      </button>
      <div
        ref={track}
        className="ink-timeline-track"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekTo(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) seekTo(e.clientX);
        }}
      >
        <div className="ink-timeline-fill" style={{ width: at(state.tick) }} />
        {session.timeline.marks.map((m, i) => (
          <div
            key={i}
            className="ink-timeline-mark"
            data-kind={m.kind}
            title={`${m.kind}: ${m.label} @ ${m.tick}`}
            style={{
              left: at(m.tick),
              background: m.kind === "failure" ? "#ff6b5e" : undefined,
              width: m.kind === "failure" ? 8 : undefined,
              cursor: "pointer",
            }}
            role={m.kind === "failure" ? "button" : undefined}
            tabIndex={m.kind === "failure" ? 0 : undefined}
            aria-label={m.kind === "failure"
              ? `Failure at tick ${m.tick}`
              : undefined}
            onPointerDown={(e) => {
              if (m.kind !== "failure") return;
              e.stopPropagation();
              session.seek(m.tick);
              setFailure(m);
            }}
            onKeyDown={(e) => {
              if (m.kind === "failure" && e.key === "Enter") {
                session.seek(m.tick);
                setFailure(m);
              }
            }}
          />
        ))}
        <div className="ink-timeline-head" style={{ left: at(state.tick) }} />
      </div>
      <span className="ink-timeline-label">
        tick {state.tick} · {(state.tick / session.tickRate).toFixed(1)} s
      </span>
      {failure && (
        <div
          role="dialog"
          aria-label="Scenario failure"
          style={{
            position: "fixed",
            bottom: 60,
            left: "20%",
            width: "60%",
            padding: 16,
            zIndex: 100,
            background: "#191c22",
            border: "1px solid #ff6b5e",
            borderRadius: 8,
          }}
        >
          <button
            className="ink-button"
            type="button"
            style={{ float: "right" }}
            onClick={() => setFailure(null)}
          >
            Close
          </button>
          <p>Tick {failure.tick}: {failure.label}</p>
          <div style={{ display: "flex", gap: 12 }}>
            {failure.detail?.png && (
              <figure style={{ margin: 0, width: "50%" }}>
                <figcaption>Actual</figcaption>
                <img
                  alt="Actual frame"
                  src={failure.detail.png}
                  style={{ width: "100%" }}
                />
              </figure>
            )}
            {failure.detail?.diff && (
              <figure style={{ margin: 0, width: "50%" }}>
                <figcaption>Difference ×4</figcaption>
                <img
                  alt="Image difference"
                  src={failure.detail.diff}
                  style={{ width: "100%" }}
                />
              </figure>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

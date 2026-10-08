/** Scrub through the recorded play session. Seeking pauses and replays
 * inputs from the nearest keyframe; resuming from the past branches. */
import { useRef } from "react";
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
            style={{ left: at(m.tick) }}
          />
        ))}
        <div className="ink-timeline-head" style={{ left: at(state.tick) }} />
      </div>
      <span className="ink-timeline-label">
        tick {state.tick} · {(state.tick / session.tickRate).toFixed(1)} s
      </span>
    </div>
  );
}

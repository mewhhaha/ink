/** Scrub through the recorded play session. Seeking pauses and replays
 * inputs from the nearest keyframe; resuming from the past branches. */
import { useRef, useState } from "react";
import type { TimelineMark } from "@ink/core";
import { useInk, useSession, useSessionValue } from "./context.tsx";
import { Icon } from "./icons.tsx";
import { saveHandoff } from "./live.ts";

export function Timeline() {
  const ink = useInk();
  const session = useSession();
  const comments = useSessionValue((s) => s.comments);
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
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
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
        {comments.filter((c) =>
          c.anchor.scene === session.sceneName && c.anchor.range &&
          c.status !== "resolved"
        ).map((c) => {
          const range = c.anchor.range!;
          return (
            <div
              key={c.id}
              title={c.text}
              style={{
                position: "absolute",
                height: 4,
                bottom: 0,
                background: "var(--ink-comment)",
                left: at(range.from),
                width: `${
                  Math.max(0.5, (range.to - range.from) / span * 100)
                }%`,
              }}
            />
          );
        })}
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
      <button
        type="button"
        className="ink-button"
        onClick={() => {
          session.pause();
          setRange({ from: state.tick, to: state.tick });
        }}
      >
        Comment range
      </button>
      {range && (
        <div
          role="dialog"
          aria-label="Comment on timeline range"
          className="ink-composer"
          style={{ position: "fixed", right: 24, bottom: 60 }}
        >
          <label>
            From tick<input
              className="ink-input"
              type="number"
              min={state.first}
              max={state.last}
              value={range.from}
              onChange={(e) =>
                setRange({ ...range, from: Number(e.target.value) })}
            />
          </label>
          <label>
            To tick<input
              className="ink-input"
              type="number"
              min={range.from}
              max={state.last}
              value={range.to}
              onChange={(e) =>
                setRange({ ...range, to: Number(e.target.value) })}
            />
          </label>
          <textarea
            className="ink-input"
            aria-label="Range comment"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="ink-comment-controls">
            <button
              type="button"
              className="ink-button"
              disabled={saving || !text.trim() || range.from > range.to ||
                range.from < state.first || range.to > state.last}
              onClick={async () => {
                setSaving(true);
                try {
                  session.seek(range.to);
                  const handoff = await saveHandoff(ink, text.trim());
                  session.addComment({
                    author: "you",
                    text: text.trim(),
                    handoff,
                    anchor: {
                      mode: "play",
                      tick: range.from,
                      range,
                      scene: session.sceneName,
                    },
                  });
                  ink.ui.set({ comments: true });
                  setRange(null);
                  setText("");
                } catch (e) {
                  session.error(`could not save range comment: ${e}`);
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save comment
            </button>
            <button
              type="button"
              className="ink-button"
              onClick={() => setRange(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
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

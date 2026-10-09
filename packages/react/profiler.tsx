/**
 * The frame profiler: a compact toolbar readout (guest step, drawing and GPU
 * time, and the last save-to-pixels time) that opens into a panel with every
 * metric and the stages of recent code, schema, scene and tuning changes.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LoopTrace, MetricSummary, TraceKind } from "@ink/core";
import { useSession } from "./context.tsx";

/** Budgets from hill 12: code under 150 ms, tuning values under 50 ms. */
export const BUDGET_MS: Partial<Record<TraceKind, number>> = {
  code: 150,
  schema: 150,
  tuning: 50,
  scene: 50,
};

const STAGE_LABEL: Record<string, string> = {
  watch: "file watcher",
  queue: "debounce + schema",
  blotc: "Blot compiler",
  prepare: "server prepare",
  transport: "websocket",
  fetch: "fetch",
  schema: "schema import",
  migrate: "world migration",
  wasm: "Wasm compile",
  warm: "lazy compile (worker)",
  instantiate: "instantiate",
  swap: "session swap",
  apply: "apply",
  reload: "reload",
  frame: "wait for frame",
  step: "game step",
  extract: "extraction",
  draw: "draw prep",
  render: "render submit",
  gpu: "GPU",
  present: "present",
};

const STAGE_COLOR = [
  "#5b9cff",
  "#4fd18b",
  "#e8b84f",
  "#f06565",
  "#b48cff",
  "#4cc9d6",
  "#ff8fb1",
  "#9bd14f",
];

const ms = (value: number) =>
  value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value
    .toFixed(2);

function colorOf(stage: string, stages: { stage: string }[]) {
  const index = stages.findIndex((s) => s.stage === stage);
  return STAGE_COLOR[index % STAGE_COLOR.length];
}

function useProfile() {
  const profiler = useSession().profiler;
  useSyncExternalStore(profiler.subscribe, () => profiler.version);
  return profiler;
}

const KINDS: TraceKind[] = ["code", "schema", "scene", "tuning", "asset"];

/** Toolbar readout; click for the panel. */
export function FrameProfiler() {
  const profiler = useProfile();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const snapshot = profiler.snapshot();
  const { step, render, gpu } = snapshot.metrics;
  const last = profiler.lastTrace && profiler.lastTrace.outcome === "presented"
    ? profiler.lastTrace
    : Object.values(snapshot.latest).sort((a, b) => b.start - a.start)[0];
  const over = last && BUDGET_MS[last.kind] !== undefined &&
    last.total > BUDGET_MS[last.kind]!;
  return (
    <>
      <button
        type="button"
        ref={button}
        className="ink-profiler"
        aria-expanded={open}
        title="Frame profiler"
        onClick={() => setOpen(!open)}
      >
        <span
          title={`step ${ms(step.median)} · draw ${ms(render.median)} ms`}
        >
          cpu {ms(step.median + render.median)} · gpu{" "}
          {snapshot.gpuTimestamps ? ms(gpu.median) : "–"}
        </span>
        {last && (
          <span className="ink-profiler-loop" data-over={over || undefined}>
            {last.kind} {Math.round(last.total)} ms
          </span>
        )}
      </button>
      {open && (
        <ProfilerPanel
          anchor={button.current}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Row(props: { name: string; m: MetricSummary; note?: string }) {
  const { m } = props;
  return (
    <tr title={props.note}>
      <th scope="row">{props.name}</th>
      <td>{m.samples ? ms(m.last) : "–"}</td>
      <td>{m.samples ? ms(m.median) : "–"}</td>
      <td>{m.samples ? ms(m.p95) : "–"}</td>
      <td>{m.samples ? ms(m.max) : "–"}</td>
    </tr>
  );
}

function ProfilerPanel(
  { anchor, onClose }: { anchor: HTMLElement | null; onClose(): void },
) {
  const profiler = useProfile();
  const ref = useRef<HTMLDivElement>(null);
  const snapshot = profiler.snapshot();
  const rect = anchor?.getBoundingClientRect();
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) {
        onClose();
      }
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("pointerdown", down, true);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("pointerdown", down, true);
      removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  const m = snapshot.metrics;
  return (
    <div
      ref={ref}
      className="ink-profiler-panel"
      role="dialog"
      aria-label="Frame profiler"
      style={{
        left: Math.max(8, Math.min(rect?.left ?? 8, innerWidth - 420)),
        top: (rect?.bottom ?? 32) + 4,
      }}
    >
      <h4>Per frame (ms, last 120 samples)</h4>
      <table className="ink-profiler-table">
        <thead>
          <tr>
            <th />
            <th>last</th>
            <th>median</th>
            <th>p95</th>
            <th>max</th>
          </tr>
        </thead>
        <tbody>
          <Row name="game step" m={m.step} note="session.step, all in" />
          <Row name="  guest call" m={m.guest} note="Wasm, packet encode" />
          <Row name="  decode" m={m.decode} note="result packet to state" />
          <Row name="extraction" m={m.extract} />
          <Row name="render CPU" m={m.render} note="view.render calls" />
          <Row
            name={snapshot.gpuTimestamps ? "GPU" : "GPU (no timestamp-query)"}
            m={m.gpu}
            note="sum of pass durations, a few frames old"
          />
          <Row name="frame interval" m={m.frame} />
        </tbody>
      </table>
      <h4>Save to pixels</h4>
      {KINDS.map((kind) => {
        const trace = snapshot.latest[kind];
        return trace ? <Trace key={kind} trace={trace} /> : null;
      })}
      {Object.keys(snapshot.latest).length === 0 && (
        <p className="ink-profiler-empty">
          Edit a Blot file, a scene file or an inspector field to measure.
        </p>
      )}
      {snapshot.traces.filter((t) =>
        t.outcome === "error" || t.outcome === "unchanged"
      ).slice(0, 3)
        .map((t) => (
          <p key={t.id} className="ink-profiler-empty">
            {t.kind} {t.file}: {t.outcome}
          </p>
        ))}
    </div>
  );
}

function Trace({ trace }: { trace: LoopTrace }) {
  const budget = BUDGET_MS[trace.kind];
  const total = Math.max(trace.total, 1);
  const shown = trace.stages.filter((s) => s.ms >= 0.05);
  return (
    <div className="ink-trace">
      <div className="ink-trace-head">
        <strong>{trace.kind}</strong>
        <span className="ink-trace-file">{trace.file}</span>
        <span
          className="ink-trace-total"
          data-over={budget !== undefined && trace.total > budget || undefined}
        >
          {Math.round(trace.total)} ms
          {budget !== undefined ? ` / ${budget}` : ""}
        </span>
      </div>
      <div className="ink-trace-bar">
        {shown.map((s) => (
          <span
            key={s.stage}
            title={`${STAGE_LABEL[s.stage] ?? s.stage}: ${ms(s.ms)} ms`}
            style={{
              width: `${(s.ms / total) * 100}%`,
              background: colorOf(s.stage, trace.stages),
            }}
          />
        ))}
      </div>
      <div className="ink-trace-stages">
        {shown.map((s) => (
          <span key={s.stage}>
            <i style={{ background: colorOf(s.stage, trace.stages) }} />
            {STAGE_LABEL[s.stage] ?? s.stage} {ms(s.ms)}
          </span>
        ))}
      </div>
      {trace.detail && (
        <div className="ink-trace-detail">
          {Object.entries(trace.detail).map(([k, v]) => `${k} ${v}`).join(
            " · ",
          )}
        </div>
      )}
    </div>
  );
}

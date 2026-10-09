/**
 * Frame and iteration profiler. Two kinds of measurement share one object:
 *
 * - Metrics: rolling windows of per-frame costs (guest step, decode,
 *   extraction, render CPU, GPU time, frame interval), summarised as last,
 *   median, 95th percentile and worst.
 * - Loop traces: the path of one change from the moment its file was written
 *   (or the edit was made) to the first presented frame that shows it, split
 *   into consecutive stages. A trace is a list of timestamps; a stage is the
 *   time since the previous mark, so the stages add up to the total.
 *
 * Timestamps are epoch milliseconds from `performance.timeOrigin +
 * performance.now()`, which the dev server, the page and a test driver on the
 * same machine all agree on to well under a millisecond.
 */

export const METRICS = [
  "step",
  "guest",
  "decode",
  "extract",
  "render",
  "gpu",
  "frame",
] as const;
export type Metric = (typeof METRICS)[number];

export interface MetricSummary {
  last: number;
  median: number;
  p95: number;
  max: number;
  samples: number;
}

/** What started a trace. */
export type TraceKind = "code" | "schema" | "scene" | "asset" | "tuning";

export interface TraceMark {
  /** The stage that ended at `at`. */
  stage: string;
  at: number;
}

export interface LoopTrace {
  id: string;
  kind: TraceKind;
  /** Project-relative file, or a description such as `transform.position`. */
  file: string;
  /** Epoch ms of the first timestamp (the file write or the edit). */
  start: number;
  marks: TraceMark[];
  /** Stage durations in order; they add up to `total`. */
  stages: { stage: string; ms: number }[];
  total: number;
  /** Which presented frame ended the trace, `error` when the build failed. */
  outcome: "presented" | "error" | "unchanged" | "dropped";
  /** Free-form facts, e.g. compiler module counts. */
  detail?: Record<string, number | string>;
}

export interface ProfileSnapshot {
  metrics: Record<Metric, MetricSummary>;
  /** Most recent first. */
  traces: LoopTrace[];
  /** The most recent finished trace of each kind. */
  latest: Partial<Record<TraceKind, LoopTrace>>;
  /** True when the adapter reports GPU timestamps. */
  gpuTimestamps: boolean;
}

const WINDOW = 120;
const MAX_TRACES = 24;
/** A trace that never reaches pixels (nothing visible changed) is dropped. */
const TRACE_TIMEOUT_MS = 30000;

export const epochNow = () => performance.timeOrigin + performance.now();

class Ring {
  values = new Float64Array(WINDOW);
  count = 0;
  next = 0;
  last = 0;
  push(value: number) {
    this.values[this.next] = value;
    this.next = (this.next + 1) % WINDOW;
    if (this.count < WINDOW) this.count++;
    this.last = value;
  }
  summary(): MetricSummary {
    if (this.count === 0) {
      return { last: 0, median: 0, p95: 0, max: 0, samples: 0 };
    }
    const sorted = Array.from(this.values.subarray(0, this.count)).sort((
      a,
      b,
    ) => a - b);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
      last: this.last,
      median: at(0.5),
      p95: at(0.95),
      max: sorted[sorted.length - 1],
      samples: this.count,
    };
  }
}

type Listener = () => void;

interface Pending {
  trace: Omit<LoopTrace, "stages" | "total" | "outcome">;
  /** Waiting for `armTail` (the new code or value to be installed). */
  armed: boolean;
  deadline: number;
}

export class Profiler {
  readonly #rings = new Map<Metric, Ring>(
    METRICS.map((metric) => [metric, new Ring()]),
  );
  #traces: LoopTrace[] = [];
  #latest = new Map<TraceKind, LoopTrace>();
  #pending: Pending | null = null;
  #listeners = new Set<Listener>();
  #version = 0;
  #notify = false;
  /** Set by the renderer when GPU timestamp queries are available. */
  gpuTimestamps = false;
  /** Frames drawn so far by any view; a trace ends at a draw after arming. */
  #draws = 0;

  /** Subscribe to new samples and traces (coalesced by the caller). */
  subscribe = (listener: Listener): () => void => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get version() {
    return this.#version;
  }

  /** Record one sample of a per-frame metric. */
  sample(metric: Metric, ms: number) {
    if (!Number.isFinite(ms)) return;
    this.#rings.get(metric)!.push(ms);
    this.#notify = true;
  }

  /** Tell listeners about everything sampled since the last call. */
  flush() {
    if (!this.#notify) return;
    this.#notify = false;
    this.#version++;
    for (const listener of this.#listeners) listener();
  }

  metric(metric: Metric): MetricSummary {
    return this.#rings.get(metric)!.summary();
  }

  get traces(): readonly LoopTrace[] {
    return this.#traces;
  }

  get lastTrace(): LoopTrace | null {
    return this.#traces[0] ?? null;
  }

  /**
   * Measure an in-page change (an inspector edit): the trace starts now, ends
   * `run`, and completes at the next presented frame. Skipped while another
   * trace is open or when the last one started under 250 ms ago, so a drag
   * produces a handful of traces rather than hundreds.
   */
  measure<T>(kind: TraceKind, file: string, run: () => T): T {
    const start = epochNow();
    const open = this.#pending && start < this.#pending.deadline;
    if (open || start - this.#lastMeasure < 250) return run();
    if (this.#pending) this.#finish("dropped", start);
    this.#lastMeasure = start;
    this.begin(crypto.randomUUID(), kind, file, start);
    try {
      return run();
    } finally {
      this.mark("apply");
      this.arm();
    }
  }
  #lastMeasure = 0;

  /** The trace being measured, if any. */
  get pending(): { id: string; kind: TraceKind; file: string } | null {
    return this.#pending?.trace
      ? {
        id: this.#pending.trace.id,
        kind: this.#pending.trace.kind,
        file: this.#pending.trace.file,
      }
      : null;
  }

  snapshot(): ProfileSnapshot {
    const metrics = {} as Record<Metric, MetricSummary>;
    for (const metric of METRICS) metrics[metric] = this.metric(metric);
    return {
      metrics,
      traces: [...this.#traces],
      latest: Object.fromEntries(this.#latest),
      gpuTimestamps: this.gpuTimestamps,
    };
  }

  // Loop traces ---------------------------------------------------------------

  /**
   * Start a trace whose first timestamp is `start`. A trace already open with
   * the same id (a schema edit sends a project event, then a game) continues.
   */
  begin(
    id: string,
    kind: TraceKind,
    file: string,
    start: number,
    detail?: Record<string, number | string>,
  ): boolean {
    if (this.#pending?.trace.id === id) {
      Object.assign(this.#pending.trace.detail ??= {}, detail);
      return false;
    }
    if (this.#pending) this.#finish("dropped", epochNow());
    this.#pending = {
      trace: { id, kind, file, start, marks: [], detail },
      armed: false,
      deadline: epochNow() + 15000,
    };
    return true;
  }

  /** Add the end of a stage. Timestamps default to now. */
  mark(stage: string, at: number = epochNow()) {
    const pending = this.#pending;
    if (!pending) return;
    pending.trace.marks.push({ stage, at });
  }

  /** Mark only if a trace with `id` is open. */
  markFor(id: string, stage: string, at: number = epochNow()) {
    if (this.#pending?.trace.id === id) this.mark(stage, at);
  }

  detail(values: Record<string, number | string>) {
    if (this.#pending) Object.assign(this.#pending.trace.detail ??= {}, values);
  }

  /**
   * The change is installed (new game swapped in, value written): the next
   * frame that is drawn and presented ends the trace.
   */
  arm() {
    const pending = this.#pending;
    if (!pending) return;
    pending.armed = true;
    pending.deadline = epochNow() + TRACE_TIMEOUT_MS;
  }

  /** `arm`, but only for the trace with this id. */
  armFor(id: string) {
    if (this.#pending?.trace.id === id) this.arm();
  }

  /** `end`, but only for the trace with this id. */
  endFor(id: string, outcome: "error" | "unchanged") {
    if (this.#pending?.trace.id === id) this.end(outcome);
  }

  /** The trace ended without pixels (compile error, identical output). */
  end(outcome: "error" | "unchanged") {
    if (this.#pending) this.#finish(outcome, epochNow());
  }

  get armed(): boolean {
    return !!this.#pending?.armed;
  }

  // The frame loop drives the tail of a trace ---------------------------------

  /** A tick of the frame loop starts: forget the previous tick's totals. */
  beginTick() {
    this.#tickExtract = 0;
    this.#tickRender = 0;
    this.#tickDraws = this.#draws;
  }
  #tickExtract = 0;
  #tickRender = 0;
  #tickDraws = 0;

  /** Time spent extracting a scene or rendering a view; also a metric. */
  spend(what: "extract" | "render", ms: number) {
    this.sample(what, ms);
    if (what === "extract") this.#tickExtract += ms;
    else this.#tickRender += ms;
  }

  /** A view finished `render`. */
  drawn() {
    this.#draws++;
  }

  /**
   * A tick finished its callbacks. When it drew, add the stages it is made of
   * (waiting for the tick, the step, extraction, the rest of drawing, GPU
   * submission) and return true; the caller then awaits the GPU and calls
   * `gpuDone` and `presented`.
   */
  tail(
    t: {
      start: number;
      stepEnd: number;
      stepped: boolean;
      end: number;
    },
  ): boolean {
    const pending = this.#pending;
    if (!pending?.armed) return false;
    if (t.start > pending.deadline) {
      this.#finish("dropped", t.start);
      return false;
    }
    if (this.#draws === this.#tickDraws) return false;
    const marks = pending.trace.marks;
    marks.push({ stage: "frame", at: t.start });
    if (t.stepped) marks.push({ stage: "step", at: t.stepEnd });
    const afterStep = Math.max(t.stepEnd, t.start);
    const extract = Math.min(this.#tickExtract, t.end - afterStep);
    marks.push({ stage: "extract", at: afterStep + extract });
    const render = Math.min(this.#tickRender, t.end - afterStep - extract);
    marks.push({ stage: "draw", at: t.end - render });
    marks.push({ stage: "render", at: t.end });
    return true;
  }

  /** The GPU finished the work of the tick `tail` accepted. */
  gpuDone(at: number = epochNow()) {
    this.mark("gpu", at);
  }

  /** The animation frame after the GPU finished: the change is on screen. */
  presented(at: number = epochNow()) {
    if (!this.#pending?.armed) return;
    this.mark("present", at);
    this.#finish("presented", at);
  }

  #finish(outcome: LoopTrace["outcome"], at: number) {
    const pending = this.#pending!;
    this.#pending = null;
    const { trace } = pending;
    const stages: { stage: string; ms: number }[] = [];
    let previous = trace.start;
    for (const mark of trace.marks) {
      const ms = Math.max(0, mark.at - previous);
      previous = Math.max(previous, mark.at);
      // The same stage can be reported twice (a schema edit sends two events).
      const again = stages.find((s) => s.stage === mark.stage);
      if (again) again.ms += ms;
      else stages.push({ stage: mark.stage, ms });
    }
    const end = trace.marks.at(-1)?.at ?? at;
    const finished: LoopTrace = {
      ...trace,
      stages,
      total: Math.max(0, end - trace.start),
      outcome,
    };
    this.#traces.unshift(finished);
    if (outcome === "presented") this.#latest.set(trace.kind, finished);
    if (this.#traces.length > MAX_TRACES) this.#traces.length = MAX_TRACES;
    this.#notify = true;
    this.flush();
  }
}

/** Median and 95th percentile of repeated measurements. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

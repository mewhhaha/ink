import {
  type FrameProfile,
  type MetricUnit,
  type ObservationClock,
  type ObservationContext,
  type ObservationSource,
  type ObservationValue,
  parse_finite,
  parse_name,
  parse_source,
  parse_timestamp,
  type ProfileSpan,
  type Severity,
} from "./model.ts";
import type { ObservationSink } from "./sink.ts";

export type Evidence = Readonly<Record<string, ObservationValue>>;

export interface ObserverOptions {
  readonly source: ObservationSource;
  readonly sink: ObservationSink;
  readonly clock: ObservationClock;
  readonly correlation_id?: string;
}

export interface ActiveSpan {
  readonly id: string;
  end(evidence?: Evidence): void;
}

interface OpenSpan {
  readonly id: string;
  readonly name: string;
  readonly started_at_seconds: number;
  readonly context: ObservationContext;
  readonly evidence: Evidence;
}

export class Observer {
  readonly #source: ObservationSource;
  readonly #sink: ObservationSink;
  readonly #clock: ObservationClock;
  readonly #correlation_id: string | undefined;
  readonly #open_spans: OpenSpan[] = [];
  #next_span_id = 0;

  constructor(options: ObserverOptions) {
    this.#source = parse_source(options.source);
    this.#sink = options.sink;
    this.#clock = options.clock;
    this.#correlation_id = options.correlation_id === undefined
      ? undefined
      : parse_name(options.correlation_id, "observation correlation id");
  }

  event(name: string, evidence: Evidence = {}): void {
    this.#sink.record({
      type: "event",
      name: parse_name(name, "observation event"),
      source: this.#source,
      timestamp_seconds: this.#now(),
      context: this.#context(),
      evidence,
    });
  }

  diagnostic(
    severity: Severity,
    operation: string,
    message: string,
    evidence: Evidence,
  ): void {
    this.#sink.record({
      type: "diagnostic",
      severity,
      operation: parse_name(operation, "diagnostic operation"),
      message: parse_name(message, "diagnostic message"),
      source: this.#source,
      timestamp_seconds: this.#now(),
      context: this.#context(),
      evidence,
    });
  }

  start_span(name: string, evidence: Evidence = {}): ActiveSpan {
    const id = `${this.#source.subsystem}:${this.#next_span_id}`;
    this.#next_span_id += 1;
    const span: OpenSpan = {
      id,
      name: parse_name(name, "observation span"),
      started_at_seconds: this.#now(),
      context: this.#context(),
      evidence,
    };
    this.#open_spans.push(span);
    let ended = false;
    return {
      id,
      end: (end_evidence = {}) => {
        if (ended) {
          throw new Error(`observation span ${id} ended more than once`);
        }
        const current = this.#open_spans.at(-1);
        if (current?.id !== id) {
          throw new Error(
            `observation span ${id} ended out of order; active span is ${
              current?.id ?? "none"
            }`,
          );
        }
        ended = true;
        this.#open_spans.pop();
        const ended_at = this.#now();
        this.#sink.record({
          type: "span",
          id,
          name: span.name,
          source: this.#source,
          timestamp_seconds: span.started_at_seconds,
          duration_seconds: ended_at - span.started_at_seconds,
          context: span.context,
          evidence: { ...span.evidence, ...end_evidence },
        });
      },
    };
  }

  counter(name: string, value = 1, unit: MetricUnit = "count"): void {
    this.#metric("counter", name, value, unit);
  }

  gauge(name: string, value: number, unit: MetricUnit): void {
    this.#metric("gauge", name, value, unit);
  }

  histogram(name: string, samples: readonly number[], unit: MetricUnit): void {
    if (samples.length === 0) {
      throw new Error(
        `histogram ${JSON.stringify(name)} requires at least one sample`,
      );
    }
    const parsed = samples.map((value, index) =>
      parse_finite(value, `histogram ${JSON.stringify(name)} sample ${index}`)
    );
    let minimum = parsed[0];
    let maximum = parsed[0];
    let sum = 0;
    for (const value of parsed) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      sum += value;
    }
    this.#sink.record({
      type: "metric",
      kind: "histogram",
      name: parse_name(name, "histogram name"),
      unit,
      count: parsed.length,
      minimum,
      maximum,
      sum,
      source: this.#source,
      timestamp_seconds: this.#now(),
      context: this.#context(),
    });
  }

  frame_profile(
    frame_id: number,
    cpu_spans: readonly ProfileSpan[],
    gpu_spans: readonly ProfileSpan[],
  ): void {
    if (!Number.isSafeInteger(frame_id) || frame_id < 0) {
      throw new Error(
        `frame profile id ${
          JSON.stringify(frame_id)
        } must be a nonnegative safe integer`,
      );
    }
    const profile: FrameProfile = {
      type: "frame_profile",
      frame_id,
      cpu_spans: parse_profile_spans(cpu_spans, "CPU"),
      gpu_spans: parse_profile_spans(gpu_spans, "GPU"),
      source: this.#source,
      timestamp_seconds: this.#now(),
      context: this.#context(),
    };
    this.#sink.record(profile);
  }

  #metric(
    kind: "counter" | "gauge",
    name: string,
    value: number,
    unit: MetricUnit,
  ): void {
    this.#sink.record({
      type: "metric",
      kind,
      name: parse_name(name, `${kind} name`),
      unit,
      value: parse_finite(value, `${kind} ${JSON.stringify(name)} value`),
      source: this.#source,
      timestamp_seconds: this.#now(),
      context: this.#context(),
    });
  }

  #context(): ObservationContext {
    return {
      ...(this.#correlation_id === undefined
        ? {}
        : { correlation_id: this.#correlation_id }),
      ...(this.#open_spans.length === 0
        ? {}
        : { parent_span_id: this.#open_spans.at(-1)!.id }),
    };
  }

  #now(): number {
    return parse_timestamp(this.#clock.now_seconds(), "observation clock");
  }
}

function parse_profile_spans(
  spans: readonly ProfileSpan[],
  kind: string,
): readonly ProfileSpan[] {
  return spans.map((span, index) => ({
    name: parse_name(span.name, `${kind} profile span ${index}`),
    duration_seconds: parse_timestamp(
      span.duration_seconds,
      `${kind} profile span ${JSON.stringify(span.name)} duration`,
    ),
  }));
}

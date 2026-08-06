export type Severity = "debug" | "info" | "warning" | "error";

export type MetricUnit =
  | "bytes"
  | "count"
  | "frames"
  | "microseconds"
  | "milliseconds"
  | "nanoseconds"
  | "ratio"
  | "seconds";

export type ObservationValue =
  | null
  | boolean
  | number
  | string
  | readonly ObservationValue[]
  | { readonly [key: string]: ObservationValue };

export interface ObservationSource {
  readonly subsystem: string;
  readonly instance?: string;
}

export interface ObservationContext {
  readonly correlation_id?: string;
  readonly parent_span_id?: string;
}

interface ObservationBase {
  readonly source: ObservationSource;
  readonly timestamp_seconds: number;
  readonly context: ObservationContext;
}

export interface Diagnostic extends ObservationBase {
  readonly type: "diagnostic";
  readonly severity: Severity;
  readonly operation: string;
  readonly message: string;
  readonly evidence: Readonly<Record<string, ObservationValue>>;
}

export interface Event extends ObservationBase {
  readonly type: "event";
  readonly name: string;
  readonly evidence: Readonly<Record<string, ObservationValue>>;
}

export interface Span extends ObservationBase {
  readonly type: "span";
  readonly id: string;
  readonly name: string;
  readonly duration_seconds: number;
  readonly evidence: Readonly<Record<string, ObservationValue>>;
}

interface MetricBase extends ObservationBase {
  readonly type: "metric";
  readonly name: string;
  readonly unit: MetricUnit;
}

export interface CounterMetric extends MetricBase {
  readonly kind: "counter";
  readonly value: number;
}

export interface GaugeMetric extends MetricBase {
  readonly kind: "gauge";
  readonly value: number;
}

export interface HistogramMetric extends MetricBase {
  readonly kind: "histogram";
  readonly count: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly sum: number;
}

export interface ProfileSpan {
  readonly name: string;
  readonly duration_seconds: number;
}

export interface FrameProfile extends ObservationBase {
  readonly type: "frame_profile";
  readonly frame_id: number;
  readonly cpu_spans: readonly ProfileSpan[];
  readonly gpu_spans: readonly ProfileSpan[];
}

export type Metric = CounterMetric | GaugeMetric | HistogramMetric;

export type Observation = Diagnostic | Event | Span | Metric | FrameProfile;

export interface ObservationClock {
  now_seconds(): number;
}

export function parse_source(source: ObservationSource): ObservationSource {
  return {
    subsystem: parse_name(source.subsystem, "observation subsystem"),
    ...(source.instance === undefined
      ? {}
      : { instance: parse_name(source.instance, "observation instance") }),
  };
}

export function parse_name(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) throw new Error(`${label} cannot be empty`);
  return parsed;
}

export function parse_timestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${label} ${String(value)} must be finite and nonnegative`,
    );
  }
  return value;
}

export function parse_finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${String(value)} must be finite`);
  }
  return value;
}

import type { Observation } from "./model.ts";

export interface ObservationSink {
  record(observation: Observation): void;
}

export interface BufferedObservationSink extends ObservationSink {
  readonly capacity: number;
  observations(): readonly Observation[];
  dropped(): number;
  clear(): void;
}

export interface SinkFailure {
  readonly sink_index: number;
  readonly reason: string;
}

export interface FanOutObservationSink extends ObservationSink {
  failures(): readonly SinkFailure[];
  dropped_failures(): number;
}

export const no_observations: ObservationSink = { record() {} };

export function create_test_sink(): BufferedObservationSink {
  const recorded: Observation[] = [];
  return {
    capacity: Number.POSITIVE_INFINITY,
    record(observation) {
      recorded.push(observation);
    },
    observations() {
      return recorded.slice();
    },
    dropped() {
      return 0;
    },
    clear() {
      recorded.length = 0;
    },
  };
}

export function create_ring_buffer_sink(
  capacity: number,
): BufferedObservationSink {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error(
      `observation buffer capacity ${
        JSON.stringify(capacity)
      } must be a positive safe integer`,
    );
  }
  const recorded: Observation[] = [];
  let dropped_count = 0;
  return {
    capacity,
    record(observation) {
      if (recorded.length === capacity) {
        recorded.shift();
        dropped_count += 1;
      }
      recorded.push(observation);
    },
    observations() {
      return recorded.slice();
    },
    dropped() {
      return dropped_count;
    },
    clear() {
      recorded.length = 0;
      dropped_count = 0;
    },
  };
}

export function create_fan_out_sink(
  sinks: readonly ObservationSink[],
  failure_capacity = 100,
): FanOutObservationSink {
  if (!Number.isSafeInteger(failure_capacity) || failure_capacity <= 0) {
    throw new Error(
      `observation sink failure capacity ${
        JSON.stringify(failure_capacity)
      } must be a positive safe integer`,
    );
  }
  const recorded_failures: SinkFailure[] = [];
  const configured_sinks = [...sinks];
  let dropped_failure_count = 0;
  return {
    record(observation) {
      for (const [sink_index, sink] of configured_sinks.entries()) {
        try {
          sink.record(observation);
        } catch (error) {
          if (recorded_failures.length === failure_capacity) {
            recorded_failures.shift();
            dropped_failure_count += 1;
          }
          recorded_failures.push({
            sink_index,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    failures() {
      return recorded_failures.slice();
    },
    dropped_failures() {
      return dropped_failure_count;
    },
  };
}

export interface ObservationExporter {
  export(observations: readonly Observation[]): Promise<void>;
}

export type ExportResult =
  | { readonly type: "exported"; readonly count: number }
  | {
    readonly type: "failed";
    readonly count: number;
    readonly reason: string;
  };

export async function export_observations(
  observations: readonly Observation[],
  exporter: ObservationExporter,
): Promise<ExportResult> {
  try {
    await exporter.export(observations);
    return { type: "exported", count: observations.length };
  } catch (error) {
    return {
      type: "failed",
      count: observations.length,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

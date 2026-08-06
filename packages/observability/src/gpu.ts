import { parse_name, parse_timestamp, type ProfileSpan } from "./model.ts";

export type GpuTimestampCapability =
  | { readonly type: "unsupported"; readonly reason: string }
  | {
    readonly type: "supported";
    readonly timestamp_period_nanoseconds: number;
  };

export interface GpuTimestampPair {
  readonly name: string;
  readonly start_tick: bigint;
  readonly end_tick: bigint;
}

export interface GpuTimestampBatch {
  readonly submitted_frame_id: number;
  readonly available_frame_id: number;
  readonly timestamps: readonly GpuTimestampPair[];
}

export type GpuTimestampResult =
  | { readonly type: "unsupported"; readonly reason: string }
  | {
    readonly type: "profile";
    readonly submitted_frame_id: number;
    readonly available_frame_id: number;
    readonly spans: readonly ProfileSpan[];
  };

export function ingest_gpu_timestamps(
  capability: GpuTimestampCapability,
  batch: GpuTimestampBatch,
): GpuTimestampResult {
  if (capability.type === "unsupported") {
    return {
      type: "unsupported",
      reason: parse_name(capability.reason, "GPU timestamp unsupported reason"),
    };
  }
  const submitted_frame_id = parse_frame_id(
    batch.submitted_frame_id,
    "submitted GPU timestamp frame",
  );
  const available_frame_id = parse_frame_id(
    batch.available_frame_id,
    "available GPU timestamp frame",
  );
  if (available_frame_id < submitted_frame_id) {
    throw new Error(
      `GPU timestamps for submitted frame ${submitted_frame_id} cannot become available in earlier frame ${available_frame_id}`,
    );
  }
  const period = parse_timestamp(
    capability.timestamp_period_nanoseconds,
    "GPU timestamp period",
  );
  if (period === 0) {
    throw new Error("GPU timestamp period must be greater than zero");
  }
  return {
    type: "profile",
    submitted_frame_id,
    available_frame_id,
    spans: batch.timestamps.map((timestamp, index) => {
      if (timestamp.end_tick < timestamp.start_tick) {
        throw new Error(
          `GPU timestamp ${index} ${
            JSON.stringify(timestamp.name)
          } ends before it starts`,
        );
      }
      return {
        name: parse_name(timestamp.name, `GPU timestamp ${index}`),
        duration_seconds: Number(timestamp.end_tick - timestamp.start_tick) *
          period / 1_000_000_000,
      };
    }),
  };
}

function parse_frame_id(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value;
}

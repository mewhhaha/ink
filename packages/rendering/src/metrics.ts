export interface RenderFrameMetrics {
  readonly frame: number;
  readonly extraction_seconds: number;
  readonly submission_seconds: number;
  readonly gpu_seconds?: number;
  readonly allocated_bytes: number;
  readonly uploaded_bytes: number;
  readonly pipeline_misses: number;
  readonly shadow_cache_hits: number;
  readonly shadow_cache_misses: number;
  readonly visible_draws: number;
  readonly submitted_draws: number;
  readonly rejected_draws: number;
  readonly texture_bindings: number;
}

export interface RenderMetricSummary {
  readonly frame_count: number;
  readonly mean_extraction_seconds: number;
  readonly mean_submission_seconds: number;
  readonly mean_gpu_seconds?: number;
  readonly maximum_allocated_bytes: number;
  readonly uploaded_bytes: number;
  readonly pipeline_misses: number;
  readonly shadow_cache_hit_ratio: number;
  readonly rejected_draw_ratio: number;
}

export class RenderMetricHistory {
  readonly #capacity: number;
  readonly #frames: RenderFrameMetrics[] = [];

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error(
        `render metric history capacity ${
          JSON.stringify(capacity)
        } must be positive`,
      );
    }
    this.#capacity = capacity;
  }

  record(metrics: RenderFrameMetrics): void {
    validate_metrics(metrics);
    if (
      this.#frames.at(-1)?.frame !== undefined &&
      metrics.frame <= this.#frames.at(-1)!.frame
    ) {
      throw new Error(
        `render metric frame ${metrics.frame} must exceed ${
          this.#frames.at(-1)!.frame
        }`,
      );
    }
    this.#frames.push(Object.freeze({ ...metrics }));
    if (this.#frames.length > this.#capacity) this.#frames.shift();
  }

  frames(): readonly RenderFrameMetrics[] {
    return [...this.#frames];
  }

  summary(): RenderMetricSummary | undefined {
    if (this.#frames.length === 0) return undefined;
    const count = this.#frames.length;
    const gpu = this.#frames.flatMap((frame) =>
      frame.gpu_seconds === undefined ? [] : [frame.gpu_seconds]
    );
    const shadow_requests = sum(this.#frames, "shadow_cache_hits") +
      sum(this.#frames, "shadow_cache_misses");
    const considered_draws = sum(this.#frames, "submitted_draws") +
      sum(this.#frames, "rejected_draws");
    return {
      frame_count: count,
      mean_extraction_seconds: sum(this.#frames, "extraction_seconds") / count,
      mean_submission_seconds: sum(this.#frames, "submission_seconds") / count,
      ...(gpu.length === 0 ? {} : {
        mean_gpu_seconds: gpu.reduce((total, value) => total + value, 0) /
          gpu.length,
      }),
      maximum_allocated_bytes: Math.max(
        ...this.#frames.map((frame) => frame.allocated_bytes),
      ),
      uploaded_bytes: sum(this.#frames, "uploaded_bytes"),
      pipeline_misses: sum(this.#frames, "pipeline_misses"),
      shadow_cache_hit_ratio: shadow_requests === 0
        ? 1
        : sum(this.#frames, "shadow_cache_hits") / shadow_requests,
      rejected_draw_ratio: considered_draws === 0
        ? 0
        : sum(this.#frames, "rejected_draws") / considered_draws,
    };
  }
}

function validate_metrics(metrics: RenderFrameMetrics): void {
  for (const [label, value] of Object.entries(metrics)) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `render metric frame ${metrics.frame} ${label} ${
          JSON.stringify(value)
        } must be nonnegative`,
      );
    }
  }
  for (
    const [label, value] of [
      ["frame", metrics.frame],
      ["allocated_bytes", metrics.allocated_bytes],
      ["uploaded_bytes", metrics.uploaded_bytes],
      ["pipeline_misses", metrics.pipeline_misses],
      ["shadow_cache_hits", metrics.shadow_cache_hits],
      ["shadow_cache_misses", metrics.shadow_cache_misses],
      ["visible_draws", metrics.visible_draws],
      ["submitted_draws", metrics.submitted_draws],
      ["rejected_draws", metrics.rejected_draws],
      ["texture_bindings", metrics.texture_bindings],
    ] as const
  ) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `render metric ${label} ${
          JSON.stringify(value)
        } must be a safe integer`,
      );
    }
  }
  if (
    metrics.submitted_draws + metrics.rejected_draws < metrics.visible_draws
  ) {
    throw new Error(
      `render metric frame ${metrics.frame} accounts for ${
        metrics.submitted_draws + metrics.rejected_draws
      } draws below ${metrics.visible_draws} visible draws`,
    );
  }
}

function sum<Key extends keyof RenderFrameMetrics>(
  frames: readonly RenderFrameMetrics[],
  key: Key,
): number {
  return frames.reduce((total, frame) => total + (frame[key] as number), 0);
}

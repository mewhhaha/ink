import type { Observer } from "@ink/observability/observer.ts";
import {
  ingest_occlusion_batch,
  type OcclusionBatch,
} from "@ink/visibility/occlusion.ts";
import type { OcclusionState, VisibilityId } from "@ink/visibility/model.ts";
import { visibility_id } from "@ink/visibility/model.ts";

export interface DepthPyramidLevel {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly reduction: "maximum";
}

export interface OcclusionReadback {
  readonly input_revision: number;
  readonly object_ids: readonly VisibilityId[];
  readonly visible_bits: Uint32Array;
}

interface PendingReadback {
  readonly ready_frame: number;
  readonly readback: OcclusionReadback;
}

export function reversed_depth_pyramid(
  width: number,
  height: number,
): readonly DepthPyramidLevel[] {
  if (
    !Number.isSafeInteger(width) || width <= 0 ||
    !Number.isSafeInteger(height) || height <= 0
  ) {
    throw new Error(
      `render depth pyramid extent ${width}x${height} must be positive integers`,
    );
  }
  const levels: DepthPyramidLevel[] = [];
  let current_width = width;
  let current_height = height;
  let level = 0;
  while (true) {
    levels.push({
      level,
      width: current_width,
      height: current_height,
      reduction: "maximum",
    });
    if (current_width === 1 && current_height === 1) return levels;
    current_width = Math.max(1, Math.ceil(current_width / 2));
    current_height = Math.max(1, Math.ceil(current_height / 2));
    level += 1;
  }
}

export class GpuOcclusionReadbacks {
  readonly #latency_frames: number;
  readonly #maximum_pending: number;
  readonly #observer: Observer | undefined;
  readonly #pending: PendingReadback[] = [];

  constructor(
    options: {
      readonly latency_frames: number;
      readonly maximum_pending: number;
      readonly observer?: Observer;
    },
  ) {
    if (
      !Number.isSafeInteger(options.latency_frames) ||
      options.latency_frames < 1
    ) {
      throw new Error(
        `render occlusion latency ${
          JSON.stringify(options.latency_frames)
        } must be at least one frame`,
      );
    }
    if (
      !Number.isSafeInteger(options.maximum_pending) ||
      options.maximum_pending < 1
    ) {
      throw new Error(
        `render occlusion pending maximum ${
          JSON.stringify(options.maximum_pending)
        } must be positive`,
      );
    }
    this.#latency_frames = options.latency_frames;
    this.#maximum_pending = options.maximum_pending;
    this.#observer = options.observer;
  }

  submit(frame: number, readback: OcclusionReadback): void {
    if (
      !Number.isSafeInteger(frame) || frame < 0 ||
      !Number.isSafeInteger(readback.input_revision) ||
      readback.input_revision < 0
    ) {
      throw new Error(
        `render occlusion frame ${JSON.stringify(frame)} and revision ${
          JSON.stringify(readback.input_revision)
        } must be nonnegative`,
      );
    }
    if (!(readback.visible_bits instanceof Uint32Array)) {
      throw new Error("render occlusion visible bits must be a Uint32Array");
    }
    const object_ids = readback.object_ids.map(visibility_id);
    if (new Set(object_ids).size !== object_ids.length) {
      throw new Error(
        `render occlusion revision ${readback.input_revision} repeats an object identity`,
      );
    }
    if (readback.visible_bits.length * 32 < readback.object_ids.length) {
      throw new Error(
        `render occlusion revision ${readback.input_revision} has ${
          readback.visible_bits.length * 32
        } result bits for ${readback.object_ids.length} objects`,
      );
    }
    const ready_frame = frame + this.#latency_frames;
    if (!Number.isSafeInteger(ready_frame)) {
      throw new Error(
        `render occlusion ready frame ${frame} + ${this.#latency_frames} exceeds safe integer range`,
      );
    }
    this.#pending.push({
      ready_frame,
      readback: {
        ...readback,
        object_ids: Object.freeze(object_ids),
        visible_bits: new Uint32Array(readback.visible_bits),
      },
    });
    while (this.#pending.length > this.#maximum_pending) this.#pending.shift();
  }

  collect(
    frame: number,
    expected_revision: number,
    options: { readonly camera_cut?: true } = {},
  ): ReadonlyMap<VisibilityId, OcclusionState> | undefined {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new Error(
        `render occlusion collection frame ${
          JSON.stringify(frame)
        } must be nonnegative`,
      );
    }
    const ready = this.#pending.filter((entry) => entry.ready_frame <= frame);
    if (ready.length === 0) return undefined;
    const selected = ready.at(-1)!;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      if (this.#pending[index].ready_frame <= frame) {
        this.#pending.splice(index, 1);
      }
    }
    const states = new Map<VisibilityId, OcclusionState>();
    for (const [index, id] of selected.readback.object_ids.entries()) {
      const visible =
        (selected.readback.visible_bits[index >>> 5] & (1 << (index & 31))) !==
          0;
      states.set(
        id,
        visible
          ? { type: "visible", revision: selected.readback.input_revision }
          : {
            type: "occluded",
            revision: selected.readback.input_revision,
            confidence: "certain",
          },
      );
    }
    const batch: OcclusionBatch = {
      input_revision: selected.readback.input_revision,
      states,
    };
    const delivered = ingest_occlusion_batch(batch, expected_revision, options);
    this.#observer?.event("render.occlusion.delivered", {
      input_revision: selected.readback.input_revision,
      expected_revision,
      object_count: states.size,
      camera_cut: options.camera_cut === true,
    });
    return delivered;
  }

  invalidate(): void {
    this.#pending.splice(0);
  }
}

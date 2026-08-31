import { type Vec3, vec3 } from "@ink/math/vector.ts";

export type DebugView =
  | "final"
  | "albedo"
  | "normals"
  | "roughness"
  | "metallic"
  | "depth"
  | "motion"
  | "object_id"
  | "light_clusters"
  | "shadow_cascades"
  | "overdraw";
export type ToneMapping = "aces" | "reinhard" | "neutral";

export interface PostProcessSettings {
  readonly exposure: number;
  readonly tone_mapping: ToneMapping;
  readonly bloom_threshold: number;
  readonly bloom_intensity: number;
  readonly color_lut_size?: number;
  readonly debug_view: DebugView;
}

export interface TemporalHistory {
  readonly surface_revision: number;
  readonly frame: number;
  readonly color_revision: number;
  readonly valid: boolean;
  readonly reset_reason?:
    | "initial"
    | "camera_cut"
    | "resize"
    | "device_loss"
    | "path_change";
}

export type PickResult = {
  readonly type: "hit";
  readonly object_id: string;
  readonly depth: number;
} | {
  readonly type: "miss";
};

export interface Screenshot {
  readonly width: number;
  readonly height: number;
  readonly color_space: "srgb";
  readonly rgba8: Uint8Array;
}

export function post_process_settings(
  settings: PostProcessSettings,
): PostProcessSettings {
  if (!["aces", "reinhard", "neutral"].includes(settings.tone_mapping)) {
    throw new Error(
      `render tone mapping ${
        JSON.stringify(settings.tone_mapping)
      } is unsupported`,
    );
  }
  if (
    ![
      "final",
      "albedo",
      "normals",
      "roughness",
      "metallic",
      "depth",
      "motion",
      "object_id",
      "light_clusters",
      "shadow_cascades",
      "overdraw",
    ].includes(settings.debug_view)
  ) {
    throw new Error(
      `render debug view ${JSON.stringify(settings.debug_view)} is unsupported`,
    );
  }
  if (!Number.isFinite(settings.exposure)) {
    throw new Error(
      `render exposure ${JSON.stringify(settings.exposure)} must be finite`,
    );
  }
  if (
    !Number.isFinite(settings.bloom_threshold) || settings.bloom_threshold < 0
  ) {
    throw new Error(
      `render bloom threshold ${
        JSON.stringify(settings.bloom_threshold)
      } must be nonnegative`,
    );
  }
  if (
    !Number.isFinite(settings.bloom_intensity) || settings.bloom_intensity < 0
  ) {
    throw new Error(
      `render bloom intensity ${
        JSON.stringify(settings.bloom_intensity)
      } must be nonnegative`,
    );
  }
  if (
    settings.color_lut_size !== undefined &&
    (!Number.isSafeInteger(settings.color_lut_size) ||
      settings.color_lut_size < 2)
  ) {
    throw new Error(
      `render color LUT size ${
        JSON.stringify(settings.color_lut_size)
      } must be an integer of at least 2`,
    );
  }
  return Object.freeze({ ...settings });
}

export function tone_map(color: Vec3, settings: PostProcessSettings): Vec3 {
  settings = post_process_settings(settings);
  if (color.x < 0 || color.y < 0 || color.z < 0) {
    throw new Error(
      `render HDR color (${color.x}, ${color.y}, ${color.z}) must be nonnegative`,
    );
  }
  const scale = Math.pow(2, settings.exposure);
  if (!Number.isFinite(scale)) {
    throw new Error(
      `render exposure ${settings.exposure} overflows HDR scaling`,
    );
  }
  const exposed = [color.x * scale, color.y * scale, color.z * scale] as const;
  const mapped = exposed.map((channel) => {
    if (settings.tone_mapping === "reinhard") return channel / (1 + channel);
    if (settings.tone_mapping === "neutral") return Math.min(1, channel);
    const numerator = channel * (2.51 * channel + 0.03);
    const denominator = channel * (2.43 * channel + 0.59) + 0.14;
    return Math.max(0, Math.min(1, numerator / denominator));
  });
  return vec3(mapped[0], mapped[1], mapped[2]);
}

export function bloom_kernel(radius: number): Float32Array {
  if (!Number.isSafeInteger(radius) || radius < 1 || radius > 32) {
    throw new Error(
      `render bloom radius ${
        JSON.stringify(radius)
      } must be an integer in 1..32`,
    );
  }
  const sigma = Math.max(1, radius / 2);
  const weights = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let index = -radius; index <= radius; index += 1) {
    const weight = Math.exp(-(index * index) / (2 * sigma * sigma));
    weights[index + radius] = weight;
    sum += weight;
  }
  for (let index = 0; index < weights.length; index += 1) weights[index] /= sum;
  return weights;
}

export function next_temporal_history(
  previous: TemporalHistory | undefined,
  request: {
    readonly surface_revision: number;
    readonly frame: number;
    readonly color_revision: number;
    readonly reset?: Exclude<TemporalHistory["reset_reason"], "initial">;
  },
): TemporalHistory {
  for (
    const [label, value] of [["surface", request.surface_revision], [
      "frame",
      request.frame,
    ], ["color", request.color_revision]] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `render temporal ${label} revision ${
          JSON.stringify(value)
        } must be nonnegative`,
      );
    }
  }
  const reset_reason = previous === undefined
    ? "initial"
    : request.reset ?? (previous.surface_revision !== request.surface_revision
      ? "resize"
      : undefined);
  if (
    request.reset !== undefined &&
    !["camera_cut", "resize", "device_loss", "path_change"].includes(
      request.reset,
    )
  ) {
    throw new Error(
      `render temporal reset ${JSON.stringify(request.reset)} is unsupported`,
    );
  }
  return Object.freeze({
    surface_revision: request.surface_revision,
    frame: request.frame,
    color_revision: request.color_revision,
    valid: reset_reason === undefined,
    ...(reset_reason === undefined ? {} : { reset_reason }),
  });
}

export function decode_pick(
  object_ids: readonly string[],
  draw_index: number,
  depth: number,
): PickResult {
  if (!Number.isFinite(depth) || depth < 0 || depth > 1) {
    throw new Error(
      `render pick depth ${JSON.stringify(depth)} must be in [0, 1]`,
    );
  }
  if (draw_index === 0xffff_ffff) return { type: "miss" };
  if (
    !Number.isSafeInteger(draw_index) || draw_index < 0 ||
    draw_index >= object_ids.length
  ) {
    throw new Error(
      `render pick draw index ${JSON.stringify(draw_index)} is outside 0..${
        object_ids.length - 1
      }`,
    );
  }
  return { type: "hit", object_id: object_ids[draw_index], depth };
}

export function screenshot(
  width: number,
  height: number,
  rgba8: Uint8Array,
): Screenshot {
  if (
    !Number.isSafeInteger(width) || width <= 0 ||
    !Number.isSafeInteger(height) || height <= 0
  ) {
    throw new Error(
      `render screenshot extent ${width}x${height} must be positive integers`,
    );
  }
  const expected = width * height * 4;
  if (!Number.isSafeInteger(expected)) {
    throw new Error(
      `render screenshot extent ${width}x${height} exceeds safe byte range`,
    );
  }
  if (!(rgba8 instanceof Uint8Array)) {
    throw new Error("render screenshot pixels must be a Uint8Array");
  }
  if (rgba8.length !== expected) {
    throw new Error(
      `render screenshot ${width}x${height} needs ${expected} RGBA bytes, received ${rgba8.length}`,
    );
  }
  return Object.freeze({
    width,
    height,
    color_space: "srgb",
    rgba8: new Uint8Array(rgba8),
  });
}

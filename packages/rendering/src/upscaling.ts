export type Fsr1Quality =
  | "ultra_quality"
  | "quality"
  | "balanced"
  | "performance";

export type Fsr2Quality =
  | "quality"
  | "balanced"
  | "performance"
  | "ultra_performance";

export type RenderUpscaling =
  | { readonly type: "native" }
  | {
    readonly type: "fsr1";
    readonly quality: Fsr1Quality;
    readonly sharpness: number;
  }
  | {
    readonly type: "fsr2";
    readonly quality: Fsr2Quality;
    readonly sharpness: number;
  };

export interface PixelExtent {
  readonly width: number;
  readonly height: number;
}

export interface UpscalingPlan {
  readonly upscaling: RenderUpscaling;
  readonly render_extent: PixelExtent;
  readonly display_extent: PixelExtent;
  readonly scale_factor: number;
  readonly temporal: boolean;
}

const scale_factors: Readonly<Record<Fsr1Quality | Fsr2Quality, number>> = {
  ultra_quality: 1.3,
  quality: 1.5,
  balanced: 1.7,
  performance: 2,
  ultra_performance: 3,
};
const fsr1_quality_modes: readonly Fsr1Quality[] = [
  "ultra_quality",
  "quality",
  "balanced",
  "performance",
];
const fsr2_quality_modes: readonly Fsr2Quality[] = [
  "quality",
  "balanced",
  "performance",
  "ultra_performance",
];

export function validate_upscaling(
  upscaling: RenderUpscaling,
): RenderUpscaling {
  if (upscaling.type === "native") return Object.freeze({ ...upscaling });
  if (upscaling.type !== "fsr1" && upscaling.type !== "fsr2") {
    throw new Error(
      `render upscaling type ${
        JSON.stringify((upscaling as { readonly type: unknown }).type)
      } must be native, fsr1, or fsr2`,
    );
  }
  const supported_quality_modes = upscaling.type === "fsr1"
    ? fsr1_quality_modes
    : fsr2_quality_modes;
  if (
    !(supported_quality_modes as readonly string[]).includes(upscaling.quality)
  ) {
    throw new Error(
      `render ${upscaling.type} quality ${
        JSON.stringify(upscaling.quality)
      } must be one of ${supported_quality_modes.join(", ")}`,
    );
  }
  if (
    !Number.isFinite(upscaling.sharpness) || upscaling.sharpness < 0 ||
    upscaling.sharpness > 1
  ) {
    throw new Error(
      `render ${upscaling.type} sharpness ${
        JSON.stringify(upscaling.sharpness)
      } must be in [0, 1]`,
    );
  }
  return Object.freeze({ ...upscaling });
}

export function plan_upscaling(
  upscaling: RenderUpscaling,
  display_extent: PixelExtent,
): UpscalingPlan {
  const parsed = validate_upscaling(upscaling);
  validate_extent(display_extent, "display");
  const scale_factor = parsed.type === "native"
    ? 1
    : scale_factors[parsed.quality];
  const render_extent = Object.freeze({
    width: Math.max(1, Math.ceil(display_extent.width / scale_factor)),
    height: Math.max(1, Math.ceil(display_extent.height / scale_factor)),
  });
  return Object.freeze({
    upscaling: parsed,
    render_extent,
    display_extent: Object.freeze({ ...display_extent }),
    scale_factor,
    temporal: parsed.type === "fsr2",
  });
}

export function fsr2_jitter(
  frame: number,
  plan: UpscalingPlan,
): { readonly x: number; readonly y: number } {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error(
      `render FSR 2 jitter frame ${JSON.stringify(frame)} must be nonnegative`,
    );
  }
  if (plan.upscaling.type !== "fsr2") {
    throw new Error(
      `render FSR 2 jitter requires fsr2 upscaling, received ${
        JSON.stringify(plan.upscaling.type)
      }`,
    );
  }
  const phase_count = Math.max(1, Math.ceil(8 * plan.scale_factor ** 2));
  const phase = frame % phase_count + 1;
  return Object.freeze({
    x: halton(phase, 2) - 0.5,
    y: halton(phase, 3) - 0.5,
  });
}

function validate_extent(extent: PixelExtent, label: string): void {
  if (
    !Number.isSafeInteger(extent.width) || extent.width <= 0 ||
    !Number.isSafeInteger(extent.height) || extent.height <= 0
  ) {
    throw new Error(
      `render ${label} extent ${extent.width}x${extent.height} must be positive integers`,
    );
  }
}

function halton(index: number, base: number): number {
  let fraction = 1;
  let value = 0;
  let remaining = index;
  while (remaining > 0) {
    fraction /= base;
    value += fraction * (remaining % base);
    remaining = Math.floor(remaining / base);
  }
  return value;
}

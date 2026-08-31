import {
  ray_tracing_sample_sequence,
  ray_tracing_scene_revision,
} from "./identity.ts";
import type {
  PathTracingAccumulationResetReason,
  PathTracingFrame,
  PathTracingPresentationState,
} from "./model.ts";

export function next_path_tracing_accumulation(
  previous: PathTracingFrame | undefined,
  presentation: PathTracingPresentationState,
): PathTracingFrame {
  const normalized = normalize_presentation(presentation);
  if (previous === undefined) {
    return reset_frame(normalized, ["initial"]);
  }
  const reasons = reset_reasons(previous.presentation, normalized);
  const first_reason = reasons[0];
  if (first_reason !== undefined) {
    return reset_frame(normalized, [first_reason, ...reasons.slice(1)]);
  }
  const accumulated_samples = previous.accumulated_samples +
    normalized.quality.samples_per_frame;
  if (!Number.isSafeInteger(accumulated_samples)) {
    throw new Error(
      `path tracing accumulated sample count ${accumulated_samples} exceeds safe integer capacity`,
    );
  }
  return Object.freeze({
    type: "continued",
    presentation: normalized,
    sample_sequence: ray_tracing_sample_sequence(
      previous.accumulated_samples,
    ),
    samples_in_frame: normalized.quality.samples_per_frame,
    accumulated_samples,
  });
}

function reset_frame(
  presentation: PathTracingPresentationState,
  reasons: readonly [
    PathTracingAccumulationResetReason,
    ...PathTracingAccumulationResetReason[],
  ],
): PathTracingFrame {
  return Object.freeze({
    type: "reset",
    presentation,
    sample_sequence: ray_tracing_sample_sequence(0),
    samples_in_frame: presentation.quality.samples_per_frame,
    accumulated_samples: presentation.quality.samples_per_frame,
    reasons: Object.freeze(reasons),
  });
}

function reset_reasons(
  previous: PathTracingPresentationState,
  next: PathTracingPresentationState,
): PathTracingAccumulationResetReason[] {
  const reasons: PathTracingAccumulationResetReason[] = [];
  if (previous.scene_revision !== next.scene_revision) reasons.push("scene");
  if (previous.transform_revision !== next.transform_revision) {
    reasons.push("transforms");
  }
  if (previous.material_revision !== next.material_revision) {
    reasons.push("materials");
  }
  if (previous.light_revision !== next.light_revision) reasons.push("lights");
  if (previous.camera_revision !== next.camera_revision) reasons.push("camera");
  if (
    previous.viewport.width !== next.viewport.width ||
    previous.viewport.height !== next.viewport.height
  ) reasons.push("viewport");
  if (previous.exposure_revision !== next.exposure_revision) {
    reasons.push("exposure");
  }
  if (previous.fog_revision !== next.fog_revision) reasons.push("fog");
  if (
    previous.quality.samples_per_frame !== next.quality.samples_per_frame ||
    previous.quality.maximum_bounces !== next.quality.maximum_bounces ||
    previous.quality.render_scale !== next.quality.render_scale ||
    previous.quality.denoiser !== next.quality.denoiser
  ) reasons.push("quality");
  return reasons;
}

function normalize_presentation(
  presentation: PathTracingPresentationState,
): PathTracingPresentationState {
  const revision_fields = [
    ["transform", presentation.transform_revision],
    ["material", presentation.material_revision],
    ["light", presentation.light_revision],
    ["camera", presentation.camera_revision],
    ["exposure", presentation.exposure_revision],
    ["fog", presentation.fog_revision],
  ] as const;
  for (const [name, revision] of revision_fields) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(
        `path tracing ${name} revision ${
          String(revision)
        } must be a nonnegative safe integer`,
      );
    }
  }
  if (
    !Number.isSafeInteger(presentation.viewport.width) ||
    presentation.viewport.width <= 0 ||
    !Number.isSafeInteger(presentation.viewport.height) ||
    presentation.viewport.height <= 0
  ) {
    throw new Error(
      `path tracing viewport ${presentation.viewport.width}x${presentation.viewport.height} must have positive safe-integer dimensions`,
    );
  }
  if (
    !Number.isSafeInteger(presentation.quality.samples_per_frame) ||
    presentation.quality.samples_per_frame <= 0
  ) {
    throw new Error(
      `path tracing samples per frame ${
        String(presentation.quality.samples_per_frame)
      } must be a positive safe integer`,
    );
  }
  if (
    !Number.isSafeInteger(presentation.quality.maximum_bounces) ||
    presentation.quality.maximum_bounces <= 0
  ) {
    throw new Error(
      `path tracing maximum bounces ${
        String(presentation.quality.maximum_bounces)
      } must be a positive safe integer`,
    );
  }
  if (
    !Number.isFinite(presentation.quality.render_scale) ||
    presentation.quality.render_scale <= 0 ||
    presentation.quality.render_scale > 1
  ) {
    throw new Error(
      `path tracing render scale ${
        String(presentation.quality.render_scale)
      } must be within (0, 1]`,
    );
  }
  if (presentation.quality.denoiser !== "edge_aware") {
    throw new Error(
      `path tracing denoiser ${
        JSON.stringify(presentation.quality.denoiser)
      } is unsupported`,
    );
  }
  return Object.freeze({
    ...presentation,
    scene_revision: ray_tracing_scene_revision(presentation.scene_revision),
    viewport: Object.freeze({ ...presentation.viewport }),
    quality: Object.freeze({ ...presentation.quality }),
  });
}

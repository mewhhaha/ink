import { type RenderUpscaling, validate_upscaling } from "./upscaling.ts";

declare const resource_id_brand: unique symbol;
declare const surface_id_brand: unique symbol;
declare const frame_id_brand: unique symbol;

export type RenderResourceId = string & { readonly [resource_id_brand]: true };
export type RenderSurfaceId = string & { readonly [surface_id_brand]: true };
export type RenderFrameId = number & { readonly [frame_id_brand]: true };

export type RenderingPath = "compatibility" | "clustered_forward" | "deferred";
export type RenderDeviceState =
  | { readonly type: "unavailable"; readonly reason: string }
  | { readonly type: "requesting" }
  | { readonly type: "ready"; readonly adapter: string }
  | { readonly type: "lost"; readonly adapter: string; readonly reason: string }
  | {
    readonly type: "recovering";
    readonly adapter: string;
    readonly attempt: number;
  };

export interface RenderCapabilities {
  readonly adapter: string;
  readonly maximum_texture_dimension_2d: number;
  readonly maximum_buffer_bytes: number;
  readonly maximum_sample_count: 1 | 4;
  readonly timestamp_queries: boolean;
  readonly indirect_draw: boolean;
  readonly depth_clip_control: boolean;
  readonly supported_paths: ReadonlySet<RenderingPath>;
}

export interface RenderQualityProfile {
  readonly path: RenderingPath;
  readonly hdr_format: "rgba16float";
  readonly depth: "reversed";
  readonly sample_count: 1 | 4;
  readonly anti_aliasing: "none" | "fxaa" | "taa";
  readonly upscaling: RenderUpscaling;
  readonly bloom: boolean;
  readonly color_grading: boolean;
  readonly maximum_lights: number;
  readonly maximum_shadow_lights: number;
}

export interface RenderSurface {
  readonly id: RenderSurfaceId;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly revision: number;
}

export interface RenderFrame {
  readonly id: RenderFrameId;
  readonly surface: RenderSurface;
  readonly started_seconds: number;
}

export function render_resource_id(value: string): RenderResourceId {
  return identity(value, "resource") as RenderResourceId;
}

export function render_surface_id(value: string): RenderSurfaceId {
  return identity(value, "surface") as RenderSurfaceId;
}

export function render_frame_id(value: number): RenderFrameId {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `render frame identity ${JSON.stringify(value)} must be nonnegative`,
    );
  }
  return value as RenderFrameId;
}

export function render_surface(surface: RenderSurface): RenderSurface {
  const id = render_surface_id(surface.id);
  if (
    !Number.isSafeInteger(surface.width) || surface.width <= 0 ||
    !Number.isSafeInteger(surface.height) || surface.height <= 0
  ) {
    throw new Error(
      `render surface ${
        JSON.stringify(surface.id)
      } extent ${surface.width}x${surface.height} must be positive integers`,
    );
  }
  if (!Number.isSafeInteger(surface.revision) || surface.revision < 0) {
    throw new Error(
      `render surface ${JSON.stringify(surface.id)} revision ${
        JSON.stringify(surface.revision)
      } must be nonnegative`,
    );
  }
  if (
    typeof surface.format !== "string" || surface.format.trim().length === 0
  ) {
    throw new Error(
      `render surface ${JSON.stringify(id)} format must be nonempty`,
    );
  }
  return Object.freeze({
    ...surface,
    id,
    format: surface.format.trim() as GPUTextureFormat,
  });
}

export function select_quality_profile(
  requested: RenderQualityProfile,
  capabilities: RenderCapabilities,
): {
  readonly type: "ready";
  readonly profile: RenderQualityProfile;
  readonly degraded_from?: RenderingPath;
} | { readonly type: "unsupported"; readonly reason: string } {
  const requested_profile = render_quality_profile(requested);
  if (requested_profile.sample_count > capabilities.maximum_sample_count) {
    return {
      type: "unsupported",
      reason: `render adapter ${
        JSON.stringify(capabilities.adapter)
      } supports sample count ${capabilities.maximum_sample_count}, requested ${requested_profile.sample_count}`,
    };
  }
  if (capabilities.supported_paths.has(requested_profile.path)) {
    return { type: "ready", profile: requested_profile };
  }
  if (!capabilities.supported_paths.has("compatibility")) {
    return {
      type: "unsupported",
      reason: `render adapter ${
        JSON.stringify(capabilities.adapter)
      } supports neither ${requested_profile.path} nor compatibility path`,
    };
  }
  return {
    type: "ready",
    profile: render_quality_profile({
      ...requested_profile,
      path: "compatibility",
      anti_aliasing: requested_profile.anti_aliasing === "taa"
        ? "fxaa"
        : requested_profile.anti_aliasing,
    }),
    degraded_from: requested_profile.path,
  };
}

export function render_quality_profile(
  profile: RenderQualityProfile,
): RenderQualityProfile {
  if (
    !["compatibility", "clustered_forward", "deferred"].includes(profile.path)
  ) {
    throw new Error(
      `render path ${JSON.stringify(profile.path)} is unsupported`,
    );
  }
  if (profile.hdr_format !== "rgba16float" || profile.depth !== "reversed") {
    throw new Error(
      `render quality HDR ${JSON.stringify(profile.hdr_format)} depth ${
        JSON.stringify(profile.depth)
      } is unsupported`,
    );
  }
  if (profile.sample_count !== 1 && profile.sample_count !== 4) {
    throw new Error(
      `render sample count ${
        JSON.stringify(profile.sample_count)
      } must be 1 or 4`,
    );
  }
  if (!["none", "fxaa", "taa"].includes(profile.anti_aliasing)) {
    throw new Error(
      `render anti-aliasing ${
        JSON.stringify(profile.anti_aliasing)
      } is unsupported`,
    );
  }
  if (
    typeof profile.bloom !== "boolean" ||
    typeof profile.color_grading !== "boolean"
  ) {
    throw new Error("render bloom and color grading flags must be boolean");
  }
  const upscaling = validate_upscaling(profile.upscaling);
  if (upscaling.type === "fsr2" && profile.anti_aliasing !== "none") {
    throw new Error(
      `render FSR 2 includes temporal anti-aliasing and cannot be combined with ${
        JSON.stringify(profile.anti_aliasing)
      } anti-aliasing`,
    );
  }
  if (upscaling.type === "fsr2" && profile.sample_count !== 1) {
    throw new Error(
      `render FSR 2 requires sample count 1, received ${profile.sample_count}`,
    );
  }
  for (
    const [label, value] of [["lights", profile.maximum_lights], [
      "shadow lights",
      profile.maximum_shadow_lights,
    ]] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `render quality maximum ${label} ${
          JSON.stringify(value)
        } must be nonnegative`,
      );
    }
  }
  if (profile.path === "deferred" && profile.sample_count !== 1) {
    throw new Error(
      `render deferred path sample count ${profile.sample_count} must be 1`,
    );
  }
  return Object.freeze({ ...profile, upscaling });
}

function identity(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `render ${label} identity ${JSON.stringify(value)} must be a string`,
    );
  }
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(
      `render ${label} identity ${JSON.stringify(value)} cannot be empty`,
    );
  }
  return parsed;
}

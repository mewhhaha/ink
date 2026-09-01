import type { RenderTechnique } from "@ink/rendering/renderer.ts";

export type LightingTechniqueSelection = "raster" | "path_traced";

export interface RasterOnlyLightingTechniqueSupport {
  readonly type: "raster_only";
  readonly reason: string;
}

export interface RasterAndPathTracedLightingTechniqueSupport {
  readonly type: "raster_and_path_traced";
}

export type LightingTechniqueSupport =
  | RasterOnlyLightingTechniqueSupport
  | RasterAndPathTracedLightingTechniqueSupport;

export interface LightingPathTracingQuality {
  readonly maximum_bounces: number;
  readonly samples_per_frame: number;
}

interface LightingTechniquePreferencesBase {
  readonly maximum_bounces: number;
  readonly path_samples_per_frame: number;
}

export type LightingTechniquePreferences =
  & LightingTechniquePreferencesBase
  & (
    | {
      readonly selection: "raster";
      readonly support: RasterOnlyLightingTechniqueSupport;
    }
    | {
      readonly selection: LightingTechniqueSelection;
      readonly support: RasterAndPathTracedLightingTechniqueSupport;
    }
  );

export function lighting_technique_preferences(
  support: LightingTechniqueSupport,
  selection: LightingTechniqueSelection,
  quality: LightingPathTracingQuality,
): LightingTechniquePreferences {
  if (
    !Number.isSafeInteger(quality.samples_per_frame) ||
    quality.samples_per_frame < 1 || quality.samples_per_frame > 64
  ) {
    throw new Error(
      `lighting path samples per frame ${quality.samples_per_frame} must be a safe integer within [1, 64]`,
    );
  }
  if (
    !Number.isSafeInteger(quality.maximum_bounces) ||
    quality.maximum_bounces < 1 || quality.maximum_bounces > 16
  ) {
    throw new Error(
      `lighting path maximum bounces ${quality.maximum_bounces} must be a safe integer within [1, 16]`,
    );
  }
  if (support.type === "raster_only") {
    return Object.freeze({
      maximum_bounces: quality.maximum_bounces,
      path_samples_per_frame: quality.samples_per_frame,
      selection: "raster",
      support,
    });
  }
  return Object.freeze({
    maximum_bounces: quality.maximum_bounces,
    path_samples_per_frame: quality.samples_per_frame,
    selection,
    support,
  });
}

export function constrain_lighting_technique(
  current: LightingTechniquePreferences,
  support: LightingTechniqueSupport,
): LightingTechniquePreferences {
  return lighting_technique_preferences(
    support,
    current.selection,
    {
      maximum_bounces: current.maximum_bounces,
      samples_per_frame: current.path_samples_per_frame,
    },
  );
}

export function select_lighting_technique(
  current: LightingTechniquePreferences,
  selection: LightingTechniqueSelection,
): LightingTechniquePreferences {
  if (current.support.type === "raster_only") return current;
  if (current.selection === selection) return current;
  return Object.freeze({
    maximum_bounces: current.maximum_bounces,
    path_samples_per_frame: current.path_samples_per_frame,
    selection,
    support: current.support,
  });
}

export function set_lighting_path_samples(
  current: LightingTechniquePreferences,
  path_samples_per_frame: number,
): LightingTechniquePreferences {
  return lighting_technique_preferences(
    current.support,
    current.selection,
    {
      maximum_bounces: current.maximum_bounces,
      samples_per_frame: path_samples_per_frame,
    },
  );
}

export function lighting_render_technique(
  preferences: LightingTechniquePreferences,
): RenderTechnique {
  return preferences.selection === "raster"
    ? Object.freeze({
      type: "raster",
      path: "clustered_forward",
      sample_count: 1,
      anti_aliasing: "fxaa",
    })
    : Object.freeze({
      type: "path_traced",
      samples_per_frame: preferences.path_samples_per_frame,
      maximum_bounces: preferences.maximum_bounces,
      render_scale: 1,
      denoiser: "edge_aware",
    });
}

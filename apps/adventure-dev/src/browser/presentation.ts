import type { RenderTechnique } from "@ink/rendering/renderer.ts";

export type AdventureTechniqueSelection = "raster" | "path_traced";

export interface AdventureHostCameraOverride {
  readonly yaw_radians: number;
  readonly pitch_radians: number;
  readonly position_offset: readonly [number, number, number];
  readonly distance_scale: number;
}

export interface AdventurePresentationSettings {
  readonly host_camera: AdventureHostCameraOverride;
  readonly technique: AdventureTechniqueSelection;
}

const initial_camera_position_offset: readonly [number, number, number] = [
  0,
  0,
  0,
];

export const initial_adventure_presentation_settings:
  AdventurePresentationSettings = Object.freeze({
    host_camera: Object.freeze({
      yaw_radians: 0,
      pitch_radians: 0,
      position_offset: Object.freeze(initial_camera_position_offset),
      distance_scale: 1,
    }),
    technique: "raster",
  });

export function adventure_render_technique(
  settings: AdventurePresentationSettings,
): RenderTechnique {
  switch (settings.technique) {
    case "raster":
      return Object.freeze({
        type: "raster",
        path: "clustered_forward",
        sample_count: 4,
        anti_aliasing: "none",
      });
    case "path_traced":
      return Object.freeze({
        type: "path_traced",
        samples_per_frame: 4,
        maximum_bounces: 4,
        render_scale: 1,
        denoiser: "edge_aware",
      });
  }
}

export function select_adventure_technique(
  current: AdventurePresentationSettings,
  technique: AdventureTechniqueSelection,
): AdventurePresentationSettings {
  if (current.technique === technique) return current;
  return Object.freeze({ ...current, technique });
}

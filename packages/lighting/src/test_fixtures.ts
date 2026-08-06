import { camera_id, type CameraDefinition } from "@ink/camera/model.ts";
import { build_camera_frame, type CameraView } from "@ink/camera/view.ts";
import { linear_rgb } from "@ink/materials/color.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import { light_id } from "./identity.ts";
import { create_light } from "./light.ts";
import type {
  LightDefinition,
  LightingQuality,
  ShadowPolicy,
} from "./model.ts";

export function camera_view(): CameraView {
  const camera: CameraDefinition = {
    id: camera_id("main"),
    pose: { position: vec3(0, 0, 0), rotation: quat_identity() },
    projection: {
      type: "perspective",
      near: 0.1,
      far: 100,
      depth: "standard",
      vertical_fov_radians: Math.PI / 2,
    },
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    layers: 1,
    order: 0,
    clear: { type: "load" },
  };
  const result = build_camera_frame({
    camera,
    surface: { width: 640, height: 360 },
    frame_index: 0,
  });
  if (result.type !== "ready") throw new Error(result.reason);
  return result.frame.view;
}

export function shadow_policy(
  type: "dynamic" | "cached" = "dynamic",
): ShadowPolicy {
  return {
    type,
    resolution: 512,
    depth_bias: 0.001,
    normal_bias: 0.01,
    filter: { type: "pcf", radius: 2 },
    update_interval_frames: 10,
  };
}

export function point_light(
  id: string,
  fields: Partial<Extract<LightDefinition, { type: "point" }>> = {},
): Extract<LightDefinition, { type: "point" }> {
  return create_light({
    id: light_id(id),
    revision: 0,
    type: "point",
    color: linear_rgb(1, 1, 1),
    layers: 1,
    importance: 1,
    shadow: { type: "off" },
    position: vec3(0, 0, 0),
    intensity_candela: 100,
    range: 100,
    source_radius: 0,
    ...fields,
  }) as Extract<LightDefinition, { type: "point" }>;
}

export function lighting_quality(): LightingQuality {
  return {
    clusters: {
      x_slices: 2,
      y_slices: 2,
      z_slices: 4,
      maximum_lights_per_cluster: 4,
    },
    shadows: {
      atlas_size: 1024,
      cascade_count: 3,
      cascade_lambda: 0.5,
      minimum_resolution: 128,
      maximum_shadowed_lights: 4,
      resolution_scale: 1,
      cached_update_interval_multiplier: 1,
    },
    maximum_lights: 32,
    maximum_probes: 4,
    environment_roughness_levels: 4,
  };
}

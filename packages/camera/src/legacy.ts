import { quat_identity } from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import { camera_id, type CameraDefinition } from "./model.ts";
import { build_camera_frame, type CameraView } from "./view.ts";

export type LegacyProjection = "perspective" | "orthographic";

export function legacy_preview_camera(
  projection: LegacyProjection,
  zoom: number,
  width: number,
  height: number,
): CameraView {
  if (projection !== "perspective" && projection !== "orthographic") {
    throw new Error(
      `legacy camera projection ${JSON.stringify(projection)} is invalid`,
    );
  }
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new Error(
      `legacy camera zoom ${JSON.stringify(zoom)} must be positive and finite`,
    );
  }
  const surface = {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
  const camera: CameraDefinition = {
    id: camera_id("development.preview"),
    pose: { position: vec3(0, 0, 6), rotation: quat_identity() },
    projection: projection === "perspective"
      ? {
        type: "perspective",
        vertical_fov_radians: 2 * Math.atan(surface.height / (840 * zoom)),
        near: 0.1,
        far: 100,
        depth: "standard",
      }
      : {
        type: "orthographic",
        vertical_size: 2 * surface.height / (140 * zoom),
        near: 0.1,
        far: 100,
        depth: "standard",
      },
    viewport: { x: 0, y: 0, width: 1, height: 1 },
    layers: 0xffff_ffff,
    order: 0,
    clear: { type: "load" },
  };
  const frame = build_camera_frame({
    camera,
    surface,
    frame_index: 0,
    jitter_scale_pixels: 0,
  });
  if (frame.type !== "ready") {
    throw new Error(
      frame.type === "invalid_projection"
        ? `legacy camera ${frame.field}: ${frame.reason}`
        : `legacy camera ${frame.operation}: ${frame.reason}`,
    );
  }
  return frame.frame.view;
}

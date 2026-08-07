import {
  type Frustum,
  frustum_from_view_projection,
} from "@ink/geometry/frustum.ts";
import { type Ray, ray } from "@ink/geometry/shapes.ts";
import { type Mat4, mat4_inverse, mat4_multiply } from "@ink/math/matrix.ts";
import {
  jitter_projection,
  orthographic_projection,
  perspective_projection,
  project_to_viewport,
  reversed_orthographic_projection,
  reversed_perspective_projection,
  unproject_from_viewport,
} from "@ink/math/projection.ts";
import { transform, transform_to_mat4 } from "@ink/math/transform.ts";
import {
  type Vec2,
  vec2,
  type Vec3,
  vec3,
  vec3_length,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  type CameraDefinition,
  type CameraId,
  type CameraPose,
  type CameraProjection,
  create_camera,
  type PixelViewport,
  type ProjectionFailure,
  type RenderSurfaceSize,
  resolve_viewport,
  surface_viewport,
} from "./model.ts";

export interface CameraView {
  readonly camera: CameraId;
  readonly pose: CameraPose;
  readonly viewport: PixelViewport;
  readonly layers: number;
  readonly projection: CameraProjection;
  readonly view_matrix: Mat4;
  readonly stable_projection_matrix: Mat4;
  readonly stable_view_projection: Mat4;
  readonly jittered_projection_matrix: Mat4;
  readonly jittered_view_projection: Mat4;
  readonly previous_stable_view_projection: Mat4;
  readonly previous_jittered_view_projection: Mat4;
  readonly jitter_pixels: Vec2;
  readonly culling_frustum: Frustum;
  readonly history_reset?: CameraHistoryReset;
}

export interface ViewFamily {
  readonly id: string;
  readonly views: readonly CameraView[];
}

export type CameraHistoryReset =
  | "initial"
  | "cut"
  | "resize"
  | "projection"
  | "teleport";

export interface CameraHistory {
  readonly camera: CameraId;
  readonly surface: RenderSurfaceSize;
  readonly projection_signature: string;
  readonly pose: CameraPose;
  readonly stable_view_projection: Mat4;
  readonly jittered_view_projection: Mat4;
}

export interface CameraFrame {
  readonly view: CameraView;
  readonly history: CameraHistory;
}

export interface CameraFrameRequest {
  readonly camera: CameraDefinition;
  readonly surface: RenderSurfaceSize;
  readonly frame_index: number;
  readonly previous?: CameraHistory;
  readonly cut?: true;
  readonly teleport_distance?: number;
  readonly jitter_scale_pixels?: number;
  readonly observer?: Observer;
}

export type CameraFrameResult =
  | { readonly type: "ready"; readonly frame: CameraFrame }
  | ProjectionFailure
  | {
    readonly type: "conversion_failed";
    readonly camera: CameraId;
    readonly operation: string;
    readonly reason: string;
  };

export type CameraConversionResult<Value> =
  | { readonly type: "ready"; readonly value: Value }
  | {
    readonly type: "conversion_failed";
    readonly camera: CameraId;
    readonly operation: string;
    readonly reason: string;
  };

export function build_camera_frame(
  request: CameraFrameRequest,
): CameraFrameResult {
  const parsed = create_camera(request.camera);
  if (parsed.type === "invalid_projection") return parsed;
  if (
    !Number.isSafeInteger(request.surface.width) ||
    request.surface.width <= 0 ||
    !Number.isSafeInteger(request.surface.height) || request.surface.height <= 0
  ) {
    return conversion_failure(
      request.camera.id,
      "build view",
      `render surface ${
        JSON.stringify(request.surface)
      } must have positive safe-integer dimensions`,
    );
  }
  if (!Number.isSafeInteger(request.frame_index) || request.frame_index < 0) {
    return conversion_failure(
      request.camera.id,
      "build view",
      `frame index ${
        JSON.stringify(request.frame_index)
      } must be a nonnegative safe integer`,
    );
  }
  const jitter_scale = request.jitter_scale_pixels ?? 1;
  if (!Number.isFinite(jitter_scale) || jitter_scale < 0) {
    return conversion_failure(
      request.camera.id,
      "build view",
      `jitter scale ${
        JSON.stringify(jitter_scale)
      } must be finite and nonnegative`,
    );
  }
  const teleport_distance = request.teleport_distance ?? 10;
  if (!Number.isFinite(teleport_distance) || teleport_distance < 0) {
    return conversion_failure(
      request.camera.id,
      "build view",
      `teleport distance ${
        JSON.stringify(teleport_distance)
      } must be finite and nonnegative`,
    );
  }
  const viewport = resolve_viewport(
    surface_viewport(request.surface),
    parsed.camera.viewport,
  );
  const view_inverse = mat4_inverse(transform_to_mat4(transform(
    parsed.camera.pose.position,
    parsed.camera.pose.rotation,
    vec3(1, 1, 1),
  )));
  if (!view_inverse.ok) {
    return conversion_failure(
      request.camera.id,
      "build view",
      `camera pose is singular at pivot ${view_inverse.pivot}`,
    );
  }
  let stable_projection: Mat4;
  let stable_view_projection: Mat4;
  let jitter_pixels: Vec2;
  let jittered_projection_matrix: Mat4;
  let jittered_view_projection: Mat4;
  let culling_frustum: Frustum;
  try {
    stable_projection = projection_matrix(
      parsed.camera.projection,
      viewport,
    );
    stable_view_projection = mat4_multiply(
      stable_projection,
      view_inverse.value,
    );
    jitter_pixels = temporal_jitter(request.frame_index, jitter_scale);
    const jitter_ndc = vec2(
      jitter_pixels.x * 2 / viewport.width,
      -jitter_pixels.y * 2 / viewport.height,
    );
    jittered_projection_matrix = jitter_projection(
      stable_projection,
      jitter_ndc,
    );
    jittered_view_projection = mat4_multiply(
      jittered_projection_matrix,
      view_inverse.value,
    );
    culling_frustum = frustum_from_view_projection(stable_view_projection);
  } catch (error) {
    return conversion_failure(
      request.camera.id,
      "build view",
      `camera matrices could not be constructed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const projection_signature = JSON.stringify(parsed.camera.projection);
  const history_reset = history_reset_reason(
    request,
    parsed.camera.pose,
    projection_signature,
  );
  const previous_stable_view_projection = history_reset === undefined
    ? request.previous!.stable_view_projection
    : stable_view_projection;
  const previous_jittered_view_projection = history_reset === undefined
    ? request.previous!.jittered_view_projection
    : jittered_view_projection;
  const view: CameraView = {
    camera: parsed.camera.id,
    pose: parsed.camera.pose,
    viewport,
    layers: parsed.camera.layers,
    projection: parsed.camera.projection,
    view_matrix: view_inverse.value,
    stable_projection_matrix: stable_projection,
    stable_view_projection,
    jittered_projection_matrix,
    jittered_view_projection,
    previous_stable_view_projection,
    previous_jittered_view_projection,
    jitter_pixels,
    culling_frustum,
    ...(history_reset === undefined ? {} : { history_reset }),
  };
  request.observer?.event("camera.view.created", {
    camera_id: parsed.camera.id,
    frame_index: request.frame_index,
    ...(history_reset === undefined ? {} : { history_reset }),
  });
  return {
    type: "ready",
    frame: {
      view,
      history: {
        camera: parsed.camera.id,
        surface: { ...request.surface },
        projection_signature,
        pose: parsed.camera.pose,
        stable_view_projection,
        jittered_view_projection,
      },
    },
  };
}

export function world_to_screen(
  view: CameraView,
  point: Vec3,
): CameraConversionResult<Vec3> {
  const result = project_to_viewport(
    point,
    view.stable_view_projection,
    view.viewport,
  );
  return result.ok
    ? { type: "ready", value: result.value }
    : conversion_failure(
      view.camera,
      "world to screen",
      `${result.reason} with evidence ${result.evidence}`,
    );
}

export function screen_to_world(
  view: CameraView,
  point: Vec3,
): CameraConversionResult<Vec3> {
  const result = unproject_from_viewport(
    point,
    view.stable_view_projection,
    view.viewport,
  );
  return result.ok
    ? { type: "ready", value: result.value }
    : conversion_failure(
      view.camera,
      "screen to world",
      `${result.reason} with evidence ${result.evidence}`,
    );
}

export function reconstruct_world_position(
  view: CameraView,
  x: number,
  y: number,
  depth: number,
): CameraConversionResult<Vec3> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return conversion_failure(
      view.camera,
      "depth reconstruction",
      `screen coordinates ${String(x)},${String(y)} must be finite`,
    );
  }
  if (!Number.isFinite(depth) || depth < 0 || depth > 1) {
    return conversion_failure(
      view.camera,
      "depth reconstruction",
      `depth ${JSON.stringify(depth)} must be finite and in 0..1`,
    );
  }
  return screen_to_world(view, vec3(x, y, depth));
}

export function screen_ray(
  view: CameraView,
  x: number,
  y: number,
): CameraConversionResult<Ray> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return conversion_failure(
      view.camera,
      "screen ray",
      `screen coordinates ${String(x)},${String(y)} must be finite`,
    );
  }
  const near_depth = view.projection.depth === "reversed" ? 1 : 0;
  const far_depth = view.projection.depth === "reversed" ? 0 : 1;
  const near = screen_to_world(view, vec3(x, y, near_depth));
  if (near.type === "conversion_failed") return near;
  const far = screen_to_world(view, vec3(x, y, far_depth));
  if (far.type === "conversion_failed") return far;
  const direction = vec3_subtract(far.value, near.value);
  if (vec3_length(direction) === 0) {
    return conversion_failure(
      view.camera,
      "screen ray",
      "near and far points are equal",
    );
  }
  return { type: "ready", value: ray(near.value, direction) };
}

export function temporal_jitter(frame_index: number, scale_pixels = 1): Vec2 {
  if (!Number.isSafeInteger(frame_index) || frame_index < 0) {
    throw new Error(
      `camera jitter frame ${JSON.stringify(frame_index)} must be nonnegative`,
    );
  }
  if (!Number.isFinite(scale_pixels) || scale_pixels < 0) {
    throw new Error(
      `camera jitter scale ${JSON.stringify(scale_pixels)} must be nonnegative`,
    );
  }
  const sample = frame_index % 8 + 1;
  return vec2(
    (halton(sample, 2) - 0.5) * scale_pixels,
    (halton(sample, 3) - 0.5) * scale_pixels,
  );
}

function projection_matrix(
  projection: CameraProjection,
  viewport: PixelViewport,
): Mat4 {
  if (projection.type === "custom") return projection.matrix;
  const aspect_ratio = viewport.width / viewport.height;
  if (projection.type === "orthographic") {
    const half_height = projection.vertical_size / 2;
    const value = {
      left: -half_height * aspect_ratio,
      right: half_height * aspect_ratio,
      bottom: -half_height,
      top: half_height,
      near_plane: projection.near,
      far_plane: projection.far,
    };
    return projection.depth === "reversed"
      ? reversed_orthographic_projection(value)
      : orthographic_projection(value);
  }
  const vertical_fov_radians = projection.type === "physical"
    ? 2 * Math.atan(
      projection.sensor_height_millimeters /
        (2 * projection.focal_length_millimeters),
    )
    : projection.vertical_fov_radians;
  const value = {
    vertical_fov_radians,
    aspect_ratio,
    near_plane: projection.near,
    far_plane: projection.far,
  };
  return projection.depth === "reversed"
    ? reversed_perspective_projection(value)
    : perspective_projection(value);
}

function history_reset_reason(
  request: CameraFrameRequest,
  pose: CameraPose,
  projection_signature: string,
): CameraHistoryReset | undefined {
  const previous = request.previous;
  if (previous === undefined || previous.camera !== request.camera.id) {
    return "initial";
  }
  if (request.cut) return "cut";
  if (
    previous.surface.width !== request.surface.width ||
    previous.surface.height !== request.surface.height
  ) return "resize";
  if (previous.projection_signature !== projection_signature) {
    return "projection";
  }
  const teleport_distance = request.teleport_distance ?? 10;
  if (
    vec3_length(vec3_subtract(previous.pose.position, pose.position)) >
      teleport_distance
  ) {
    return "teleport";
  }
  const rotation_alignment = Math.abs(
    previous.pose.rotation.x * pose.rotation.x +
      previous.pose.rotation.y * pose.rotation.y +
      previous.pose.rotation.z * pose.rotation.z +
      previous.pose.rotation.w * pose.rotation.w,
  );
  return rotation_alignment < Math.cos(Math.PI / 4) ? "teleport" : undefined;
}

function halton(index: number, base: number): number {
  let fraction = 1;
  let result = 0;
  let value = index;
  while (value > 0) {
    fraction /= base;
    result += fraction * (value % base);
    value = Math.floor(value / base);
  }
  return result;
}

function conversion_failure(
  camera: CameraId,
  operation: string,
  reason: string,
): Extract<CameraFrameResult, { type: "conversion_failed" }> {
  return { type: "conversion_failed", camera, operation, reason };
}

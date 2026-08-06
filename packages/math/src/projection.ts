import {
  type Mat4,
  mat4,
  mat4_inverse,
  mat4_transform_point,
} from "./matrix.ts";
import { finite_number } from "./scalar.ts";
import {
  type Vec2,
  type Vec3,
  vec3,
  vec3_cross,
  vec3_dot,
  vec3_normalize,
  vec3_subtract,
} from "./vector.ts";

export interface PerspectiveProjection {
  readonly vertical_fov_radians: number;
  readonly aspect_ratio: number;
  readonly near_plane: number;
  readonly far_plane: number;
}

export interface OrthographicProjection {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
  readonly near_plane: number;
  readonly far_plane: number;
}

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ViewportProjectionResult =
  | { readonly ok: true; readonly value: Vec3 }
  | {
    readonly ok: false;
    readonly reason: "zero_homogeneous_w" | "singular_matrix";
    readonly evidence: number;
  };

function validate_depth_range(near_plane: number, far_plane: number): void {
  finite_number(near_plane, "near plane");
  finite_number(far_plane, "far plane");
  if (near_plane <= 0 || far_plane <= near_plane) {
    throw new Error(
      `depth range requires 0 < near ${near_plane} < far ${far_plane}`,
    );
  }
}

export function perspective_projection(value: PerspectiveProjection): Mat4 {
  validate_depth_range(value.near_plane, value.far_plane);
  finite_number(value.vertical_fov_radians, "vertical field of view");
  finite_number(value.aspect_ratio, "aspect ratio");
  if (
    value.vertical_fov_radians <= 0 || value.vertical_fov_radians >= Math.PI
  ) {
    throw new Error(
      `vertical field of view must be between 0 and pi, received ${value.vertical_fov_radians}`,
    );
  }
  if (value.aspect_ratio <= 0) {
    throw new Error(
      `aspect ratio must be positive, received ${value.aspect_ratio}`,
    );
  }
  const focal_length = 1 / Math.tan(value.vertical_fov_radians / 2);
  const depth_scale = value.far_plane / (value.near_plane - value.far_plane);
  return mat4([
    focal_length / value.aspect_ratio,
    0,
    0,
    0,
    0,
    focal_length,
    0,
    0,
    0,
    0,
    depth_scale,
    -1,
    0,
    0,
    value.near_plane * depth_scale,
    0,
  ]);
}

export function reversed_perspective_projection(
  value: PerspectiveProjection,
): Mat4 {
  validate_depth_range(value.near_plane, value.far_plane);
  finite_number(value.vertical_fov_radians, "vertical field of view");
  finite_number(value.aspect_ratio, "aspect ratio");
  if (
    value.vertical_fov_radians <= 0 || value.vertical_fov_radians >= Math.PI
  ) {
    throw new Error(
      `vertical field of view must be between 0 and pi, received ${value.vertical_fov_radians}`,
    );
  }
  if (value.aspect_ratio <= 0) {
    throw new Error(
      `aspect ratio must be positive, received ${value.aspect_ratio}`,
    );
  }
  const focal_length = 1 / Math.tan(value.vertical_fov_radians / 2);
  const depth_scale = value.near_plane / (value.far_plane - value.near_plane);
  return mat4([
    focal_length / value.aspect_ratio,
    0,
    0,
    0,
    0,
    focal_length,
    0,
    0,
    0,
    0,
    depth_scale,
    -1,
    0,
    0,
    value.far_plane * depth_scale,
    0,
  ]);
}

function validate_orthographic(value: OrthographicProjection): void {
  validate_depth_range(value.near_plane, value.far_plane);
  finite_number(value.left, "left bound");
  finite_number(value.right, "right bound");
  finite_number(value.bottom, "bottom bound");
  finite_number(value.top, "top bound");
  if (value.left === value.right) {
    throw new Error(`orthographic left and right are both ${value.left}`);
  }
  if (value.bottom === value.top) {
    throw new Error(`orthographic bottom and top are both ${value.bottom}`);
  }
}

export function orthographic_projection(value: OrthographicProjection): Mat4 {
  validate_orthographic(value);
  return mat4([
    2 / (value.right - value.left),
    0,
    0,
    0,
    0,
    2 / (value.top - value.bottom),
    0,
    0,
    0,
    0,
    1 / (value.near_plane - value.far_plane),
    0,
    -(value.right + value.left) / (value.right - value.left),
    -(value.top + value.bottom) / (value.top - value.bottom),
    value.near_plane / (value.near_plane - value.far_plane),
    1,
  ]);
}

export function reversed_orthographic_projection(
  value: OrthographicProjection,
): Mat4 {
  validate_orthographic(value);
  return mat4([
    2 / (value.right - value.left),
    0,
    0,
    0,
    0,
    2 / (value.top - value.bottom),
    0,
    0,
    0,
    0,
    1 / (value.far_plane - value.near_plane),
    0,
    -(value.right + value.left) / (value.right - value.left),
    -(value.top + value.bottom) / (value.top - value.bottom),
    value.far_plane / (value.far_plane - value.near_plane),
    1,
  ]);
}

export function jitter_projection(projection: Mat4, jitter_ndc: Vec2): Mat4 {
  const jittered = [...projection];
  for (let column = 0; column < 4; column++) {
    jittered[column * 4] += jitter_ndc.x * projection[column * 4 + 3];
    jittered[column * 4 + 1] += jitter_ndc.y * projection[column * 4 + 3];
  }
  return mat4(jittered);
}

export function look_at_view(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const backward = vec3_normalize(vec3_subtract(eye, target));
  const right = vec3_normalize(vec3_cross(up, backward));
  const camera_up = vec3_cross(backward, right);
  return mat4([
    right.x,
    camera_up.x,
    backward.x,
    0,
    right.y,
    camera_up.y,
    backward.y,
    0,
    right.z,
    camera_up.z,
    backward.z,
    0,
    -vec3_dot(right, eye),
    -vec3_dot(camera_up, eye),
    -vec3_dot(backward, eye),
    1,
  ]);
}

function validate_viewport(viewport: Viewport): void {
  finite_number(viewport.x, "viewport.x");
  finite_number(viewport.y, "viewport.y");
  finite_number(viewport.width, "viewport.width");
  finite_number(viewport.height, "viewport.height");
  if (viewport.width <= 0 || viewport.height <= 0) {
    throw new Error(
      `viewport dimensions must be positive, received ${viewport.width}x${viewport.height}`,
    );
  }
}

export function project_to_viewport(
  point: Vec3,
  view_projection: Mat4,
  viewport: Viewport,
): ViewportProjectionResult {
  validate_viewport(viewport);
  const projected = mat4_transform_point(view_projection, point);
  if (!projected.ok) {
    return { ok: false, reason: "zero_homogeneous_w", evidence: projected.w };
  }
  return {
    ok: true,
    value: vec3(
      viewport.x + (projected.value.x + 1) * viewport.width / 2,
      viewport.y + (1 - projected.value.y) * viewport.height / 2,
      projected.value.z,
    ),
  };
}

export function unproject_from_viewport(
  point: Vec3,
  view_projection: Mat4,
  viewport: Viewport,
): ViewportProjectionResult {
  validate_viewport(viewport);
  const inverse = mat4_inverse(view_projection);
  if (!inverse.ok) {
    return { ok: false, reason: "singular_matrix", evidence: inverse.pivot };
  }
  const ndc = vec3(
    (point.x - viewport.x) * 2 / viewport.width - 1,
    1 - (point.y - viewport.y) * 2 / viewport.height,
    point.z,
  );
  const unprojected = mat4_transform_point(inverse.value, ndc);
  if (!unprojected.ok) {
    return { ok: false, reason: "zero_homogeneous_w", evidence: unprojected.w };
  }
  return unprojected;
}

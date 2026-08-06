import type { CameraView } from "@ink/camera/view.ts";
import {
  mat4_transform_affine_point,
  mat4_transform_point,
} from "@ink/math/matrix.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { VisibleSet } from "@ink/visibility/model.ts";
import type { LightId } from "./identity.ts";
import { light_affects_layers, light_bounds } from "./light.ts";
import type { ClusterQuality, LightDefinition } from "./model.ts";

export interface LightCluster {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly lights: readonly LightId[];
  readonly overflow: readonly LightId[];
}

export interface ClusteredLightPlan {
  readonly camera: CameraView["camera"];
  readonly grid: ClusterQuality;
  readonly clusters: readonly LightCluster[];
  readonly selected_lights: readonly LightId[];
  readonly global_overflow: readonly LightId[];
  readonly cluster_overflow_count: number;
  readonly visibility_revision?: VisibleSet["input_revision"];
}

export interface ClusteredLightInput {
  readonly view: CameraView;
  readonly lights: readonly LightDefinition[];
  readonly grid: ClusterQuality;
  readonly maximum_lights: number;
  readonly visibility_revision?: VisibleSet["input_revision"];
  readonly observer?: Observer;
}

interface ClusterSpan {
  readonly minimum_x: number;
  readonly maximum_x: number;
  readonly minimum_y: number;
  readonly maximum_y: number;
  readonly minimum_z: number;
  readonly maximum_z: number;
}

function validate_grid(grid: ClusterQuality): void {
  for (const [field, value] of Object.entries(grid)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `lighting cluster ${field} ${value} must be a positive safe integer`,
      );
    }
  }
}

function clamp_index(value: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor(value)));
}

function depth_slice(
  depth: number,
  near: number,
  far: number,
  count: number,
): number {
  if (depth <= near) return 0;
  if (depth >= far) return count - 1;
  return clamp_index(
    Math.log(depth / near) / Math.log(far / near) * count,
    count,
  );
}

function span_for_light(
  light: LightDefinition,
  view: CameraView,
  grid: ClusterQuality,
): ClusterSpan | null {
  if (light.type === "environment") return null;
  if (light.type === "directional") {
    return {
      minimum_x: 0,
      maximum_x: grid.x_slices - 1,
      minimum_y: 0,
      maximum_y: grid.y_slices - 1,
      minimum_z: 0,
      maximum_z: grid.z_slices - 1,
    };
  }
  const bounds = light_bounds(light)!;
  const view_center = mat4_transform_affine_point(
    view.view_matrix,
    bounds.center,
  );
  const depth = -view_center.z;
  const near = view.projection.near;
  const far = view.projection.far;
  if (depth + bounds.radius < near || depth - bounds.radius > far) return null;
  const projected = mat4_transform_point(
    view.stable_view_projection,
    bounds.center,
  );
  if (!projected.ok) return null;
  const safe_depth = Math.max(near, depth);
  const radius_x = Math.abs(view.stable_projection_matrix[0]) * bounds.radius /
    safe_depth;
  const radius_y = Math.abs(view.stable_projection_matrix[5]) * bounds.radius /
    safe_depth;
  return {
    minimum_x: clamp_index(
      (projected.value.x - radius_x + 1) * 0.5 * grid.x_slices,
      grid.x_slices,
    ),
    maximum_x: clamp_index(
      (projected.value.x + radius_x + 1) * 0.5 * grid.x_slices,
      grid.x_slices,
    ),
    minimum_y: clamp_index(
      (1 - (projected.value.y + radius_y)) * 0.5 * grid.y_slices,
      grid.y_slices,
    ),
    maximum_y: clamp_index(
      (1 - (projected.value.y - radius_y)) * 0.5 * grid.y_slices,
      grid.y_slices,
    ),
    minimum_z: depth_slice(
      Math.max(near, depth - bounds.radius),
      near,
      far,
      grid.z_slices,
    ),
    maximum_z: depth_slice(
      Math.min(far, depth + bounds.radius),
      near,
      far,
      grid.z_slices,
    ),
  };
}

export function build_clustered_light_plan(
  input: ClusteredLightInput,
): ClusteredLightPlan {
  validate_grid(input.grid);
  if (
    !Number.isSafeInteger(input.maximum_lights) || input.maximum_lights <= 0
  ) {
    throw new Error(
      `lighting maximum lights ${input.maximum_lights} must be a positive safe integer`,
    );
  }
  const eligible = input.lights
    .filter((light) =>
      light.type !== "environment" &&
      light_affects_layers(light, input.view.layers)
    )
    .sort((left, right) =>
      right.importance - left.importance || left.id.localeCompare(right.id)
    );
  const selected = eligible.slice(0, input.maximum_lights);
  const global_overflow = eligible.slice(input.maximum_lights).map(({ id }) =>
    id
  );
  const cluster_count = input.grid.x_slices * input.grid.y_slices *
    input.grid.z_slices;
  const memberships = Array.from(
    { length: cluster_count },
    () => [] as LightId[],
  );
  for (const light of selected) {
    const span = span_for_light(light, input.view, input.grid);
    if (span === null) continue;
    for (let z = span.minimum_z; z <= span.maximum_z; z += 1) {
      for (let y = span.minimum_y; y <= span.maximum_y; y += 1) {
        for (let x = span.minimum_x; x <= span.maximum_x; x += 1) {
          const index = x + input.grid.x_slices * (y + input.grid.y_slices * z);
          memberships[index].push(light.id);
        }
      }
    }
  }
  let cluster_overflow_count = 0;
  const clusters = memberships.map((lights, index) => {
    const accepted = lights.slice(0, input.grid.maximum_lights_per_cluster);
    const overflow = lights.slice(input.grid.maximum_lights_per_cluster);
    cluster_overflow_count += overflow.length;
    const plane = input.grid.x_slices * input.grid.y_slices;
    const z = Math.floor(index / plane);
    const within_plane = index - z * plane;
    const y = Math.floor(within_plane / input.grid.x_slices);
    const x = within_plane - y * input.grid.x_slices;
    return Object.freeze({
      index,
      x,
      y,
      z,
      lights: Object.freeze(accepted),
      overflow: Object.freeze(overflow),
    });
  });
  input.observer?.event("lighting.clusters.built", {
    camera_id: input.view.camera,
    light_count: selected.length,
    cluster_count,
    global_overflow: global_overflow.length,
    cluster_overflow: cluster_overflow_count,
    ...(input.visibility_revision === undefined
      ? {}
      : { visibility_revision: input.visibility_revision }),
  });
  return Object.freeze({
    camera: input.view.camera,
    grid: Object.freeze(structuredClone(input.grid)),
    clusters: Object.freeze(clusters),
    selected_lights: Object.freeze(selected.map(({ id }) => id)),
    global_overflow: Object.freeze(global_overflow),
    cluster_overflow_count,
    ...(input.visibility_revision === undefined
      ? {}
      : { visibility_revision: input.visibility_revision }),
  });
}

export function cluster_index_for_fragment(
  plan: ClusteredLightPlan,
  pixel_x: number,
  pixel_y: number,
  linear_depth: number,
  viewport_width: number,
  viewport_height: number,
  near: number,
  far: number,
): number {
  if (
    ![
      pixel_x,
      pixel_y,
      linear_depth,
      viewport_width,
      viewport_height,
      near,
      far,
    ]
      .every(Number.isFinite) ||
    viewport_width <= 0 || viewport_height <= 0 ||
    near <= 0 || far <= near
  ) {
    throw new Error(
      `cluster fragment (${pixel_x}, ${pixel_y}, depth ${linear_depth}) has invalid viewport ${viewport_width}x${viewport_height} or range [${near}, ${far}]`,
    );
  }
  const x = clamp_index(
    pixel_x / viewport_width * plan.grid.x_slices,
    plan.grid.x_slices,
  );
  const y = clamp_index(
    pixel_y / viewport_height * plan.grid.y_slices,
    plan.grid.y_slices,
  );
  const z = depth_slice(linear_depth, near, far, plan.grid.z_slices);
  return x + plan.grid.x_slices * (y + plan.grid.y_slices * z);
}

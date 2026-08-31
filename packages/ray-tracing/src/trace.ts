import { ray_aabb_intersection } from "@ink/geometry/queries.ts";
import { type Ray, ray } from "@ink/geometry/shapes.ts";
import {
  mat4_transform_affine_point,
  mat4_transform_direction,
  mat4_transform_normal,
} from "@ink/math/matrix.ts";
import {
  vec2,
  vec3_add,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import {
  type PackedRayTracingBvhNode,
  type PackedRayTracingScene,
  type PackedRayTracingTriangle,
  ray_tracing_missing_node,
  type RayTracingHit,
} from "./model.ts";

interface LocalTriangleHit {
  readonly distance: number;
  readonly b: number;
  readonly c: number;
}

interface NearestRayTracingHit {
  readonly hit: RayTracingHit;
  readonly instance_index: number;
  readonly triangle_index: number;
}

export function trace_ray(
  scene: PackedRayTracingScene,
  cast: Ray,
  maximum_distance = Infinity,
): RayTracingHit | null {
  if (Number.isNaN(maximum_distance) || maximum_distance < 0) {
    throw new Error(
      `ray tracing maximum distance ${
        String(maximum_distance)
      } must be nonnegative`,
    );
  }
  if (scene.tlas_root === null) return null;
  const candidate_instances = bvh_candidates(
    scene.tlas,
    scene.tlas_indices,
    scene.tlas_root,
    cast,
  );
  let nearest: NearestRayTracingHit | null = null;
  for (const instance_index of candidate_instances) {
    const instance = scene.instances[instance_index];
    const geometry = scene.geometries[instance.geometry_index];
    const local_ray = ray(
      mat4_transform_affine_point(instance.inverse_transform, cast.origin),
      mat4_transform_direction(instance.inverse_transform, cast.direction),
    );
    const candidate_triangles = bvh_candidates(
      scene.blas,
      scene.blas_indices,
      geometry.blas_root,
      local_ray,
    );
    for (const triangle_index of candidate_triangles) {
      const triangle = scene.triangles[triangle_index];
      const local_hit = intersect_triangle(local_ray, triangle);
      if (local_hit === null) continue;
      const local_position = vec3_add(
        local_ray.origin,
        vec3_scale(local_ray.direction, local_hit.distance),
      );
      const position = mat4_transform_affine_point(
        instance.transform,
        local_position,
      );
      const distance = vec3_length(vec3_subtract(position, cast.origin));
      if (distance > maximum_distance) continue;
      if (
        nearest !== null &&
        (distance > nearest.hit.distance ||
          (distance === nearest.hit.distance &&
            (instance_index > nearest.instance_index ||
              (instance_index === nearest.instance_index &&
                triangle_index >= nearest.triangle_index))))
      ) continue;

      const world_a = mat4_transform_affine_point(
        instance.transform,
        triangle.a,
      );
      const world_b = mat4_transform_affine_point(
        instance.transform,
        triangle.b,
      );
      const world_c = mat4_transform_affine_point(
        instance.transform,
        triangle.c,
      );
      const geometric_normal = vec3_normalize(
        vec3_cross(
          vec3_subtract(world_b, world_a),
          vec3_subtract(world_c, world_a),
        ),
      );
      const front_face = vec3_dot(geometric_normal, cast.direction) < 0;
      const barycentric_a = 1 - local_hit.b - local_hit.c;
      const shading_normal = world_shading_normal(
        triangle,
        instance.transform,
        geometric_normal,
        barycentric_a,
        local_hit.b,
        local_hit.c,
      );
      nearest = Object.freeze({
        hit: Object.freeze({
          distance,
          position,
          normal: front_face ? shading_normal : vec3_scale(shading_normal, -1),
          front_face,
          barycentrics: Object.freeze({
            a: barycentric_a,
            b: local_hit.b,
            c: local_hit.c,
          }),
          texture_coordinate: triangle.texture_coordinates === null
            ? null
            : vec2(
              triangle.texture_coordinates[0].x * barycentric_a +
                triangle.texture_coordinates[1].x * local_hit.b +
                triangle.texture_coordinates[2].x * local_hit.c,
              triangle.texture_coordinates[0].y * barycentric_a +
                triangle.texture_coordinates[1].y * local_hit.b +
                triangle.texture_coordinates[2].y * local_hit.c,
            ),
          geometry: geometry.id,
          instance: instance.id,
          material: scene.materials[triangle.material_index].identity,
          source_triangle: triangle.source_triangle,
        }),
        instance_index,
        triangle_index,
      });
    }
  }
  return nearest?.hit ?? null;
}

function world_shading_normal(
  triangle: PackedRayTracingTriangle,
  transform: PackedRayTracingScene["instances"][number]["transform"],
  geometric_normal: ReturnType<typeof vec3_normalize>,
  barycentric_a: number,
  barycentric_b: number,
  barycentric_c: number,
): ReturnType<typeof vec3_normalize> {
  if (triangle.vertex_normals === null) return geometric_normal;
  const [a, b, c] = triangle.vertex_normals;
  const local_normal = vec3_normalize(vec3_add(
    vec3_add(
      vec3_scale(a, barycentric_a),
      vec3_scale(b, barycentric_b),
    ),
    vec3_scale(c, barycentric_c),
  ));
  const transformed = mat4_transform_normal(transform, local_normal);
  if (!transformed.ok) {
    throw new Error("packed ray tracing instance transform became singular");
  }
  const normal = vec3_normalize(transformed.value);
  return vec3_dot(normal, geometric_normal) < 0
    ? vec3_scale(normal, -1)
    : normal;
}

function bvh_candidates(
  nodes: readonly PackedRayTracingBvhNode[],
  indices: readonly number[],
  root: number,
  cast: Ray,
): readonly number[] {
  const candidates: number[] = [];
  let node_index = root;
  while (node_index !== ray_tracing_missing_node) {
    const node = nodes[node_index];
    if (ray_aabb_intersection(cast, node.bounds) === null) {
      node_index = node.escape;
      continue;
    }
    if (node.type === "branch") {
      node_index = node.left;
      continue;
    }
    for (
      let index = node.first_index;
      index < node.first_index + node.index_count;
      index++
    ) candidates.push(indices[index]);
    node_index = node.escape;
  }
  return candidates;
}

function intersect_triangle(
  cast: Ray,
  triangle: PackedRayTracingTriangle,
): LocalTriangleHit | null {
  const edge_ab = vec3_subtract(triangle.b, triangle.a);
  const edge_ac = vec3_subtract(triangle.c, triangle.a);
  const perpendicular = vec3_cross(cast.direction, edge_ac);
  const determinant = vec3_dot(edge_ab, perpendicular);
  if (Math.abs(determinant) <= 1e-8) return null;
  const inverse_determinant = 1 / determinant;
  const origin_offset = vec3_subtract(cast.origin, triangle.a);
  const b = vec3_dot(origin_offset, perpendicular) * inverse_determinant;
  if (b < 0 || b > 1) return null;
  const cross = vec3_cross(origin_offset, edge_ab);
  const c = vec3_dot(cast.direction, cross) * inverse_determinant;
  if (c < 0 || b + c > 1) return null;
  const distance = vec3_dot(edge_ac, cross) * inverse_determinant;
  if (distance < 0) return null;
  return { distance, b, c };
}

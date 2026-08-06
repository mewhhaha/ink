import type { Vec2, Vec3, Vec4 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_add,
  vec3_cross,
  vec3_dot,
  vec3_length_squared,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
  vec4,
} from "@ink/math/vector.ts";
import type { Aabb } from "./shapes.ts";
import { aabb_from_points } from "./shapes.ts";

declare const mesh_topology_brand: unique symbol;

export interface MeshTopology {
  readonly positions: readonly Vec3[];
  readonly indices: readonly number[];
  readonly texture_coordinates: readonly Vec2[] | null;
  readonly triangle_count: number;
  readonly [mesh_topology_brand]: true;
}

export interface TriangleAdjacency {
  readonly triangle: number;
  readonly neighbors: readonly [number | null, number | null, number | null];
}

export function mesh_topology(
  positions: readonly Vec3[],
  indices: readonly number[],
  texture_coordinates: readonly Vec2[] | null = null,
): MeshTopology {
  if (positions.length < 3) {
    throw new Error(
      `mesh requires at least 3 positions, received ${positions.length}`,
    );
  }
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new Error(
      `mesh index count ${indices.length} must be a positive multiple of 3`,
    );
  }
  if (
    texture_coordinates !== null &&
    texture_coordinates.length !== positions.length
  ) {
    throw new Error(
      `mesh has ${positions.length} positions but ${texture_coordinates.length} texture coordinates`,
    );
  }
  const copied_indices = indices.map((index, corner) => {
    if (
      !Number.isSafeInteger(index) || index < 0 || index >= positions.length
    ) {
      throw new Error(
        `mesh corner ${corner} references position ${
          String(index)
        } outside 0..${positions.length - 1}`,
      );
    }
    return index;
  });
  for (
    let triangle_index = 0;
    triangle_index < copied_indices.length / 3;
    triangle_index++
  ) {
    const offset = triangle_index * 3;
    const a = positions[copied_indices[offset]];
    const b = positions[copied_indices[offset + 1]];
    const c = positions[copied_indices[offset + 2]];
    if (
      vec3_length_squared(
        vec3_cross(vec3_subtract(b, a), vec3_subtract(c, a)),
      ) === 0
    ) {
      throw new Error(`mesh triangle ${triangle_index} has zero area`);
    }
  }
  return Object.freeze({
    positions: Object.freeze([...positions]),
    indices: Object.freeze(copied_indices),
    texture_coordinates: texture_coordinates === null
      ? null
      : Object.freeze([...texture_coordinates]),
    triangle_count: copied_indices.length / 3,
  }) as MeshTopology;
}

export function mesh_bounds(topology: MeshTopology): Aabb {
  return aabb_from_points(topology.positions);
}

export function generate_vertex_normals(
  topology: MeshTopology,
): readonly Vec3[] {
  const accumulated = Array.from(
    { length: topology.positions.length },
    () => vec3(0, 0, 0),
  );
  for (
    let triangle_index = 0;
    triangle_index < topology.triangle_count;
    triangle_index++
  ) {
    const offset = triangle_index * 3;
    const a_index = topology.indices[offset];
    const b_index = topology.indices[offset + 1];
    const c_index = topology.indices[offset + 2];
    const a = topology.positions[a_index];
    const b = topology.positions[b_index];
    const c = topology.positions[c_index];
    const weighted_normal = vec3_cross(
      vec3_subtract(b, a),
      vec3_subtract(c, a),
    );
    accumulated[a_index] = vec3_add(accumulated[a_index], weighted_normal);
    accumulated[b_index] = vec3_add(accumulated[b_index], weighted_normal);
    accumulated[c_index] = vec3_add(accumulated[c_index], weighted_normal);
  }
  return Object.freeze(accumulated.map((normal, position) => {
    if (vec3_length_squared(normal) === 0) {
      throw new Error(
        `mesh position ${position} has no incident surface normal`,
      );
    }
    return vec3_normalize(normal);
  }));
}

export function generate_vertex_tangents(
  topology: MeshTopology,
  normals: readonly Vec3[],
): readonly Vec4[] {
  if (topology.texture_coordinates === null) {
    throw new Error("cannot generate tangents without texture coordinates");
  }
  if (normals.length !== topology.positions.length) {
    throw new Error(
      `mesh has ${topology.positions.length} positions but ${normals.length} normals`,
    );
  }
  const tangent_sums = Array.from(
    { length: topology.positions.length },
    () => vec3(0, 0, 0),
  );
  const bitangent_sums = Array.from(
    { length: topology.positions.length },
    () => vec3(0, 0, 0),
  );
  for (
    let triangle_index = 0;
    triangle_index < topology.triangle_count;
    triangle_index++
  ) {
    const offset = triangle_index * 3;
    const indices = [
      topology.indices[offset],
      topology.indices[offset + 1],
      topology.indices[offset + 2],
    ] as const;
    const a = topology.positions[indices[0]];
    const b = topology.positions[indices[1]];
    const c = topology.positions[indices[2]];
    const uv_a = topology.texture_coordinates[indices[0]];
    const uv_b = topology.texture_coordinates[indices[1]];
    const uv_c = topology.texture_coordinates[indices[2]];
    const edge_ab = vec3_subtract(b, a);
    const edge_ac = vec3_subtract(c, a);
    const uv_ab_x = uv_b.x - uv_a.x;
    const uv_ab_y = uv_b.y - uv_a.y;
    const uv_ac_x = uv_c.x - uv_a.x;
    const uv_ac_y = uv_c.y - uv_a.y;
    const determinant = uv_ab_x * uv_ac_y - uv_ab_y * uv_ac_x;
    if (determinant === 0) {
      throw new Error(
        `mesh triangle ${triangle_index} has degenerate texture coordinates`,
      );
    }
    const reciprocal = 1 / determinant;
    const tangent = vec3_scale(
      vec3_subtract(vec3_scale(edge_ab, uv_ac_y), vec3_scale(edge_ac, uv_ab_y)),
      reciprocal,
    );
    const bitangent = vec3_scale(
      vec3_subtract(vec3_scale(edge_ac, uv_ab_x), vec3_scale(edge_ab, uv_ac_x)),
      reciprocal,
    );
    for (const index of indices) {
      tangent_sums[index] = vec3_add(tangent_sums[index], tangent);
      bitangent_sums[index] = vec3_add(bitangent_sums[index], bitangent);
    }
  }
  return Object.freeze(normals.map((normal, index) => {
    const orthogonal = vec3_subtract(
      tangent_sums[index],
      vec3_scale(normal, vec3_dot(normal, tangent_sums[index])),
    );
    if (vec3_length_squared(orthogonal) === 0) {
      throw new Error(`mesh position ${index} has no stable tangent`);
    }
    const tangent = vec3_normalize(orthogonal);
    const handedness =
      vec3_dot(vec3_cross(normal, tangent), bitangent_sums[index]) < 0 ? -1 : 1;
    return vec4(tangent.x, tangent.y, tangent.z, handedness);
  }));
}

export function reverse_mesh_winding(topology: MeshTopology): MeshTopology {
  const indices: number[] = [];
  for (let offset = 0; offset < topology.indices.length; offset += 3) {
    indices.push(
      topology.indices[offset],
      topology.indices[offset + 2],
      topology.indices[offset + 1],
    );
  }
  return mesh_topology(
    topology.positions,
    indices,
    topology.texture_coordinates,
  );
}

export function generate_triangle_adjacency(
  topology: MeshTopology,
): readonly TriangleAdjacency[] {
  const neighbors: [number | null, number | null, number | null][] = Array.from(
    { length: topology.triangle_count },
    () => [null, null, null],
  );
  const unmatched_edges = new Map<string, { triangle: number; edge: number }>();
  const closed_edges = new Set<string>();
  for (
    let triangle_index = 0;
    triangle_index < topology.triangle_count;
    triangle_index++
  ) {
    const offset = triangle_index * 3;
    const vertices = [
      topology.indices[offset],
      topology.indices[offset + 1],
      topology.indices[offset + 2],
    ] as const;
    for (let edge = 0; edge < 3; edge++) {
      const start = vertices[edge];
      const finish = vertices[(edge + 1) % 3];
      const key = start < finish ? `${start}:${finish}` : `${finish}:${start}`;
      if (closed_edges.has(key)) {
        throw new Error(
          `mesh edge ${key} is non-manifold at triangle ${triangle_index}`,
        );
      }
      const match = unmatched_edges.get(key);
      if (match === undefined) {
        unmatched_edges.set(key, { triangle: triangle_index, edge });
        continue;
      }
      neighbors[triangle_index][edge] = match.triangle;
      neighbors[match.triangle][match.edge] = triangle_index;
      unmatched_edges.delete(key);
      closed_edges.add(key);
    }
  }
  return Object.freeze(
    neighbors.map((triangle_neighbors, triangle_index) =>
      Object.freeze({
        triangle: triangle_index,
        neighbors: Object.freeze(triangle_neighbors),
      })
    ),
  );
}

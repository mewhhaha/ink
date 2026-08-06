import { mesh_topology, type MeshTopology } from "@ink/geometry/mesh.ts";
import { finite_number } from "@ink/math/scalar.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3, vec3_lerp } from "@ink/math/vector.ts";
import type { SignedDistanceField } from "./sdf.ts";

export interface DistanceMeshingRecipe {
  readonly field: SignedDistanceField;
  readonly minimum: Vec3;
  readonly maximum: Vec3;
  readonly cells_x: number;
  readonly cells_y: number;
  readonly cells_z: number;
  readonly iso_level?: number;
}

const cube_corners = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;

const cube_tetrahedra = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
] as const;

export function polygonize_distance_field(
  recipe: DistanceMeshingRecipe,
): MeshTopology {
  const cells_x = grid_size(recipe.cells_x, "distance mesh cells x");
  const cells_y = grid_size(recipe.cells_y, "distance mesh cells y");
  const cells_z = grid_size(recipe.cells_z, "distance mesh cells z");
  const iso_level = finite_number(
    recipe.iso_level ?? 0,
    "distance mesh iso level",
  );
  if (
    recipe.minimum.x >= recipe.maximum.x ||
    recipe.minimum.y >= recipe.maximum.y ||
    recipe.minimum.z >= recipe.maximum.z
  ) {
    throw new Error(
      `distance mesh bounds (${recipe.minimum.x}, ${recipe.minimum.y}, ${recipe.minimum.z})..(${recipe.maximum.x}, ${recipe.maximum.y}, ${recipe.maximum.z}) must have positive volume`,
    );
  }
  const step = vec3(
    (recipe.maximum.x - recipe.minimum.x) / cells_x,
    (recipe.maximum.y - recipe.minimum.y) / cells_y,
    (recipe.maximum.z - recipe.minimum.z) / cells_z,
  );
  const positions: Vec3[] = [];
  const indices: number[] = [];
  for (let z = 0; z < cells_z; z += 1) {
    for (let y = 0; y < cells_y; y += 1) {
      for (let x = 0; x < cells_x; x += 1) {
        const corners = cube_corners.map(([offset_x, offset_y, offset_z]) =>
          vec3(
            recipe.minimum.x + (x + offset_x) * step.x,
            recipe.minimum.y + (y + offset_y) * step.y,
            recipe.minimum.z + (z + offset_z) * step.z,
          )
        );
        const distances = corners.map((corner, corner_index) =>
          finite_number(
            recipe.field.sample(corner) - iso_level,
            `distance mesh sample cell (${x}, ${y}, ${z}) corner ${corner_index}`,
          )
        );
        for (const tetrahedron of cube_tetrahedra) {
          polygonize_tetrahedron(
            tetrahedron.map((corner) => corners[corner]),
            tetrahedron.map((corner) => distances[corner]),
            positions,
            indices,
          );
        }
      }
    }
  }
  if (indices.length === 0) {
    throw new Error(
      `distance mesh iso level ${iso_level} does not cross the sampled field`,
    );
  }
  return mesh_topology(positions, indices);
}

function polygonize_tetrahedron(
  corners: readonly Vec3[],
  distances: readonly number[],
  positions: Vec3[],
  indices: number[],
): void {
  const inside = [0, 1, 2, 3].filter((index) => distances[index] <= 0);
  const outside = [0, 1, 2, 3].filter((index) => distances[index] > 0);
  if (inside.length === 0 || inside.length === 4) return;
  if (inside.length === 1) {
    append_triangle(
      outside.map((outside_index) =>
        edge_crossing(
          corners[inside[0]],
          distances[inside[0]],
          corners[outside_index],
          distances[outside_index],
        )
      ),
      positions,
      indices,
    );
    return;
  }
  if (inside.length === 3) {
    append_triangle(
      inside.map((inside_index) =>
        edge_crossing(
          corners[outside[0]],
          distances[outside[0]],
          corners[inside_index],
          distances[inside_index],
        )
      ).reverse(),
      positions,
      indices,
    );
    return;
  }
  const first = edge_crossing(
    corners[inside[0]],
    distances[inside[0]],
    corners[outside[0]],
    distances[outside[0]],
  );
  const second = edge_crossing(
    corners[inside[0]],
    distances[inside[0]],
    corners[outside[1]],
    distances[outside[1]],
  );
  const third = edge_crossing(
    corners[inside[1]],
    distances[inside[1]],
    corners[outside[0]],
    distances[outside[0]],
  );
  const fourth = edge_crossing(
    corners[inside[1]],
    distances[inside[1]],
    corners[outside[1]],
    distances[outside[1]],
  );
  append_triangle([first, second, third], positions, indices);
  append_triangle([second, fourth, third], positions, indices);
}

function edge_crossing(
  start: Vec3,
  start_distance: number,
  finish: Vec3,
  finish_distance: number,
): Vec3 {
  const denominator = start_distance - finish_distance;
  const amount = denominator === 0 ? 0.5 : start_distance / denominator;
  return vec3_lerp(start, finish, amount);
}

function append_triangle(
  triangle: readonly Vec3[],
  positions: Vec3[],
  indices: number[],
): void {
  const start = positions.length;
  positions.push(triangle[0], triangle[1], triangle[2]);
  indices.push(start, start + 1, start + 2);
}

function grid_size(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} ${value} must be a positive safe integer`);
  }
  return value;
}

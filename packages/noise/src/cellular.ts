import { type Vec2, vec2, type Vec3, vec3 } from "@ink/math/vector.ts";
import {
  finite_position,
  type NoiseInput1d,
  type NoiseInput2d,
  type NoiseInput3d,
} from "./domain.ts";
import { hash_u32, hash_unit } from "./hash.ts";
import { wrap_lattice } from "./internal.ts";

export type CellularDistance = "euclidean" | "manhattan" | "chebyshev";

export interface CellularInput1d extends NoiseInput1d {
  readonly distance?: CellularDistance;
}

export interface CellularInput2d extends NoiseInput2d {
  readonly distance?: CellularDistance;
}

export interface CellularInput3d extends NoiseInput3d {
  readonly distance?: CellularDistance;
}

export interface CellularSample1d {
  readonly nearest_distance: number;
  readonly second_distance: number;
  readonly edge_distance: number;
  readonly feature_position: number;
  readonly cell_id: number;
}

export interface CellularSample2d {
  readonly nearest_distance: number;
  readonly second_distance: number;
  readonly edge_distance: number;
  readonly feature_position: Vec2;
  readonly cell_id: number;
}

export interface CellularSample3d {
  readonly nearest_distance: number;
  readonly second_distance: number;
  readonly edge_distance: number;
  readonly feature_position: Vec3;
  readonly cell_id: number;
}

export function cellular_noise_1d(input: CellularInput1d): CellularSample1d {
  cellular_distance(input.distance);
  const position = cellular_position(input.position, "1D cellular position");
  const center = Math.floor(position);
  let nearest = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  let feature_position = 0;
  let cell_id = 0;
  for (let cell = center - 1; cell <= center + 1; cell++) {
    const wrapped = wrap_lattice(cell, input.period?.x);
    const feature = cell + hash_unit(input.seed, wrapped, 0, 0, 1);
    const distance = Math.abs(feature - position);
    ({ nearest, second, feature_position, cell_id } = retain_candidate(
      distance,
      feature,
      hash_u32(input.seed, wrapped, 0, 0, 2),
      nearest,
      second,
      feature_position,
      cell_id,
    ));
  }
  return Object.freeze({
    nearest_distance: nearest,
    second_distance: second,
    edge_distance: second - nearest,
    feature_position,
    cell_id,
  });
}

export function cellular_noise_2d(input: CellularInput2d): CellularSample2d {
  const metric = cellular_distance(input.distance);
  const x = cellular_position(input.position.x, "2D cellular position x");
  const y = cellular_position(input.position.y, "2D cellular position y");
  const center_x = Math.floor(x);
  const center_y = Math.floor(y);
  let nearest = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  let feature_position = vec2(0, 0);
  let cell_id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cell_x = center_x + dx;
      const cell_y = center_y + dy;
      const wrapped_x = wrap_lattice(cell_x, input.period?.x);
      const wrapped_y = wrap_lattice(cell_y, input.period?.y);
      const feature = vec2(
        cell_x + hash_unit(input.seed, wrapped_x, wrapped_y, 0, 1),
        cell_y + hash_unit(input.seed, wrapped_x, wrapped_y, 0, 2),
      );
      const distance = distance_2d(
        feature.x - x,
        feature.y - y,
        metric,
      );
      const retained = retain_candidate(
        distance,
        feature,
        hash_u32(input.seed, wrapped_x, wrapped_y, 0, 3),
        nearest,
        second,
        feature_position,
        cell_id,
      );
      nearest = retained.nearest;
      second = retained.second;
      feature_position = retained.feature_position;
      cell_id = retained.cell_id;
    }
  }
  return Object.freeze({
    nearest_distance: nearest,
    second_distance: second,
    edge_distance: second - nearest,
    feature_position,
    cell_id,
  });
}

export function cellular_noise_3d(input: CellularInput3d): CellularSample3d {
  const metric = cellular_distance(input.distance);
  const x = cellular_position(input.position.x, "3D cellular position x");
  const y = cellular_position(input.position.y, "3D cellular position y");
  const z = cellular_position(input.position.z, "3D cellular position z");
  const centers = [Math.floor(x), Math.floor(y), Math.floor(z)] as const;
  let nearest = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;
  let feature_position = vec3(0, 0, 0);
  let cell_id = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell_x = centers[0] + dx;
        const cell_y = centers[1] + dy;
        const cell_z = centers[2] + dz;
        const wrapped_x = wrap_lattice(cell_x, input.period?.x);
        const wrapped_y = wrap_lattice(cell_y, input.period?.y);
        const wrapped_z = wrap_lattice(cell_z, input.period?.z);
        const feature = vec3(
          cell_x + hash_unit(input.seed, wrapped_x, wrapped_y, wrapped_z, 1),
          cell_y + hash_unit(input.seed, wrapped_x, wrapped_y, wrapped_z, 2),
          cell_z + hash_unit(input.seed, wrapped_x, wrapped_y, wrapped_z, 3),
        );
        const distance = distance_3d(
          feature.x - x,
          feature.y - y,
          feature.z - z,
          metric,
        );
        const retained = retain_candidate(
          distance,
          feature,
          hash_u32(input.seed, wrapped_x, wrapped_y, wrapped_z, 4),
          nearest,
          second,
          feature_position,
          cell_id,
        );
        nearest = retained.nearest;
        second = retained.second;
        feature_position = retained.feature_position;
        cell_id = retained.cell_id;
      }
    }
  }
  return Object.freeze({
    nearest_distance: nearest,
    second_distance: second,
    edge_distance: second - nearest,
    feature_position,
    cell_id,
  });
}

function retain_candidate<Position>(
  distance: number,
  position: Position,
  candidate_id: number,
  nearest: number,
  second: number,
  feature_position: Position,
  cell_id: number,
): {
  nearest: number;
  second: number;
  feature_position: Position;
  cell_id: number;
} {
  if (distance < nearest || (distance === nearest && candidate_id < cell_id)) {
    return {
      nearest: distance,
      second: nearest,
      feature_position: position,
      cell_id: candidate_id,
    };
  }
  return {
    nearest,
    second: Math.min(second, distance),
    feature_position,
    cell_id,
  };
}

function distance_2d(x: number, y: number, metric: CellularDistance): number {
  if (metric === "manhattan") return Math.abs(x) + Math.abs(y);
  if (metric === "chebyshev") return Math.max(Math.abs(x), Math.abs(y));
  return Math.hypot(x, y);
}

function distance_3d(
  x: number,
  y: number,
  z: number,
  metric: CellularDistance,
): number {
  if (metric === "manhattan") return Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (metric === "chebyshev") {
    return Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  }
  return Math.hypot(x, y, z);
}

function cellular_distance(
  value: CellularDistance | undefined,
): CellularDistance {
  const metric = value ?? "euclidean";
  if (
    metric !== "euclidean" && metric !== "manhattan" && metric !== "chebyshev"
  ) {
    throw new Error(
      `cellular distance ${JSON.stringify(metric)} is unsupported`,
    );
  }
  return metric;
}

function cellular_position(value: number, label: string): number {
  const parsed = finite_position(value, label);
  const lattice = Math.floor(parsed);
  if (lattice <= -0x8000_0000 || lattice >= 0x7fff_ffff) {
    throw new Error(
      `${label} ${value} needs one neighboring lattice cell within signed 32-bit range`,
    );
  }
  return parsed;
}

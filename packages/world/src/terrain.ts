import type { Vec3 } from "@ink/math/vector.ts";
import { vec3, vec3_normalize } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { GlobalPosition } from "./identity.ts";
import {
  chunk_coordinate,
  type ChunkCoordinate,
  local_origin,
  nonnegative_integer,
  positive_finite,
} from "./identity.ts";

export interface TerrainRegion {
  readonly id: string;
  readonly minimum_x: number;
  readonly minimum_z: number;
  readonly maximum_x: number;
  readonly maximum_z: number;
}

export interface TerrainDescriptor {
  readonly revision: number;
  readonly origin: GlobalPosition;
  readonly width: number;
  readonly depth: number;
  readonly spacing: number;
  readonly heights: Float32Array;
  readonly surfaces: Uint16Array;
  readonly holes: Uint8Array;
  readonly details: Float32Array;
  readonly regions: readonly TerrainRegion[];
}

export interface TerrainSource {
  readonly revision?: number;
  readonly origin: GlobalPosition;
  readonly width: number;
  readonly depth: number;
  readonly spacing: number;
  readonly heights: Float32Array;
  readonly surfaces?: Uint16Array;
  readonly holes?: Uint8Array;
  readonly details?: Float32Array;
  readonly regions?: readonly TerrainRegion[];
}

export type TerrainEdit =
  | {
    readonly type: "set_height";
    readonly x: number;
    readonly z: number;
    readonly height: number;
  }
  | {
    readonly type: "add_height";
    readonly x: number;
    readonly z: number;
    readonly amount: number;
  }
  | {
    readonly type: "set_surface";
    readonly x: number;
    readonly z: number;
    readonly surface: number;
  }
  | {
    readonly type: "set_detail";
    readonly x: number;
    readonly z: number;
    readonly detail: number;
  }
  | {
    readonly type: "set_hole";
    readonly x: number;
    readonly z: number;
    readonly hole: boolean;
  };

export interface TerrainEditResult {
  readonly terrain: TerrainDescriptor;
  readonly changed_chunks: readonly ChunkCoordinate[];
}

export interface TerrainEditOptions {
  readonly chunk_quads: number;
  readonly observer?: Observer;
}

export interface TerrainMesh {
  readonly coordinate: ChunkCoordinate;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly seams: {
    readonly north: readonly Vec3[];
    readonly east: readonly Vec3[];
    readonly south: readonly Vec3[];
    readonly west: readonly Vec3[];
  };
  readonly seam_strategy: "skirts";
}

export interface TerrainMeshOptions {
  readonly chunk_quads: number;
  readonly skirt_depth: number;
  readonly observer?: Observer;
}

export type TerrainSample =
  | { readonly type: "outside" }
  | {
    readonly type: "surface";
    readonly height: number;
    readonly normal: Vec3;
    readonly surface: number;
    readonly detail: number;
    readonly hole: boolean;
    readonly regions: readonly string[];
  };

export function create_terrain(source: TerrainSource): TerrainDescriptor {
  const width = grid_size(source.width, "terrain width");
  const depth = grid_size(source.depth, "terrain depth");
  const vertices = width * depth;
  if (!Number.isSafeInteger(vertices) || vertices > 16_777_216) {
    throw new Error(
      `terrain dimensions ${width}x${depth} exceed 16777216 vertices`,
    );
  }
  if (!(source.heights instanceof Float32Array)) {
    throw new Error("terrain heights must be a Float32Array");
  }
  if (
    source.surfaces !== undefined && !(source.surfaces instanceof Uint16Array)
  ) {
    throw new Error("terrain surfaces must be a Uint16Array");
  }
  if (source.holes !== undefined && !(source.holes instanceof Uint8Array)) {
    throw new Error("terrain holes must be a Uint8Array");
  }
  if (
    source.details !== undefined && !(source.details instanceof Float32Array)
  ) {
    throw new Error("terrain details must be a Float32Array");
  }
  if (source.heights.length !== vertices) {
    throw new Error(
      `terrain heights length ${source.heights.length} must equal width*depth ${vertices}`,
    );
  }
  const surfaces = source.surfaces ?? new Uint16Array(vertices);
  const details = source.details ?? new Float32Array(vertices);
  const holes = source.holes ?? new Uint8Array((width - 1) * (depth - 1));
  if (
    surfaces.length !== vertices || details.length !== vertices ||
    holes.length !== (width - 1) * (depth - 1)
  ) {
    throw new Error(
      `terrain layer lengths surfaces=${surfaces.length} details=${details.length} holes=${holes.length} do not match ${width}x${depth}`,
    );
  }
  for (const [index, height] of source.heights.entries()) {
    if (!Number.isFinite(height)) {
      throw new Error(`terrain height ${index} ${height} must be finite`);
    }
  }
  for (const [index, detail] of details.entries()) {
    if (!Number.isFinite(detail) || detail < 0) {
      throw new Error(
        `terrain detail ${index} ${detail} must be finite and nonnegative`,
      );
    }
  }
  if ([...holes].some((hole) => hole !== 0 && hole !== 1)) {
    throw new Error("terrain holes must contain only 0 or 1");
  }
  const region_ids = new Set<string>();
  const regions = Object.freeze((source.regions ?? []).map((region, index) => {
    const parsed = parse_region(region, index, width, depth);
    if (region_ids.has(parsed.id)) {
      throw new Error(`terrain repeats region ${JSON.stringify(parsed.id)}`);
    }
    region_ids.add(parsed.id);
    return parsed;
  }));
  return Object.freeze({
    revision: nonnegative_integer(source.revision ?? 0, "terrain revision"),
    origin: local_origin(source.origin),
    width,
    depth,
    spacing: positive_finite(source.spacing, "terrain spacing"),
    heights: source.heights.slice(),
    surfaces: surfaces.slice(),
    holes: holes.slice(),
    details: details.slice(),
    regions,
  });
}

export function edit_terrain(
  terrain: TerrainDescriptor,
  edits: readonly TerrainEdit[],
  options: TerrainEditOptions,
): TerrainEditResult {
  if (!Array.isArray(edits)) throw new Error("terrain edits must be an array");
  if (edits.length > 0 && terrain.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("terrain revision exceeds safe integer range");
  }
  const chunk_size = nonnegative_integer(
    options.chunk_quads,
    "terrain chunk quads",
  );
  if (chunk_size === 0) throw new Error("terrain chunk quads must be positive");
  const heights = terrain.heights.slice();
  const surfaces = terrain.surfaces.slice();
  const holes = terrain.holes.slice();
  const details = terrain.details.slice();
  const changed = new Map<string, ChunkCoordinate>();
  for (const edit of edits) {
    const type = edit.type as string;
    if (
      ![
        "set_height",
        "add_height",
        "set_surface",
        "set_detail",
        "set_hole",
      ].includes(type)
    ) {
      throw new Error(
        `terrain edit type ${JSON.stringify(type)} is unsupported`,
      );
    }
    const maximum_x = edit.type === "set_hole"
      ? terrain.width - 2
      : terrain.width - 1;
    const maximum_z = edit.type === "set_hole"
      ? terrain.depth - 2
      : terrain.depth - 1;
    const x = grid_coordinate(edit.x, maximum_x, `terrain ${edit.type} x`);
    const z = grid_coordinate(edit.z, maximum_z, `terrain ${edit.type} z`);
    const vertex = z * terrain.width + x;
    switch (edit.type) {
      case "set_height":
        heights[vertex] = finite(edit.height, "terrain edit height");
        break;
      case "add_height":
        heights[vertex] = finite(
          heights[vertex] + edit.amount,
          "terrain edited height",
        );
        break;
      case "set_surface":
        if (
          !Number.isInteger(edit.surface) || edit.surface < 0 ||
          edit.surface > 0xffff
        ) {
          throw new Error(
            `terrain surface ${edit.surface} must be an unsigned 16-bit integer`,
          );
        }
        surfaces[vertex] = edit.surface;
        break;
      case "set_detail":
        if (!Number.isFinite(edit.detail) || edit.detail < 0) {
          throw new Error(
            `terrain detail ${edit.detail} must be finite and nonnegative`,
          );
        }
        details[vertex] = edit.detail;
        break;
      case "set_hole":
        if (typeof edit.hole !== "boolean") {
          throw new Error(
            `terrain hole ${JSON.stringify(edit.hole)} must be boolean`,
          );
        }
        holes[z * (terrain.width - 1) + x] = edit.hole ? 1 : 0;
        break;
    }
    for (const chunk_z of neighboring_chunks(z, chunk_size)) {
      for (const chunk_x of neighboring_chunks(x, chunk_size)) {
        if (
          chunk_x * chunk_size >= terrain.width - 1 ||
          chunk_z * chunk_size >= terrain.depth - 1
        ) continue;
        const coordinate = chunk_coordinate(chunk_x, chunk_z);
        changed.set(`${chunk_x}:${chunk_z}`, coordinate);
      }
    }
  }
  const edited = create_terrain({
    ...terrain,
    revision: terrain.revision + (edits.length === 0 ? 0 : 1),
    heights,
    surfaces,
    holes,
    details,
  });
  const changed_chunks = Object.freeze(
    [...changed.values()].sort((left, right) =>
      left.z - right.z || left.x - right.x
    ),
  );
  options.observer?.event("world.terrain.edited", {
    input_revision: terrain.revision,
    output_revision: edited.revision,
    edit_count: edits.length,
    changed_chunks: changed_chunks.length,
  });
  return Object.freeze({ terrain: edited, changed_chunks });
}

export function mesh_terrain_chunk(
  terrain: TerrainDescriptor,
  coordinate_source: ChunkCoordinate,
  options: TerrainMeshOptions,
): TerrainMesh {
  const coordinate = chunk_coordinate(
    coordinate_source.x,
    coordinate_source.z,
    coordinate_source.lod,
  );
  const size = nonnegative_integer(
    options.chunk_quads,
    "terrain chunk quads",
  );
  if (size === 0) throw new Error("terrain chunk quads must be positive");
  const skirt = positive_finite(options.skirt_depth, "terrain skirt depth");
  const step = 2 ** coordinate.lod;
  if (!Number.isSafeInteger(step) || size % step !== 0) {
    throw new Error(
      `terrain chunk quads ${size} must be divisible by LOD step ${step}`,
    );
  }
  const start_x = coordinate.x * size;
  const start_z = coordinate.z * size;
  if (!Number.isSafeInteger(start_x) || !Number.isSafeInteger(start_z)) {
    throw new Error(
      `terrain chunk (${coordinate.x}, ${coordinate.z}) coordinate exceeds safe integer range`,
    );
  }
  if (
    start_x < 0 || start_z < 0 || start_x + size >= terrain.width ||
    start_z + size >= terrain.depth
  ) {
    throw new Error(
      `terrain chunk (${coordinate.x}, ${coordinate.z}) range ${start_x}..${
        start_x + size
      }, ${start_z}..${
        start_z + size
      } is outside ${terrain.width}x${terrain.depth}`,
    );
  }
  const samples = size / step + 1;
  const positions: number[] = [];
  const normals: number[] = [];
  for (let row = 0; row < samples; row += 1) {
    for (let column = 0; column < samples; column += 1) {
      const x = start_x + column * step;
      const z = start_z + row * step;
      positions.push(
        x * terrain.spacing,
        terrain.heights[z * terrain.width + x],
        z * terrain.spacing,
      );
      const normal = terrain_normal(terrain, x, z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < samples - 1; row += 1) {
    for (let column = 0; column < samples - 1; column += 1) {
      const source_x = start_x + column * step;
      const source_z = start_z + row * step;
      if (quad_has_hole(terrain, source_x, source_z, step)) continue;
      const first = row * samples + column;
      const second = first + 1;
      const fourth = first + samples;
      const third = fourth + 1;
      indices.push(first, fourth, second, second, fourth, third);
    }
  }
  const north = edge_points(terrain, start_x, start_z, size, step, "north");
  const east = edge_points(terrain, start_x, start_z, size, step, "east");
  const south = edge_points(terrain, start_x, start_z, size, step, "south");
  const west = edge_points(terrain, start_x, start_z, size, step, "west");
  for (const edge of [north, east, south, west]) {
    append_skirt(positions, normals, indices, edge, skirt);
  }
  const mesh = Object.freeze({
    coordinate,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    seams: Object.freeze({ north, east, south, west }),
    seam_strategy: "skirts",
  });
  options.observer?.event("world.terrain.rebuilt", {
    terrain_revision: terrain.revision,
    chunk_x: coordinate.x,
    chunk_z: coordinate.z,
    lod: coordinate.lod,
    vertices: mesh.positions.length / 3,
    triangles: mesh.indices.length / 3,
    byte_size: mesh.positions.byteLength + mesh.normals.byteLength +
      mesh.indices.byteLength,
  });
  return mesh;
}

export function sample_terrain(
  terrain: TerrainDescriptor,
  x: number,
  z: number,
): TerrainSample {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { type: "outside" };
  const grid_x = x / terrain.spacing;
  const grid_z = z / terrain.spacing;
  if (
    grid_x < 0 || grid_z < 0 || grid_x > terrain.width - 1 ||
    grid_z > terrain.depth - 1
  ) return { type: "outside" };
  const x0 = Math.min(Math.floor(grid_x), terrain.width - 2);
  const z0 = Math.min(Math.floor(grid_z), terrain.depth - 2);
  const x1 = x0 + 1;
  const z1 = z0 + 1;
  const tx = grid_x - x0;
  const tz = grid_z - z0;
  const h00 = terrain.heights[z0 * terrain.width + x0];
  const h10 = terrain.heights[z0 * terrain.width + x1];
  const h01 = terrain.heights[z1 * terrain.width + x0];
  const h11 = terrain.heights[z1 * terrain.width + x1];
  const height = mix(mix(h00, h10, tx), mix(h01, h11, tx), tz);
  const nearest_x = Math.round(grid_x);
  const nearest_z = Math.round(grid_z);
  const nearest = nearest_z * terrain.width + nearest_x;
  return {
    type: "surface",
    height,
    normal: terrain_normal(terrain, nearest_x, nearest_z),
    surface: terrain.surfaces[nearest],
    detail: terrain.details[nearest],
    hole: terrain.holes[z0 * (terrain.width - 1) + x0] === 1,
    regions: terrain.regions.filter((region) =>
      grid_x >= region.minimum_x && grid_x <= region.maximum_x &&
      grid_z >= region.minimum_z && grid_z <= region.maximum_z
    ).map(({ id }) => id),
  };
}

function terrain_normal(
  terrain: TerrainDescriptor,
  x: number,
  z: number,
): Vec3 {
  const left = terrain.heights[z * terrain.width + Math.max(0, x - 1)];
  const right =
    terrain.heights[z * terrain.width + Math.min(terrain.width - 1, x + 1)];
  const north = terrain.heights[Math.max(0, z - 1) * terrain.width + x];
  const south =
    terrain.heights[Math.min(terrain.depth - 1, z + 1) * terrain.width + x];
  return vec3_normalize(vec3(left - right, 2 * terrain.spacing, north - south));
}

function edge_points(
  terrain: TerrainDescriptor,
  start_x: number,
  start_z: number,
  size: number,
  step: number,
  edge: "north" | "east" | "south" | "west",
): readonly Vec3[] {
  const points: Vec3[] = [];
  for (let offset = 0; offset <= size; offset += step) {
    const x = edge === "east"
      ? start_x + size
      : edge === "west"
      ? start_x
      : start_x + offset;
    const z = edge === "south"
      ? start_z + size
      : edge === "north"
      ? start_z
      : start_z + offset;
    points.push(
      vec3(
        x * terrain.spacing,
        terrain.heights[z * terrain.width + x],
        z * terrain.spacing,
      ),
    );
  }
  return Object.freeze(points);
}

function append_skirt(
  positions: number[],
  normals: number[],
  indices: number[],
  edge: readonly Vec3[],
  depth: number,
): void {
  const top_start = positions.length / 3;
  for (const point of edge) {
    positions.push(point.x, point.y, point.z);
    normals.push(0, 1, 0);
  }
  const bottom_start = positions.length / 3;
  for (const point of edge) {
    positions.push(point.x, point.y - depth, point.z);
    normals.push(0, 1, 0);
  }
  for (let index = 0; index < edge.length - 1; index += 1) {
    indices.push(
      top_start + index,
      bottom_start + index,
      top_start + index + 1,
      top_start + index + 1,
      bottom_start + index,
      bottom_start + index + 1,
    );
  }
}

function quad_has_hole(
  terrain: TerrainDescriptor,
  x: number,
  z: number,
  step: number,
): boolean {
  for (let row = z; row < z + step; row += 1) {
    for (let column = x; column < x + step; column += 1) {
      if (terrain.holes[row * (terrain.width - 1) + column] === 1) return true;
    }
  }
  return false;
}

function neighboring_chunks(value: number, size: number): readonly number[] {
  const chunk = Math.floor(value / size);
  if (value > 0 && value % size === 0) return [chunk - 1, chunk];
  return [chunk];
}

function parse_region(
  region: TerrainRegion,
  index: number,
  width: number,
  depth: number,
): TerrainRegion {
  if (typeof region.id !== "string") {
    throw new Error(`terrain region ${index} id must be a string`);
  }
  const id = region.id.trim();
  if (id.length === 0) {
    throw new Error(`terrain region ${index} id cannot be empty`);
  }
  const minimum_x = grid_coordinate(
    region.minimum_x,
    width - 1,
    `terrain region ${id} minimum x`,
  );
  const minimum_z = grid_coordinate(
    region.minimum_z,
    depth - 1,
    `terrain region ${id} minimum z`,
  );
  const maximum_x = grid_coordinate(
    region.maximum_x,
    width - 1,
    `terrain region ${id} maximum x`,
  );
  const maximum_z = grid_coordinate(
    region.maximum_z,
    depth - 1,
    `terrain region ${id} maximum z`,
  );
  if (minimum_x > maximum_x || minimum_z > maximum_z) {
    throw new Error(
      `terrain region ${JSON.stringify(id)} minimum exceeds maximum`,
    );
  }
  return Object.freeze({ id, minimum_x, minimum_z, maximum_x, maximum_z });
}

function grid_size(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 2) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be an integer of at least 2`,
    );
  }
  return value;
}

function grid_coordinate(
  value: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be in 0..${maximum}`,
    );
  }
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} ${value} must be finite`);
  }
  return value;
}

function mix(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

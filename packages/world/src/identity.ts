import { finite_number } from "@ink/math/scalar.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3 } from "@ink/math/vector.ts";

declare const world_id_brand: unique symbol;
declare const level_id_brand: unique symbol;
declare const cell_id_brand: unique symbol;

export type WorldId = string & { readonly [world_id_brand]: true };
export type LevelId = string & { readonly [level_id_brand]: true };
export type CellId = string & { readonly [cell_id_brand]: true };

export interface ChunkCoordinate {
  readonly x: number;
  readonly z: number;
  readonly lod: number;
}

export interface GlobalPosition {
  readonly cell_x: number;
  readonly cell_z: number;
  readonly offset: Vec3;
}

export interface LocalOrigin extends GlobalPosition {}

export function world_id(value: string): WorldId {
  return identity(value, "world id") as WorldId;
}

export function level_id(value: string): LevelId {
  return identity(value, "level id") as LevelId;
}

export function cell_id(value: string): CellId {
  return identity(value, "cell id") as CellId;
}

export function chunk_coordinate(
  x: number,
  z: number,
  lod = 0,
): ChunkCoordinate {
  return Object.freeze({
    x: signed_coordinate(x, "chunk x"),
    z: signed_coordinate(z, "chunk z"),
    lod: nonnegative_integer(lod, "chunk LOD"),
  });
}

export function global_position(
  cell_x: number,
  cell_z: number,
  offset: Vec3,
  cell_size: number,
): GlobalPosition {
  const size = positive_finite(cell_size, "world cell size");
  const normalized_x = Math.floor(offset.x / size);
  const normalized_z = Math.floor(offset.z / size);
  return Object.freeze({
    cell_x: safe_sum(
      signed_coordinate(cell_x, "global position cell x"),
      normalized_x,
      "global position cell x",
    ),
    cell_z: safe_sum(
      signed_coordinate(cell_z, "global position cell z"),
      normalized_z,
      "global position cell z",
    ),
    offset: vec3(
      offset.x - normalized_x * size,
      offset.y,
      offset.z - normalized_z * size,
    ),
  });
}

export function local_origin(position: GlobalPosition): LocalOrigin {
  return Object.freeze({
    cell_x: signed_coordinate(position.cell_x, "local origin cell x"),
    cell_z: signed_coordinate(position.cell_z, "local origin cell z"),
    offset: vec3(position.offset.x, position.offset.y, position.offset.z),
  });
}

export function global_to_local(
  position: GlobalPosition,
  origin: LocalOrigin,
  cell_size: number,
): Vec3 {
  const size = positive_finite(cell_size, "world cell size");
  const parsed_position = global_position(
    position.cell_x,
    position.cell_z,
    position.offset,
    size,
  );
  const parsed_origin = global_position(
    origin.cell_x,
    origin.cell_z,
    origin.offset,
    size,
  );
  return vec3(
    safe_difference(
          parsed_position.cell_x,
          parsed_origin.cell_x,
          "cell x delta",
        ) * size +
      parsed_position.offset.x - parsed_origin.offset.x,
    parsed_position.offset.y - parsed_origin.offset.y,
    safe_difference(
          parsed_position.cell_z,
          parsed_origin.cell_z,
          "cell z delta",
        ) * size +
      parsed_position.offset.z - parsed_origin.offset.z,
  );
}

export function local_to_global(
  position: Vec3,
  origin: LocalOrigin,
  cell_size: number,
): GlobalPosition {
  return global_position(
    origin.cell_x,
    origin.cell_z,
    vec3(
      origin.offset.x + position.x,
      origin.offset.y + position.y,
      origin.offset.z + position.z,
    ),
    cell_size,
  );
}

export function global_distance_squared(
  left: GlobalPosition,
  right: GlobalPosition,
  cell_size: number,
): number {
  const delta = global_to_local(left, local_origin(right), cell_size);
  return delta.x * delta.x + delta.y * delta.y + delta.z * delta.z;
}

export function positive_finite(value: number, label: string): number {
  finite_number(value, label);
  if (value <= 0) throw new Error(`${label} ${value} must be positive`);
  return value;
}

export function nonnegative_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value;
}

function signed_coordinate(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be a safe integer`);
  }
  return value;
}

function safe_sum(left: number, right: number, label: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} ${left} + ${right} exceeds safe integer range`);
  }
  return value;
}

function safe_difference(left: number, right: number, label: string): number {
  const value = left - right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} ${left} - ${right} exceeds safe integer range`);
  }
  return value;
}

function identity(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} ${JSON.stringify(value)} must be a string`);
  }
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`${label} ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed;
}

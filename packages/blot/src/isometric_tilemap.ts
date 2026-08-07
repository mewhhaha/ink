import {
  type Effect,
  type Fails,
  from_either,
  Left,
  Program,
  Right,
  run,
  run_except,
} from "@mewhhaha/typeclasses";
import type { SceneObjectCommand } from "./protocol.ts";

export interface IsometricTilemapCommand {
  readonly columns: bigint;
  readonly detail_scale: bigint;
  readonly first_object_id: bigint;
  readonly ground_mesh: bigint;
  readonly origin_y: bigint;
  readonly road_texture: bigint;
  readonly rows: bigint;
  readonly secondary_texture: bigint;
  readonly tile_half_height: bigint;
  readonly tile_half_width: bigint;
  readonly tile_scale: bigint;
  readonly texture_scale_x: bigint;
  readonly texture_scale_y: bigint;
  readonly variation_seed: bigint;
}

export interface IsometricTileDescriptor {
  readonly blend_edges: bigint;
  readonly detail_texture: bigint;
  readonly path_connections: bigint;
  readonly terrain_texture: bigint;
}

type TilemapFailure = readonly ["tilemap.parse", string];
type TilemapParser<result> = Effect<Fails<TilemapFailure>, result>;

const Parse = Program.scope<Fails<TilemapFailure>>();

export function expand_isometric_tilemap(
  command: IsometricTilemapCommand,
  descriptors: readonly IsometricTileDescriptor[],
): readonly SceneObjectCommand[] {
  const outcome = run(run_except(parse_tilemap(command, descriptors)));
  const [branch, value] = outcome.value();
  if (branch === "Left") throw new Error(value[1]);
  return value;
}

function parse_tilemap(
  command: IsometricTilemapCommand,
  descriptors: readonly IsometricTileDescriptor[],
): TilemapParser<readonly SceneObjectCommand[]> {
  return Parse(function* () {
    const columns = yield* parse_positive_integer(command.columns, "columns");
    const rows = yield* parse_positive_integer(command.rows, "rows");
    const tile_count = columns * rows;
    if (!Number.isSafeInteger(tile_count) || tile_count > 262_144) {
      return yield* reject(
        `isometric tilemap dimensions ${columns}x${rows} exceed 262,144 tiles`,
      );
    }

    const first_object_id = yield* parse_nonnegative_integer(
      command.first_object_id,
      "first_object_id",
    );
    const road_id_offset = first_object_id + tile_count;
    const detail_id_offset = first_object_id + tile_count * 2;
    if (!Number.isSafeInteger(first_object_id + tile_count * 3 - 1)) {
      return yield* reject(
        "isometric tilemap object identifiers exceed safe integer range",
      );
    }

    const ground_mesh = yield* parse_nonnegative_integer(
      command.ground_mesh,
      "ground_mesh",
    );
    const road_mesh = ground_mesh + 1;
    const detail_mesh = ground_mesh + 2;
    if (!Number.isSafeInteger(detail_mesh)) {
      return yield* reject(
        `isometric tilemap ground_mesh ${ground_mesh} cannot reserve three consecutive mesh identifiers`,
      );
    }
    const road_texture = yield* parse_nonnegative_integer(
      command.road_texture,
      "road_texture",
    );
    const secondary_texture = yield* parse_integer(
      command.secondary_texture,
      "secondary_texture",
    );
    if (secondary_texture < -1) {
      return yield* reject(
        `isometric tilemap secondary_texture ${secondary_texture} must be -1 or greater`,
      );
    }

    const tile_half_width = yield* parse_positive_integer(
      command.tile_half_width,
      "tile_half_width",
    );
    const tile_half_height = yield* parse_positive_integer(
      command.tile_half_height,
      "tile_half_height",
    );
    const tile_scale = yield* parse_positive_integer(
      command.tile_scale,
      "tile_scale",
    );
    const detail_scale = yield* parse_positive_integer(
      command.detail_scale,
      "detail_scale",
    );
    const texture_scale_x = yield* parse_positive_integer(
      command.texture_scale_x,
      "texture_scale_x",
    );
    const texture_scale_y = yield* parse_positive_integer(
      command.texture_scale_y,
      "texture_scale_y",
    );
    const origin_y = yield* parse_integer(command.origin_y, "origin_y");
    const variation_seed = yield* parse_integer(
      command.variation_seed,
      "variation_seed",
    );

    if (descriptors.length !== tile_count) {
      return yield* reject(
        `isometric tilemap ${columns}x${rows} requires ${tile_count} descriptors, received ${descriptors.length}`,
      );
    }

    const objects: SceneObjectCommand[] = [];
    for (const [index, source] of descriptors.entries()) {
      const descriptor = yield* parse_descriptor(source, index);
      const column = index % columns;
      const row = Math.floor(index / columns);
      const position = [
        (column - row) * tile_half_width,
        (column + row) * tile_half_height + origin_y,
        0,
      ] as const;
      objects.push({
        type: "scene_object",
        id: first_object_id + index,
        mesh: ground_mesh,
        parent: null,
        color: [1, 1, 1],
        emissive: 0,
        texture: descriptor.terrain_texture,
        texture_offset: [0, 0],
        secondary_texture: secondary_texture < 0 ? null : secondary_texture,
        texture_scale: [
          texture_scale_x / 1_000_000,
          texture_scale_y / 1_000_000,
        ],
        blend_edges: descriptor.blend_edges,
        variation_seed,
        surface_mode: 0,
        path_connections: 0,
        rotation_radians: [0, 0, 0],
        position,
        scale: [tile_scale, tile_scale, tile_scale],
        visible: true,
      });
      if (descriptor.path_connections >= 0) {
        objects.push({
          type: "scene_object",
          id: road_id_offset + index,
          mesh: road_mesh,
          parent: null,
          color: [0.92, 0.9, 0.85],
          emissive: 0,
          texture: road_texture,
          texture_offset: [0, 0],
          secondary_texture: null,
          texture_scale: [0.7, 0.7],
          blend_edges: 0,
          variation_seed: 0,
          surface_mode: 1,
          path_connections: descriptor.path_connections,
          rotation_radians: [0, 0, 0],
          position,
          scale: [tile_scale, tile_scale, tile_scale],
          visible: true,
        });
      }
      if (descriptor.detail_texture >= 0) {
        objects.push({
          type: "scene_object",
          id: detail_id_offset + index,
          mesh: detail_mesh,
          parent: null,
          color: [1, 1, 1],
          emissive: 0,
          texture: descriptor.detail_texture,
          texture_offset: [0, 0],
          secondary_texture: null,
          texture_scale: [1, 1],
          blend_edges: 0,
          variation_seed: 0,
          surface_mode: 2,
          path_connections: 0,
          rotation_radians: [0, 0, 0],
          position,
          scale: [detail_scale, detail_scale, detail_scale],
          visible: true,
        });
      }
    }
    return objects;
  });
}

function parse_descriptor(
  source: IsometricTileDescriptor,
  index: number,
): TilemapParser<{
  readonly terrain_texture: number;
  readonly blend_edges: number;
  readonly path_connections: number;
  readonly detail_texture: number;
}> {
  return Parse(function* () {
    const terrain_texture = yield* parse_integer(
      source.terrain_texture,
      `descriptor ${index} terrain texture`,
    );
    const blend_edges = yield* parse_integer(
      source.blend_edges,
      `descriptor ${index} blend edges`,
    );
    const path_connections = yield* parse_integer(
      source.path_connections,
      `descriptor ${index} path connections`,
    );
    const detail_texture = yield* parse_integer(
      source.detail_texture,
      `descriptor ${index} detail texture`,
    );
    if (terrain_texture < 0) {
      return yield* reject(
        `isometric tilemap descriptor ${index} terrain texture ${terrain_texture} must be nonnegative`,
      );
    }
    if (blend_edges < 0 || blend_edges > 255) {
      return yield* reject(
        `isometric tilemap descriptor ${index} blend edges ${blend_edges} must be between 0 and 255`,
      );
    }
    if (path_connections < -1 || path_connections > 15) {
      return yield* reject(
        `isometric tilemap descriptor ${index} path connections ${path_connections} must be -1 or between 0 and 15`,
      );
    }
    if (detail_texture < -1) {
      return yield* reject(
        `isometric tilemap descriptor ${index} detail texture ${detail_texture} must be -1 or greater`,
      );
    }
    return {
      terrain_texture,
      blend_edges,
      path_connections,
      detail_texture,
    };
  });
}

function parse_integer(value: bigint, path: string): TilemapParser<number> {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? accept(parsed)
    : reject(`isometric tilemap ${path} ${value} exceeds safe integer range`);
}

function parse_nonnegative_integer(
  value: bigint,
  path: string,
): TilemapParser<number> {
  return Parse(function* () {
    const parsed = yield* parse_integer(value, path);
    return parsed >= 0 ? parsed : yield* reject(
      `isometric tilemap ${path} ${parsed} must be nonnegative`,
    );
  });
}

function parse_positive_integer(
  value: bigint,
  path: string,
): TilemapParser<number> {
  return Parse(function* () {
    const parsed = yield* parse_integer(value, path);
    return parsed > 0
      ? parsed
      : yield* reject(`isometric tilemap ${path} ${parsed} must be positive`);
  });
}

function accept<result>(value: result): TilemapParser<result> {
  return from_either(Right<TilemapFailure, result>(value));
}

function reject<result = never>(message: string): TilemapParser<result> {
  return from_either(Left<TilemapFailure, result>(["tilemap.parse", message]));
}

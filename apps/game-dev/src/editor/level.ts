export const level_asset_url = "/assets/levels/starter.json";
export const level_save_url = "/__ink/levels/starter";
export const tile_edit_event = 40;
export const tile_atlas_columns = 16;
export const tile_atlas_rows = 16;
export const tile_size = 16;

export type LevelLayer = "terrain" | "decoration";
export type LevelGeometryCategory = "collision" | "area";

export interface LevelPoint {
  readonly x: number;
  readonly y: number;
}

interface LevelGeometryBase {
  readonly id: string;
  readonly points: readonly LevelPoint[];
}

export type LevelGeometry =
  | LevelGeometryBase & { readonly category: "collision" }
  | LevelGeometryBase & { readonly category: "area"; readonly name: string };

export interface PlatformerLevel {
  readonly name: string;
  readonly columns: number;
  readonly rows: number;
  readonly terrain: readonly number[];
  readonly decoration: readonly number[];
  readonly player_start: number;
  readonly geometry: readonly LevelGeometry[];
}

export interface LevelExpansion {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export function parse_platformer_level(source: string): PlatformerLevel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error("platformer level is not valid JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("platformer level must be an object");
  }
  if (Reflect.get(parsed, "format") !== "blot-integer-data") {
    throw new Error('platformer level format must be "blot-integer-data"');
  }
  if (Reflect.get(parsed, "version") !== 1) {
    throw new Error("platformer level version must be 1");
  }
  const name = Reflect.get(parsed, "name");
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("platformer level name must be a non-empty string");
  }
  const fields = Reflect.get(parsed, "fields");
  if (!Array.isArray(fields) || fields.length !== 5) {
    throw new Error("platformer level must contain five integer fields");
  }
  const columns = parse_dimension(fields[0], "columns");
  const rows = parse_dimension(fields[1], "rows");
  const tile_count = columns * rows;
  if (tile_count > 4096) {
    throw new Error(
      `platformer level dimensions ${columns}x${rows} exceed 4096 tiles`,
    );
  }
  const geometry = parse_geometry(
    Reflect.get(parsed, "geometry"),
    columns,
    rows,
  );
  return {
    name: name.trim(),
    columns,
    rows,
    terrain: parse_layer(fields[2], tile_count, "terrain"),
    decoration: parse_layer(fields[3], tile_count, "decoration"),
    player_start: parse_player_start(fields[4], tile_count),
    geometry,
  };
}

export function serialize_platformer_level(level: PlatformerLevel): string {
  const tile_count = level.columns * level.rows;
  parse_layer(level.terrain, tile_count, "terrain");
  parse_layer(level.decoration, tile_count, "decoration");
  parse_player_start([level.player_start], tile_count);
  const geometry = parse_geometry(level.geometry, level.columns, level.rows);
  return `${
    JSON.stringify(
      {
        format: "blot-integer-data",
        version: 1,
        name: level.name,
        tile_size,
        layers: ["terrain", "decoration"],
        entities: ["player_start"],
        geometry,
        fields: [
          [level.columns],
          [level.rows],
          level.terrain,
          level.decoration,
          [level.player_start],
        ],
      },
      null,
      2,
    )
  }\n`;
}

function parse_geometry(
  source: unknown,
  columns: number,
  rows: number,
): readonly LevelGeometry[] {
  if (!Array.isArray(source)) {
    throw new Error("platformer level geometry must be an array");
  }
  const identities = new Set<string>();
  return source.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error(`platformer geometry ${index} must be an object`);
    }
    const id = Reflect.get(candidate, "id");
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(
        `platformer geometry ${index} id ${
          JSON.stringify(id)
        } must be nonempty`,
      );
    }
    if (identities.has(id)) {
      throw new Error(
        `platformer geometry id ${JSON.stringify(id)} is repeated`,
      );
    }
    identities.add(id);
    const category = Reflect.get(candidate, "category");
    if (category !== "collision" && category !== "area") {
      throw new Error(
        `platformer geometry ${JSON.stringify(id)} category ${
          JSON.stringify(category)
        } must be collision or area`,
      );
    }
    const name = category === "area"
      ? parse_area_name(Reflect.get(candidate, "name"), id)
      : undefined;
    const source_points = Reflect.get(candidate, "points");
    if (
      !Array.isArray(source_points) || source_points.length < 3 ||
      source_points.length > 64
    ) {
      throw new Error(
        `platformer geometry ${JSON.stringify(id)} must contain 3..64 points`,
      );
    }
    const points = source_points.map((source_point, point_index) => {
      const coordinates =
        Array.isArray(source_point) && source_point.length === 2
          ? source_point
          : typeof source_point === "object" && source_point !== null
          ? [Reflect.get(source_point, "x"), Reflect.get(source_point, "y")]
          : undefined;
      if (!coordinates) {
        throw new Error(
          `platformer geometry ${
            JSON.stringify(id)
          } point ${point_index} must be [x, y]`,
        );
      }
      const [x, y] = coordinates;
      if (
        !valid_geometry_coordinate(x, columns) ||
        !valid_geometry_coordinate(y, rows)
      ) {
        throw new Error(
          `platformer geometry ${JSON.stringify(id)} point ${point_index} ${
            JSON.stringify(coordinates)
          } must use quarter-tile coordinates inside ${columns}x${rows}`,
        );
      }
      return { x, y };
    });
    if (polygon_area(points) === 0) {
      throw new Error(
        `platformer geometry ${JSON.stringify(id)} must enclose a nonzero area`,
      );
    }
    return category === "area"
      ? { id, category, name, points }
      : { id, category, points };
  });
}

function parse_area_name(source: unknown, id: string): string {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error(
      `platformer area ${JSON.stringify(id)} name must be nonempty`,
    );
  }
  const name = source.trim();
  if (name.length > 80) {
    throw new Error(
      `platformer area ${
        JSON.stringify(id)
      } name is ${name.length} characters; maximum is 80`,
    );
  }
  return name;
}

function valid_geometry_coordinate(
  value: unknown,
  maximum: number,
): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= maximum && Number.isInteger(value * 4);
}

function polygon_area(points: readonly LevelPoint[]): number {
  let twice_area = 0;
  for (const [index, point] of points.entries()) {
    const next = points[(index + 1) % points.length];
    twice_area += point.x * next.y - next.x * point.y;
  }
  return Math.abs(twice_area / 2);
}

export function move_player_start(
  level: PlatformerLevel,
  index: number,
): PlatformerLevel {
  parse_player_start([index], level.columns * level.rows);
  if (level.player_start === index) return level;
  return { ...level, player_start: index };
}

export function expand_platformer_level(
  level: PlatformerLevel,
  expansion: LevelExpansion,
): PlatformerLevel {
  for (const [edge, amount] of Object.entries(expansion)) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(
        `platformer level ${edge} expansion ${
          JSON.stringify(amount)
        } must be a nonnegative integer`,
      );
    }
  }
  if (
    expansion.left === 0 && expansion.right === 0 && expansion.top === 0 &&
    expansion.bottom === 0
  ) return level;

  const columns = level.columns + expansion.left + expansion.right;
  const rows = level.rows + expansion.top + expansion.bottom;
  const tile_count = columns * rows;
  if (tile_count > 4096) {
    throw new Error(
      `platformer level expansion would create ${columns}x${rows} tiles, exceeding 4096 tiles`,
    );
  }

  const terrain = Array<number>(tile_count).fill(-1);
  const decoration = Array<number>(tile_count).fill(-1);
  for (
    let source_index = 0;
    source_index < level.terrain.length;
    source_index += 1
  ) {
    const source_row = Math.floor(source_index / level.columns);
    const source_column = source_index % level.columns;
    const destination_index = (source_row + expansion.top) * columns +
      source_column + expansion.left;
    terrain[destination_index] = level.terrain[source_index];
    decoration[destination_index] = level.decoration[source_index];
  }

  const player_column = level.player_start % level.columns;
  const player_row = Math.floor(level.player_start / level.columns);
  return {
    ...level,
    columns,
    rows,
    terrain,
    decoration,
    player_start: (player_row + expansion.top) * columns + player_column +
      expansion.left,
    geometry: level.geometry.map((geometry) => ({
      ...geometry,
      points: geometry.points.map(({ x, y }) => ({
        x: x + expansion.left,
        y: y + expansion.top,
      })),
    })),
  };
}

export function paint_level_tile(
  level: PlatformerLevel,
  layer: LevelLayer,
  index: number,
  tile: number,
): PlatformerLevel {
  const tile_count = level.columns * level.rows;
  if (!Number.isSafeInteger(index) || index < 0 || index >= tile_count) {
    throw new Error(
      `platformer tile index ${JSON.stringify(index)} is outside 0..${
        tile_count - 1
      }`,
    );
  }
  parse_tile(tile, `${layer} tile ${index}`);
  const current = level[layer];
  if (current[index] === tile) return level;
  const next = [...current];
  next[index] = tile;
  return { ...level, [layer]: next };
}

function parse_dimension(field: unknown, name: string): number {
  if (!Array.isArray(field) || field.length !== 1) {
    throw new Error(`platformer level ${name} must contain one integer`);
  }
  const value = field[0];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `platformer level ${name} ${JSON.stringify(value)} must be positive`,
    );
  }
  return value;
}

function parse_layer(
  field: unknown,
  tile_count: number,
  name: LevelLayer,
): readonly number[] {
  if (!Array.isArray(field) || field.length !== tile_count) {
    throw new Error(
      `platformer ${name} layer must contain ${tile_count} tiles`,
    );
  }
  return field.map((tile, index) => parse_tile(tile, `${name} tile ${index}`));
}

function parse_tile(value: unknown, name: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < -1 ||
    value > 255
  ) {
    throw new Error(
      `platformer ${name} ${JSON.stringify(value)} must be -1 or 0..255`,
    );
  }
  return value as number;
}

function parse_player_start(field: unknown, tile_count: number): number {
  if (!Array.isArray(field) || field.length !== 1) {
    throw new Error("platformer player start must contain one tile index");
  }
  const index = field[0];
  if (
    typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 ||
    index >= tile_count
  ) {
    throw new Error(
      `platformer player start ${JSON.stringify(index)} is outside 0..${
        tile_count - 1
      }`,
    );
  }
  return index;
}

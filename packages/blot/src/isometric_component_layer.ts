import type { SceneObjectCommand, SurfaceMode } from "./protocol.ts";

export interface IsometricComponentLayerCommand {
  readonly blend_edges: bigint;
  readonly color_blue: bigint;
  readonly color_green: bigint;
  readonly color_red: bigint;
  readonly columns: bigint;
  readonly connection_mode: bigint;
  readonly emissive: bigint;
  readonly first_object_id: bigint;
  readonly match_value: bigint;
  readonly mesh: bigint;
  readonly origin_y: bigint;
  readonly rows: bigint;
  readonly scale_x: bigint;
  readonly scale_y: bigint;
  readonly scale_z: bigint;
  readonly secondary_texture: bigint;
  readonly surface_mode: bigint;
  readonly texture: bigint;
  readonly texture_scale_x: bigint;
  readonly texture_scale_y: bigint;
  readonly tile_half_height: bigint;
  readonly tile_half_width: bigint;
  readonly variation_seed: bigint;
  readonly z: bigint;
}

const no_connections = 0;
const cardinal_connections = 1;

export function expand_isometric_component_layer(
  command: IsometricComponentLayerCommand,
  component_values: readonly (bigint | undefined)[],
): readonly SceneObjectCommand[] {
  const columns = positive_integer(command.columns, "columns");
  const rows = positive_integer(command.rows, "rows");
  const tile_count = columns * rows;
  if (tile_count > 262_144) {
    throw new Error(
      `isometric component layer dimensions ${columns}x${rows} exceed 262,144 tiles`,
    );
  }
  const first_object_id = nonnegative_integer(
    command.first_object_id,
    "first_object_id",
  );
  const mesh = nonnegative_integer(command.mesh, "mesh");
  const texture = optional_identifier(command.texture, "texture");
  const secondary_texture = optional_identifier(
    command.secondary_texture,
    "secondary_texture",
  );
  const connection_mode = integer(command.connection_mode, "connection_mode");
  if (
    connection_mode !== no_connections &&
    connection_mode !== cardinal_connections
  ) {
    throw new Error(
      `isometric component layer connection_mode ${connection_mode} must be 0 or 1`,
    );
  }
  const surface_mode = integer(command.surface_mode, "surface_mode");
  if (surface_mode < 0 || surface_mode > 2) {
    throw new Error(
      `isometric component layer surface_mode ${surface_mode} must be between 0 and 2`,
    );
  }
  const tile_half_height = positive_integer(
    command.tile_half_height,
    "tile_half_height",
  );
  const tile_half_width = positive_integer(
    command.tile_half_width,
    "tile_half_width",
  );
  const scale = [
    positive_number(command.scale_x, "scale_x"),
    positive_number(command.scale_y, "scale_y"),
    positive_number(command.scale_z, "scale_z"),
  ] as const;
  const texture_scale = [
    positive_number(command.texture_scale_x, "texture_scale_x") / 1_000_000,
    positive_number(command.texture_scale_y, "texture_scale_y") / 1_000_000,
  ] as const;
  const color = [
    color_channel(command.color_red, "color_red"),
    color_channel(command.color_green, "color_green"),
    color_channel(command.color_blue, "color_blue"),
  ] as const;
  const origin_y = integer(command.origin_y, "origin_y");
  const z = integer(command.z, "z");
  const emissive = integer(command.emissive, "emissive") / 1_000_000;
  const blend_edges = nonnegative_integer(command.blend_edges, "blend_edges");
  const variation_seed = integer(command.variation_seed, "variation_seed");

  const objects: SceneObjectCommand[] = [];
  for (let index = 0; index < tile_count; index += 1) {
    if (component_values[index] !== command.match_value) continue;
    const column = index % columns;
    const row = Math.floor(index / columns);
    objects.push({
      type: "scene_object",
      id: first_object_id + index,
      mesh,
      parent: null,
      color,
      emissive,
      texture,
      secondary_texture,
      texture_scale,
      blend_edges,
      variation_seed,
      surface_mode: surface_mode as SurfaceMode,
      path_connections: connection_mode === cardinal_connections
        ? neighboring_matches(
          component_values,
          command.match_value,
          index,
          columns,
          rows,
        )
        : 0,
      rotation_radians: [0, 0, 0],
      position: [
        (column - row) * tile_half_width,
        (column + row) * tile_half_height + origin_y,
        z,
      ],
      scale,
      visible: true,
    });
  }
  return objects;
}

function neighboring_matches(
  component_values: readonly (bigint | undefined)[],
  match_value: bigint,
  index: number,
  columns: number,
  rows: number,
): number {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const northeast = column + 1 < columns &&
      component_values[index + 1] === match_value
    ? 1
    : 0;
  const southwest = column > 0 && component_values[index - 1] === match_value
    ? 2
    : 0;
  const northwest = row + 1 < rows &&
      component_values[index + columns] === match_value
    ? 4
    : 0;
  const southeast = row > 0 &&
      component_values[index - columns] === match_value
    ? 8
    : 0;
  return northeast + southwest + northwest + southeast;
}

function positive_number(value: bigint, field: string): number {
  const parsed = integer(value, field);
  if (parsed <= 0) {
    throw new Error(
      `isometric component layer ${field} ${value} must be positive`,
    );
  }
  return parsed;
}

function positive_integer(value: bigint, field: string): number {
  return positive_number(value, field);
}

function nonnegative_integer(value: bigint, field: string): number {
  const parsed = integer(value, field);
  if (parsed < 0) {
    throw new Error(
      `isometric component layer ${field} ${value} must be nonnegative`,
    );
  }
  return parsed;
}

function optional_identifier(value: bigint, field: string): number | null {
  const parsed = integer(value, field);
  if (parsed < -1) {
    throw new Error(
      `isometric component layer ${field} ${value} must be -1 or greater`,
    );
  }
  return parsed < 0 ? null : parsed;
}

function color_channel(value: bigint, field: string): number {
  const parsed = integer(value, field);
  if (parsed < 0 || parsed > 1_000_000) {
    throw new Error(
      `isometric component layer ${field} ${value} must be between 0 and 1000000`,
    );
  }
  return parsed / 1_000_000;
}

function integer(value: bigint, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `isometric component layer ${field} ${value} is not a safe integer`,
    );
  }
  return parsed;
}

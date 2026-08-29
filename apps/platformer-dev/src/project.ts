import { parse_indexed_seed } from "@ink/blot/ecs_seed.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import { box_shape_2d } from "@ink/physics/world_2d.ts";
import {
  type PlatformerBounds,
  type PlatformerProject,
  type PlatformerRecord,
} from "@ink/platformer-editor/model.ts";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";

const units_per_meter = 1_000_000;

export interface CompiledPlatformerProject {
  readonly blot_source: string;
  readonly canonical_source: string;
  readonly entity_count: number;
  readonly kind_seed: string;
  readonly position_seed: string;
  readonly size_seed: string;
}

interface PlatformerEntitySeed {
  readonly kind: 0 | 1 | 2;
  readonly position: readonly [number, number];
  readonly size: readonly [number, number];
}

export function compile_platformer_project(
  source: string,
): CompiledPlatformerProject {
  const project = parse_platformer_project(source);
  const level = project.levels.find(({ id }) => id === project.entry_level_id);
  if (level === undefined) {
    throw new Error(
      `platformer project ${project.id} entry level ${project.entry_level_id} is missing`,
    );
  }
  const records = level.layers.flatMap(({ records }) => records);
  const spawn = required_record(records, "spawn");
  const exit = required_record(records, "exit");
  const platforms = records.filter((record) => record.kind === "platform");
  const entities: readonly PlatformerEntitySeed[] = [
    {
      kind: 0,
      position: point_seed(spawn.position),
      size: [700_000, 1_000_000],
    },
    { kind: 1, ...bounds_seed(exit.bounds) },
    ...platforms.map((platform) => ({
      kind: 2 as const,
      ...bounds_seed(platform.bounds),
    })),
  ];
  const position_seed = encode_seed(entities.map(({ position }) => position));
  const size_seed = encode_seed(entities.map(({ size }) => size));
  const kind_seed = encode_seed(entities.map(({ kind }) => [kind]));
  parse_indexed_seed(position_seed, 2, entities.length);
  parse_indexed_seed(size_seed, 2, entities.length);
  parse_indexed_seed(kind_seed, 1, entities.length);
  return Object.freeze({
    blot_source: compile_blot_source(
      project,
      level.name,
      spawn.position,
      exit.bounds,
      {
        position_seed,
        size_seed,
        kind_seed,
        entity_count: entities.length,
      },
    ),
    canonical_source: serialize_platformer_project(project),
    entity_count: entities.length,
    kind_seed,
    position_seed,
    size_seed,
  });
}

function compile_blot_source(
  project: PlatformerProject,
  level_name: string,
  spawn: { readonly x: number; readonly y: number },
  exit: PlatformerBounds,
  seeds: Pick<
    CompiledPlatformerProject,
    "entity_count" | "kind_seed" | "position_seed" | "size_seed"
  >,
): string {
  return `return {
  .project_name = ${blot_text_literal(project.name)};
  .level_name = ${blot_text_literal(level_name)};
  .entity_count = ${seeds.entity_count};
  .position_seed = ${blot_text_literal(seeds.position_seed)};
  .size_seed = ${blot_text_literal(seeds.size_seed)};
  .kind_seed = ${blot_text_literal(seeds.kind_seed)};
  .maximum_run_speed = ${
    Math.round(project.movement.maximum_run_speed * units_per_meter)
  };
  .jump_speed = ${Math.round(project.movement.jump_speed * units_per_meter)};
  .gravity = ${Math.round(project.movement.gravity * units_per_meter)};
  .terminal_fall_speed = ${
    Math.round(project.movement.terminal_fall_speed * units_per_meter)
  };
  .spawn_x = ${Math.round(spawn.x * units_per_meter)};
  .spawn_y = ${Math.round(spawn.y * units_per_meter)};
  .exit_minimum_x = ${Math.round(exit.minimum.x * units_per_meter)};
  .exit_maximum_x = ${Math.round(exit.maximum.x * units_per_meter)};
}
`;
}

function required_record<Kind extends "spawn" | "exit">(
  records: readonly PlatformerRecord[],
  kind: Kind,
): Extract<PlatformerRecord, { readonly kind: Kind }> {
  const matches = records.filter(
    (record): record is Extract<PlatformerRecord, { readonly kind: Kind }> =>
      record.kind === kind,
  );
  if (matches.length !== 1) {
    throw new Error(
      `platformer level contains ${matches.length} ${kind} records; expected one`,
    );
  }
  return matches[0];
}

function point_seed(point: { readonly x: number; readonly y: number }) {
  return [
    Math.round(point.x * units_per_meter),
    Math.round(point.y * units_per_meter),
  ] as const;
}

function bounds_seed(bounds: PlatformerBounds): {
  readonly position: readonly [number, number];
  readonly size: readonly [number, number];
} {
  const width = bounds.maximum.x - bounds.minimum.x;
  const height = bounds.maximum.y - bounds.minimum.y;
  box_shape_2d(vec2(width / 2, height / 2));
  aabb(
    vec3(bounds.minimum.x, bounds.minimum.y, 0),
    vec3(bounds.maximum.x, bounds.maximum.y, 1),
  );
  return {
    position: [
      Math.round((bounds.minimum.x + width / 2) * units_per_meter),
      Math.round((bounds.minimum.y + height / 2) * units_per_meter),
    ],
    size: [
      Math.round(width * units_per_meter),
      Math.round(height * units_per_meter),
    ],
  };
}

function encode_seed(rows: readonly (readonly number[])[]): string {
  return rows.map((row) => row.join(",")).join(";");
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

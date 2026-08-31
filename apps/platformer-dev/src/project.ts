import type {
  ExitRecord,
  PlatformerLevel,
  PlatformerProject,
  PlatformerRecord,
  PlatformRecord,
  SpawnRecord,
} from "@ink/platformer-editor/model.ts";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";

export interface CompiledPlatformerProject {
  readonly blot_source: string;
  readonly canonical_source: string;
  readonly level_asset_source: string;
}

const fixed_unit = 1_000_000;

export function compile_platformer_project(
  source: string,
): CompiledPlatformerProject {
  const project = parse_platformer_project(source);
  const level = required_entry_level(project);
  const records = level.layers.flatMap(({ records }) => records);
  const spawn = required_record(records, "spawn", level);
  const exit = required_record(records, "exit", level);
  const platforms = records.filter((record) => record.kind === "platform");
  if (platforms.length === 0) {
    throw new Error(`platformer level ${level.id} has no collision platforms`);
  }
  return Object.freeze({
    blot_source: compile_blot_project(project, level, spawn, exit, platforms),
    canonical_source: serialize_platformer_project(project),
    level_asset_source: compile_level_asset(level, platforms),
  });
}

function required_entry_level(project: PlatformerProject): PlatformerLevel {
  const level = project.levels.find(({ id }) => id === project.entry_level_id);
  if (level === undefined) {
    throw new Error(
      `platformer project ${project.id} entry level ${project.entry_level_id} is missing`,
    );
  }
  return level;
}

function required_record<Kind extends "spawn" | "exit">(
  records: readonly PlatformerRecord[],
  kind: Kind,
  level: PlatformerLevel,
): Extract<PlatformerRecord, {
  readonly kind: Kind;
}> {
  const matching = records.filter(
    (record): record is Extract<PlatformerRecord, { readonly kind: Kind }> =>
      record.kind === kind,
  );
  if (matching.length !== 1) {
    throw new Error(
      `platformer level ${level.id} has ${matching.length} ${kind} records; expected 1`,
    );
  }
  return matching[0];
}

function compile_level_asset(
  level: PlatformerLevel,
  platforms: readonly PlatformRecord[],
): string {
  return `${
    JSON.stringify(
      {
        format: "blot-integer-data",
        version: 1,
        name: level.name,
        record_ids: platforms.map(({ id }) => id),
        fields: [
          platforms.map(({ bounds, id }) =>
            fixed(bounds.minimum.x, `platform ${id} minimum x`)
          ),
          platforms.map(({ bounds, id }) =>
            fixed(bounds.minimum.y, `platform ${id} minimum y`)
          ),
          platforms.map(({ bounds, id }) =>
            fixed(bounds.maximum.x, `platform ${id} maximum x`)
          ),
          platforms.map(({ bounds, id }) =>
            fixed(bounds.maximum.y, `platform ${id} maximum y`)
          ),
          platforms.map(({ surface }) => surface === "solid" ? 0 : 1),
        ],
      },
      null,
      2,
    )
  }\n`;
}

function compile_blot_project(
  project: PlatformerProject,
  level: PlatformerLevel,
  spawn: SpawnRecord,
  exit: ExitRecord,
  platforms: readonly PlatformRecord[],
): string {
  return `open import "blot:prelude"

const PlatformerProject = {
  .runtime_token = Int;
  .project_name = Text;
  .level_name = Text;
  .platform_count = Int;
  .spawn_x = Int;
  .spawn_y = Int;
  .exit_min_x = Int;
  .exit_min_y = Int;
  .exit_max_x = Int;
  .exit_max_y = Int;
  .kill_plane_y = Int;
  .maximum_run_speed = Int;
  .ground_acceleration = Int;
  .air_acceleration = Int;
  .jump_speed = Int;
  .gravity = Int;
  .terminal_fall_speed = Int;
}

const project :: Int -> PlatformerProject
const project = fn runtime_token => {
  .runtime_token = runtime_token;
  .project_name = ${blot_text_literal(project.name)};
  .level_name = ${blot_text_literal(level.name)};
  .platform_count = ${platforms.length};
  .spawn_x = ${fixed(spawn.position.x, `spawn ${spawn.id} x`)};
  .spawn_y = ${fixed(spawn.position.y, `spawn ${spawn.id} y`)};
  .exit_min_x = ${fixed(exit.bounds.minimum.x, `exit ${exit.id} minimum x`)};
  .exit_min_y = ${fixed(exit.bounds.minimum.y, `exit ${exit.id} minimum y`)};
  .exit_max_x = ${fixed(exit.bounds.maximum.x, `exit ${exit.id} maximum x`)};
  .exit_max_y = ${fixed(exit.bounds.maximum.y, `exit ${exit.id} maximum y`)};
  .kill_plane_y = ${fixed(level.kill_plane_y, `level ${level.id} kill plane`)};
  .maximum_run_speed = ${
    fixed(project.movement.maximum_run_speed, "maximum run speed")
  };
  .ground_acceleration = ${
    fixed(project.movement.ground_acceleration, "ground acceleration")
  };
  .air_acceleration = ${
    fixed(project.movement.air_acceleration, "air acceleration")
  };
  .jump_speed = ${fixed(project.movement.jump_speed, "jump speed")};
  .gravity = ${fixed(project.movement.gravity, "gravity")};
  .terminal_fall_speed = ${
    fixed(project.movement.terminal_fall_speed, "terminal fall speed")
  };
}

return { .project = project; }
`;
}

function fixed(value: number, label: string): number {
  const scaled = Math.round(value * fixed_unit);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} exceeds fixed-point range`,
    );
  }
  if (Math.abs(scaled / fixed_unit - value) > Number.EPSILON) {
    throw new Error(
      `${label} ${JSON.stringify(value)} cannot be represented in millionths`,
    );
  }
  return scaled;
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

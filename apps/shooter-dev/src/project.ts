import type {
  ShooterEncounter,
  ShooterObjective,
  ShooterProject,
  ShooterRoom,
  ShooterSpawn,
  ShooterWeapon,
} from "@ink/shooter-editor/model.ts";
import {
  parse_shooter_project,
  serialize_shooter_project,
} from "@ink/shooter-editor/serialization.ts";

export interface CompiledShooterProject {
  readonly blot_source: string;
  readonly canonical_source: string;
}

const rounds_per_enemy = 2;

type AuthoredEnemyPair =
  | {
    readonly type: "single";
    readonly first: ShooterSpawn;
  }
  | {
    readonly type: "reinforced";
    readonly first: ShooterSpawn;
    readonly second: ShooterSpawn;
  };

export function compile_shooter_project(
  source: string,
): CompiledShooterProject {
  const project = parse_shooter_project(source);
  const player = required_one(
    project.spawns.filter(({ allegiance }) => allegiance === "player"),
    `shooter project ${project.id} player spawn`,
  );
  const weapon = required_one(
    project.weapons,
    `shooter project ${project.id} weapon`,
  );
  const objective = required_one(
    project.objectives.filter(({ kind }) => kind === "eliminate"),
    `shooter project ${project.id} eliminate objective`,
  );
  const encounter = required_one(
    project.encounters.filter(({ room_id }) => room_id === objective.room_id),
    `shooter objective ${objective.id} encounter`,
  );
  const arena = required_room(project, encounter.room_id);
  const enemies = encounter.spawn_ids.map((spawn_id) => {
    const spawn = project.spawns.find(({ id }) => id === spawn_id);
    if (spawn === undefined) {
      throw new Error(
        `shooter encounter ${encounter.id} references missing spawn ${spawn_id}`,
      );
    }
    return spawn;
  });
  const enemy_pair = authored_enemy_pair(encounter, enemies);
  const ammunition_required = enemies.length * rounds_per_enemy;
  if (weapon.magazine_capacity < ammunition_required) {
    throw new Error(
      `shooter weapon ${weapon.id} magazine ${weapon.magazine_capacity} cannot clear ${enemies.length} enemies requiring ${ammunition_required} rounds`,
    );
  }

  return Object.freeze({
    blot_source: compile_blot_project({
      project,
      player,
      weapon,
      objective,
      encounter,
      arena,
      enemies: enemy_pair,
    }),
    canonical_source: serialize_shooter_project(project),
  });
}

interface ShooterBlotProject {
  readonly project: ShooterProject;
  readonly player: ShooterSpawn;
  readonly weapon: ShooterWeapon;
  readonly objective: ShooterObjective;
  readonly encounter: ShooterEncounter;
  readonly arena: ShooterRoom;
  readonly enemies: AuthoredEnemyPair;
}

function compile_blot_project(compiled: ShooterBlotProject): string {
  const second_enemy = compiled.enemies.type === "reinforced"
    ? compiled.enemies.second.id
    : compiled.enemies.first.id;
  return `open import "blot:prelude"

const ShooterProject = {
  .runtime_token = Int;
  .project_name = Text;
  .arena_label = Text;
  .player_id = Text;
  .objective_id = Text;
  .encounter_id = Text;
  .weapon_id = Text;
  .weapon_damage = Int;
  .magazine_capacity = Int;
  .rounds_per_enemy = Int;
  .enemy_count = Int;
  .first_enemy_id = Text;
  .second_enemy_id = Text;
}

const project :: Int -> ShooterProject
const project = fn runtime_token => {
  .runtime_token = runtime_token;
  .project_name = ${blot_text_literal(compiled.project.name)};
  .arena_label = ${blot_text_literal(compiled.arena.label)};
  .player_id = ${blot_text_literal(compiled.player.id)};
  .objective_id = ${blot_text_literal(compiled.objective.id)};
  .encounter_id = ${blot_text_literal(compiled.encounter.id)};
  .weapon_id = ${blot_text_literal(compiled.weapon.id)};
  .weapon_damage = ${compiled.weapon.damage};
  .magazine_capacity = ${compiled.weapon.magazine_capacity};
  .rounds_per_enemy = ${rounds_per_enemy};
  .enemy_count = ${compiled.enemies.type === "reinforced" ? 2 : 1};
  .first_enemy_id = ${blot_text_literal(compiled.enemies.first.id)};
  .second_enemy_id = ${blot_text_literal(second_enemy)};
}

return { .project = project; }
`;
}

function authored_enemy_pair(
  encounter: ShooterEncounter,
  enemies: readonly ShooterSpawn[],
): AuthoredEnemyPair {
  if (enemies.length === 1) {
    return Object.freeze({ type: "single", first: enemies[0] });
  }
  if (enemies.length === 2) {
    return Object.freeze({
      type: "reinforced",
      first: enemies[0],
      second: enemies[1],
    });
  }
  throw new Error(
    `shooter encounter ${encounter.id} enemy count ${enemies.length} must be 1 or 2`,
  );
}

function required_room(
  project: ShooterProject,
  room_id: string,
): ShooterRoom {
  const room = project.rooms.find(({ id }) => id === room_id);
  if (room === undefined) {
    throw new Error(`shooter project ${project.id} has no room ${room_id}`);
  }
  return room;
}

function required_one<Entry>(entries: readonly Entry[], label: string): Entry {
  if (entries.length !== 1) {
    throw new Error(`${label} count ${entries.length} must be 1`);
  }
  return entries[0];
}

function blot_text_literal(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  shooter_cover_id,
  shooter_door_id,
  shooter_encounter_id,
  shooter_objective_id,
  shooter_project_id,
  shooter_room_id,
  shooter_spawn_id,
  shooter_weapon_id,
} from "./identity.ts";
import { shooter_project, type ShooterProject } from "./model.ts";
import { shooter_presets } from "./catalog.ts";
import { validate_shooter_project } from "./validation.ts";

export function parse_shooter_project(
  source: string,
  source_name = "shooter project",
): ShooterProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`${source_name} is not valid JSON`, { cause });
  }
  const root = exact_record(parsed, [
    "cover",
    "doors",
    "encounters",
    "id",
    "name",
    "objectives",
    "preset_id",
    "rooms",
    "schema_version",
    "spawns",
    "weapons",
  ], source_name);
  if (root.schema_version !== 1) {
    throw new Error(
      `${source_name} schema version ${
        JSON.stringify(root.schema_version)
      } is unsupported`,
    );
  }
  const preset_id = editor_preset_id(
    text(root.preset_id, `${source_name} preset_id`),
  );
  if (!shooter_presets.some(({ id }) => id === preset_id)) {
    throw new Error(`${source_name} preset ${preset_id} is unavailable`);
  }
  const project = shooter_project({
    schema_version: 1,
    id: shooter_project_id(text(root.id, `${source_name} id`)),
    name: text(root.name, `${source_name} name`),
    preset_id,
    rooms: array(root.rooms, `${source_name} rooms`).map((entry, index) => {
      const room = exact_record(
        entry,
        ["id", "label"],
        `${source_name} rooms[${index}]`,
      );
      return {
        id: shooter_room_id(text(room.id, `room ${index} id`)),
        label: text(room.label, `room ${index} label`),
      };
    }),
    cover: array(root.cover, `${source_name} cover`).map((entry, index) => {
      const cover = exact_record(
        entry,
        ["id", "protection", "room_id"],
        `${source_name} cover[${index}]`,
      );
      return {
        id: shooter_cover_id(text(cover.id, `cover ${index} id`)),
        room_id: shooter_room_id(
          text(cover.room_id, `cover ${index} room_id`),
        ),
        protection: one_of(
          cover.protection,
          ["low", "high"],
          `cover ${index} protection`,
        ),
      };
    }),
    spawns: array(root.spawns, `${source_name} spawns`).map((entry, index) => {
      const spawn = exact_record(
        entry,
        ["allegiance", "id", "room_id"],
        `${source_name} spawns[${index}]`,
      );
      return {
        id: shooter_spawn_id(text(spawn.id, `spawn ${index} id`)),
        room_id: shooter_room_id(
          text(spawn.room_id, `spawn ${index} room_id`),
        ),
        allegiance: one_of(
          spawn.allegiance,
          ["player", "enemy"],
          `spawn ${index} allegiance`,
        ),
      };
    }),
    weapons: array(root.weapons, `${source_name} weapons`).map(
      (entry, index) => {
        const weapon = exact_record(
          entry,
          ["damage", "id", "magazine_capacity"],
          `${source_name} weapons[${index}]`,
        );
        return {
          id: shooter_weapon_id(text(weapon.id, `weapon ${index} id`)),
          damage: finite_number(weapon.damage, `weapon ${index} damage`),
          magazine_capacity: finite_number(
            weapon.magazine_capacity,
            `weapon ${index} magazine_capacity`,
          ),
        };
      },
    ),
    encounters: array(root.encounters, `${source_name} encounters`).map(
      (entry, index) => {
        const encounter = exact_record(
          entry,
          ["id", "room_id", "spawn_ids"],
          `${source_name} encounters[${index}]`,
        );
        return {
          id: shooter_encounter_id(
            text(encounter.id, `encounter ${index} id`),
          ),
          room_id: shooter_room_id(
            text(encounter.room_id, `encounter ${index} room_id`),
          ),
          spawn_ids: array(
            encounter.spawn_ids,
            `encounter ${index} spawn_ids`,
          ).map((spawn_id, spawn_index) =>
            shooter_spawn_id(
              text(
                spawn_id,
                `encounter ${index} spawn_ids[${spawn_index}]`,
              ),
            )
          ),
        };
      },
    ),
    doors: array(root.doors, `${source_name} doors`).map((entry, index) => {
      const door = exact_record(entry, [
        "from_room_id",
        "id",
        "required_objective_id",
        "to_room_id",
      ], `${source_name} doors[${index}]`);
      const required_objective_id = door.required_objective_id === null
        ? null
        : shooter_objective_id(
          text(
            door.required_objective_id,
            `door ${index} required_objective_id`,
          ),
        );
      return {
        id: shooter_door_id(text(door.id, `door ${index} id`)),
        from_room_id: shooter_room_id(
          text(door.from_room_id, `door ${index} from_room_id`),
        ),
        to_room_id: shooter_room_id(
          text(door.to_room_id, `door ${index} to_room_id`),
        ),
        required_objective_id,
      };
    }),
    objectives: array(root.objectives, `${source_name} objectives`).map(
      (entry, index) => {
        const objective = exact_record(
          entry,
          ["id", "kind", "room_id"],
          `${source_name} objectives[${index}]`,
        );
        return {
          id: shooter_objective_id(
            text(objective.id, `objective ${index} id`),
          ),
          room_id: shooter_room_id(
            text(objective.room_id, `objective ${index} room_id`),
          ),
          kind: one_of(
            objective.kind,
            ["eliminate", "reach", "interact"],
            `objective ${index} kind`,
          ),
        };
      },
    ),
  });
  const diagnostics = validate_shooter_project(project).filter(
    ({ severity }) => severity === "error",
  );
  if (diagnostics.length > 0) {
    throw new Error(
      `${source_name} is invalid: ${
        diagnostics.map(({ message }) => message).join("; ")
      }`,
    );
  }
  return project;
}

export function serialize_shooter_project(project: ShooterProject): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

function exact_record(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = Object.fromEntries(Object.entries(value));
  const expected = new Set(fields);
  const missing = fields.filter((field) => !(field in record));
  const unknown = Object.keys(record).filter((field) => !expected.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} fields differ; missing [${missing.join(", ")}], unknown [${
        unknown.join(", ")
      }]`,
    );
  }
  return record;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function finite_number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must be finite`);
  }
  return value;
}

function one_of<const Value extends string>(
  value: unknown,
  choices: readonly Value[],
  label: string,
): Value {
  if (typeof value === "string") {
    const match = choices.find((choice) => choice === value);
    if (match !== undefined) return match;
  }
  throw new Error(
    `${label} ${JSON.stringify(value)} must be one of ${choices.join(", ")}`,
  );
}

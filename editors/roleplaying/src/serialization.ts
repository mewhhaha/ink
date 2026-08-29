import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  roleplaying_actor_id,
  roleplaying_dialogue_id,
  roleplaying_encounter_id,
  roleplaying_loot_id,
  roleplaying_navigation_id,
  roleplaying_project_id,
  roleplaying_quest_id,
  roleplaying_region_id,
} from "./identity.ts";
import { roleplaying_project, type RoleplayingProject } from "./model.ts";
import { validate_roleplaying_project } from "./validation.ts";

export function parse_roleplaying_project(
  source: string,
  source_name = "role-playing project",
): RoleplayingProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`${source_name} is not valid JSON`, { cause });
  }
  const root = exact_record(parsed, [
    "actors",
    "dialogue",
    "encounters",
    "id",
    "initial_region_id",
    "loot",
    "name",
    "navigation",
    "preset_id",
    "quests",
    "regions",
    "schema_version",
    "shrine_region_id",
  ], source_name);
  if (root.schema_version !== 1) {
    throw new Error(
      `${source_name} schema version ${
        JSON.stringify(root.schema_version)
      } is unsupported`,
    );
  }
  const project = roleplaying_project({
    schema_version: 1,
    id: roleplaying_project_id(text(root.id, `${source_name} id`)),
    name: text(root.name, `${source_name} name`),
    preset_id: editor_preset_id(
      text(root.preset_id, `${source_name} preset_id`),
    ),
    initial_region_id: roleplaying_region_id(
      text(root.initial_region_id, `${source_name} initial_region_id`),
    ),
    shrine_region_id: roleplaying_region_id(
      text(root.shrine_region_id, `${source_name} shrine_region_id`),
    ),
    regions: array(root.regions, `${source_name} regions`).map(
      (entry, index) => {
        const region = exact_record(
          entry,
          ["id", "label"],
          `${source_name} regions[${index}]`,
        );
        return {
          id: roleplaying_region_id(text(region.id, `region ${index} id`)),
          label: text(region.label, `region ${index} label`),
        };
      },
    ),
    actors: array(root.actors, `${source_name} actors`).map((entry, index) => {
      const actor = exact_record(
        entry,
        ["id", "region_id", "role"],
        `${source_name} actors[${index}]`,
      );
      return {
        id: roleplaying_actor_id(text(actor.id, `actor ${index} id`)),
        region_id: roleplaying_region_id(
          text(actor.region_id, `actor ${index} region_id`),
        ),
        role: one_of(
          actor.role,
          ["player", "companion", "nonplayer", "enemy"],
          `actor ${index} role`,
        ),
      };
    }),
    dialogue: array(root.dialogue, `${source_name} dialogue`).map(
      (entry, index) => {
        const dialogue = exact_record(
          entry,
          ["id", "lines", "speaker_id"],
          `${source_name} dialogue[${index}]`,
        );
        return {
          id: roleplaying_dialogue_id(
            text(dialogue.id, `dialogue ${index} id`),
          ),
          speaker_id: roleplaying_actor_id(
            text(dialogue.speaker_id, `dialogue ${index} speaker_id`),
          ),
          lines: string_array(dialogue.lines, `dialogue ${index} lines`),
        };
      },
    ),
    quests: array(root.quests, `${source_name} quests`).map((entry, index) => {
      const quest = exact_record(
        entry,
        ["id", "objective", "region_id"],
        `${source_name} quests[${index}]`,
      );
      return {
        id: roleplaying_quest_id(text(quest.id, `quest ${index} id`)),
        region_id: roleplaying_region_id(
          text(quest.region_id, `quest ${index} region_id`),
        ),
        objective: text(quest.objective, `quest ${index} objective`),
      };
    }),
    loot: array(root.loot, `${source_name} loot`).map((entry, index) => {
      const loot = exact_record(
        entry,
        ["entries", "id", "region_id"],
        `${source_name} loot[${index}]`,
      );
      return {
        id: roleplaying_loot_id(text(loot.id, `loot ${index} id`)),
        region_id: roleplaying_region_id(
          text(loot.region_id, `loot ${index} region_id`),
        ),
        entries: string_array(loot.entries, `loot ${index} entries`),
      };
    }),
    encounters: array(root.encounters, `${source_name} encounters`).map(
      (entry, index) => {
        const encounter = exact_record(
          entry,
          ["actor_ids", "id", "region_id"],
          `${source_name} encounters[${index}]`,
        );
        return {
          id: roleplaying_encounter_id(
            text(encounter.id, `encounter ${index} id`),
          ),
          region_id: roleplaying_region_id(
            text(encounter.region_id, `encounter ${index} region_id`),
          ),
          actor_ids: string_array(
            encounter.actor_ids,
            `encounter ${index} actor_ids`,
          ).map(roleplaying_actor_id),
        };
      },
    ),
    navigation: array(root.navigation, `${source_name} navigation`).map(
      (entry, index) => {
        const link = exact_record(entry, [
          "from_region_id",
          "id",
          "to_region_id",
        ], `${source_name} navigation[${index}]`);
        return {
          id: roleplaying_navigation_id(
            text(link.id, `navigation ${index} id`),
          ),
          from_region_id: roleplaying_region_id(
            text(link.from_region_id, `navigation ${index} from_region_id`),
          ),
          to_region_id: roleplaying_region_id(
            text(link.to_region_id, `navigation ${index} to_region_id`),
          ),
        };
      },
    ),
  });
  const errors = validate_roleplaying_project(project);
  if (errors.length > 0) {
    throw new Error(
      `${source_name} is invalid: ${
        errors.map(({ message }) => message).join("; ")
      }`,
    );
  }
  return project;
}

export function serialize_roleplaying_project(
  project: RoleplayingProject,
): string {
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

function string_array(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry, index) =>
    text(entry, `${label}[${index}]`)
  );
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

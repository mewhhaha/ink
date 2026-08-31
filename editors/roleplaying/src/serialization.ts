import { editor_preset_id } from "@ink/authoring/identity.ts";
import {
  roleplaying_actor_id,
  roleplaying_dialogue_id,
  roleplaying_encounter_id,
  roleplaying_loot_id,
  roleplaying_project_id,
  roleplaying_quest_id,
  roleplaying_region_id,
  roleplaying_timeline_id,
  roleplaying_travel_link_id,
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
    "preset_id",
    "quests",
    "regions",
    "schema_version",
    "timeline",
    "travel_links",
  ], source_name);
  if (root.schema_version !== 2) {
    throw new Error(
      `${source_name} schema version ${
        JSON.stringify(root.schema_version)
      } is unsupported`,
    );
  }
  const timeline = exact_record(
    root.timeline,
    ["beats", "id", "version"],
    `${source_name} timeline`,
  );
  if (timeline.version !== 1) {
    throw new Error(
      `${source_name} timeline version ${
        JSON.stringify(timeline.version)
      } is unsupported`,
    );
  }
  const project = roleplaying_project({
    schema_version: 2,
    id: roleplaying_project_id(text(root.id, `${source_name} id`)),
    name: text(root.name, `${source_name} name`),
    preset_id: editor_preset_id(
      text(root.preset_id, `${source_name} preset_id`),
    ),
    initial_region_id: roleplaying_region_id(
      text(root.initial_region_id, `${source_name} initial_region_id`),
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
      const label = `${source_name} actors[${index}]`;
      const actor_record = record(entry, label);
      const role = one_of(
        actor_record.role,
        ["player", "companion", "nonplayer", "enemy"],
        `actor ${index} role`,
      );
      const actor = exact_record(
        entry,
        role === "player" || role === "enemy"
          ? [
            "attack_damage",
            "id",
            "label",
            "maximum_health",
            "region_id",
            "role",
          ]
          : ["id", "label", "region_id", "role"],
        label,
      );
      const id = roleplaying_actor_id(text(actor.id, `actor ${index} id`));
      const actor_label = text(actor.label, `actor ${index} label`);
      const region_id = roleplaying_region_id(
        text(actor.region_id, `actor ${index} region_id`),
      );
      if (role === "player" || role === "enemy") {
        return {
          id,
          label: actor_label,
          region_id,
          role,
          maximum_health: positive_integer(
            actor.maximum_health,
            `actor ${index} maximum_health`,
          ),
          attack_damage: positive_integer(
            actor.attack_damage,
            `actor ${index} attack_damage`,
          ),
        };
      }
      return {
        id,
        label: actor_label,
        region_id,
        role,
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
        ["completion", "id", "objective"],
        `${source_name} quests[${index}]`,
      );
      const completion_record = record(
        quest.completion,
        `quest ${index} completion`,
      );
      const completion_type = one_of(
        completion_record.type,
        ["reach_region", "deliver_loot"],
        `quest ${index} completion type`,
      );
      const completion = exact_record(
        quest.completion,
        completion_type === "reach_region"
          ? ["region_id", "type"]
          : ["loot_id", "region_id", "type"],
        `quest ${index} completion`,
      );
      return {
        id: roleplaying_quest_id(text(quest.id, `quest ${index} id`)),
        objective: text(quest.objective, `quest ${index} objective`),
        completion: completion_type === "reach_region"
          ? {
            type: completion_type,
            region_id: roleplaying_region_id(
              text(completion.region_id, `quest ${index} completion region_id`),
            ),
          }
          : {
            type: completion_type,
            region_id: roleplaying_region_id(
              text(completion.region_id, `quest ${index} completion region_id`),
            ),
            loot_id: roleplaying_loot_id(
              text(completion.loot_id, `quest ${index} completion loot_id`),
            ),
          },
      };
    }),
    loot: array(root.loot, `${source_name} loot`).map((entry, index) => {
      const loot = exact_record(
        entry,
        ["availability", "entries", "id", "region_id"],
        `${source_name} loot[${index}]`,
      );
      const availability_record = record(
        loot.availability,
        `loot ${index} availability`,
      );
      const availability_type = one_of(
        availability_record.type,
        ["available", "after_encounter"],
        `loot ${index} availability type`,
      );
      const availability = exact_record(
        loot.availability,
        availability_type === "available" ? ["type"] : ["encounter_id", "type"],
        `loot ${index} availability`,
      );
      return {
        id: roleplaying_loot_id(text(loot.id, `loot ${index} id`)),
        region_id: roleplaying_region_id(
          text(loot.region_id, `loot ${index} region_id`),
        ),
        entries: string_array(loot.entries, `loot ${index} entries`),
        availability: availability_type === "available"
          ? { type: availability_type }
          : {
            type: availability_type,
            encounter_id: roleplaying_encounter_id(
              text(
                availability.encounter_id,
                `loot ${index} availability encounter_id`,
              ),
            ),
          },
      };
    }),
    encounters: array(root.encounters, `${source_name} encounters`).map(
      (entry, index) => {
        const encounter = exact_record(
          entry,
          ["enemy_actor_ids", "id", "region_id"],
          `${source_name} encounters[${index}]`,
        );
        return {
          id: roleplaying_encounter_id(
            text(encounter.id, `encounter ${index} id`),
          ),
          region_id: roleplaying_region_id(
            text(encounter.region_id, `encounter ${index} region_id`),
          ),
          enemy_actor_ids: string_array(
            encounter.enemy_actor_ids,
            `encounter ${index} enemy_actor_ids`,
          ).map(roleplaying_actor_id),
        };
      },
    ),
    travel_links: array(root.travel_links, `${source_name} travel_links`).map(
      (entry, index) => {
        const link = exact_record(entry, [
          "availability",
          "from_region_id",
          "id",
          "to_region_id",
        ], `${source_name} travel_links[${index}]`);
        const availability_record = record(
          link.availability,
          `travel link ${index} availability`,
        );
        const availability_type = one_of(
          availability_record.type,
          ["available", "after_dialogue", "after_loot"],
          `travel link ${index} availability type`,
        );
        const availability = exact_record(
          link.availability,
          availability_type === "available"
            ? ["type"]
            : availability_type === "after_dialogue"
            ? ["dialogue_id", "type"]
            : ["loot_id", "type"],
          `travel link ${index} availability`,
        );
        return {
          id: roleplaying_travel_link_id(
            text(link.id, `travel link ${index} id`),
          ),
          from_region_id: roleplaying_region_id(
            text(
              link.from_region_id,
              `travel link ${index} from_region_id`,
            ),
          ),
          to_region_id: roleplaying_region_id(
            text(link.to_region_id, `travel link ${index} to_region_id`),
          ),
          availability: availability_type === "available"
            ? { type: availability_type }
            : availability_type === "after_dialogue"
            ? {
              type: availability_type,
              dialogue_id: roleplaying_dialogue_id(
                text(
                  availability.dialogue_id,
                  `travel link ${index} availability dialogue_id`,
                ),
              ),
            }
            : {
              type: availability_type,
              loot_id: roleplaying_loot_id(
                text(
                  availability.loot_id,
                  `travel link ${index} availability loot_id`,
                ),
              ),
            },
        };
      },
    ),
    timeline: {
      version: 1,
      id: roleplaying_timeline_id(
        text(timeline.id, `${source_name} timeline id`),
      ),
      beats: array(timeline.beats, `${source_name} timeline beats`).map(
        (entry, index) => {
          const label = `${source_name} timeline beats[${index}]`;
          const beat_record = record(entry, label);
          const type = one_of(
            beat_record.type,
            ["dialogue", "travel", "encounter", "loot", "quest"],
            `${label} type`,
          );
          const time_us = positive_integer(
            beat_record.time_us,
            `${label} time_us`,
          );
          switch (type) {
            case "dialogue": {
              const beat = exact_record(
                entry,
                ["dialogue_id", "time_us", "type"],
                label,
              );
              return {
                type,
                time_us,
                dialogue_id: roleplaying_dialogue_id(
                  text(beat.dialogue_id, `${label} dialogue_id`),
                ),
              };
            }
            case "travel": {
              const beat = exact_record(
                entry,
                ["time_us", "travel_link_id", "type"],
                label,
              );
              return {
                type,
                time_us,
                travel_link_id: roleplaying_travel_link_id(
                  text(beat.travel_link_id, `${label} travel_link_id`),
                ),
              };
            }
            case "encounter": {
              const beat = exact_record(
                entry,
                ["encounter_id", "time_us", "type"],
                label,
              );
              return {
                type,
                time_us,
                encounter_id: roleplaying_encounter_id(
                  text(beat.encounter_id, `${label} encounter_id`),
                ),
              };
            }
            case "loot": {
              const beat = exact_record(
                entry,
                ["loot_id", "time_us", "type"],
                label,
              );
              return {
                type,
                time_us,
                loot_id: roleplaying_loot_id(
                  text(beat.loot_id, `${label} loot_id`),
                ),
              };
            }
            case "quest": {
              const beat = exact_record(
                entry,
                ["quest_id", "time_us", "type"],
                label,
              );
              return {
                type,
                time_us,
                quest_id: roleplaying_quest_id(
                  text(beat.quest_id, `${label} quest_id`),
                ),
              };
            }
          }
        },
      ),
    },
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

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
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
  const parsed = record(value, label);
  const expected = new Set(fields);
  const missing = fields.filter((field) => !(field in parsed));
  const unknown = Object.keys(parsed).filter((field) => !expected.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} fields differ; missing [${missing.join(", ")}], unknown [${
        unknown.join(", ")
      }]`,
    );
  }
  return parsed;
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

function positive_integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a positive safe integer`,
    );
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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { renderToString } from "react-dom/server";
import { roleplaying_editor } from "./catalog.ts";
import { apply_roleplaying_command } from "./commands.ts";
import {
  roleplaying_actor_id,
  roleplaying_dialogue_id,
  roleplaying_encounter_id,
  roleplaying_loot_id,
  roleplaying_quest_id,
  roleplaying_region_id,
  roleplaying_travel_link_id,
} from "./identity.ts";
import { roleplaying_project } from "./model.ts";
import { create_roleplaying_starter_project } from "./presets.ts";
import {
  parse_roleplaying_project,
  serialize_roleplaying_project,
} from "./serialization.ts";
import { validate_roleplaying_project } from "./validation.ts";
import { RoleplayingWorkspace } from "./workspace.tsx";

Deno.test("role-playing catalog exposes focused tools and presets", () => {
  assertEquals(roleplaying_editor.tools.length, 8);
  assertEquals(roleplaying_editor.presets.length, 5);
});

Deno.test("starter timeline preserves authored beat identities and microsecond timing", () => {
  const project = create_roleplaying_starter_project();

  assertEquals(project.schema_version, 2);
  assertEquals(project.timeline.version, 1);
  assertEquals(
    project.timeline.beats.map(({ type, time_us }) => [type, time_us]),
    [
      ["dialogue", 250_000],
      ["travel", 500_000],
      ["encounter", 750_000],
      ["loot", 1_250_000],
      ["travel", 1_500_000],
      ["quest", 1_500_000],
    ],
  );
  assertEquals(Object.isFrozen(project.timeline), true);
  assertEquals(Object.isFrozen(project.timeline.beats), true);
  assertEquals(project.timeline.beats.every(Object.isFrozen), true);
});

Deno.test("adding ruins loot preserves and freezes the source project", () => {
  const source = create_roleplaying_starter_project();
  const changed = apply_roleplaying_command(source, {
    version: 2,
    type: "add_loot_entry",
    loot_id: roleplaying_loot_id("ruins-cache"),
    entry: "moonstone-relic",
  });
  assertEquals(source.loot[0].entries, ["healing-herb"]);
  assertEquals(changed.loot[0].entries, ["healing-herb", "moonstone-relic"]);
  assertEquals(Object.isFrozen(changed.loot[0].entries), true);
  assertEquals(validate_roleplaying_project(changed), []);
  assertThrows(
    () =>
      apply_roleplaying_command(changed, {
        version: 2,
        type: "add_loot_entry",
        loot_id: roleplaying_loot_id("ruins-cache"),
        entry: "moonstone-relic",
      }),
    Error,
    "repeats entry moonstone-relic",
  );
});

Deno.test("moving an actor changes its branded region without mutating the project", () => {
  const source = create_roleplaying_starter_project();
  const changed = apply_roleplaying_command(source, {
    version: 2,
    type: "move_actor",
    actor_id: roleplaying_actor_id("hero"),
    region_id: roleplaying_region_id("ruins"),
  });

  assertEquals(
    source.actors.find(({ id }) => id === "hero")?.region_id,
    "village",
  );
  assertEquals(
    changed.actors.find(({ id }) => id === "hero")?.region_id,
    "ruins",
  );
  assertEquals(Object.isFrozen(changed.actors), true);
  assertEquals(validate_roleplaying_project(changed), []);
  assertThrows(
    () =>
      apply_roleplaying_command(source, {
        version: 2,
        type: "move_actor",
        actor_id: roleplaying_actor_id("hero"),
        region_id: roleplaying_region_id("missing-region"),
      }),
    Error,
    "no region missing-region",
  );
});

Deno.test("versioned commands author dialogue, travel, combat, loot, and shrine completion", () => {
  const commands = [
    {
      version: 2,
      type: "add_region",
      region: {
        id: roleplaying_region_id("lower-vault"),
        label: "Lower Vault",
      },
    },
    {
      version: 2,
      type: "add_actor",
      actor: {
        id: roleplaying_actor_id("echo-sentinel"),
        label: "Echo Sentinel",
        region_id: roleplaying_region_id("lower-vault"),
        role: "enemy",
        maximum_health: 8,
        attack_damage: 2,
      },
    },
    {
      version: 2,
      type: "add_dialogue",
      dialogue: {
        id: roleplaying_dialogue_id("keeper-warning"),
        speaker_id: roleplaying_actor_id("keeper"),
        lines: ["The lower vault answers only to the moonstone."],
      },
    },
    {
      version: 2,
      type: "add_encounter",
      encounter: {
        id: roleplaying_encounter_id("lower-guard"),
        region_id: roleplaying_region_id("lower-vault"),
        enemy_actor_ids: [roleplaying_actor_id("echo-sentinel")],
      },
    },
    {
      version: 2,
      type: "add_loot",
      loot: {
        id: roleplaying_loot_id("lower-cache"),
        region_id: roleplaying_region_id("lower-vault"),
        entries: ["sun-disk"],
        availability: {
          type: "after_encounter",
          encounter_id: roleplaying_encounter_id("lower-guard"),
        },
      },
    },
    {
      version: 2,
      type: "add_travel_link",
      travel_link: {
        id: roleplaying_travel_link_id("vault-stairs"),
        from_region_id: roleplaying_region_id("ruins"),
        to_region_id: roleplaying_region_id("lower-vault"),
        availability: {
          type: "after_dialogue",
          dialogue_id: roleplaying_dialogue_id("keeper-warning"),
        },
      },
    },
    {
      version: 2,
      type: "add_quest",
      quest: {
        id: roleplaying_quest_id("deliver-sun-disk"),
        objective: "Carry the sun disk from the lower vault to the shrine.",
        completion: {
          type: "deliver_loot",
          region_id: roleplaying_region_id("shrine"),
          loot_id: roleplaying_loot_id("lower-cache"),
        },
      },
    },
    {
      version: 2,
      type: "add_timeline_beat",
      beat: {
        type: "quest",
        time_us: 1_750_000,
        quest_id: roleplaying_quest_id("deliver-sun-disk"),
      },
    },
  ] as const;
  const source = create_roleplaying_starter_project();
  const changed = commands.reduce(apply_roleplaying_command, source);

  assertEquals(commands.map(({ version }) => version), [
    2,
    2,
    2,
    2,
    2,
    2,
    2,
    2,
  ]);
  assertEquals(source.regions.some(({ id }) => id === "lower-vault"), false);
  assertEquals(Object.isFrozen(changed.actors), true);
  assertEquals(Object.isFrozen(changed.loot.at(-1)?.availability), true);
  assertEquals(
    Object.isFrozen(changed.travel_links.at(-1)?.availability),
    true,
  );
  assertEquals(validate_roleplaying_project(changed), []);
  assertEquals(changed.timeline.beats.at(-1), {
    type: "quest",
    time_us: 1_750_000,
    quest_id: roleplaying_quest_id("deliver-sun-disk"),
  });
});

Deno.test("role-playing serialization round trips and rejects unknown fields", () => {
  const source = serialize_roleplaying_project(
    create_roleplaying_starter_project(),
  );
  assertEquals(
    serialize_roleplaying_project(parse_roleplaying_project(source)),
    source,
  );
  const unknown = JSON.parse(source);
  unknown.revision = 1;
  assertThrows(
    () => parse_roleplaying_project(JSON.stringify(unknown)),
    Error,
    "unknown [revision]",
  );
  const obsolete = JSON.parse(source);
  obsolete.schema_version = 1;
  assertThrows(
    () => parse_roleplaying_project(JSON.stringify(obsolete)),
    Error,
    "schema version 1 is unsupported",
  );
});

Deno.test("timeline validation names missing, duplicate, and reverse-ordered beats", () => {
  const source = create_roleplaying_starter_project();
  const invalid = roleplaying_project({
    ...source,
    timeline: {
      ...source.timeline,
      beats: [
        {
          type: "dialogue",
          time_us: 500_000,
          dialogue_id: roleplaying_dialogue_id("missing-dialogue"),
        },
        {
          type: "travel",
          time_us: 250_000,
          travel_link_id: roleplaying_travel_link_id("village-road"),
        },
        ...source.timeline.beats.slice(2),
        {
          type: "quest",
          time_us: 1_750_000,
          quest_id: roleplaying_quest_id("reach-shrine"),
        },
      ],
    },
  });

  assertEquals(
    validate_roleplaying_project(invalid).map(({ code }) => code),
    [
      "UNKNOWN_TIMELINE_REFERENCE",
      "TIMELINE_TIME_ORDER",
      "DUPLICATE_TIMELINE_BEAT",
    ],
  );
});

Deno.test("role-playing workspace presents the authoritative loot edit", () => {
  const source = renderToString(
    <RoleplayingWorkspace
      project={create_roleplaying_starter_project()}
      selected_region_id="ruins"
      onAddLoot={() => {}}
      onSelectRegion={() => {}}
    />,
  );
  assertStringIncludes(source, "Old Ruins");
  assertStringIncludes(source, "healing-herb");
  assertStringIncludes(source, "Add moonstone relic");
});

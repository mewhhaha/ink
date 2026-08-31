import { assertEquals, assertThrows } from "@std/assert";
import { shooter_editor } from "./catalog.ts";
import { apply_shooter_command } from "./commands.ts";
import {
  shooter_cover_id,
  shooter_door_id,
  shooter_encounter_id,
  shooter_objective_id,
  shooter_room_id,
  shooter_spawn_id,
  shooter_weapon_id,
} from "./identity.ts";
import { create_shooter_starter_project } from "./presets.ts";
import {
  parse_shooter_project,
  serialize_shooter_project,
} from "./serialization.ts";
import { validate_shooter_project } from "./validation.ts";

Deno.test("shooter catalog exposes a command-owned tool for every authored collection", () => {
  assertEquals(shooter_editor.tools.map(({ id }) => id), [
    "rooms",
    "cover",
    "spawns",
    "weapons",
    "encounters",
    "doors",
    "objectives",
  ]);
});

Deno.test("adding a reinforcement atomically updates the spawn and encounter", () => {
  const source = create_shooter_starter_project();
  const changed = apply_shooter_command(source, {
    type: "add_reinforcement",
    encounter_id: shooter_encounter_id("first-contact"),
    spawn: {
      id: shooter_spawn_id("reinforcement"),
      room_id: shooter_room_id("arena"),
      allegiance: "enemy",
    },
  });
  assertEquals(source.spawns.map(({ id }) => id), ["player", "guard"]);
  assertEquals(changed.spawns.map(({ id }) => id), [
    "player",
    "guard",
    "reinforcement",
  ]);
  assertEquals(changed.encounters[0].spawn_ids.map(String), [
    "guard",
    "reinforcement",
  ]);
  assertEquals(Object.isFrozen(source), true);
  assertEquals(Object.isFrozen(changed), true);
  assertEquals(Object.isFrozen(changed.spawns), true);
  assertEquals(Object.isFrozen(changed.spawns.at(-1)), true);
  assertEquals(Object.isFrozen(changed.encounters[0].spawn_ids), true);
  assertEquals(validate_shooter_project(changed), []);
});

Deno.test("shooter commands cover every catalog collection without mutating their source", () => {
  const source = create_shooter_starter_project();
  const room_id = shooter_room_id("vault");
  const spawn_id = shooter_spawn_id("vault-guard");
  let changed = apply_shooter_command(source, {
    type: "add_room",
    room: { id: room_id, label: "Vault" },
  });
  changed = apply_shooter_command(changed, {
    type: "add_cover",
    cover: {
      id: shooter_cover_id("vault-cover"),
      room_id,
      protection: "high",
    },
  });
  changed = apply_shooter_command(changed, {
    type: "add_spawn",
    spawn: { id: spawn_id, room_id, allegiance: "enemy" },
  });
  changed = apply_shooter_command(changed, {
    type: "add_weapon",
    weapon: {
      id: shooter_weapon_id("scattergun"),
      damage: 40,
      magazine_capacity: 6,
    },
  });
  changed = apply_shooter_command(changed, {
    type: "add_encounter",
    encounter: {
      id: shooter_encounter_id("vault-defense"),
      room_id,
      spawn_ids: [spawn_id],
    },
  });
  changed = apply_shooter_command(changed, {
    type: "add_objective",
    objective: {
      id: shooter_objective_id("reach-vault"),
      room_id,
      kind: "reach",
    },
  });
  changed = apply_shooter_command(changed, {
    type: "add_door",
    door: {
      id: shooter_door_id("vault-door"),
      from_room_id: shooter_room_id("arena"),
      to_room_id: room_id,
      required_objective_id: null,
    },
  });
  assertEquals(source.rooms.length, 2);
  assertEquals(changed.rooms.at(-1)?.id, "vault");
  assertEquals(validate_shooter_project(changed), []);
  assertThrows(
    () =>
      apply_shooter_command(source, {
        type: "add_room",
        room: source.rooms[0],
      }),
    Error,
    "repeats identity entry",
  );
});

Deno.test("shooter serialization round trips and rejects unknown fields", () => {
  const serialized = serialize_shooter_project(
    create_shooter_starter_project(),
  );
  assertEquals(
    serialize_shooter_project(parse_shooter_project(serialized)),
    serialized,
  );
  const unknown = JSON.parse(serialized);
  unknown.revision = 1;
  assertThrows(
    () => parse_shooter_project(JSON.stringify(unknown), "arena.json"),
    Error,
    "arena.json fields differ; missing [], unknown [revision]",
  );
});

Deno.test("shooter parsing rejects encounter references with diagnostic evidence", () => {
  const malformed = JSON.parse(
    serialize_shooter_project(create_shooter_starter_project()),
  );
  malformed.encounters[0].spawn_ids = ["missing"];
  assertThrows(
    () => parse_shooter_project(JSON.stringify(malformed), "arena.json"),
    Error,
    "arena.json is invalid: Encounter first-contact uses missing spawn missing.",
  );
});

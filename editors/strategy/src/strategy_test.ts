import { assertEquals, assertThrows } from "@std/assert";
import { apply_strategy_command } from "./commands.ts";
import {
  strategy_objective_id,
  strategy_resource_id,
  strategy_route_id,
  strategy_structure_id,
  strategy_unit_id,
  strategy_wave_id,
} from "./identity.ts";
import { create_strategy_starter, strategy_editor } from "./presets.ts";
import {
  parse_strategy_project,
  serialize_strategy_project,
} from "./serialization.ts";
import { validate_strategy_project } from "./validation.ts";

Deno.test("strategy editor exposes one command-owned operation for each creator tool", () => {
  assertEquals(strategy_editor.tools.map(({ id }) => id), [
    "paint-map",
    "place-structure",
    "draw-route",
    "add-wave",
    "edit-economy",
    "set-objective",
  ]);
});

Deno.test("strategy commands author a barracks and route without mutating their source", () => {
  const source = create_strategy_starter("real-time-strategy");
  const scout_unit_id = strategy_unit_id("scout");
  const route_id = strategy_route_id("scout-route");
  let changed = apply_strategy_command(source, {
    type: "paint_map",
    map: { width: 30, height: 20 },
  });
  changed = apply_strategy_command(changed, {
    type: "place_structure",
    structure: {
      id: strategy_structure_id("barracks"),
      kind: "barracks",
      faction_id: source.factions[0].id,
      position: { x: 5, y: 10 },
      produces_unit_id: scout_unit_id,
    },
  });
  changed = apply_strategy_command(changed, {
    type: "draw_route",
    route: {
      id: route_id,
      points: [{ x: 5, y: 10 }, { x: 14, y: 10 }, { x: 22, y: 8 }],
    },
  });
  changed = apply_strategy_command(changed, {
    type: "schedule_wave",
    wave: {
      id: strategy_wave_id("scout-advance"),
      route_id,
      faction_id: source.factions[0].id,
      unit_id: scout_unit_id,
      count: 3,
      starts_at_seconds: 0,
    },
  });
  changed = apply_strategy_command(changed, {
    type: "edit_economy",
    resources: [
      strategy_resource_id("credits"),
      strategy_resource_id("ore"),
    ],
  });
  changed = apply_strategy_command(changed, {
    type: "set_objective",
    objective: {
      id: strategy_objective_id("train-scouts"),
      text: "Train three scouts",
      condition: { type: "produce_units", unit_id: scout_unit_id, count: 3 },
    },
  });
  assertEquals(source.structures.length, 2);
  assertEquals(changed.structures.at(-1)?.kind, "barracks");
  assertEquals(changed.routes.at(-1)?.id, "scout-route");
  assertEquals(Object.isFrozen(changed.routes.at(-1)?.points), true);
  assertEquals(changed.resources.map(String), ["credits", "ore"]);
  assertEquals(validate_strategy_project(changed), []);
});

Deno.test("strategy commands reject a wave whose authored route is missing", () => {
  assertThrows(
    () =>
      apply_strategy_command(create_strategy_starter("tactics"), {
        type: "schedule_wave",
        wave: {
          id: strategy_wave_id("bad-wave"),
          route_id: strategy_route_id("missing"),
          faction_id: create_strategy_starter("tactics").factions[1].id,
          unit_id: strategy_unit_id("scout"),
          count: 1,
          starts_at_seconds: 0,
        },
      }),
    Error,
    "missing route missing",
  );
});

Deno.test("strategy serialization round trips and reports unknown fields", () => {
  const serialized = serialize_strategy_project(
    create_strategy_starter("tower-defense"),
  );
  assertEquals(
    serialize_strategy_project(parse_strategy_project(serialized)),
    serialized,
  );
  const unknown = JSON.parse(serialized);
  unknown.title = "Legacy title";
  assertThrows(
    () => parse_strategy_project(JSON.stringify(unknown), "battle.json"),
    Error,
    "battle.json fields differ; missing [], unknown [title]",
  );
});

Deno.test("strategy parsing rejects a wave whose route is absent", () => {
  const malformed = JSON.parse(
    serialize_strategy_project(create_strategy_starter("tower-defense")),
  );
  malformed.waves[0].route_id = "missing";
  assertThrows(
    () => parse_strategy_project(JSON.stringify(malformed), "battle.json"),
    Error,
    "battle.json is invalid: Wave wave-1 references missing route missing.",
  );
});

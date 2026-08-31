import { create_strategy_starter } from "@ink/strategy-editor/presets.ts";
import {
  parse_strategy_project,
  serialize_strategy_project,
} from "@ink/strategy-editor/serialization.ts";
import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { add_player_barracks_and_scout_route } from "./edit.ts";
import { compile_strategy_project } from "./project.ts";

const application_directory = new URL("../", import.meta.url);

Deno.test("strategy production project is the canonical barracks and scout-route edit", async () => {
  const production_source = await Deno.readTextFile(
    new URL("projects/starter.json", application_directory),
  );
  const edited = add_player_barracks_and_scout_route(
    create_strategy_starter("real-time-strategy"),
  );
  assertEquals(production_source, serialize_strategy_project(edited));
  assertEquals(parse_strategy_project(production_source), edited);
});

Deno.test("strategy compilation makes the authored barracks and route change gameplay content", () => {
  const raw = create_strategy_starter("real-time-strategy");
  const edited = add_player_barracks_and_scout_route(raw);
  const raw_compiled = compile_strategy_project(
    serialize_strategy_project(raw),
  );
  const edited_compiled = compile_strategy_project(
    serialize_strategy_project(edited),
  );
  assertEquals(raw_compiled.content.has_barracks, false);
  assertEquals(raw_compiled.content.route.length, 2);
  assertEquals(edited_compiled.content.has_barracks, true);
  assertEquals(
    edited_compiled.content.route.map(({ x, z }) => [x, z]),
    [[4, 8], [8, 5], [14, 11], [22, 8]],
  );
  assertNotEquals(edited_compiled.content.seed, raw_compiled.content.seed);
  assertNotEquals(
    edited_compiled.content.terrain.map(({ y }) => y),
    raw_compiled.content.terrain.map(({ y }) => y),
  );
  assertNotEquals(
    edited_compiled.content.vegetation.map(({ source_id }) => source_id),
    raw_compiled.content.vegetation.map(({ source_id }) => source_id),
  );
  assertNotEquals(
    edited_compiled.content.scatter.map(({ source_id }) => source_id),
    raw_compiled.content.scatter.map(({ source_id }) => source_id),
  );
  assertStringIncludes(edited_compiled.blot_source, ".has_barracks = 1;");
  assertStringIncludes(edited_compiled.blot_source, '"scout-route-point-4"');
  assertStringIncludes(
    edited_compiled.blot_source,
    ".route = [StrategyRoutePoint];",
  );
  assertStringIncludes(
    edited_compiled.blot_source,
    ".terrain = [StrategyTerrainTile];",
  );
  assertStringIncludes(
    edited_compiled.blot_source,
    "const project :: Int -> StrategyProject",
  );
});

Deno.test("strategy generated content has golden deterministic terrain and scenery samples", async () => {
  const compiled = compile_strategy_project(
    await Deno.readTextFile(
      new URL("projects/starter.json", application_directory),
    ),
  );
  assertEquals({
    seed: compiled.content.seed,
    route_seconds: compiled.content.route.map(({ travel_seconds }) =>
      travel_seconds
    ),
    terrain: compiled.content.terrain.slice(0, 3).map(({ y, surface }) => ({
      y,
      surface,
    })),
    vegetation: compiled.content.vegetation.slice(0, 2).map((entry) => ({
      source_id: entry.source_id,
      x: entry.x,
      z: entry.z,
      scale: entry.scale,
    })),
    scatter: compiled.content.scatter.slice(0, 2).map((entry) => ({
      source_id: entry.source_id,
      x: entry.x,
      z: entry.z,
      scale: entry.scale,
    })),
  }, strategy_content_golden);
});

const strategy_content_golden = {
  seed: 2_253_359_092,
  route_seconds: [1, 2, 3, 3],
  terrain: [
    { y: -0.07488766591995955, surface: 0 },
    { y: -0.2047237642109394, surface: 0 },
    { y: -0.25616537407040596, surface: 0 },
  ],
  vegetation: [
    {
      source_id: "vegetation:d0c2edbe18f5baf5",
      x: 2.1397666141718625,
      z: 1.1663895717087112,
      scale: 1.1198917090080878,
    },
    {
      source_id: "vegetation:cd9b0e0ded69d13c",
      x: 5.209020964842439,
      z: 0.032527137353846824,
      scale: 1.1546360489170935,
    },
  ],
  scatter: [
    {
      source_id: "2253359092:strategy-24x16-scout-route:0:0",
      x: 1.6881686305360384,
      z: 1.6881690477685518,
      scale: 1.2184740627659505,
    },
    {
      source_id: "2253359092:strategy-24x16-scout-route:1:0",
      x: 6.441929494026754,
      z: 2.941929911259267,
      scale: 1.0505507568813919,
    },
  ],
};

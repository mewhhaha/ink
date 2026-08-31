import { move_platformer_record } from "@ink/platformer-editor/commands.ts";
import {
  platformer_level_id,
  platformer_record_id,
} from "@ink/platformer-editor/identity.ts";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { compile_platformer_project } from "./project.ts";

const project_path = new URL("../projects/starter.json", import.meta.url);

Deno.test("platformer compilation publishes authored collision and movement values", async () => {
  const compiled = compile_platformer_project(
    await Deno.readTextFile(project_path),
  );
  const level = JSON.parse(compiled.level_asset_source);

  assertEquals(level.record_ids, ["ground", "step"]);
  assertEquals(level.fields, [
    [0, 10_000_000],
    [0, 3_000_000],
    [32_000_000, 16_000_000],
    [2_000_000, 4_000_000],
    [0, 1],
  ]);
  assertStringIncludes(compiled.blot_source, ".jump_speed = 12000000;");
  assertStringIncludes(compiled.blot_source, ".exit_min_x = 28000000;");
  assertStringIncludes(
    compiled.blot_source,
    "const project :: Int -> PlatformerProject",
  );
  assertEquals(JSON.parse(compiled.canonical_source).schema_version, 1);
});

Deno.test("moving the authored exit changes the compiled Blot boundary", async () => {
  const source = await Deno.readTextFile(project_path);
  const parsed = parse_platformer_project(source);
  const moved = move_platformer_record(
    parsed,
    platformer_level_id("first-steps"),
    platformer_record_id("level-exit"),
    { x: 1, y: 0 },
  );
  const compiled = compile_platformer_project(
    serialize_platformer_project(moved),
  );

  assertStringIncludes(compiled.blot_source, ".exit_min_x = 29000000;");
  assertStringIncludes(compiled.blot_source, ".exit_max_x = 32000000;");
});

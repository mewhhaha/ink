import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { parse_indexed_seed } from "@ink/blot/ecs_seed.ts";
import { move_platformer_record } from "@ink/platformer-editor/commands.ts";
import {
  platformer_level_id,
  platformer_record_id,
} from "@ink/platformer-editor/identity.ts";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";
import { compile_platformer_project } from "./project.ts";

const starter_source = await Deno.readTextFile(
  new URL("../projects/starter.json", import.meta.url),
);

Deno.test("platformer compiler emits verified ECS seeds and canonical source", () => {
  const compiled = compile_platformer_project(starter_source);
  assertEquals(
    parse_indexed_seed(compiled.position_seed, 2, compiled.entity_count).length,
    compiled.entity_count,
  );
  assertEquals(
    parse_platformer_project(compiled.canonical_source),
    parse_platformer_project(starter_source),
  );
});

Deno.test("moving the editor-owned exit changes the compiled game authority", () => {
  const project = parse_platformer_project(starter_source);
  const moved = move_platformer_record(
    project,
    platformer_level_id("first-steps"),
    platformer_record_id("level-exit"),
    { x: -4, y: 0 },
  );
  const before = compile_platformer_project(starter_source);
  const after = compile_platformer_project(serialize_platformer_project(moved));
  assertNotEquals(after.position_seed, before.position_seed);
  assertNotEquals(after.blot_source, before.blot_source);
});

Deno.test("platformer compiler rejects malformed source before baking", () => {
  assertThrows(
    () => compile_platformer_project('{"schema_version":1}'),
    Error,
    "fields are",
  );
});

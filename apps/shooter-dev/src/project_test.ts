import {
  parse_shooter_project,
  serialize_shooter_project,
} from "@ink/shooter-editor/serialization.ts";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { add_first_contact_reinforcement } from "./edit.ts";
import { compile_shooter_project } from "./project.ts";

const starter_file = new URL("../projects/starter.json", import.meta.url);

Deno.test("the shooter compiler emits authored ammunition and reinforcement identities", async () => {
  const source = await Deno.readTextFile(starter_file);
  const starter = parse_shooter_project(source);
  const edited = add_first_contact_reinforcement(starter);
  const compiled = compile_shooter_project(serialize_shooter_project(edited));
  assertStringIncludes(compiled.blot_source, ".magazine_capacity = 12;");
  assertStringIncludes(compiled.blot_source, ".rounds_per_enemy = 2;");
  assertStringIncludes(compiled.blot_source, ".enemy_count = 2;");
  assertStringIncludes(
    compiled.blot_source,
    '.second_enemy_id = "reinforcement";',
  );
  assertStringIncludes(
    compiled.blot_source,
    "const project :: Int -> ShooterProject",
  );
  assertEquals(starter.spawns.map(({ id }) => id), ["player", "guard"]);
});

Deno.test("the shooter compiler rejects encounters outside the two-enemy game contract", async () => {
  const source = await Deno.readTextFile(starter_file);
  let project = parse_shooter_project(source);
  for (const id of ["reinforcement", "reserve"]) {
    project = add_first_contact_reinforcement(project, id);
  }
  assertThrows(
    () => compile_shooter_project(serialize_shooter_project(project)),
    Error,
    "enemy count 3 must be 1 or 2",
  );
});

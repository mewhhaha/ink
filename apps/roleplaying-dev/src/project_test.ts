import { apply_roleplaying_command } from "@ink/roleplaying-editor/commands.ts";
import { roleplaying_loot_id } from "@ink/roleplaying-editor/identity.ts";
import {
  parse_roleplaying_project,
  serialize_roleplaying_project,
} from "@ink/roleplaying-editor/serialization.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { compile_roleplaying_project } from "./project.ts";

Deno.test("adding ruins loot changes the generated guest outcome", async () => {
  const source = await Deno.readTextFile(
    new URL("../projects/starter.json", import.meta.url),
  );
  const initial = compile_roleplaying_project(source);
  const edited = apply_roleplaying_command(parse_roleplaying_project(source), {
    type: "add_loot_entry",
    loot_id: roleplaying_loot_id("ruins-cache"),
    entry: "moonstone-relic",
  });
  const changed = compile_roleplaying_project(
    serialize_roleplaying_project(edited),
  );
  assertEquals(initial.loot_count, 1);
  assertEquals(changed.loot_count, 2);
  assertEquals(changed.route_count, 3);
  assertStringIncludes(changed.blot_source, "moonstone-relic");
});

import { assertEquals, assertStringIncludes } from "@std/assert";
import { compile_adventure_project } from "./project.ts";

Deno.test("adventure compilation emits canonical layout and numeric Blot data", async () => {
  const source = await Deno.readTextFile(
    new URL("../projects/starter.json", import.meta.url),
  );
  const compiled = compile_adventure_project(source);
  const level = JSON.parse(compiled.level_asset_source);
  assertEquals(level.fields[0][6], 1);
  assertEquals(level.fields[8][6], 2);
  assertEquals(level.fields[9], [0, 4]);
  assertStringIncludes(compiled.blot_source, ".gate_slot = 6;");
  assertEquals(
    JSON.parse(compiled.canonical_source).format,
    "ink-adventure-project",
  );
});

Deno.test("adventure text is escaped before entering generated Blot source", async () => {
  const starter = JSON.parse(
    await Deno.readTextFile(
      new URL("../projects/starter.json", import.meta.url),
    ),
  );
  starter.project.title = 'Dungeon "North"\nWing';
  const compiled = compile_adventure_project(JSON.stringify(starter));
  assertStringIncludes(
    compiled.blot_source,
    '.project_title = "Dungeon \\"North\\"\\nWing";',
  );
});

import { parse_adventure_document } from "@ink/adventure-editor/document.ts";
import { assertEquals } from "@std/assert";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { write_adventure_project } from "./vite.ts";

Deno.test("the editor saves a canonical adventure project atomically", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/starter.json`;
  const source = await Deno.readTextFile(
    new URL("../../projects/starter.json", import.meta.url),
  );
  try {
    const submitted = JSON.parse(source);
    submitted.project.title = "  Test adventure  ";
    submitted.layout.name = "  Test dungeon  ";
    await write_adventure_project(
      pathToFileURL(path),
      JSON.stringify(submitted),
    );

    const saved_source = await readFile(path, "utf8");
    const saved = parse_adventure_document(saved_source);
    assertEquals(saved.project.title, "Test adventure");
    assertEquals(saved.layout.name, "Test dungeon");
    assertEquals(saved.layout.brushes[6].material, "dungeon.gate.oak");
    assertEquals(saved_source.endsWith("\n"), true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

import { assertEquals } from "@std/assert";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "@ink/platformer-editor/serialization.ts";
import { write_platformer_project } from "./vite.ts";

const starter = new URL("../../projects/starter.json", import.meta.url);

Deno.test("the platformer editor saves canonical projects atomically", async () => {
  const directory = await Deno.makeTempDir();
  const target = new URL("starter.json", `file://${directory}/`);
  const source = await Deno.readTextFile(starter);
  try {
    await write_platformer_project(target, source);
    assertEquals(
      await Deno.readTextFile(target),
      serialize_platformer_project(parse_platformer_project(source)),
    );
    assertEquals(
      [...Deno.readDirSync(directory)].map(({ name }) => name),
      ["starter.json"],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

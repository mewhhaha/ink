import { assertEquals } from "@std/assert";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { write_platformer_level } from "./vite.ts";

Deno.test("the editor saves a normalized level document atomically", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/starter.json`;
  try {
    await write_platformer_level(
      pathToFileURL(path),
      JSON.stringify({
        format: "blot-integer-data",
        version: 1,
        name: "  Test room  ",
        geometry: [],
        fields: [[2], [1], [0, 1], [-1, 48], [0]],
      }),
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    assertEquals(saved.name, "Test room");
    assertEquals(saved.tile_size, 16);
    assertEquals(saved.layers, ["terrain", "decoration"]);
    assertEquals(saved.entities, ["player_start"]);
    assertEquals(saved.geometry, []);
    assertEquals(saved.fields, [[2], [1], [0, 1], [-1, 48], [0]]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

import { assertEquals } from "@std/assert";
import { load_isometric_city } from "../src/wasm_game.ts";

Deno.test("the map exposes nine accessible terrain regions", async () => {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(
      new URL("../generated/isometric_city.wasm", import.meta.url),
    ),
    Deno.readTextFile(
      new URL("../generated/isometric_city.wasm.json", import.meta.url),
    ),
  ]);
  const session = await load_isometric_city(wasm_bytes, manifest_source);

  const initial = session.describe();
  const terrain_regions = initial.regions.filter((region) =>
    region.id.startsWith("city-tile-")
  );
  assertEquals(initial.projection, "orthographic");
  assertEquals(initial.regions.length, 10);
  assertEquals(terrain_regions.length, 9);
  assertEquals(terrain_regions.every((region) => region.role === "text"), true);
  assertEquals(terrain_regions.map((region) => region.order), [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
  ]);
  assertEquals(terrain_regions[0].label, "1,1 terrain tile");
  assertEquals(terrain_regions[8].label, "3,3 terrain tile");
  assertEquals(initial.actions, []);
  assertEquals(initial.status, {
    done: false,
    label: "Map",
    value: "Nine terrain tiles",
  });
  assertEquals(
    session.render().objects.map((object) => ({
      id: object.id,
      mesh: object.mesh,
      visible: object.visible,
    })),
    [
      { id: 0, mesh: 0, visible: true },
      { id: 1, mesh: 0, visible: true },
      { id: 2, mesh: 0, visible: true },
      { id: 3, mesh: 0, visible: true },
      { id: 4, mesh: 0, visible: true },
      { id: 5, mesh: 0, visible: true },
      { id: 6, mesh: 0, visible: true },
      { id: 7, mesh: 0, visible: true },
      { id: 8, mesh: 0, visible: true },
    ],
  );
  session.close();
});

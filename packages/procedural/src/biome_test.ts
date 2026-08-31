import { assertEquals, assertThrows } from "@std/assert";
import {
  bake_biome_surfaces,
  type BiomeDefinition,
  select_biome,
} from "./experimental/biome.ts";

const biomes: readonly BiomeDefinition[] = [
  {
    id: "tundra",
    priority: 1,
    elevation: { minimum: -100, maximum: 100 },
    moisture: { minimum: 0, maximum: 1 },
    temperature: { minimum: -1, maximum: 0.3, falloff: 0.2 },
    surface: 3,
  },
  {
    id: "grassland",
    elevation: { minimum: -100, maximum: 100 },
    moisture: { minimum: 0, maximum: 1 },
    temperature: { minimum: 0.3, maximum: 1, falloff: 0.2 },
    surface: 7,
  },
];

Deno.test("biome selection uses suitability and deterministic priority ties", () => {
  assertEquals(
    select_biome(biomes, { elevation: 4, moisture: 0.5, temperature: 0.3 }),
    { biome: "tundra", surface: 3, suitability: 1 },
  );
  assertEquals(
    select_biome(biomes, { elevation: 4, moisture: 0.5, temperature: 0.9 })
      .biome,
    "grassland",
  );
});

Deno.test("biome surface baking preserves sample order", () => {
  assertEquals(
    [...bake_biome_surfaces(biomes, [
      { elevation: 0, moisture: 1, temperature: -0.5 },
      { elevation: 0, moisture: 1, temperature: 0.8 },
    ])],
    [3, 7],
  );
});

Deno.test("biome selection reports samples not covered by any definition", () => {
  assertThrows(
    () =>
      select_biome(biomes, {
        elevation: 1000,
        moisture: 0.5,
        temperature: 0.5,
      }),
    Error,
    "no biome accepts",
  );
});

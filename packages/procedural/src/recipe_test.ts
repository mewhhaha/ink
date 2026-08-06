import { vec3 } from "@ink/math/vector.ts";
import { global_position } from "@ink/world/identity.ts";
import { assertEquals } from "@std/assert";
import { generator_revision, procedural_seed } from "./identity.ts";
import { generate_procedural_world } from "./recipe.ts";

Deno.test("procedural world recipes publish matching terrain, biome, and scatter products", () => {
  const result = generate_procedural_world({
    seed: procedural_seed(7n),
    revision: generator_revision("world-v1"),
    origin: global_position(0, 0, vec3(0, 0, 0), 64),
    heightfield: {
      width: 4,
      depth: 4,
      spacing: 2,
      field: { sample: (x, z) => (x + z) / 12 },
    },
    moisture: { sample: () => 0.5 },
    temperature: { sample: () => 0.5 },
    biomes: [{
      id: "temperate",
      elevation: { minimum: -10, maximum: 10 },
      moisture: { minimum: 0, maximum: 1 },
      temperature: { minimum: 0, maximum: 1 },
      surface: 4,
    }],
    scatter_spacing: 1,
    scatter_limit: 5,
    scatter_density: { sample: () => 1 },
  });
  assertEquals(result.terrain.heights, result.heightfield.heights);
  assertEquals([...result.biome_surfaces], Array(16).fill(4));
  assertEquals(result.terrain.surfaces, result.biome_surfaces);
  assertEquals(result.scatter.length, 5);
});

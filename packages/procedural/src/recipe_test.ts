import { assertEquals, assertThrows } from "@std/assert";
import { procedural_recipe } from "./recipe.ts";
import { scatter_points } from "./scatter.ts";

Deno.test("procedural recipes bind deterministic scatter to one seed and revision", () => {
  const recipe = procedural_recipe({
    seed: 7n,
    revision: "strategy-v1",
    scatter: {
      minimum_x: 0,
      minimum_z: 0,
      maximum_x: 12,
      maximum_z: 8,
      spacing: 2,
      maximum_points: 6,
      density: { sample: () => 1 },
    },
  });
  assertEquals(Object.isFrozen(recipe), true);
  assertEquals(Object.isFrozen(recipe.scatter), true);
  assertEquals(scatter_points(recipe.scatter).length, 6);
  assertEquals(scatter_points(recipe.scatter), scatter_points(recipe.scatter));
});

Deno.test("procedural recipes reject invalid scatter at construction", () => {
  assertThrows(
    () =>
      procedural_recipe({
        seed: 7n,
        revision: "strategy-v1",
        scatter: {
          minimum_x: 2,
          minimum_z: 0,
          maximum_x: 2,
          maximum_z: 8,
          spacing: 1,
          maximum_points: 1,
          density: { sample: () => 1 },
        },
      }),
    Error,
    "must have positive area",
  );
});

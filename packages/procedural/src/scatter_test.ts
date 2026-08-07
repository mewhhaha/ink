import { vec2_length_squared, vec2_subtract } from "@ink/math/vector.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { generator_revision, procedural_seed } from "./identity.ts";
import { scatter_points } from "./scatter.ts";

Deno.test("scatter placement is deterministic, bounded, and separated", () => {
  const recipe = {
    seed: procedural_seed(99n),
    revision: generator_revision("scatter-v1"),
    minimum_x: -5,
    minimum_z: 2,
    maximum_x: 12,
    maximum_z: 19,
    spacing: 2,
    maximum_points: 20,
    density: { sample: () => 1 },
  } as const;
  const first = scatter_points(recipe);
  const second = scatter_points(recipe);
  assertEquals(first, second);
  assert(first.length > 0);
  for (const point of first) {
    assert(point.position.x >= -5 && point.position.x < 12);
    assert(point.position.y >= 2 && point.position.y < 19);
  }
  for (let left = 0; left < first.length; left += 1) {
    for (let right = left + 1; right < first.length; right += 1) {
      assert(
        vec2_length_squared(
          vec2_subtract(first[left].position, first[right].position),
        ) >= 4,
      );
    }
  }
});

Deno.test("scatter density can exclude every candidate", () => {
  assertEquals(
    scatter_points({
      seed: procedural_seed(0n),
      revision: generator_revision("v1"),
      minimum_x: 0,
      minimum_z: 0,
      maximum_x: 10,
      maximum_z: 10,
      spacing: 1,
      maximum_points: 100,
      density: { sample: () => 0 },
    }),
    [],
  );
});

Deno.test("scatter rejects density outside the normalized range", () => {
  assertThrows(
    () =>
      scatter_points({
        seed: procedural_seed(0n),
        revision: generator_revision("v1"),
        minimum_x: 0,
        minimum_z: 0,
        maximum_x: 1,
        maximum_z: 1,
        spacing: 1,
        maximum_points: 1,
        density: { sample: () => 2 },
      }),
    Error,
    "must be in 0..1",
  );
  assertThrows(
    () =>
      scatter_points({
        seed: procedural_seed(0n),
        revision: generator_revision("v1"),
        minimum_x: 0,
        minimum_z: 0,
        maximum_x: Number.MAX_VALUE,
        maximum_z: 1,
        spacing: Number.MIN_VALUE,
        maximum_points: 1,
        density: { sample: () => 1 },
      }),
    Error,
    "scatter columns Infinity must be a positive safe integer",
  );
});

import { vec2, vec2_length_squared, vec2_subtract } from "@ink/math/vector.ts";
import { noise_seed } from "@ink/noise/domain.ts";
import { value_noise_2d } from "@ink/noise/value.ts";
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

Deno.test("strategy scatter recipe matches its golden output", () => {
  const seed = noise_seed(2_253_359_092);
  const route = [[4, 8], [8, 5], [14, 11], [22, 8]] as const;
  const points = scatter_points({
    seed: procedural_seed(BigInt(seed)),
    revision: generator_revision("strategy-24x16-scout-route"),
    minimum_x: 0,
    minimum_z: 0,
    maximum_x: 24,
    maximum_z: 16,
    spacing: 3.5,
    maximum_points: 8,
    density: {
      sample(x, z) {
        if (
          route.some(([route_x, route_z]) =>
            (route_x - x) ** 2 + (route_z - z) ** 2 < 4
          )
        ) return 0;
        const amount = value_noise_2d({
          position: vec2(x / 7, z / 7),
          seed,
        });
        return Math.min(1, Math.max(0, 0.68 + amount * 0.2));
      },
    },
  });
  assertEquals(points.slice(0, 3), [
    {
      id: "2253359092:strategy-24x16-scout-route:0:0",
      position: vec2(1.6881686305360384, 1.6881690477685518),
      rotation_radians: 2.272130120547494,
      scale: 1.2184740627659505,
    },
    {
      id: "2253359092:strategy-24x16-scout-route:1:0",
      position: vec2(6.441929494026754, 2.941929911259267),
      rotation_radians: 3.1321487516773976,
      scale: 1.0505507568813919,
    },
    {
      id: "2253359092:strategy-24x16-scout-route:3:0",
      position: vec2(11.246053805248323, 0.7460533880158093),
      rotation_radians: 0.5252337070002636,
      scale: 0.9496169112615747,
    },
  ]);
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

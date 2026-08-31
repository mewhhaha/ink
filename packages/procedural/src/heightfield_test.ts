import { vec3 } from "@ink/math/vector.ts";
import { global_position } from "@ink/world/identity.ts";
import { sample_terrain } from "@ink/world/terrain.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  bake_heightfield,
  heightfield_to_terrain,
} from "./experimental/heightfield.ts";

Deno.test("heightfield baking samples world coordinates in row-major order", () => {
  const heightfield = bake_heightfield({
    width: 3,
    depth: 2,
    spacing: 2,
    origin_x: 10,
    origin_z: -4,
    base_height: 1,
    amplitude: 2,
    field: { sample: (x, z) => x + z },
  });
  assertEquals([...heightfield.heights], [13, 17, 21, 17, 21, 25]);
  assertEquals(heightfield.minimum_height, 13);
  assertEquals(heightfield.maximum_height, 25);
});

Deno.test("heightfields adapt to the shared world terrain contract", () => {
  const heightfield = bake_heightfield({
    width: 2,
    depth: 2,
    spacing: 1,
    field: { sample: (x, z) => x + z },
  });
  const terrain = heightfield_to_terrain(
    heightfield,
    global_position(0, 0, vec3(0, 0, 0), 64),
    new Uint16Array([2, 2, 2, 2]),
  );
  const sampled = sample_terrain(terrain, 0.5, 0.5);
  assertEquals(sampled.type, "surface");
  if (sampled.type === "surface") assertEquals(sampled.surface, 2);
});

Deno.test("heightfield baking attaches coordinates to non-finite sample errors", () => {
  assertThrows(
    () =>
      bake_heightfield({
        width: 2,
        depth: 2,
        spacing: 1,
        field: { sample: () => Number.NaN },
      }),
    Error,
    "heightfield sample (0, 0)",
  );
  assertThrows(
    () =>
      bake_heightfield({
        width: 2,
        depth: 2,
        spacing: 1,
        field: { sample: () => Number.MAX_VALUE },
      }),
    Error,
    "cannot be stored as finite Float32",
  );
  assertThrows(
    () =>
      bake_heightfield({
        width: 2,
        depth: 2,
        spacing: 1,
        field: {
          sample: () => {
            throw new Error("source unavailable");
          },
        },
      }),
    Error,
    "heightfield sample (0, 0) failed: source unavailable",
  );
});

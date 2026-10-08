import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  blueNoise,
  builtinTexture,
  fbm2,
  perlin2,
  ridged2,
  seamless,
  simplex2,
  value2,
  worley2,
} from "./noise.ts";

Deno.test("periodic noise tiles exactly", () => {
  for (const [x, y] of [[0.3, 0.7], [2.1, 5.9], [7.99, 0.01]]) {
    assertAlmostEquals(
      perlin2(x, y, { period: 8 }),
      perlin2(x + 8, y - 16, { period: 8 }),
      1e-9,
    );
    assertAlmostEquals(
      value2(x, y, { period: 8 }),
      value2(x - 8, y + 8, { period: 8 }),
      1e-9,
    );
    assertAlmostEquals(
      worley2(x, y, { period: 8 }).f1,
      worley2(x + 8, y, { period: 8 }).f1,
      1e-9,
    );
    assertAlmostEquals(
      fbm2(perlin2, x, y, { period: 4 }),
      fbm2(perlin2, x + 4, y, { period: 4 }),
      1e-9,
    );
  }
  // The seamless blend matches across the tile edge.
  assertAlmostEquals(
    seamless(simplex2, 0, 0.4, 8),
    seamless(simplex2, 1 - 1e-9, 0.4, 8),
    1e-5,
  );
});

Deno.test("noise stays in range and is deterministic", () => {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 2000; i++) {
    const x = i * 0.137, y = i * 0.071;
    for (const v of [perlin2(x, y), simplex2(x, y), value2(x, y)]) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    const r = ridged2(x, y);
    assert(r >= 0 && r <= 1);
  }
  assert(min >= -1.05 && max <= 1.05, `${min} ${max}`);
  assert(max - min > 1, "noise uses its range");
  assertEquals(perlin2(1.5, 2.5, { seed: 3 }), perlin2(1.5, 2.5, { seed: 3 }));
  assert(perlin2(1.5, 2.5, { seed: 3 }) !== perlin2(1.5, 2.5, { seed: 4 }));
});

Deno.test("blue noise ranks every pixel once and has no clumps", () => {
  const size = 32;
  const ranks = blueNoise(size);
  const sorted = [...ranks].sort((a, b) => a - b);
  sorted.forEach((r, i) => assertAlmostEquals(r, i / (size * size), 1e-9));
  // The darkest 10% are spread out: far fewer neighbouring pairs than white
  // noise would have (about 41 for 103 points on a 32² torus).
  const dark = [...ranks.keys()].filter((i) => ranks[i] < 0.1);
  let adjacent = 0;
  for (const a of dark) {
    for (const b of dark) {
      if (a >= b) continue;
      const dx = Math.abs((a % size) - (b % size)),
        dy = Math.abs(((a / size) | 0) - ((b / size) | 0));
      if (Math.max(Math.min(dx, size - dx), Math.min(dy, size - dy)) <= 1) {
        adjacent++;
      }
    }
  }
  assert(adjacent < 12, `${adjacent} neighbouring pairs`);
});

Deno.test("builtin textures exist", () => {
  for (
    const name of [
      "checker",
      "grid",
      "noise/value",
      "noise/perlin",
      "noise/simplex",
      "noise/worley",
      "noise/fbm",
      "noise/ridged",
      "noise/blue",
    ]
  ) {
    const image = builtinTexture(`builtin:${name}`)!;
    assert(image, name);
    assertEquals(image.data.length, image.width * image.height * 4);
  }
});

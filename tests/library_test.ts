import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("standalone numeric library", async (t) => {
  const fixture = await compile(new URL("./library.blot", import.meta.url));
  const { guest } = fixture;
  try {
    await t.step(
      "sorting is stable across empty, ordered and merged runs",
      () => {
        const cases = [[], [1], [1, 1, 1], [3, -2, 3, 0, -2]];
        for (const length of [7, 8, 9, 31, 100, 1000, 10000]) {
          cases.push(Array.from({ length }, (_, i) => (i * 37) % 11 - 5));
        }
        for (const keys of cases) {
          const indices = keys.map((_, i) => i).sort((a, b) =>
            keys[a] - keys[b]
          );
          assertEquals(
            Array.from(
              guest.call("order", new Float32Array(keys)) as Uint32Array,
            ),
            indices,
          );
        }
      },
    );

    await t.step(
      "unsigned ordering preserves all bits and equal-key order",
      () => {
        for (const length of [0, 1, 7, 16, 17, 100, 1000, 10000]) {
          const keys = Array.from(
            { length },
            (_, i) =>
              [0xffffffff, 16777217, 16777216, 0, 0x80000000, 16777217][i % 6],
          );
          const indices = keys.map((_, i) => i).sort((a, b) =>
            keys[a] - keys[b]
          );
          assertEquals(
            Array.from(
              guest.call("order_u32", new Uint32Array(keys)) as Uint32Array,
            ),
            indices,
          );
        }
        const keys = Array.from(
          { length: 10000 },
          (_, i) => (Math.imul(i, 2654435761) ^ (i >>> 4)) >>> 0,
        );
        assertEquals(
          Array.from(
            guest.call("order_u32", new Uint32Array(keys)) as Uint32Array,
          ),
          keys.map((_, i) => i).sort((a, b) => keys[a] - keys[b]),
        );
      },
    );

    await t.step("copies can change without changing their source", () => {
      assertEquals(
        Array.from(
          guest.call("copy", new Float32Array([1, 2, 3])) as Float32Array,
        ),
        [1, 2, 3, 11, 2, 3],
      );
      assertEquals(
        Array.from(
          guest.call("copy_u32", new Uint32Array([1, 2, 3])) as Uint32Array,
        ),
        [1, 2, 3, 11, 2, 3],
      );
      assertEquals(guest.call("copy", new Float32Array()), new Float32Array());
    });

    await t.step("random state is explicit and supports all 32 bits", () => {
      for (const seed of [0, 1, 7, 0x80000000, 0xffffffff]) {
        let expected = seed;
        if (expected === 0) expected = 2654435769;
        expected ^= expected << 13;
        expected ^= expected >>> 17;
        expected ^= expected << 5;
        assertEquals(guest.call("next", seed), expected >>> 0);
        const unit = guest.call("unit", seed) as number;
        assertEquals(unit, Math.fround((seed >>> 8) / 16777216));
        assert(unit >= 0 && unit < 1);
      }
    });

    await t.step(
      "quaternions rotate around +Y and invert their rotation",
      () => {
        const result = guest.call("rotation", Math.PI / 2) as Float32Array;
        assertAlmostEquals(result[0], -1, 1e-6);
        assertAlmostEquals(result[1], 0, 1e-6);
        assertAlmostEquals(result[2], 0, 1e-6);
        for (let i = 3; i < 6; i++) assertAlmostEquals(result[i], 0, 1e-6);
        assertAlmostEquals(result[6], 1, 1e-6);
        assertEquals(result[7], 1);
      },
    );

    await t.step(
      "ray planes reject parallel and behind-origin intersections",
      () => {
        assertEquals(guest.call("plane", new Float32Array([3, -1])), 3);
        assertEquals(guest.call("plane", new Float32Array([3, 0])), -1);
        assertEquals(guest.call("plane", new Float32Array([3, 1])), -1);
      },
    );

    await t.step("zero-octave noise is zero and seeded fractals repeat", () => {
      assertEquals(guest.call("fractal", 0), new Float32Array([0, 0]));
      const first = guest.call("fractal", 4) as Float32Array;
      assertEquals(first, guest.call("fractal", 4));
      assert(
        first.every((value) =>
          Number.isFinite(value) && Math.abs(value) < 1.04
        ),
      );
    });
  } finally {
    await fixture.dispose();
  }
});

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("authored shader noise preserves lattice and fractional witnesses", async () => {
  const fixture = await compile(
    new URL("./noise_authored.blot", import.meta.url),
  );
  try {
    // Salt-surface shader scale/offset, then a second caller's parameters.
    // Witnesses retain the original CPU expression's F32 arithmetic order.
    for (
      const [input, expected] of [
        [[0.1031, 33.33, 0, 0, 0], [0, -0.5]],
        [[0.1031, 33.33, 1, 2, 0.25], [0.93890380859375, 0.43890380859375]],
        [[0.1031, 33.33, -3.75, 2.25, 0.5], [0.69140625, 0.2106461524963379]],
        [[0.137, 17.5, 0.625, -1.25, 0.75], [
          0.231201171875,
          -0.388034850358963,
        ]],
        [[0.137, 17.5, 123.125, 98.875, 1], [
          0.9384765625,
          0.07835984230041504,
        ]],
      ]
    ) {
      const output = fixture.guest.call(
        "authored",
        new Float32Array(input),
      ) as Float32Array;
      assertEquals(Array.from(output.slice(0, 2)), expected);
      const weights = Array.from(output.slice(2));
      assert(weights.every((value) => value >= 0));
      assertAlmostEquals(
        weights.reduce((sum, value) => sum + value, 0),
        1,
        1e-7,
      );
    }
    for (let sample = 0; sample <= 100; sample++) {
      const fraction = sample / 100;
      const forward = fixture.guest.call(
        "authored",
        new Float32Array([0.1031, 33.33, 0, 0, fraction]),
      ) as Float32Array;
      const reverse = fixture.guest.call(
        "authored",
        new Float32Array([0.1031, 33.33, 0, 0, 1 - fraction]),
      ) as Float32Array;
      for (let index = 0; index < 4; index++) {
        assertAlmostEquals(forward[2 + index], reverse[5 - index], 1e-7);
      }
    }
  } finally {
    await fixture.dispose();
  }
});

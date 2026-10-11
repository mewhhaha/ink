import { assert, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("contact caches retain exact U32 ids through solving and sleeping", async () => {
  const fixture = await compile(new URL("./cache.blot", import.meta.url));
  try {
    for (
      const ids of [
        [1, 16777216, 16777217, 16777218],
        [0xffffffff, 0x80000000, 0x80000001, 0x80000002],
      ]
    ) {
      const out = fixture.guest.call(
        "ids",
        new Uint32Array(ids),
      ) as Uint32Array;
      const count = out[0];
      assert(count > 0);
      const expected = [
        [ids[0], ids[1]].toSorted((a, b) => a - b),
        [ids[0], ids[2]].toSorted((a, b) => a - b),
      ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const pairs = Array.from(
        { length: count },
        (_, i) => [out[1 + i * 2], out[2 + i * 2]],
      );
      const unique = pairs.filter((p, i) =>
        i === 0 || p[0] !== pairs[i - 1][0] || p[1] !== pairs[i - 1][1]
      );
      assertEquals(unique, expected);
      assertEquals(Array.from(out.subarray(1 + count * 2)), [
        1,
        1,
        0,
        0,
        ids[2],
      ]);
      const sleep = fixture.guest.call(
        "sleeping",
        new Uint32Array([ids[0], ids[1], ids[3]]),
      ) as Uint32Array;
      assert(sleep[0] > 0);
      assertEquals(sleep[1], sleep[0]);
      assertEquals(
        sleep[2],
        0,
        "changing an id discards its old warm-start contacts",
      );
      assertEquals(Array.from(sleep.subarray(3)), expected[0]);
    }
    for (const dt of [0, -1, NaN, Infinity]) {
      assertEquals(
        fixture.guest.call("unchanged", dt),
        new Float32Array([10, 0]),
      );
    }
  } finally {
    await fixture.dispose();
  }
});

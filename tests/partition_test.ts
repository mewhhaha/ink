import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("partitions cover their input once, including empty and U32 maximum", async () => {
  const fixture = await compile(new URL("./partition.blot", import.meta.url));
  try {
    for (const count of [0, 1, 3, 4, 5, 31, 32, 33, 0xffffffff]) {
      for (const parts of [1, 2, 4, 16]) {
        let cursor = 0;
        const sizes = [];
        for (let index = 0; index < parts; index++) {
          const output = fixture.guest.call(
            "range",
            new Uint32Array([count, parts, index]),
          ) as Uint32Array;
          assertEquals(output[0], cursor);
          cursor += output[1];
          sizes.push(output[1]);
        }
        assertEquals(cursor, count);
        assertEquals(Math.max(...sizes) - Math.min(...sizes) <= 1, true);
      }
    }
    for (const input of [[5, 0, 0], [5, 4, 4], [5, 4, 0xffffffff]]) {
      assertEquals(
        fixture.guest.call("range", new Uint32Array(input)),
        new Uint32Array(),
      );
    }
  } finally {
    await fixture.dispose();
  }
});

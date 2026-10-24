import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("soft circle rows preserve clipped edges, overlaps and every SIMD tail", async () => {
  const fixture = await compile(new URL("./radial.blot", import.meta.url));
  try {
    for (const size of [1, 2, 3, 4, 5, 17, 193]) {
      for (const count of [0, 1, 31, 63, 64, 128]) {
        for (const z of new Set([0, Math.floor(size / 2), size - 1])) {
          const input = new Uint32Array([size, count, z]);
          const expected = fixture.guest.call("reference", input);
          for (const method of ["scalar", "vectorized", "selected"]) {
            assertEquals(
              fixture.guest.call(method, input),
              expected,
              `${method}: ${size}/${count}/${z}`,
            );
          }
        }
      }
    }
  } finally {
    await fixture.dispose();
  }
});

import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("bounded compiler reuse and hot-loop probes preserve every write and route", async () => {
  const fixture = await compile(
    new URL("../tools/compiler-probe.blot", import.meta.url),
  );
  try {
    for (const count of [1000, 2000]) {
      for (const name of ["inline_writes", "break_writes"]) {
        assertEquals(
          fixture.guest.call(name, count),
          new Float32Array([count - 1, count * (count - 1) / 2]),
        );
      }
      assertEquals(
        fixture.guest.call("pathfinding", count),
        new Float32Array([count - 1, count, count]),
      );
      assertEquals(
        fixture.guest.call("unsigned_sort", count),
        new Uint32Array([count - 1, 0, count, count * (count * count - 1) / 6]),
      );
    }
  } finally {
    await fixture.dispose();
  }
});

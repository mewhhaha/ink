import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("access plans preserve write hazards, dependencies and serial barriers", async () => {
  const fixture = await compile(new URL("./schedule.blot", import.meta.url));
  try {
    assertEquals(
      fixture.guest.call("dependencies", null),
      new Uint32Array([3, 0, 1, 3, 1, 2, 1, 4, 2, 5, 6]),
    );
    assertEquals(
      fixture.guest.call("rejected", null),
      new Uint32Array([1, 1, 1, 1]),
    );
    for (let seed = 0; seed < 100; seed++) {
      assertEquals(fixture.guest.call("equivalence", seed), 1);
    }
    assertEquals(
      fixture.guest.call("invalid_execution", null),
      new Uint32Array([1, 1, 1, 1, 1]),
    );
  } finally {
    await fixture.dispose();
  }
});

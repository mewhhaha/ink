import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("point index matches an exhaustive nearest search, including exclusions and ties", async () => {
  const fixture = await compile(new URL("./nearest.blot", import.meta.url));
  try {
    for (const count of [0, 1, 2, 31, 32, 33, 400, 2000]) {
      assertEquals(
        fixture.guest.call("actual", count),
        fixture.guest.call("expected", count),
      );
    }
    assertEquals(fixture.guest.call("ties", null), new Uint32Array([0, 1, 9]));
  } finally {
    await fixture.dispose();
  }
});

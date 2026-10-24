import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("typed services check answer domains and consume a result once", async () => {
  const fixture = await compile(
    new URL("./typed_services.blot", import.meta.url),
  );
  try {
    assertEquals(
      fixture.guest.call("query", null),
      new Uint32Array([42, 0, 3, 10]),
    );
    for (
      const value of [-1, 0.5, 16777216, Number.NaN, Number.POSITIVE_INFINITY]
    ) {
      assertEquals(fixture.guest.call("invalid", value), 1);
    }
    assertEquals(fixture.guest.call("invalid", 0), 0);
    assertThrows(() => fixture.guest.call("wrong_method", 4));
    assertEquals(fixture.guest.call("wrong_method", 3), 0);
  } finally {
    await fixture.dispose();
  }
});

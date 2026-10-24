import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("resource claims preserve priorities and ignore delivery order", async () => {
  const fixture = await compile(new URL("./claims.blot", import.meta.url));
  try {
    assertEquals(
      fixture.guest.call("bounds", null),
      new Uint32Array([1, 1, 1, 1]),
    );
    for (let seed = 0; seed < 128; seed++) {
      assertEquals(fixture.guest.call("witness", seed), 1);
    }
  } finally {
    await fixture.dispose();
  }
});

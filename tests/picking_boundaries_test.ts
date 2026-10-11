import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("picking accepts sparse short marker columns and retains nearest ties", async () => {
  const fixture = await compile(
    new URL("./picking_boundaries.blot", import.meta.url),
  );
  try {
    assertEquals(
      Array.from(fixture.guest.call("aligned", null) as Uint32Array),
      [
        0xffffffff,
        1,
        0,
        0,
      ],
    );
  } finally {
    await fixture.dispose();
  }
});

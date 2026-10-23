import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("creation, restores and paused scene replacement normalize once before consumers", async () => {
  const fixture = await compile(
    new URL("./normalization.blot", import.meta.url),
  );
  try {
    assertEquals(
      Array.from(fixture.guest.call("boundaries", null) as Float32Array),
      [0, 1, 0, 1, 0, 1, 0, 1, 0, 2],
    );
  } finally {
    await fixture.dispose();
  }
});

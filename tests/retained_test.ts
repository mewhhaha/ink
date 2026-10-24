import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("retained streams preserve snapshots, never recycle removed IDs and accept unordered dirty groups", async () => {
  const fixture = await compile(new URL("./retained.blot", import.meta.url));
  try {
    assertEquals(
      fixture.guest.call("lifecycle", null),
      new Uint32Array([
        1,
        3,
        0,
        0,
        0,
        2,
        1,
        2,
        3,
        4,
        1,
        3,
        3,
        0,
        2,
        1,
        1,
      ]),
    );
  } finally {
    await fixture.dispose();
  }
});

import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("derived values invalidate complete keys and rebuild after restore", async () => {
  const fixture = await compile(new URL("./derived.blot", import.meta.url));
  try {
    assertEquals(
      Array.from(fixture.guest.call("rebuilding", null) as Uint32Array),
      [
        8,
        8,
        12,
        8,
        4,
        0,
      ],
    );
  } finally {
    await fixture.dispose();
  }
});

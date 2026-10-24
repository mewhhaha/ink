import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("semantic revisions follow writes, ignore animation and preserve snapshots", async () => {
  const fixture = await compile(new URL("./observed.blot", import.meta.url));
  try {
    assertEquals(
      fixture.guest.call("observed", null),
      new Uint32Array([0, 1, 0, 0, 3]),
    );
  } finally {
    await fixture.dispose();
  }
});

Deno.test("component revisions cover edits, despawns and replacements", async () => {
  const fixture = await compile(
    new URL("./observed_components.blot", import.meta.url),
  );
  try {
    assertEquals(
      fixture.guest.call("components", 3),
      new Uint32Array([3, 1, 1, 2, 2, 2, 3, 3]),
    );
  } finally {
    await fixture.dispose();
  }
});

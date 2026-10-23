import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./incremental.blot", import.meta.url));
Deno.test("change composition retains replacements, removal precedence and full U32 identities", () => {
  assertEquals(
    fixture.guest.call("composition", null),
    new Uint32Array([1, 3, 2, 2, 4, 0xffffffff, 1, 3]),
  );
});
Deno.test("paged edits, shrink and regrowth preserve old snapshots without resurrecting truncated values", () => {
  assertEquals(
    fixture.guest.call("snapshots", null),
    new Uint32Array([64, 1064, 63, 1129, 1130, 1064, 2065, 2130, 130]),
  );
  for (const count of [64, 1024, 65536]) {
    assertEquals(
      fixture.guest.call("workload", count),
      new Uint32Array([count - 1, count + 30, count / 2 + 31]),
    );
  }
});
Deno.test.afterAll(() => fixture.dispose());

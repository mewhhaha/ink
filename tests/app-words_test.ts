import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./app-words.blot", import.meta.url));
Deno.test("application word saves compose native codecs, existing lane plugins, schedules and snapshots", () => {
  for (const count of [0, 1, 70, 1024]) {
    assertEquals(
      fixture.guest.call("roundtrip", count),
      new Uint32Array([
        0xfffffffe,
        0xffffffff,
        count,
        count * (count - 1) / 2,
        1229867863,
        1,
      ]),
    );
  }
});
Deno.test.afterAll(() => fixture.dispose());

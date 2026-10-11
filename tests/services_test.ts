import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("service ids avoid every live collection when the wire range wraps", async () => {
  const fixture = await compile(new URL("./services.blot", import.meta.url));
  try {
    const call = (name: string, argument = 0) =>
      Array.from(fixture.guest.call(name, argument) as Uint32Array);
    assertEquals(call("ids"), [4, 5, 4, 6, 3]);
    assertEquals(call("saturation"), [1, 0, 256, 1]);
    assertEquals(call("retry_wrap"), [1, 0, 0, 1, 2, 1, 0, 0, 1, 7, 1, 1]);
    for (const roster of [0, 1, 6, 9]) {
      assertEquals(call("saved_tick_and_roster", roster), [roster, 0xffffffff]);
    }
    assertEquals(call("retained_answers", 2), [2, 2, 3]);
    assertEquals(call("retained_answers", 0), [0]);
    assertEquals(call("send_and_clip"), [1, 1, 16384, 0, 0xffffffff, 1]);
  } finally {
    await fixture.dispose();
  }
});

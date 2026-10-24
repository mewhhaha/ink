import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("cross-frame jobs preserve order, epochs, saved results and bounds", async () => {
  const fixture = await compile(new URL("./task_queue.blot", import.meta.url));
  try {
    for (const order of [[1, 2, 3], [3, 1, 2], [2, 3, 1], [3, 2, 1]]) {
      assertEquals(
        fixture.guest.call("ordered", new Uint32Array(order)),
        new Uint32Array([0, 0, 0, 1, 101, 7, 2, 102, 14, 3, 103, 21]),
      );
    }
    assertEquals(
      fixture.guest.call("lifetime", null),
      new Uint32Array([0, 1, 0, 0, 1, 0, 1, 101, 7, 1, 1, 45]),
    );
    assertEquals(
      fixture.guest.call("save", null),
      new Uint32Array([0, 0, 1, 1, 0, 1, 101, 7, 2, 102, 14]),
    );
    assertEquals(
      fixture.guest.call("bounds", null),
      new Uint32Array([1, 256, 0xffffffff, 0]),
    );
    assertEquals(
      fixture.guest.call("cancellation", null),
      new Uint32Array([1, 1, 1, 7]),
    );
    assertEquals(
      fixture.guest.call("invalid_times", null),
      new Uint32Array([1, 1, 1]),
    );
  } finally {
    await fixture.dispose();
  }
});

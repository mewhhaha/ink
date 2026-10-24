import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
Deno.test("numeric navigation snapshots preserve collision queries and reject malformed geometry", async () => {
  const fixture = await compile(
    new URL("./navigation_packet.blot", import.meta.url),
  );
  try {
    const { guest } = fixture;
    assertEquals(guest.call("geometry", null), 1);
    const values = guest.call("encoded", null) as Float32Array;
    for (let end = 0; end < values.length; end++) {
      assertEquals(guest.call("accepted", values.slice(0, end)), 0);
    }
    assertEquals(guest.call("accepted", new Float32Array([...values, 0])), 0);
    for (
      const [at, value] of [[0, 2], [1, -1], [1, 1e7], [2, 0.5], [3, 1025], [
        4,
        3,
      ], [10, -1]]
    ) {
      const bad = values.slice();
      bad[at] = value;
      assertEquals(guest.call("accepted", bad), 0, `field ${at} = ${value}`);
    }
    for (let at = 0; at < values.length; at++) {
      for (const value of [NaN, Infinity, -Infinity]) {
        const bad = values.slice();
        bad[at] = value;
        assertEquals(guest.call("accepted", bad), 0);
      }
    }
    assertEquals(guest.call("accepted", values), 1);
  } finally {
    await fixture.dispose();
  }
});

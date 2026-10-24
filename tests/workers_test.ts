import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("worker batch framing bounds each value and rejects malformed replies", async () => {
  const fixture = await compile(new URL("./workers.blot", import.meta.url));
  try {
    assertEquals(
      fixture.guest.call("encode", null),
      new Float32Array([
        -4670545,
        3,
        2,
        1,
        2,
        0,
        1,
        3,
      ]),
    );
    for (
      const lanes of [
        [],
        [-4670545, 0],
        [-4670545, 1, -1],
        [-4670545, 1, 2, 0],
        [-4670545, 1, 16385],
        [-4670545, 1, 0, 3],
      ]
    ) {
      assertThrows(() => fixture.guest.call("decode", new Float32Array(lanes)));
    }
  } finally {
    await fixture.dispose();
  }
});

import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";

Deno.test("acceleration and restitution optimizations preserve every output and input snapshot bit", async () => {
  const fixture = await compile(
    new URL("./perf/rigid-costs.blot", import.meta.url),
  );
  const bytes = (name: string, count: number) => {
    const values = fixture.guest.call(name, count) as Float32Array;
    return new Uint32Array(values.buffer, values.byteOffset, values.length);
  };
  try {
    for (const count of [0, 1, 31, 128, 512, 2048]) {
      assertEquals(bytes("accelerated", count), bytes("original", count));
      assertEquals(bytes("vector", count), bytes("original", count));
      assertEquals(
        bytes("bounce_fixed", count),
        bytes("bounce_original", count),
      );
    }
  } finally {
    await fixture.dispose();
  }
});

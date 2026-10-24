import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";

const bits = (values: Float32Array) =>
  new Uint32Array(values.buffer, values.byteOffset, values.length);

Deno.test("scalar, four-lane and column integration preserve operation order and snapshots", async () => {
  const fixture = await compile(
    new URL("./motion-batch.blot", import.meta.url),
  );
  const call = (name: string, value: number | Float32Array) =>
    fixture.guest.call(name, value) as Float32Array;
  try {
    for (const count of [0, 1, 3, 4, 5, 7, 8, 31, 32, 33, 256, 2048]) {
      assertEquals(bits(call("vector", count)), bits(call("original", count)));
    }
    const values = [0, -0, 1, -1, 1e-30, -1e-30, 1e20, -1e20, 0.125];
    const f = Math.fround;
    for (const count of [0, 1, 3, 4, 5, 8, 9]) {
      for (const acceleration of [-9.81, 0, -0, 1e-15]) {
        for (const dt of [0, -0, 0.016, -0.5]) {
          const p = Float32Array.from({ length: count }, (_, i) => values[i]);
          const v = Float32Array.from(
            { length: count },
            (_, i) => values[count - i - 1],
          );
          const input = new Float32Array([acceleration, dt, ...p, ...v]);
          const velocities = v.map((value) =>
            f(value + f(input[0] * input[1]))
          );
          const positions = p.map((value, i) =>
            f(value + f(velocities[i] * input[1]))
          );
          const expected = new Float32Array([
            ...positions,
            ...velocities,
            ...positions,
            ...velocities,
            ...p,
            ...v,
          ]);
          assertEquals(bits(call("varied", input)), bits(expected));
          if (count === 4) {
            assertEquals(
              bits(call("lanes", input)),
              bits(expected.subarray(0, 8)),
            );
          }
        }
      }
    }
    assertThrows(() => call("mismatched", 1));
    assertEquals(call("vector", 0).length, 0);
  } finally {
    await fixture.dispose();
  }
});

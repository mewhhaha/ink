import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./clock.blot", import.meta.url));
const { guest } = fixture;
Deno.test("clock uses caller policy, checkpoints each step and reports discarded time", () => {
  assertEquals(
    Array.from(
      guest.call("advance", new Float32Array([0.0625, 0.5])) as Float32Array,
    ),
    [13, 0.0625, 3, 0.5, 0.125, 0.375, 0.25],
  );
  assertEquals(
    Array.from(
      guest.call("advance", new Float32Array([0, 10])) as Float32Array,
    ),
    [13, 0, 3, 0, 9.625, 0.375, 0.25],
  );
  assertEquals(
    Array.from(
      guest.call("advance", new Float32Array([0.0625, 0])) as Float32Array,
    ),
    [10, 0.0625, 0, 0.5, 0, 0, 0],
  );
});
Deno.test("clock saves full-width ticks and zero cadence never fires", () => {
  for (const tick of [0, 65535, 65536, 16777217, 0xffffffff]) {
    assertEquals(guest.call("roundtrip_tick", tick), tick);
  }
  assertEquals(guest.call("zero_cadence", null), false);
});
Deno.test("clock rejects malformed snapshots and invalid elapsed or policy", () => {
  for (
    const values of [[0, 0, -1], [0, 0, 0.125], [65536, 0, 0], [0, 0, NaN], [
      0,
      0,
    ], [0, 0, 0, 0]]
  ) {
    assertThrows(() => guest.call("decode", new Float32Array(values)));
  }
  for (const value of [-1, NaN, Infinity]) {
    assertThrows(() => guest.call("advance", new Float32Array([0, value])));
  }
  for (const step of [0, -1, NaN, Infinity]) {
    assertThrows(() => guest.call("invalid_policy", step));
  }
});
Deno.test.afterAll(() => fixture.dispose());

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./time.blot", import.meta.url));
const { guest } = fixture;

function fixed(step: number, limit: number, remainder: number, delta: number) {
  return guest.call(
    "fixed",
    new Float32Array([step, limit, remainder, delta]),
  ) as Float32Array;
}

function timer(remaining: number, delta: number) {
  return guest.call(
    "timer",
    new Float32Array([remaining, delta]),
  ) as Float32Array;
}

function neighbor(value: number, offset: number) {
  const valueLane = new Float32Array([value]);
  const bits = new Uint32Array(valueLane.buffer);
  bits[0] += offset;
  return valueLane[0];
}

Deno.test("fixed steps preserve time across frame partitions", () => {
  const single = fixed(0.125, 20, 0, 0.9375);
  let remainder = 0;
  let steps = 0;
  for (const delta of [0.0625, 0.25, 0.03125, 0.46875, 0.125]) {
    const result = fixed(0.125, 20, remainder, delta);
    assertEquals(result[0], 1);
    steps += result[1];
    remainder = result[2];
    assertEquals(result[4], 0);
  }
  assertEquals(steps, single[1]);
  assertEquals(remainder, single[2]);
  assertEquals(single[3], 0.5);
});

Deno.test("catch-up discards whole ticks and keeps the interpolation fraction", () => {
  const result = fixed(0.125, 3, 0.0625, 10);
  assertEquals(Array.from(result), [1, 3, 0.0625, 0.5, 9.625]);
  const next = fixed(0.125, 3, result[2], 0.0625);
  assertEquals(Array.from(next), [1, 1, 0, 0, 0]);
  assertEquals(Array.from(fixed(0.125, 0, 0, 0.5625)), [
    1,
    0,
    0.0625,
    0.5,
    0.5,
  ]);
});

Deno.test("very large finite elapsed time remains bounded before integer conversion", () => {
  const delta = Math.fround(1e20);
  assertEquals(Array.from(fixed(1, 2, 0, delta)), [1, 2, 0, 0, delta]);
  assertEquals(Array.from(fixed(1, 0, 0, delta)), [1, 0, 0, 0, delta]);
  assertEquals(Array.from(fixed(1e-30, 2, 0, delta)), [0]);
});

Deno.test("full-width U32 catch-up limits preserve exact step counts", () => {
  for (const limit of [0, 2, 16777217, 16777219, 0xffffff00, 0xffffffff]) {
    assertEquals(guest.call("huge_steps", limit), limit);
    assertEquals(
      guest.call("near_steps", limit),
      Math.min(Math.fround(limit), limit),
    );
  }
});

Deno.test("rounded three-tick frames do not retain a fourth tick as their remainder", () => {
  const result = guest.call("three_ticks", 0.05) as Float32Array;
  assertEquals(Array.from(result), [1, 3, 0, 0, 0]);
  const step = Math.fround(1 / 60);
  assertAlmostEquals(
    result[1] * step + result[2] + result[4],
    Math.fround(0.05),
    4e-9,
  );
  assertEquals(Array.from(fixed(step, 8, result[2], 0)), [1, 0, 0, 0, 0]);
  const fractional = fixed(step, 8, 0, Math.fround(step * 3.25));
  assertEquals(fractional[1], 3);
  assertAlmostEquals(fractional[2], step * 0.25, 4e-9);
  assertAlmostEquals(fractional[3], 0.25, 3e-7);
  assertAlmostEquals(fractional[4], 0, 4e-9);
});

Deno.test("elapsed accounting stays within F32 precision around whole-tick boundaries", () => {
  for (const value of [1 / 60, 0.1, 0.007, 0.125]) {
    const step = Math.fround(value);
    for (const ticks of [1, 2, 3, 7, 31, 127]) {
      const boundary = Math.fround(ticks * step);
      const ulp = neighbor(boundary, 1) - boundary;
      for (
        const delta of [neighbor(boundary, -1), boundary, neighbor(boundary, 1)]
      ) {
        for (const limit of [0, 2, 8, 200]) {
          const result = fixed(step, limit, 0, delta);
          assertEquals(result[0], 1);
          assertEquals(result[1] <= limit, true);
          assertEquals(result[2] >= 0 && result[2] < step, true);
          assertEquals(result[3] >= 0 && result[3] < 1, true);
          assertAlmostEquals(
            result[1] * step + result[2] + result[4],
            delta,
            ulp * 2,
          );
          if (limit >= ticks) assertAlmostEquals(result[4], 0, ulp);
        }
      }
    }
  }
});

Deno.test("fixed bookkeeping handles ordinary decimal steps without losing accounted time", () => {
  let remainder = 0;
  let consumed = 0;
  let received = 0;
  const step = Math.fround(1 / 60);
  for (let frame = 0; frame < 120; frame++) {
    const delta = Math.fround((frame % 7 + 1) / 1000);
    const result = fixed(step, 4, remainder, delta);
    assertEquals(result[0], 1);
    received += delta;
    consumed += result[1] * step + result[4];
    remainder = result[2];
    assertEquals(result[3] >= 0 && result[3] < 1, true);
  }
  assertAlmostEquals(consumed + remainder, received, 1e-6);
});

Deno.test("zero frame deltas preserve remainder; invalid timing returns Nothing", () => {
  assertEquals(Array.from(fixed(0.125, 3, 0.0625, 0)), [1, 0, 0.0625, 0.5, 0]);
  for (const delta of [-0.1, NaN, Infinity, -Infinity]) {
    assertEquals(Array.from(fixed(0.125, 3, 0, delta)), [0]);
  }
  for (const step of [0, -1, NaN, Infinity]) {
    assertEquals(Array.from(fixed(step, 3, 0, 1)), [0]);
  }
  for (const remainder of [-1, NaN, Infinity]) {
    assertEquals(Array.from(fixed(0.125, 3, remainder, 1)), [0]);
  }
  assertEquals(Array.from(fixed(0.125, 3, 3e38, 3e38)), [0]);
});

Deno.test("timers expire once and return unused time", () => {
  const first = timer(0.5, 0.125);
  assertEquals(Array.from(first), [1, 0.375, 0, 0, 0]);
  const expired = timer(first[1], 0.5);
  assertEquals(Array.from(expired), [1, 0, 1, 0.125, 1]);
  assertEquals(Array.from(timer(expired[1], 0.25)), [1, 0, 0, 0.25, 1]);
  assertEquals(Array.from(timer(0.5, 0.5)), [1, 0, 1, 0, 1]);
  assertEquals(Array.from(timer(0, 0)), [1, 0, 0, 0, 1]);
  assertEquals(Array.from(timer(0.5, 0)), [1, 0.5, 0, 0, 0]);
});

Deno.test("timers reject negative and non-finite values", () => {
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    assertEquals(Array.from(timer(invalid, 0.1)), [0]);
    assertEquals(Array.from(timer(1, invalid)), [0]);
  }
});

Deno.test.afterAll(() => fixture.dispose());

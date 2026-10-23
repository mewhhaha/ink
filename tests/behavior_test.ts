import { assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./behavior.blot", import.meta.url));
const { guest } = fixture;
Deno.test("behavior restoration during every wait preserves transition and event traces", () => {
  for (
    const deltas of [[0, 0.25, 0.25, 0.25, 0.25], [2], [
      0.125,
      0,
      0.375,
      0.5,
      1,
    ]]
  ) {
    const result = Array.from(
      guest.call("replay", new Float32Array(deltas)) as Uint32Array,
    );
    assertEquals(result.slice(0, 2), [3, 3]);
    assertEquals(result[2], result[3]);
    assertEquals(result.slice(4, 4 + result[2]), result.slice(4 + result[2]));
    // Explicit reference: wait once per supplied tick until one second passes,
    // enter a three-hit loop, then stop. Later ticks produce no transitions.
    const trace: number[] = [];
    let elapsed = 0, done = false;
    for (const dt of deltas) {
      if (!done) {
        trace.push(10);
        elapsed += dt;
        if (elapsed >= 1) {
          trace.push(20, 30, 40, 30, 40, 30, 40, 50);
          done = true;
        }
      }
    }
    assertEquals(result.slice(4, 4 + result[2]), trace);
  }
});
Deno.test("zero-time loops are bounded; missing targets clean up once; conditions use logical ticks", () => {
  assertEquals(Array.from(guest.call("budget", null) as Uint32Array), [
    7,
    7,
    1,
    100,
  ]);
  assertEquals(Array.from(guest.call("interruption", null) as Uint32Array), [
    3,
    1003,
    1003,
    1003,
    0,
  ]);
  assertEquals(Array.from(guest.call("conditions", null) as Uint32Array), [
    3,
    0,
    3,
    4,
    0,
  ]);
  for (const n of [1, 64, 1024]) {
    assertEquals(Array.from(guest.call("workload", n) as Uint32Array), [
      3 * n,
      8 * n,
    ]);
  }
});
Deno.test("every transition boundary resumes; delivery handles preserve targets and fallback on deletion", () => {
  const call = (name: string, value: number | null | Uint32Array = null) =>
    Array.from(guest.call(name, value) as Uint32Array);
  assertEquals(call("boundaries"), [3, 3, 10, 20, 30, 40, 30, 40, 30, 40, 50]);
  // Reference delivery: walk, accumulate one logical second, deliver, stop.
  assertEquals(call("delivery", 0), [4, 0, 0, 4, 20, 30, 40]);
  assertEquals(call("delivery", 1), [0, 4, 1, 4, 20, 30]);
  assertEquals(call("version_migration"), [1, 10, 200, 7]);
  assertEquals(call("stack_limit"), [1, 0, 2, 1]);
  for (const dt of [-1, NaN, Infinity]) {
    assertEquals(guest.call("invalid_time", dt), 0);
  }
  for (const dt of [0, 1e30]) assertEquals(guest.call("invalid_time", dt), 1);
  const saved = guest.call("saved", null) as Uint32Array;
  assertEquals(guest.call("read", saved), 1);
  for (let i = 0; i < saved.length; i++) {
    assertEquals(guest.call("read", saved.slice(0, i)), 0);
  }
  for (
    const [at, value] of [
      [0, 2],
      [1, 2],
      [2, 999],
      [3, 0x7f800000],
      [4, 4],
      [4, 3],
      [5, 1],
      [6, 99],
      [7, 99],
    ]
  ) {
    const bad = saved.slice();
    bad[at] = value;
    assertEquals(guest.call("read", bad), 0);
  }
});
Deno.test("bounded actor dispatch matches the explicit state-machine baseline", () => {
  for (const n of [1, 64, 256, 1024]) {
    assertEquals(guest.call("workload", n), guest.call("reference", n));
  }
});
Deno.test.afterAll(() => fixture.dispose());

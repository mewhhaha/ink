import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./derived.blot", import.meta.url));
const call = (name: string, value: number | null = null) =>
  Array.from(fixture.guest.call(name, value) as Uint32Array);
Deno.test("derived results remain correct across no-ops, older replacements, branches, chains and eviction", () => {
  assertEquals(call("lifecycle"), [
    20,
    20,
    20,
    198,
    20,
    154,
    21,
    155,
    20,
    3,
    2,
    2,
    4,
    20,
    7,
  ]);
  assertEquals(call("conditional"), [5, 7, 8, 3]);
  assertEquals(call("graph"), [2, 0, 1, 1, 1]);
  assertThrows(() => fixture.guest.call("exhaustion", null));
});
Deno.test("unchanged semantic dependencies avoid recomputation at crowd scales", () => {
  for (const n of [1, 100, 10000]) {
    assertEquals(call("workload", n), [6 * n, 1, n - 1]);
  }
});
Deno.test("ECS staffing tracks selected fields and membership; terrain replacement and unrelated restores invalidate", () => {
  const rows = call("staffing");
  const results = [3, 3, 3, 4, 6, 5, 3, 3];
  const computes = [1, 1, 1, 2, 3, 4, 5, 1];
  for (let i = 0; i < results.length; i++) {
    assertEquals(rows[i * 4], results[i]);
    assertEquals(rows[i * 4 + 1], results[i]);
    assertEquals(rows[i * 4 + 2], computes[i]);
  }
  assertEquals(call("terrain"), [8, 14, 8, 18, 4, 1]);
  for (const n of [64, 256, 1024]) {
    assertEquals(call("staffing_cached", n), [16 * n * (n - 1), 1, 31]);
    assertEquals(call("staffing_uncached", n), [16 * n * (n - 1), 32, 0]);
  }
});
Deno.test.afterAll(() => fixture.dispose());

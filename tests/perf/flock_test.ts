import { assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "../support.ts";

const fixture = await compile(
  new URL("./flock.blot", import.meta.url),
);
const { guest } = fixture;
function call(entry: string, count: number) {
  return Array.from(guest.call(entry, count) as Float32Array);
}

Deno.test("flock sparse cells and dense budgets retain count, heading and steering witnesses", () => {
  for (const count of [128, 512, 2048]) {
    const rows = count / 32;
    const neighbours = 2 * (31 * rows + (rows - 1) * 32);
    assertEquals(call("sparse", count), [neighbours, count, count, 0]);
    const dense = call("dense", count);
    assertEquals(dense.slice(0, 3), [
      8 * count,
      4.5 * count - 3.5,
      4.5 * count - 3.5,
    ]);
    assertAlmostEquals(dense[3], 32 * count, 0.1);
    assertEquals(call("dense", count), dense);
    assertEquals(call("dense_outputs", count), [count, 4.5 * count - 3.5]);
  }
});

Deno.test("flock budget preserves first-cell ordering across row boundaries and zero", () => {
  for (const most of [0, 1, 8, 31, 32, 33, 63, 64, 128]) {
    const kept = Math.min(63, most);
    let x = 0;
    let z = 0;
    for (let index = 1; index <= kept; index++) {
      x += (index % 32) * 0.01;
      z += Math.floor(index / 32);
    }
    const result = call("row_budget", most);
    assertEquals(result[0], kept);
    if (kept === 0) {
      assertEquals(result, [0, 0, 0, 0]);
    } else {
      assertAlmostEquals(result[1], (kept + 1) / 2, 0.00001);
      assertAlmostEquals(result[2], x / kept, 0.00001);
      assertAlmostEquals(result[3], z / kept, 0.00001);
    }
  }
});

Deno.test("flock bounded calls reuse committed memory after warmup", () => {
  const expected = call("dense", 2048);
  const output = call("dense_outputs", 2048);
  call("sparse", 2048);
  const plateau = guest.memoryBytes();
  for (let repeat = 0; repeat < 16; repeat++) {
    assertEquals(call("dense", 2048), expected);
    assertEquals(call("dense_outputs", 2048), output);
    assertEquals(guest.memoryBytes(), plateau);
  }
});

Deno.test.afterAll(() => fixture.dispose());

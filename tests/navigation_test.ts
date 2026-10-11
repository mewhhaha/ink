import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./navigation.blot", import.meta.url));
const { guest } = fixture;

function dijkstra(width: number, costs: number[], start: number, goal: number) {
  const distance = costs.map(() => Infinity);
  const closed = new Set<number>();
  distance[start] = 0;
  for (;;) {
    let cell = -1;
    for (let i = 0; i < costs.length; i++) {
      if (!closed.has(i) && (cell < 0 || distance[i] < distance[cell])) {
        cell = i;
      }
    }
    if (cell < 0 || !Number.isFinite(distance[cell])) return Infinity;
    if (cell === goal) return distance[cell];
    closed.add(cell);
    const neighbours = [];
    if (cell % width > 0) neighbours.push(cell - 1);
    if (cell % width + 1 < width) neighbours.push(cell + 1);
    if (cell >= width) neighbours.push(cell - width);
    if (cell + width < costs.length) neighbours.push(cell + width);
    for (const other of neighbours) {
      if (costs[other] > 0) {
        distance[other] = Math.min(
          distance[other],
          distance[cell] + costs[other],
        );
      }
    }
  }
}
Deno.test("weighted A* matches independent Dijkstra and returns traversable shortest routes", () => {
  for (let seed = 1; seed <= 25; seed++) {
    let state = seed;
    const costs = Array.from({ length: 117 }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      if (state % 7 === 0) return 0;
      return (state % 8 + 1) * 0.25;
    });
    costs[0] = 1;
    costs[116] = 1;
    const expected = dijkstra(13, costs, 0, 116);
    const result = guest.call(
      "path",
      new Float32Array([13, 9, 0, 116, 117, ...costs]),
    ) as Float32Array;
    if (!Number.isFinite(expected)) {
      assertEquals(result[0], -1);
    } else {
      assertAlmostEquals(result[0], expected, 1e-5);
      const cells = Array.from(result.slice(2));
      assertEquals(cells[0], 0);
      assertEquals(cells.at(-1), 116);
      let cost = 0;
      for (let i = 1; i < cells.length; i++) {
        const a = cells[i - 1], b = cells[i];
        assert(
          Math.abs(a % 13 - b % 13) +
              Math.abs(Math.floor(a / 13) - Math.floor(b / 13)) === 1,
        );
        assert(costs[b] > 0);
        cost += costs[b];
      }
      assertAlmostEquals(cost, expected, 1e-5);
    }
  }
});
Deno.test("reverse flow respects asymmetric entering costs and routes strictly toward the goal", () => {
  const costs = [1, 10, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1];
  const result = guest.call(
    "field",
    new Float32Array([4, 3, 3, ...costs]),
  ) as Float32Array;
  for (let start = 0; start < costs.length; start++) {
    if (!costs[start]) continue;
    assertAlmostEquals(result[start], dijkstra(4, costs, start, 3), 1e-6);
    let cell = start;
    for (let step = 0; step < costs.length && cell !== 3; step++) {
      const next = result[costs.length + cell];
      assert(result[next] < result[cell]);
      assertAlmostEquals(result[cell], costs[next] + result[next], 1e-6);
      cell = next;
    }
    assertEquals(cell, 3);
  }
});
Deno.test("grid validation, walls, trivial routes and explicit budgets", () => {
  assertEquals(
    guest.call("path", new Float32Array([2, 1, 0, 1, 2, 1, -1])),
    new Float32Array([-2]),
  );
  assertEquals(
    guest.call("path", new Float32Array([2, 1, 0, 1, 2, 1, 0])),
    new Float32Array([-1]),
  );
  assertEquals(
    guest.call("path", new Float32Array([2, 1, 0, 1, 0, 1, 1])),
    new Float32Array([-1]),
  );
  assertEquals(
    guest.call("path", new Float32Array([1, 1, 0, 0, 1, 1])),
    new Float32Array([0, 1, 0]),
  );
});
Deno.test("[stress] navigation handles grids through 512 squared within a practical guest budget", () => {
  for (const size of [32, 128, 512]) {
    const started = performance.now();
    const result = guest.call("large", size) as Float32Array;
    const elapsed = performance.now() - started;
    assertEquals(result[0], (size - 1) * 2);
    assertEquals(result[2], size * 2 - 1);
    assert(elapsed < 5000, `${size} grid took ${elapsed}ms`);
    console.log(`A* ${size}²: ${elapsed.toFixed(2)}ms, ${result[1]} expanded`);
    const flowStarted = performance.now();
    const cost = guest.call("large_flow", size) as number;
    const flowElapsed = performance.now() - flowStarted;
    assertEquals(cost, (size - 1) * 2);
    assert(flowElapsed < 5000, `${size} flow took ${flowElapsed}ms`);
    console.log(`Flow ${size}²: ${flowElapsed.toFixed(2)}ms`);
  }
});
Deno.test.afterAll(() => fixture.dispose());

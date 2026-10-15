import { assert, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(
  new URL("./navigation_ground.blot", import.meta.url),
);
const { guest } = fixture;
function call(entry: string, arg: unknown = null) {
  return Array.from(guest.call(entry, arg) as Uint32Array);
}

Deno.test("indexed ground queries match a linear scan on seeded corpora", () => {
  for (const mode of [0, 1, 2]) {
    for (const count of [1, 3, 4, 8, 64, 512]) {
      for (let seed = 1; seed <= 3; seed++) {
        const args = new Uint32Array([seed, count, mode, 800]);
        const result = call("compare", args);
        const label = JSON.stringify({ mode, count, seed, result });
        assertEquals(result.slice(0, 5), [0, 0, 0, 0, 0], label);
        assertEquals(call("compare", args), result, label);
        const [clears, lines, pushes, steps] = result.slice(5);
        assert(clears > 0 && clears < 800, label);
        assert(lines > 0 && lines < 800, label);
        assert(pushes > 0 && steps > 0, label);
      }
    }
  }
});

Deno.test("ground construction validates obstacles once", () => {
  assertEquals(call("validation"), [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

Deno.test("indexed ground keeps zero, clipped and huge arenas exact", () => {
  const expected = [0, 1, 1, 0, 1, 0, 1, 1, 0, 1];
  const single = call("edges", false);
  assertEquals(single, [...expected, 1]);
  const grid = call("edges", true);
  assertEquals(grid.slice(0, -1), expected);
  assert(grid[grid.length - 1] > 1, JSON.stringify(grid));
});

Deno.test("extent cells list each item ascending in exactly the cells it covers", () => {
  for (let seed = 1; seed <= 3; seed++) {
    for (const count of [0, 1, 5, 50, 400]) {
      for (const size of [0, 1, 8, 400]) {
        const result = call("areas", new Uint32Array([seed, count, size]));
        const label = JSON.stringify({ seed, count, size, result });
        const [wrong, miscounted, finite, cells, listings] = result;
        assertEquals([wrong, miscounted], [0, 0], label);
        assert(cells <= finite * 4 + 64, label);
        assert(listings <= finite * 8 + 64, label);
        assert(listings >= finite, label);
      }
    }
  }
});

Deno.test.afterAll(() => fixture.dispose());

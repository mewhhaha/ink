import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./steering.blot", import.meta.url));
const { guest } = fixture;
Deno.test("seek, arrival radii and acceleration caps", () => {
  const result = guest.call(
    "motion",
    new Float32Array([0, 0, 0, 3, 0, 4, 10, 10, 0]),
  ) as Float32Array;
  assertAlmostEquals(result[0], 6, 1e-5);
  assertAlmostEquals(result[2], 8, 1e-5);
  assertAlmostEquals(result[3], 3, 1e-5);
  assertAlmostEquals(result[5], 4, 1e-5);
  assertAlmostEquals(result[6], 3, 1e-5);
  assertEquals(
    guest.call("motion", new Float32Array([0, 0, 0, 0, 0, 0, 10, 10, 0])),
    new Float32Array(7),
  );
});
Deno.test("separation is symmetric, finite for coincident points, and capped", () => {
  assertEquals(
    guest.call("separation", new Float32Array([-1, 0, 0, 1, 0, 0, 0, 0, 0])),
    new Float32Array(3),
  );
  assertAlmostEquals(
    (guest.call("separation", new Float32Array([0.01, 0, 0])) as Float32Array)[
      0
    ],
    -5,
    1e-5,
  );
});
Deno.test("FOV cone and layer-filtered solid LOS handle target and trigger colliders", () => {
  assertEquals(guest.call("cone", new Float32Array([1, 0, 1, 3, 0.7])), 1);
  assertEquals(guest.call("cone", new Float32Array([-1, 0, 0, 3, 0.7])), 0);
  assertEquals(guest.call("cone", new Float32Array([4, 0, 0, 3, 0.7])), 0);
  assertEquals(guest.call("perception", 0), 1);
  assertEquals(guest.call("perception", 1), 0);
  assertEquals(guest.call("perception", 2), 1);
});
Deno.test("1000 agents with caller-provided local neighbours stay inexpensive", () => {
  const started = performance.now();
  const result = guest.call("crowd", 1000) as number;
  const elapsed = performance.now() - started;
  assert(Number.isFinite(result) && result > 0);
  assert(elapsed < 1000);
  console.log(`1000 steering agents: ${elapsed.toFixed(2)}ms`);
});
Deno.test.afterAll(() => fixture.dispose());

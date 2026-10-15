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
Deno.test("uniform cells find exactly the points within a radius, stacked and non-finite ones included", () => {
  for (
    const [count, seed, extent, radius, size] of [
      [400, 7, 30, 2.5, 2.5],
      [400, 9, 30, 2.5, 0.7],
      [300, 11, 200, 6, 1],
      [50, 13, 1, 2, 0],
    ]
  ) {
    const [wrong, found, cells, items] = guest.call(
      "grid_query",
      new Float32Array([count, seed, extent, radius, size]),
    ) as Float32Array;
    assertEquals(wrong, 0);
    assert(found >= count - 1);
    assert(cells <= (count - 1) * 4 + 64);
    assertEquals(items, count - 1);
  }
});
Deno.test("alignment matches the neighbours' mean velocity and cohesion seeks their centre", () => {
  const result = guest.call("rules", 0) as Float32Array;
  assertAlmostEquals(result[0], 1.5, 1e-5);
  assertEquals([result[1], result[2]], [0, 0]);
  assertAlmostEquals(result[3], 3 / Math.SQRT2, 1e-5);
  assertAlmostEquals(result[4], 3 / Math.SQRT2, 1e-5);
  assertEquals(result[5], 0);
});
Deno.test("a neighbourhood averages its own group and pushes from every close member, none from nowhere", () => {
  const [count, cx, cz, hx, hz, px, pz, , outside] = guest.call(
    "neighbours",
    16,
  ) as Float32Array;
  assertEquals(count, 2);
  assertAlmostEquals(cx, 0.5, 1e-6);
  assertAlmostEquals(cz, 1.5, 1e-6);
  assertAlmostEquals(hx, 1, 1e-6);
  assertAlmostEquals(hz, 1, 1e-6);
  // (0.5, 0, 0) and (1, 0, 0) are within the spacing of 1 only once: the
  // other group's member pushes -x by 1 / 0.5; the stacked one along the
  // index's fixed direction (index 0: +z) by 4.
  assertAlmostEquals(px, -2, 1e-5);
  assertAlmostEquals(pz, 4, 1e-5);
  // One placed nowhere sees no one.
  assertEquals(outside, 0);
  const capped = guest.call("neighbours", 1) as Float32Array;
  assertEquals(capped[0], 1);
});
Deno.test("stacked members part along a finite direction at any index, and flocking stays finite", () => {
  for (const index of [0, 1, 3413, 3414, 4095, 4096, 10007]) {
    const result = Array.from(
      guest.call("stacked", index) as Float32Array,
    );
    assert(result.every(Number.isFinite), `index ${index}: ${result}`);
    assertAlmostEquals(Math.hypot(result[0], result[1], result[2]), 4, 1e-4);
    assertEquals(result.slice(6), [0, 0, 0]);
  }
});
Deno.test("flocking holds acceleration, turn, stray and top speed", () => {
  const step = (values: number[]) =>
    Array.from(guest.call("limited", new Float32Array(values)) as Float32Array);
  // Free: the goal gain alone moves (1,0,0) by (goal - v) * 2 * 0.1.
  const free = step([2, 100, 100, 100, 4, 0.1]);
  assertAlmostEquals(free[0], 0.8, 1e-5);
  assertAlmostEquals(free[2], 0.4, 1e-5);
  // The acceleration cap of 1 per second.
  const capped = step([2, 1, 100, 100, 4, 0.1]);
  assertAlmostEquals(Math.hypot(capped[0] - 1, capped[2]), 0.1, 1e-5);
  // A turn of at most 0.05 radians in the step, keeping the speed.
  const turned = step([100, 1000, 100, 0.5, 4, 0.1]);
  assertAlmostEquals(Math.atan2(turned[2], turned[0]), 0.05, 1e-4);
  // Within 0.3 radians of the goal's direction (+z).
  const strayed = step([0.1, 100, 100, 100, 0.3, 0.1]);
  assertAlmostEquals(Math.atan2(strayed[0], strayed[2]), 0.3, 1e-4);
  // Under the top speed.
  const slow = step([2, 100, 0.25, 100, 4, 0.1]);
  assertAlmostEquals(Math.hypot(slow[0], slow[2]), 0.25, 1e-5);
});
Deno.test("boids align with their neighbours, keep apart and replay exactly", () => {
  const run = (rules: number[]) =>
    guest.call(
      "boids",
      new Float32Array([150, 150, 5, ...rules]),
    ) as Float32Array;
  // Goal, alignment, cohesion and separation gains.
  const flocked = run([0.3, 3, 0.2, 1.5]);
  const [before, after, closestBefore, closestAfter] = flocked;
  assert(Math.abs(before) < 0.2, `random headings start apart: ${before}`);
  assert(after > 0.8, `neighbours end aligned: ${after}`);
  assert(closestAfter > 0.3, `separation keeps room: ${closestAfter}`);
  assert(closestBefore >= 0);
  assertEquals(run([0.3, 3, 0.2, 1.5]), flocked);
  const loners = run([0.3, 0, 0, 0]);
  assert(loners[1] < 0.3, `without the rules they stay apart: ${loners[1]}`);
});
Deno.test("a flocking step for 10,000 boids stays inexpensive", () => {
  guest.call("flock_step", 1000);
  const started = performance.now();
  const result = guest.call("flock_step", 10000) as number;
  const elapsed = performance.now() - started;
  assert(Number.isFinite(result) && result > 0);
  assert(elapsed < 1000);
  console.log(`10,000 flocking boids: ${elapsed.toFixed(2)}ms`);
});
const avoid = (values: number[]) =>
  Array.from(guest.call("avoidance", new Float32Array(values)) as Float32Array);
Deno.test("avoidance leaves a clear way alone and ignores triggers, the skipped id and other layers", () => {
  // Moving along the wall, and toward it with too short a reach.
  assertEquals(avoid([0, 0, 0, 0, 0, 1, 0.5, 1, 0]), [0, 0, 0]);
  assertEquals(avoid([0, 0, 0, 1, 0, 0, 0.3, 0.5, 0]), [0, 0, 0]);
  // Over flat ground the sphere clears it; dropping onto it, it pushes up.
  assertEquals(avoid([0, 0, 10, 2, 0, 0, 0.5, 1, 4]), [0, 0, 0]);
  assert(avoid([0, 0, 10, 0, -2, 0, 0.5, 1, 4])[1] > 0);
  const headOn = [0, 0, 0, 2, 0, 0, 0.5, 2];
  assert(avoid([...headOn, 0])[0] < 0);
  for (const variant of [1, 2, 3]) {
    assertEquals(avoid([...headOn, variant]), [0, 0, 0], `variant ${variant}`);
  }
});
Deno.test("avoidance turns a member heading straight at a wall to its right, away from it", () => {
  // Heading +x into the face at x = 1.5, the sphere's 0.5 radius reaches it
  // after 1 metre of a 4 metre reach: urgency 0.75.
  const change = avoid([0, 0, 0, 2, 0, 0, 0.5, 2, 0]);
  assertAlmostEquals(change[0], -3, 1e-5);
  assertAlmostEquals(change[2], 1.5, 1e-5);
  // The steered goal (2, 0, 0) + change heads out of the wall and to +z.
  assert(2 + change[0] < 0);
  assertEquals(change[1], 0);
  assertEquals(avoid([0, 0, 0, 2, 0, 0, 0.5, 2, 0]), change);
  // Heading -z into the other wall, its right is +x: urgency 0.5 leaves no
  // part of the steered goal toward the wall.
  const other = avoid([-6, 0, 0, 0, 0, -2, 0.5, 2, 0]);
  assertAlmostEquals(other[0], 1, 1e-5);
  assertAlmostEquals(other[2], 2, 1e-5);
  // A goal leaning one way turns that way; a velocity already sliding along
  // the wall keeps its way whatever the goal.
  assert(avoid([0, 0, 0, 2, 0, 0, 0.5, 2, 0, 2, 0, -0.5])[2] < 0);
  assert(avoid([0, 0, 0, 2, 0, 0.5, 0.5, 2, 0, 2, 0, -0.5])[2] > 0);
});
Deno.test("avoidance slides an oblique approach along the wall, more urgently nearer", () => {
  // (1, 0, 1) reaches the face after sqrt 2 of a 2 sqrt 2 reach: urgency 0.5.
  const near = avoid([0, 0, 0, 1, 0, 1, 0.5, 2, 0]);
  const steered = [1 + near[0], near[1], 1 + near[2]];
  assert(steered[0] <= 0, `no part into the wall: ${steered}`);
  assert(steered[2] > 1, `faster along it: ${steered}`);
  // Half a metre farther back the urgency is 0.25, the change half as big.
  const far = avoid([-0.5, 0, 0, 1, 0, 1, 0.5, 2, 0]);
  assertAlmostEquals(far[0], near[0] / 2, 1e-5);
  assertAlmostEquals(far[2], near[2] / 2, 1e-5);
});
Deno.test("avoidance pushes a member out of a solid it starts in, and stays finite", () => {
  // Inside the wall near its -x face, moving in or out.
  const entering = avoid([1.6, 0, 0, 1, 0, 0, 0.3, 1, 0]);
  assert(1 + entering[0] < 0, `leaves: ${entering}`);
  assertEquals(avoid([1.6, 0, 0, -1, 0, 0, 0.3, 1, 0]), [-1, 0, 0]);
  for (
    const values of [
      [0, 0, 0, NaN, 0, 0, 0.5, 1, 0],
      [Infinity, 0, 0, 1, 0, 0, 0.5, 1, 0],
      [0, 0, 0, 1, 0, 0, 0.5, NaN, 0],
      [0, 0, 0, 1, 0, 0, NaN, 1, 0],
      [0, 0, 0, 2, 0, 0, 0.5, 2, 0, NaN, 0, 0],
      [0, 0, 0, 3e38, 3e38, 0, 0.5, 1, 0],
      [1.6, 0, 0, 0, 0, 0, 0.5, 1, 0],
    ]
  ) {
    assertEquals(avoid(values), [0, 0, 0], `${values}`);
  }
});
Deno.test("flock members steered by avoidance pass a box to a goal behind it, never inside it", () => {
  const detour = (values: number[]) =>
    Array.from(guest.call("detour", new Float32Array(values)) as Float32Array);
  // One member heading straight at the box's middle, its target straight
  // behind; then three abreast.
  const single = detour([240, 0, 0.8, -5, 0]);
  const trio = detour([240, 0, 0.8, -5, -0.4, -5.6, 0, -5, 0.4]);
  for (const [closest, farthest] of [single, trio]) {
    assert(closest > 0.3, `kept the sphere's radius off the box: ${closest}`);
    assert(farthest < 0.6, `reached the target: ${farthest}`);
  }
  assertEquals(detour([240, 0, 0.8, -5, 0]), single);
  // Without looking ahead the member walks through the box.
  assert(detour([240, 0, 0, -5, 0])[0] < 0);
});
Deno.test.afterAll(() => fixture.dispose());

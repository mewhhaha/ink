import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";
const fixture = await compile(new URL("./joints.blot", import.meta.url));
const { guest } = fixture;
function initial(
  mode: number,
  x: number,
  y: number,
  anchorY = 0,
  speed = 0,
): Float32Array {
  const state = new Float32Array(22);
  state[0] = mode;
  state[1] = 1 / 60;
  state[2] = speed;
  state[4] = anchorY;
  state[9] = x;
  state[10] = y;
  state[15] = 1;
  return state;
}
function tick(state: Float32Array) {
  return guest.call("tick", state) as Float32Array;
}
function distance(state: Float32Array) {
  return Math.hypot(
    state[9] - state[3],
    state[10] - state[4],
    state[11] - state[5],
  );
}
Deno.test("distance joint pendulum stays finite with bounded drift for one simulated minute", () => {
  let state = initial(0, 1, 2, 2);
  let drift = 0;
  let maxEnergy = 0;
  for (let frame = 0; frame < 3600; frame++) {
    state = tick(state);
    assert(state.every(Number.isFinite));
    drift = Math.max(drift, Math.abs(distance(state) - 1));
    const kinetic = (state[16] ** 2 + state[17] ** 2 + state[18] ** 2) / 2;
    const potential = 9.81 * (state[10] - 1);
    maxEnergy = Math.max(maxEnergy, kinetic + potential);
  }
  console.log(
    `60s pendulum: max drift ${drift.toFixed(6)}m, max energy ${
      maxEnergy.toFixed(4)
    }J`,
  );
  assert(drift < 0.015);
  assert(maxEnergy < 11);
});
Deno.test("implicit damped spring settles from extension without gravity", () => {
  let state = initial(1, 2, 0);
  for (let frame = 0; frame < 360; frame++) state = tick(state);
  assertAlmostEquals(distance(state), 1, 0.002);
  assert(Math.hypot(...state.slice(16, 19)) < 0.01);
});
Deno.test("hinge keeps its pivot and axes while bounded motors respond in either direction", () => {
  for (const speed of [-3, 3]) {
    let state = initial(2, 1, 0, 0, speed);
    state[12] = Math.sin(0.15);
    state[15] = Math.cos(0.15);
    let maxPivot = 0;
    for (let frame = 0; frame < 600; frame++) {
      state = tick(state);
      const qx = state[12], qy = state[13], qz = state[14], qw = state[15];
      const anchor = [
        state[9] - (1 - 2 * (qy * qy + qz * qz)),
        state[10] - 2 * (qx * qy + qw * qz),
        state[11] - 2 * (qx * qz - qw * qy),
      ];
      maxPivot = Math.max(maxPivot, Math.hypot(...anchor));
      assert(state.every(Number.isFinite));
    }
    assert(maxPivot < 0.03, `pivot drift ${maxPivot}`);
    assertAlmostEquals(state[21], speed, 0.05);
    const axisAlignment = 1 - 2 * (state[12] ** 2 + state[13] ** 2);
    assert(axisAlignment > 0.999);
  }
});
Deno.test("hinge corrects exactly antiparallel axes", () => {
  let state = initial(2, 1, 0);
  state[12] = 1;
  state[15] = 0;
  for (let frame = 0; frame < 600; frame++) state = tick(state);
  assert(state.every(Number.isFinite));
  assert(1 - 2 * (state[12] ** 2 + state[13] ** 2) > 0.999);
});
Deno.test("caller-driven kinematic anchor carries the attached dynamic body", () => {
  let state = initial(3, 1, 0);
  state[6] = 0.5;
  for (let frame = 0; frame < 180; frame++) {
    state[3] = (frame + 1) / 120;
    state = tick(state);
  }
  assertAlmostEquals(distance(state), 1, 0.02);
  assertAlmostEquals(state[16], 0.5, 0.02);
});
Deno.test("contacts and joints constrain the same body", () => {
  let state = initial(4, 1, 1.1, 1.1);
  for (let frame = 0; frame < 900; frame++) state = tick(state);
  assert(state[10] >= 0.28, `ground penetration ${state[10]}`);
  assertAlmostEquals(distance(state), 1, 0.03);
  assert(state.length > 22, "ground must produce solver contacts");
  assertEquals(state.every(Number.isFinite), true);
});
Deno.test("connected bodies wake and malformed joint coefficients are rejected", () => {
  const state = tick(initial(6, 1, 2, 2));
  assert(state[17] < 0);
  assertEquals(guest.call("validity", new Float32Array([1, 40, 8, 3, 5])), 1);
  for (const index of [0, 1, 2, 3, 4]) {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      const coefficients = new Float32Array([1, 40, 8, 3, 5]);
      coefficients[index] = invalid;
      assertEquals(guest.call("validity", coefficients), 0);
    }
  }
  assertEquals(guest.call("validity", new Float32Array([-1, 40, 8, 3, 5])), 0);
});
Deno.test("[stress] 1000 independent joint rows fit a practical solver budget", () => {
  const started = performance.now();
  const result = guest.call("thousand", 1000) as number;
  const elapsed = performance.now() - started;
  assertAlmostEquals(result, 3000, 0.1);
  assert(elapsed < 1000);
  console.log(`1000 joint rows: ${elapsed.toFixed(2)}ms`);
});
Deno.test.afterAll(() => fixture.dispose());

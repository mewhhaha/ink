import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./tween.blot", import.meta.url));
const { guest } = fixture;

const f32 = Math.fround;
const below = f32(1 - 2 ** -24);
// Linear, Smooth, Smoother, CubicIn, CubicOut, CubicInOut, Back, Hold,
// Steps 4, Steps 0, Steps 1, Steps 3.
const eases = (t: number) => Array.from(guest.call("eases", t) as Float32Array);
const lanes = (name: string, values: number[]) =>
  Array.from(guest.call(name, new Float32Array(values)) as Float32Array);

type Quat = [number, number, number, number];
const turn = (axis: [number, number, number], angle: number): Quat => {
  const length = Math.hypot(...axis);
  const s = Math.sin(angle / 2) / length;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
// The rotation angle between two unit quaternions, either sign, from the
// relative rotation conj(a) * b; atan2 stays accurate near zero.
const between = (a: Quat, b: Quat) => {
  const [ax, ay, az, aw] = [-a[0], -a[1], -a[2], a[3]];
  const [bx, by, bz, bw] = b;
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w));
};
const slerp = (a: Quat, b: Quat, t: number) =>
  Array.from(
    guest.call("slerp", new Float32Array([...a, ...b, t])) as Float32Array,
  ) as Quat;

Deno.test("every easing starts at exactly 0, ends at exactly 1 and clamps outside", () => {
  for (const t of [-Infinity, -1, -1e-30, 0, NaN]) {
    assertEquals(eases(t), new Array(12).fill(0), `t = ${t}`);
  }
  for (const t of [1, 1.5, 2, 1e30, Infinity]) {
    assertEquals(eases(t), new Array(12).fill(1), `t = ${t}`);
  }
});

Deno.test("easings at the midpoint", () => {
  const back = 1 + 2.70158 * -0.125 + 1.70158 * 0.25;
  const middle = eases(0.5);
  assertEquals(middle.slice(0, 6), [0.5, 0.5, 0.5, 0.125, 0.875, 0.5]);
  assertAlmostEquals(middle[6], back, 1e-6);
  assertEquals(middle.slice(7), [0, 0.5, 0, 0, f32(1 / 3)]);
});

Deno.test("cubic easings mirror each other and Back overshoots before settling", () => {
  for (const t of [0.1, 0.25, 0.4, 0.6, 0.9]) {
    const [, smooth, smoother, cubicIn, cubicOut, inOut, back] = eases(t);
    const mirror = eases(1 - t);
    assertAlmostEquals(cubicOut, 1 - mirror[3], 1e-6);
    assertAlmostEquals(cubicIn, 1 - mirror[4], 1e-6);
    assertAlmostEquals(inOut, 1 - mirror[5], 1e-6);
    assertAlmostEquals(smooth, 1 - mirror[1], 1e-6);
    assertAlmostEquals(smoother, 1 - mirror[2], 1e-6);
    assert(back > cubicOut);
  }
  assert(eases(0.25)[6] < 1);
  assert(eases(0.6)[6] > 1.09);
});

Deno.test("rounding never carries an ease to 1 before the end", () => {
  for (const t of [0.999, 0.9999, below]) {
    const values = eases(t);
    values.splice(6, 1);
    assert(values.every((value) => value < 1), `t = ${t}: ${values}`);
  }
  assertEquals(eases(below).slice(1, 3), [below, below]);
  assertEquals(eases(below)[4], below);
});

Deno.test("Steps rise in equal jumps; Steps 0, Steps 1 and Hold wait for the end", () => {
  for (let i = 0; i < 40; i++) {
    const t = f32(i / 40);
    const [, , , , , , , hold, four, zero, one, three] = eases(t);
    assertEquals(four, Math.floor(f32(t * 4)) / 4, `t = ${t}`);
    assertEquals(three, f32(Math.floor(f32(t * 3)) / 3), `t = ${t}`);
    assertEquals([hold, zero, one], [0, 0, 0]);
  }
  assertEquals(eases(below).slice(7), [0, 0.75, 0, 0, f32(2 / 3)]);
});

Deno.test("tweens hold their ends outside their span", () => {
  // Linear 2 -> 10 over [2, 6]: value, progress, done, end.
  const expected = [
    [0, 2, 0, 0],
    [2, 2, 0, 0],
    [3, 4, 0.25, 0],
    [4, 6, 0.5, 0],
    [5.5, 9, 0.875, 0],
    [6, 10, 1, 1],
    [7, 10, 1, 1],
  ];
  for (const [time, value, progress, done] of expected) {
    assertEquals(lanes("scalar", [2, 4, time]), [1, value, progress, done, 6]);
  }
});

Deno.test("a zero-duration tween jumps at its start", () => {
  assertEquals(lanes("scalar", [2, 0, f32(1.999)]), [1, 2, 0, 0, 2]);
  assertEquals(lanes("scalar", [2, 0, 2]), [1, 10, 1, 1, 2]);
  assertEquals(lanes("scalar", [2, 0, 5]), [1, 10, 1, 1, 2]);
});

Deno.test("make refuses non-finite times, negative durations and overflowing ends", () => {
  for (
    const [start, duration] of [
      [NaN, 1],
      [Infinity, 1],
      [-Infinity, 1],
      [0, NaN],
      [0, Infinity],
      [0, -1],
      [0, -1e-30],
      [3e38, 3e38],
    ]
  ) {
    assertEquals(lanes("scalar", [start, duration, 0]), [0]);
  }
  assertEquals(lanes("scalar", [-5, 1e30, -5])[0], 1);
  assertEquals(lanes("scalar", [3e38, 0, 3e38])[0], 1);
});

Deno.test("toward redirects from the current value without a jump", () => {
  // Smooth 0 -> 10 over [0, 4], then toward 20 over 2 seconds (CubicOut).
  for (const at of [0, 1, 2.5, 4, 5]) {
    const [ok, before, after, , start, duration, from, to] = lanes("toward", [
      at,
      at,
    ]);
    assertEquals([ok, start, duration, to], [1, at, 2, 20]);
    assertEquals(after, before);
    assertEquals(from, before);
    const halfway = lanes("toward", [at, at + 1])[3];
    assertAlmostEquals(halfway, before + (20 - before) * 0.875, 1e-5);
    assertEquals(lanes("toward", [at, at + 2])[3], 20);
  }
  assertEquals(lanes("toward", [1, 1])[1], 1.5625);
  assertEquals(lanes("toward", [NaN, 0]), [0]);
});

Deno.test("reversed swaps the ends over the same span and keeps the ease", () => {
  // 0 -> 10 over [1, 3].
  for (const time of [0, 1, 1.5, 2, 2.75, 3, 4]) {
    const [forward, backward, from, to, start, duration] = lanes("reversed", [
      0,
      time,
    ]);
    assertEquals([from, to, start, duration], [10, 0, 1, 2]);
    const mirrored = lanes("reversed", [0, 4 - time])[0];
    assertAlmostEquals(backward, mirrored, 1e-5);
    assertAlmostEquals(backward, 10 - forward, 1e-5);
    // CubicIn keeps starting slowly in the new direction.
    const [slow, back] = lanes("reversed", [1, time]);
    assertAlmostEquals(back, 10 - slow, 1e-5);
  }
  assertEquals(lanes("reversed", [1, 1.5]).slice(0, 2), [0.15625, 9.84375]);
});

Deno.test("Discrete holds a variant until the end", () => {
  // Idle (0) -> Run (2) over [0, 1].
  for (const time of [-1, 0, 0.5, 0.999, below]) {
    assertEquals(guest.call("variant", new Float32Array([1, time, 0])), 0);
  }
  for (const time of [1, 2]) {
    assertEquals(guest.call("variant", new Float32Array([1, time, 0])), 2);
  }
  assertEquals(guest.call("variant", new Float32Array([0, -0.001, 0])), 0);
  assertEquals(guest.call("variant", new Float32Array([0, 0, 0])), 2);
  // Back passes 1 early, so its discrete value switches there.
  assertEquals(guest.call("variant", new Float32Array([1, 0.3, 1])), 0);
  assertEquals(guest.call("variant", new Float32Array([1, 0.5, 1])), 2);
});

Deno.test("Discrete holds a count through an easing that rounds near the end", () => {
  // 3 -> 7 over [1, 3], Smoother.
  for (const time of [0, 1, 2, 2.9, 2.999, f32(2.99999)]) {
    assertEquals(guest.call("count", new Float32Array([1, 2, time])), 3);
  }
  assertEquals(guest.call("count", new Float32Array([1, 2, 3])), 7);
  assertEquals(guest.call("count", new Float32Array([1, 0, 1])), 7);
  assertEquals(guest.call("count", new Float32Array([1, 0, 0.5])), 3);
});

Deno.test("Vec3 tweens interpolate each component", () => {
  // zero -> (2, -4, 6) over [0, 2].
  const vector = (time: number) =>
    Array.from(guest.call("vector", time) as Float32Array);
  assertEquals(vector(-1), [0, 0, 0]);
  assertEquals(vector(0.5), [0.5, -1, 1.5]);
  assertEquals(vector(1), [1, -2, 3]);
  assertEquals(vector(3), [2, -4, 6]);
});

Deno.test("a type declared outside Ink tweens through its own lerp", () => {
  // Level 0 -> 8 over [0, 2]; Gauge.lerp keeps the brighter glow.
  const gauge = (time: number) =>
    Array.from(guest.call("gauge", time) as Float32Array);
  assertEquals(gauge(-1), [0, 1]);
  assertEquals(gauge(1), [4, 1]);
  assertEquals(gauge(2), [8, 1]);
});

Deno.test("slerp turns at constant angular speed along the shorter arc", () => {
  const cases: [Quat, Quat][] = [
    [[0, 0, 0, 1], turn([0, 1, 0], 2)],
    [turn([1, 2, 3], 0.7), turn([-2, 1, 0.5], 2.9)],
    [turn([0, 0, 1], -1), turn([0, 0, 1], 1.5)],
  ];
  for (const [a, b] of cases) {
    const total = between(a, b);
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const q = slerp(a, b, t);
      assertAlmostEquals(Math.hypot(...q), 1, 1e-6);
      assertAlmostEquals(between(a, q), total * t, 2e-4, `t = ${t}`);
      assertAlmostEquals(between(q, b), total * (1 - t), 2e-4, `t = ${t}`);
      // The negated target is the same rotation and takes the same arc.
      const negated = slerp(a, b.map((x) => -x) as Quat, t);
      negated.forEach((x, i) => assertAlmostEquals(x, q[i], 1e-6));
    }
  }
  // A half turn and more takes the other way round: 300 degrees is 60 back.
  const far = turn([0, 1, 0], (300 * Math.PI) / 180);
  const half = slerp([0, 0, 0, 1], far, 0.5);
  assertAlmostEquals(between(half, turn([0, 1, 0], -Math.PI / 6)), 0, 2e-4);
});

Deno.test("nearly equal rotations fall back to normalized interpolation", () => {
  const a = turn([0, 1, 0], 0.3);
  const b = turn([0, 1, 0], 0.31);
  const q = slerp(a, b, 0.5);
  assertAlmostEquals(Math.hypot(...q), 1, 1e-6);
  assertAlmostEquals(between(q, turn([0, 1, 0], 0.305)), 0, 1e-3);
  const same = slerp(a, a, 0.4);
  assertAlmostEquals(between(same, a), 0, 1e-3);
  assertEquals(slerp([0, 0, 0, 1], [0, 0, 0, -1], 0.5), [0, 0, 0, 1]);
  // Either side of the fallback, at about 0.0632 radians, keeps the speed.
  for (const angle of [0.062, 0.0645]) {
    const turned = slerp([0, 0, 0, 1], turn([0, 1, 0], angle), 0.25);
    assertAlmostEquals(between([0, 0, 0, 1], turned), angle * 0.25, 1e-6);
  }
});

Deno.test("rotation tweens slerp with the eased progress", () => {
  const target = turn([0, 1, 0], 2);
  for (const t of [0, 0.25, 0.5, 1]) {
    const linear = lanes("turning", [2, 0, t]) as Quat;
    assertAlmostEquals(
      between(linear, slerp([0, 0, 0, 1], target, t)),
      0,
      1e-3,
    );
    const smooth = lanes("turning", [2, 1, t]) as Quat;
    const s = t * t * (3 - 2 * t);
    assertAlmostEquals(between([0, 0, 0, 1], smooth), 2 * s, 2e-4);
  }
});

Deno.test.afterAll(() => fixture.dispose());

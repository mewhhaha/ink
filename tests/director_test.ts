import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { checkWitness, workloads } from "../tools/library-bench.ts";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./director.blot", import.meta.url));
const { guest } = fixture;

type Quat = [number, number, number, number];

const call = (name: string, input: number[] | number | null = null) => {
  let value: Float32Array | number | null;
  if (Array.isArray(input)) value = new Float32Array(input);
  else value = input;
  return Array.from(guest.call(name, value) as Float32Array);
};
const shot = (id: number) => call("shot", id);
const multiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisAngle = (axis: number[], angle: number): Quat => {
  const scale = Math.sin(angle / 2) / Math.hypot(axis[0], axis[1], axis[2]);
  return [
    axis[0] * scale,
    axis[1] * scale,
    axis[2] * scale,
    Math.cos(angle / 2),
  ];
};
const rotate = (q: Quat, v: number[]) =>
  multiply(multiply(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]])
    .slice(0, 3);
const near = (actual: number[], expected: number[], tolerance = 2e-6) => {
  assertEquals(actual.length, expected.length);
  actual.forEach((value, i) =>
    assertAlmostEquals(value, expected[i], tolerance)
  );
};
// Shot 1 is the origin unrotated with focal length 1; shot 2 is at
// (4, 2, -8), yawed a quarter turn, with focal length 4.
const between = (weight: number) => [
  4 * weight,
  2 * weight,
  -8 * weight,
  ...axisAngle([0, 1, 0], Math.PI / 2 * weight),
  4 ** weight,
];

Deno.test("a cut shows the new shot at once", () => {
  assertEquals(call("cut"), [0, ...shot(3)]);
});

Deno.test("blends start and end exactly on their shots", () => {
  assertEquals(call("blended", [0, 2, 0, 0]), [1, ...shot(1)]);
  assertEquals(call("blended", [0, 2, 1, 1]), [0, ...shot(2)]);
  assertEquals(call("blended", [0, 2, 1.5, 1.5]), [0, ...shot(2)]);
  const last = call("blended", [0, 2, 1.9375, 0]);
  assertEquals(last[0], 1);
  near(last.slice(1), between(1.9375 / 2));
});

Deno.test("mid-blend positions lerp, rotations slerp and focal lengths move by equal ratios", () => {
  const half = call("blended", [0, 2, 1, 0]);
  near(half, [1, ...between(0.5)]);
  assertAlmostEquals(half[8], 2, 2e-6);
  assertEquals(call("blended", [0, 2, 0.5, 0.5]), half);
  near(call("blended", [0, 2, 0.25, 0.25]).slice(1), between(0.25));
});

Deno.test("the blend's ease shapes its weight", () => {
  const u = -0.75;
  const weights = [
    0.25,
    0.15625,
    0.103515625,
    0.015625,
    0.578125,
    0.0625,
    1 + 2.70158 * u ** 3 + 1.70158 * u ** 2,
    0,
    0.25,
  ];
  weights.forEach((weight, kind) => {
    near(call("blended", [kind, 2, 0.5, 0]), [1, ...between(weight)]);
  });
  assertEquals(call("blended", [7, 2, 1.5, 0]), [1, ...shot(1)]);
});

Deno.test("interrupting a blend freezes where it was, so nothing jumps", () => {
  for (const first of [0.25, 0.5, 1, 1.75, 1.9990234375]) {
    const result = call("interrupted", [first, 0]);
    const before = result.slice(0, 8);
    assertEquals(result.slice(8, 16), before);
    assertEquals(result.slice(16, 24), before);
    assertEquals(result.slice(24), [2, 1]);
    const smooth = (x: number) => x * x * (3 - 2 * x);
    near(before.slice(0, 3), between(smooth(first / 2)).slice(0, 3));
    const soon = call("interrupted", [first, 0.001]);
    near(soon.slice(16, 24), before, 1e-5);
    const ended = call("interrupted", [first, 1]);
    assertEquals(ended.slice(16), [...shot(3), 2, 0]);
  }
});

Deno.test("a blend from a live shot follows it as it moves", () => {
  near(call("live", [0.5, 10]), [
    4.5,
    1,
    -4,
    ...axisAngle([0, 1, 0], Math.PI / 4),
    2,
  ]);
  near(call("live", [0.25, -4]), [
    0.25,
    0.5,
    -2,
    ...axisAngle([0, 1, 0], Math.PI / 8),
    Math.SQRT2,
  ]);
});

Deno.test("negative or non-finite durations and steps are refused", () => {
  assertEquals(call("accepted", [0, 0]), [1, 1]);
  assertEquals(call("accepted", [2, 0.5]), [1, 1]);
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    assertEquals(call("accepted", [invalid, 0]), [0, 1]);
    assertEquals(call("accepted", [1, invalid]), [1, 0]);
  }
});

Deno.test("blending to the live shot changes nothing; a zero-length blend cuts", () => {
  const result = call("unchanged");
  assertEquals(result.slice(16, 32), result.slice(0, 16));
  assertEquals(result.slice(32), [0, ...shot(3)]);
});

Deno.test("director states round-trip their lanes", () => {
  const result = call("saved");
  const saved = result.slice(0, 48);
  assertEquals(result.slice(48), saved);
  assertEquals(saved.slice(0, 16), [
    7,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  assertEquals(saved.slice(16, 32), [
    9,
    0,
    1,
    7,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0.25,
    1.5,
    8,
    5,
    0,
  ]);
  const frozen = saved.slice(32, 48);
  assertEquals(frozen.slice(0, 3), [3, 0, 2]);
  assertEquals(frozen.slice(11), [0, 3, 5, 0, 0]);
  const back = (t: number) =>
    1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
  near(frozen.slice(3, 11), between(back(0.25)), 4e-6);
  for (const id of [1, 65535, 65536, 16777217, 0xfffffffe, 0xffffffff]) {
    assertEquals(guest.call("saved_shot", id), id);
  }
});

Deno.test("malformed director lanes are rejected", () => {
  const frozen = call("saved").slice(32, 48);
  const live = [9, 0, 1, 7, 0, 0, 0, 0, 0, 0, 0, 0.25, 1.5, 8, 5, 0];
  const settled = [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const valid of [frozen, live, settled]) {
    assertEquals(guest.call("decode", new Float32Array(valid)), valid[11]);
  }
  const changed = (values: number[], index: number, value: number) =>
    values.map((old, i) => i === index ? value : old);
  const malformed = [
    live.slice(0, 15),
    [...live, 0],
    changed(live, 0, 65536),
    changed(live, 2, 3),
    changed(live, 5, 1),
    changed(live, 11, 1.5),
    changed(live, 11, -0.25),
    changed(live, 12, NaN),
    changed(live, 13, 9),
    changed(live, 13, 0),
    changed(settled, 11, 0.5),
    changed(settled, 12, 1),
    changed(settled, 4, 1),
    changed(settled, 14, 2),
    changed(frozen, 10, 0),
    changed(frozen, 9, 0.5),
    changed(frozen, 3, Infinity),
  ];
  for (const values of malformed) {
    assertThrows(() => guest.call("decode", new Float32Array(values)));
  }
});

Deno.test("shaking moves and turns the camera in its own axes", () => {
  const still = shot(2);
  assertEquals(call("shaken", [0, 0, 0, 0, 0, 0]), still);
  assertEquals(call("settled_shake", 0).slice(6), still);
  // A quarter turn left points the camera's right along world -Z.
  assertEquals(call("shaken", [1, 0, 0, 0, 0, 0]), [
    4,
    2,
    -9,
    ...still.slice(3),
  ]);
  near(call("shaken", [0, 0, 0, 0, 0.1, 0]), [
    4,
    2,
    -8,
    ...axisAngle([0, 1, 0], Math.PI / 2 + 0.1),
    4,
  ]);
  const shake = call("settled_shake", 0.05);
  const [translation, rotation, shaken] = [
    shake.slice(0, 3),
    shake.slice(3, 6),
    shake.slice(6),
  ];
  const angle = Math.hypot(rotation[0], rotation[1], rotation[2]);
  assertEquals(angle > 0.001 && Math.hypot(...translation) > 0.01, true);
  const turn = still.slice(3, 7) as Quat;
  const offset = rotate(turn, translation);
  near(shaken, [
    4 + offset[0],
    2 + offset[1],
    -8 + offset[2],
    ...multiply(turn, axisAngle(rotation, angle)),
    4,
  ]);
});

Deno.test("poses tween with tween.at, ending exactly on their ends", () => {
  const halfway = call("tweened", 2);
  assertEquals(halfway.slice(0, 8), halfway.slice(8));
  assertEquals(call("tweened", 1).slice(0, 8), shot(1));
  assertEquals(call("tweened", 0).slice(0, 8), shot(1));
  assertEquals(call("tweened", 3).slice(0, 8), shot(3));
  near(halfway.slice(0, 3), [-1, 3, 1]);
  assertAlmostEquals(halfway[7], Math.SQRT2, 2e-6);
});

Deno.test("focal lengths blend by equal ratios and stay positive past the ends", () => {
  const zoom = (a: number, b: number, t: number) =>
    guest.call("zoom", new Float32Array([a, b, t])) as number;
  assertAlmostEquals(zoom(1, 4, 0.5), 2, 2e-6);
  assertAlmostEquals(zoom(4, 1, 0.5), 2, 2e-6);
  assertAlmostEquals(zoom(2, 8, 0.25), 2 * Math.SQRT2, 4e-6);
  assertAlmostEquals(zoom(20, 1, 1.1), 20 * 0.05 ** 1.1, 1e-5);
  assertAlmostEquals(zoom(1, 20, 1.1), 20 ** 1.1, 1e-4);
  assertAlmostEquals(zoom(1, 20, -0.1), 20 ** -0.1, 1e-6);
  assertEquals(zoom(4, 1, 0), 4);
  assertEquals(zoom(4, 1, 1), 1);
  assertEquals(zoom(-1, 2, 0.5), 0.5);
  assertEquals(zoom(0, 2, 0.25), 0.5);
});

Deno.test("lens helpers apply the pose's focal length and camera", () => {
  const result = call("lens");
  assertEquals(result.slice(0, 3), [4, 0.25, 500]);
  assertEquals(result.slice(3, 7), result.slice(7, 11));
  assertEquals(result.slice(3, 5), [2, 4]);
  assertEquals(result[11], 4);
  // The view moves the yawed camera at (4, 2, -8) back to the origin.
  near(result.slice(12), [-8, -2, -4], 2e-6);
});

Deno.test("the director benchmark keeps its numerical witness", () => {
  const workload = workloads.find((item) =>
    item.entry === "director_workload"
  )!;
  for (const size of workload.sizes) {
    checkWitness(workload, size, call(workload.entry, size));
  }
});

Deno.test.afterAll(() => fixture.dispose());

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./rig.blot", import.meta.url));
const { guest } = fixture;

type Vec = [number, number, number];

const call = (entry: string, values: number[]) =>
  Array.from(guest.call(entry, new Float32Array(values)) as Float32Array);
const valid = (settings: number[]) =>
  guest.call("valid", new Float32Array(settings)) as number;
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: number[], b: number[]) =>
  a.reduce((sum, value, i) => sum + value * b[i], 0);
const norm = (a: Vec) => Math.hypot(...a);
const unit = (a: Vec) => scale(a, 1 / norm(a));
const close = (actual: number[], expected: number[], tolerance: number) => {
  assertEquals(actual.length, expected.length);
  for (const [i, value] of actual.entries()) {
    assertAlmostEquals(value, expected[i], tolerance, `lane ${i}: ${actual}`);
  }
};
// A yaw turn of `angle` applied to v, as math.Quat.yaw: +x toward -z.
const yawed = (v: Vec, angle: number): Vec => [
  v[0] * Math.cos(angle) + v[2] * Math.sin(angle),
  v[1],
  -v[0] * Math.sin(angle) + v[2] * Math.cos(angle),
];
// The camera lanes: position, rotation, forward, up.
const camera = (lanes: number[]) => ({
  position: lanes.slice(0, 3) as Vec,
  rotation: lanes.slice(3, 7),
  forward: lanes.slice(7, 10) as Vec,
  up: lanes.slice(10, 13) as Vec,
});

Deno.test("look_at faces the target, keeps up up and stays defined when degenerate", () => {
  const ahead = camera(call("look", [0, 0, 0, 0, 0, -5, 0, 1, 0]));
  close(ahead.rotation, [0, 0, 0, 1], 1e-6);
  const eye: Vec = [1, 2, 3];
  const target: Vec = [4, -1, 7];
  const view = camera(call("look", [...eye, ...target, 0, 1, 0]));
  assertEquals(view.position, eye);
  close(view.forward, unit(sub(target, eye)), 1e-5);
  assert(view.up[1] > 0);
  assertAlmostEquals(dot(view.up, view.forward), 0, 1e-5);
  // An eye on its target looks down -Z; an up along the view picks a fixed
  // perpendicular.
  const same = camera(call("look", [1, 1, 1, 1, 1, 1, 0, 1, 0]));
  close(same.rotation, [0, 0, 0, 1], 0);
  const upward = camera(call("look", [0, 0, 0, 0, 10, 0, 0, 1, 0]));
  close(upward.forward, [0, 1, 0], 1e-5);
  assertAlmostEquals(Math.hypot(...upward.rotation), 1, 1e-5);
});

Deno.test("turn smooths exponentially, independent of the step size", () => {
  const turned = (steps: number, rate = 2, seconds = 0.5) =>
    call("turning", [0, 1, rate, seconds, steps]);
  const once = turned(1);
  for (const steps of [7, 60]) close(turned(steps), once, 2e-6);
  // After rate × seconds = 1, e^-1 of the turn remains.
  assertAlmostEquals(2 * Math.atan2(once[1], once[3]), 1 - Math.exp(-1), 1e-5);
  close(turned(1, 0), [0, 0, 0, 1], 0);
  close(turned(1, 2, 0), [0, 0, 0, 1], 0);
  close(turned(1, NaN), [0, 0, 0, 1], 0);
  close(turned(1, Infinity), [0, Math.sin(0.5), 0, Math.cos(0.5)], 1e-6);
});

// offset, turns, dead zone, lookahead, frequency, damping, turn rate
const rules = (
  changes: Partial<Record<"turns" | "dead" | "ahead" | "rate", number>> = {},
  offset: Vec = [0, 2, 5],
) => [
  ...offset,
  changes.turns ?? 0,
  changes.dead ?? 0,
  changes.ahead ?? 0,
  8,
  1,
  changes.rate ?? 6,
];
interface Step {
  target: Vec;
  velocity?: Vec;
  heading?: number;
}
const follow = (settings: number[], dt: number, steps: Step[]) => {
  const result = call("following", [
    ...settings,
    steps.length - 1,
    dt,
    ...steps.flatMap((step) => [
      ...step.target,
      ...(step.velocity ?? [0, 0, 0]),
      step.heading ?? 0,
    ]),
  ]);
  assertEquals(result[0], 0, "every camera shows its state");
  const states = [];
  for (let i = 1; i < result.length; i += 16) {
    states.push({
      anchor: result.slice(i, i + 3) as Vec,
      seat: result.slice(i + 3, i + 6) as Vec,
      focus: result.slice(i + 6, i + 9) as Vec,
      eye: result.slice(i + 9, i + 12) as Vec,
      rotation: result.slice(i + 12, i + 16),
    });
  }
  return states;
};
// The forward direction of a rotation [x, y, z, w].
const forward = ([x, y, z, w]: number[]): Vec => [
  -2 * (x * z + w * y),
  -2 * (y * z - w * x),
  -(1 - 2 * (x * x + y * y)),
];

Deno.test("a follower starts settled, so a still target never moves it", () => {
  const target: Vec = [3, 1, -2];
  const states = follow(
    rules({ turns: 1 }),
    1 / 60,
    Array(6).fill({ target, heading: 0.7 }),
  );
  const [start] = states;
  close(start.eye, add(target, yawed([0, 2, 5], 0.7)), 1e-5);
  assertEquals(start.anchor, target);
  assertEquals(start.focus, target);
  close(forward(start.rotation), unit(sub(target, start.eye)), 1e-5);
  for (const state of states) assertEquals(state, start);
});

Deno.test("the focus holds while the target moves inside the dead zone, then trails at its edge", () => {
  const inside = Array.from({ length: 10 }, (_, i) => ({
    target: [i * 0.1, 0, 0] as Vec,
  }));
  const outside = Array.from({ length: 240 }, () => ({
    target: [1.5, 0, 0] as Vec,
  }));
  const states = follow(rules({ dead: 1 }), 1 / 60, [...inside, ...outside]);
  for (const state of states.slice(0, 10)) assertEquals(state, states[0]);
  // The lead left the zone: the anchor sits a radius behind it.
  for (const state of states.slice(10)) close(state.anchor, [0.5, 0, 0], 1e-6);
  const last = states[states.length - 1];
  close(last.focus, [0.5, 0, 0], 1e-4);
  close(last.eye, [0.5, 2, 5], 1e-4);
});

Deno.test("the focus leads a moving target and a fixed offset keeps the view", () => {
  const velocity: Vec = [2, 0, 0];
  const dt = 1 / 60;
  const steps = Array.from({ length: 181 }, (_, i) => ({
    target: scale(velocity, i * dt),
    velocity,
  }));
  const states = follow(rules({ dead: 0.25, ahead: 0.5 }), dt, steps);
  // It starts on the lead (target + velocity × lookahead), which leaves the
  // zone after 0.125 seconds and then keeps on its edge.
  close(states[0].anchor, [1, 0, 0], 0);
  for (const [i, state] of states.entries()) {
    const target = steps[i].target;
    if (i >= 8) close(state.anchor, add(target, [0.75, 0, 0]), 1e-4);
    else close(state.anchor, [1, 0, 0], 0);
    // The eye keeps the offset from the focus, so the view never turns.
    close(sub(state.eye, state.focus), [0, 2, 5], 1e-4);
    close(state.rotation, states[0].rotation, 1e-5);
  }
  // A critically damped spring trails a steady pace by 2 v / frequency.
  const last = states[states.length - 1];
  close(last.focus, add(steps[180].target, [0.25, 0, 0]), 1e-4);
});

Deno.test("a turning offset swings the eye behind the heading and the view turns after it", () => {
  const steps: Step[] = [{ target: [0, 0, 0] }];
  for (let i = 0; i < 300; i++) {
    steps.push({ target: [0, 0, 0], heading: Math.PI / 2 });
  }
  const states = follow(rules({ turns: 1, rate: 4 }), 1 / 60, steps);
  const last = states[states.length - 1];
  close(last.eye, [5, 2, 0], 1e-4);
  close(forward(last.rotation), unit([-5, -2, 0]), 1e-4);
  // Midway the view still lags its eye's line to the focus.
  const middle = states[8];
  const wanted = unit(sub(middle.focus, middle.eye));
  assert(dot(forward(middle.rotation), wanted) < 0.9999);
  assert(dot(forward(middle.rotation), wanted) > 0.9);
});

Deno.test("following agrees across frame rates to millimetres", () => {
  const run = (rate: number) => {
    const dt = 1 / rate;
    const steps = Array.from({ length: 2 * rate + 1 }, (_, i) => {
      const t = i * dt;
      return {
        target: [3 * Math.cos(t), 0, 3 * Math.sin(t)] as Vec,
        velocity: [-3 * Math.sin(t), 0, 3 * Math.cos(t)] as Vec,
        heading: -t,
      };
    });
    return follow(rules({ turns: 1, dead: 0.2, ahead: 0.3 }), dt, steps)
      .pop()!;
  };
  const slow = run(30);
  const fast = run(120);
  // Springs held at each step's goal would differ by about 8 cm here.
  assert(norm(sub(slow.eye, fast.eye)) < 0.005);
  assert(norm(sub(slow.focus, fast.focus)) < 0.005);
  assert(dot(forward(slow.rotation), forward(fast.rotation)) > 0.9999);
});

Deno.test("invalid steps keep the state and invalid settings are refused", () => {
  const steps = [{ target: [0, 0, 0] as Vec }, { target: [5, 0, 0] as Vec }];
  for (const dt of [0, -1, NaN, Infinity]) {
    const [start, after] = follow(rules(), dt, steps);
    assertEquals(after, start);
  }
  assertEquals(valid(rules()), 1);
  for (
    const lane of [
      [0, NaN],
      [4, -1],
      [5, -0.5],
      [6, Infinity],
      [7, -1],
      [8, NaN],
    ]
  ) {
    const settings = rules();
    settings[lane[0]] = lane[1];
    assertEquals(valid(settings), 0, `${lane}`);
  }
});

const focal = 1 / Math.tan(Math.PI / 6);
const cluster: Vec[] = [
  [0, 0, 0],
  [3, 1, -2],
  [-2, 4, 1],
  [1, -1, 3],
  [4, 2, 2],
  [-1, 0, -4],
];
const framed = (
  points: Vec[],
  padding = 0,
  aspect = 16 / 9,
  yaw = 0.4,
  pitch = -0.3,
) => {
  const result = call("framing", [
    aspect,
    focal,
    padding,
    yaw,
    pitch,
    ...points.flat(),
  ]);
  if (result.length === 0) return undefined;
  const pixels = [];
  for (let i = 4; i < result.length; i += 2) {
    pixels.push([result[i], result[i + 1]]);
  }
  return {
    eye: result.slice(0, 3),
    ahead: result[3],
    pixels,
    width: aspect * 1000,
  };
};

Deno.test("framing fits every point in view, touching an edge, as near as it can", () => {
  for (const aspect of [16 / 9, 0.5]) {
    const { pixels, width, ahead } = framed(cluster, 0, aspect)!;
    let slack = Infinity;
    for (const [x, y] of pixels) {
      assert(x >= -0.002 && x <= width + 0.002, `x ${x} of ${width}`);
      assert(y >= -0.002 && y <= 1000.002, `y ${y}`);
      slack = Math.min(slack, x, width - x, y, 1000 - y);
    }
    assert(slack < 0.002, `nearest edge ${slack}`);
    // Any step nearer loses a point.
    assertEquals(ahead, 0);
  }
});

Deno.test("framing padding keeps points that angle inside the edges", () => {
  const padding = 0.08;
  const aspect = 16 / 9;
  const { pixels, width } = framed(cluster, padding, aspect)!;
  const halfY = Math.PI / 6;
  const halfX = Math.atan(aspect / focal);
  const marginX = (width / 2) *
    (1 - Math.tan(halfX - padding) / Math.tan(halfX));
  const marginY = 500 * (1 - Math.tan(halfY - padding) / Math.tan(halfY));
  let slack = Infinity;
  for (const [x, y] of pixels) {
    const sx = Math.min(x, width - x) - marginX;
    const sy = Math.min(y, 1000 - y) - marginY;
    assert(sx > -0.002 && sy > -0.002, `${x}, ${y}`);
    slack = Math.min(slack, sx, sy);
  }
  assert(slack < 0.002, `nearest padded edge ${slack}`);
});

Deno.test("framing one point puts it in the middle at the near plane; impossible framings are refused", () => {
  const single = framed([[2, 3, 4]])!;
  close(single.pixels[0], [single.width / 2, 500], 0.01);
  // yaw 0.4, pitch -0.3: the eye is the near distance back along the view.
  const back = scale(
    [
      -Math.cos(-0.3) * Math.sin(0.4),
      Math.sin(-0.3),
      -Math.cos(-0.3) * Math.cos(0.4),
    ],
    -0.1,
  );
  close(single.eye, add([2, 3, 4], back), 1e-5);
  assertEquals(framed([]), undefined);
  for (const padding of [Math.PI / 6, 0.6, 2, Infinity]) {
    assertEquals(framed(cluster, padding), undefined, `padding ${padding}`);
  }
  assertEquals(framed(cluster, -0.1), undefined);
  assertEquals(framed([[0, 0, 0], [NaN, 0, 0]]), undefined);
  assertEquals(framed(cluster, 0, 0), undefined);
  // Too wide to fit before the far plane.
  assertEquals(framed([[-2000, 0, 0], [2000, 0, 0]]), undefined);
});

const collide = (pivot: Vec, eye: Vec, radius: number, variant = 0) =>
  call("collision", [...pivot, ...eye, radius, variant]);

Deno.test("collision pulls the eye in front of the first solid and leaves a clear way alone", () => {
  assertEquals(collide([0, 0, 0], [0, 0.5, 4], 0.3), [0, 0.5, 4]);
  const blocked = collide([0, 0, 0], [4, 0, 0], 0.3);
  close(blocked, [1.2, 0, 0], 1e-3);
  assert(blocked[0] <= Math.fround(1.2));
  // At an angle, the eye stays on the line from the pivot.
  const slanted = collide([0, 0.5, 0], [4, 0.5, 2], 0.3);
  assertAlmostEquals(slanted[0], 1.2, 1e-3);
  assertAlmostEquals(slanted[2], slanted[0] / 2, 1e-5);
  // A trigger, a skipped id or a layer left out of the mask lets it through.
  for (const variant of [1, 2, 3]) {
    assertEquals(collide([0, 0, 0], [4, 0, 0], 0.3, variant), [4, 0, 0]);
  }
  // Terrain counts unless its layer is left out.
  close(collide([-3, 1, 0], [-3, -3, 0], 0.3), [-3, -0.7, 0], 1e-3);
  assertEquals(collide([-3, 1, 0], [-3, -3, 0], 0.3, 4), [-3, -3, 0]);
  // A pivot inside a solid stops at once; non-finite input changes nothing.
  assertEquals(collide([2, 0, 0], [-2, 0, 0], 0.3), [2, 0, 0]);
  assertEquals(collide([NaN, 0, 0], [4, 0, 0], 0.3), [4, 0, 0]);
});

const dolly = (aim: number, distance: number, extra: number[] = []) =>
  camera(call("dollying", [aim, distance, ...extra]));

Deno.test("a dolly rides its spline, aimed along it, at a point or fixed", () => {
  for (const distance of [0, 2, 5.5, 9, 100]) {
    const lanes = call("dollying", [0, distance]);
    const view = camera(lanes);
    close(view.forward, lanes.slice(13, 16), 1e-5);
    assert(view.up[1] > 0);
  }
  const start = dolly(0, 0);
  close(start.position, [0, 0, 0], 0);
  const target: Vec = [2, 5, 0];
  const aimed = dolly(1, 6, target);
  close(aimed.forward, unit(sub(target, aimed.position)), 1e-5);
  // Aimed at its own position, it looks along the path.
  const along = dolly(0, 6);
  close(dolly(1, 6, along.position).rotation, along.rotation, 1e-6);
  const fixed = dolly(2, 3, [0.3, -0.2]);
  close(
    fixed.forward,
    [
      -Math.cos(-0.2) * Math.sin(0.3),
      Math.sin(-0.2),
      -Math.cos(-0.2) * Math.cos(0.3),
    ],
    1e-5,
  );
  close(fixed.position, dolly(0, 3).position, 0);
});

Deno.test.afterAll(() => fixture.dispose());

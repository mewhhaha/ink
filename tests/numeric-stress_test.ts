import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

// Bounded calls reset the guest arena. Seeds and initial conditions are fixed;
// correctness witnesses use host arithmetic, never timing thresholds.
const fixture = await compile(
  new URL("./numeric-stress.blot", import.meta.url),
);
function call(name: string, a: number[]) {
  const result = Array.from(
    fixture.guest.call(name, new Float32Array(a)) as Float32Array,
  );
  assert(result.every(Number.isFinite), `${name}: nonfinite result for ${a}`);
  return result;
}
function near(a: number[], b: number[], tolerance = 1e-5) {
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) assertAlmostEquals(a[i], b[i], tolerance);
}
function next(state: number) {
  if (state === 0) state = 2654435769;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
let seed = 0xa19c4037;
function random() {
  seed = next(seed);
  return (seed >>> 8) / 16777216;
}
function between(low: number, high: number) {
  return low + (high - low) * random();
}
function vector() {
  return [between(-5, 5), between(-5, 5), between(-5, 5)];
}
function normalized(v: number[]) {
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}
function dot(a: number[], b: number[]) {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}

Deno.test("[stress] full-width RNG replays 4096 states and bounded high-bit units", () => {
  for (const initial of [0, 1, 0x80000001, 0xffffffff]) {
    const actual = Array.from(
      fixture.guest.call("sequence", initial) as Uint32Array,
    );
    let state = initial;
    for (const value of actual) {
      state = next(state);
      assertEquals(value, state);
      assertEquals(fixture.guest.call("unit", state), (state >>> 8) / 16777216);
    }
    assertEquals(
      actual,
      Array.from(fixture.guest.call("sequence", initial) as Uint32Array),
    );
  }
});

function hash(x: number, y: number, z: number, seed: number) {
  let h = Math.imul(x, 2747636419) ^ Math.imul(y, 2654435769) ^
    Math.imul(z, 2246822519) ^ Math.imul(seed, 3266489917);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
function fade(t: number) {
  return t ** 3 * (t * (t * 6 - 15) + 10);
}
function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function perlin(p: number[], seed: number): number {
  const lattice = p.map(Math.floor), f = p.map((v, i) => v - lattice[i]);
  const weights = f.map(fade);
  const corners: number[] = [];
  for (let z = 0; z < 2; z++) {
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const k = hash(lattice[0] + x, lattice[1] + y, lattice[2] + z, seed) %
          12;
        let u = f[1] - y, v = f[2] - z;
        if (k < 8) u = f[0] - x;
        if (k < 4) {
          v = f[1] - y;
        }
        if ((k & 1) !== 0) u = -u;
        if ((k & 2) !== 0) v = -v;
        corners.push(u + v);
      }
    }
  }
  const planes: number[] = [];
  for (let z = 0; z < 2; z++) {
    const offset = z * 4;
    planes.push(
      mix(
        mix(corners[offset], corners[offset + 1], weights[0]),
        mix(corners[offset + 2], corners[offset + 3], weights[0]),
        weights[1],
      ),
    );
  }
  return mix(planes[0], planes[1], weights[2]);
}
function fbm(p: number[], dimension: number) {
  let sum = 0, total = 0;
  for (let octave = 0; octave < 6; octave++) {
    const point = p.map((v) => Math.fround(v * 2 ** octave));
    if (dimension === 2) point[2] = 0.5;
    sum += perlin(point, (0xdeadbeef + octave * 101) >>> 0) * 2 ** -octave;
    total += 2 ** -octave;
  }
  return sum / total;
}
Deno.test("[stress] seeded noise matches independent lattice interpolation across negative boundaries", () => {
  for (let i = 0; i < 128; i++) {
    let p = vector().map(Math.fround);
    if (i < 16) p = [-3 + i * 0.5, -2, 1];
    const actual = call("noises", [...p, 4294967040, 16777216]);
    const x = Math.floor(p[0]), y = Math.floor(p[1]);
    const u = fade(p[0] - x), v = fade(p[1] - y);
    const value = (x: number, y: number) =>
      (hash(x, y, 0, 0xdeadbeef) >>> 8) / 16777216 * 2 - 1;
    near(actual, [
      perlin([p[0], 0.5, 0.5], 0xdeadbeef),
      perlin([p[0], p[1], 0.5], 0xdeadbeef),
      perlin(p, 0xdeadbeef),
      mix(
        mix(value(x, y), value(x + 1, y), u),
        mix(value(x, y + 1), value(x + 1, y + 1), u),
        v,
      ),
      fbm(p, 2),
      fbm(p, 3),
      0,
      0,
      (hash(4294967040, 16777216, 0, 0xdeadbeef) >>> 8) / 16777216,
    ], 2e-6);
    assert(actual.slice(0, 6).every((x) => Math.abs(x) <= 1.5));
    assertEquals(actual, call("noises", [...p, 4294967040, 16777216]));
    const left = call("noises", [-2 - 1e-4, p[1], p[2], 0, 0]);
    const right = call("noises", [-2 + 1e-4, p[1], p[2], 0, 0]);
    near(left.slice(0, 6), right.slice(0, 6), 0.003);
  }
});

Deno.test("[stress] arbitrary axis rotations retain scale invariance and parallel look directions", () => {
  for (const direction of [[1, -2, 3], [0, 1, 0], [0, -1, 0]]) {
    const baseline = call("rotations", [...direction, 1.3, ...direction]);
    for (const scale of [1e-30, 1e-23, 1e-22, 1e-20, 1e-10, 1, 1e10, 1e30]) {
      const result = call("rotations", [
        ...direction.map((v) => v * scale),
        1.3,
        ...direction,
      ]);
      near(result.slice(0, 4), baseline.slice(0, 4), 2e-6);
      near(
        [Math.hypot(...result.slice(0, 4)), Math.hypot(...result.slice(4))],
        [1, 1],
        2e-6,
      );
      const [x, y, z, w] = result.slice(4);
      near(
        [-2 * (x * z + y * w), -2 * (y * z - x * w), -1 + 2 * (x * x + y * y)],
        normalized(direction),
        2e-6,
      );
    }
  }
});

Deno.test("[stress] quaternion normalization retains unit length through subnormal squared magnitudes", () => {
  for (const scale of [1e-30, 1e-23, 1e-22, 1e-20, 1e-10, 1, 1e10, 1e30]) {
    const q = [scale, -2 * scale, 3 * scale, 4 * scale].map(Math.fround);
    const result = call("normalize_quaternion", q);
    near(result, normalized(q), 2e-6);
    assertAlmostEquals(Math.hypot(...result), 1, 2e-6);
  }
});

Deno.test("[stress] damped springs compose time steps, dissipate energy and settle after 240 updates", () => {
  for (const damping of [0, 0.001, 0.25, 0.999, 1, 1.001, 2, 20]) {
    const initial = [3, -2],
      target = 1,
      frequency = 6,
      dt = Math.fround(1 / 60);
    const direct = call("spring", [
      ...initial,
      target,
      frequency,
      damping,
      Math.fround(dt * 240),
    ]);
    let state = initial,
      previousEnergy = (state[0] - target) ** 2 * frequency ** 2 +
        state[1] ** 2;
    for (let i = 0; i < 240; i++) {
      state = call("spring", [...state, target, frequency, damping, dt]);
      assertEquals(state.length, 2);
      const energy = (state[0] - target) ** 2 * frequency ** 2 + state[1] ** 2;
      assert(
        energy <= previousEnergy + 0.0001,
        `energy increased at damping ${damping}`,
      );
      previousEnergy = energy;
    }
    near(state, direct, 0.0005);
    if (damping >= 0.999 && damping < 3) near(state, [target, 0], 0.01);
    if (damping === 0) assertAlmostEquals(previousEnergy, 148, 0.003);
  }
});

Deno.test("[stress] 8192 variable frames conserve fixed-step seconds and timers expire once", () => {
  const step = Math.fround(1 / 60);
  let remainder = 0, timer = 2.5, transitions = 0, elapsed = 0, consumed = 0;
  for (let i = 0; i < 8192; i++) {
    let dt = Math.fround((i % 7 + 1) / 240);
    if (i % 997 === 0) dt = 0.5;
    const result = call("fixed", [step, remainder, dt]);
    assertEquals(result.length, 4);
    assert(result[0] >= 0 && result[0] <= 8 && result[2] >= 0 && result[2] < 1);
    assertAlmostEquals(
      remainder + dt,
      result[0] * step + result[1] + result[3],
      1e-7,
    );
    elapsed += dt;
    consumed += result[0] * step + result[3];
    remainder = result[1];
    const tick = call("timer", [timer, dt]);
    transitions += tick[1];
    timer = tick[0];
  }
  assertAlmostEquals(elapsed, consumed + remainder, 0.0001);
  assertEquals(transitions, 1);
  assertEquals(timer, 0);
});

Deno.test("[stress] rotated affine compositions and four camera conventions round-trip", () => {
  for (let i = 0; i < 64; i++) {
    const scale = () => [between(0.2, 3), between(-3, -0.2), between(0.2, 3)];
    const p = vector().map(Math.fround);
    const affine = call("affine", [
      ...vector(),
      between(-3, 3),
      between(-1.5, 1.5),
      ...scale(),
      ...vector(),
      between(-3, 3),
      between(-1.5, 1.5),
      ...scale(),
      ...p,
    ]);
    near(affine.slice(0, 3), affine.slice(3, 6), 0.00003);
    near(affine.slice(6), p, 0.00005);
    for (const ortho of [0, 1]) {
      for (const reversed of [0, 1]) {
        const local = [
          between(-0.1, 0.1),
          between(-0.1, 0.1),
          between(-40, -1),
        ];
        const result = call("lens", [
          between(0.5, 2),
          between(0.5, 3),
          0.1,
          100,
          reversed,
          ortho,
          ...vector(),
          between(-3, 3),
          between(-1.5, 1.5),
          ...local,
        ]);
        assertEquals(result.length, 19);
        near(result.slice(0, 3), result.slice(3, 6), 0.005);
        near(
          [Math.hypot(...result.slice(6, 9)), ...result.slice(13)],
          Array(7).fill(1),
          1e-6,
        );
        assertEquals(result[9], 1);
      }
    }
    const corners = call("cascade", [
      ...vector(),
      ...vector(),
      between(0.01, 10),
      between(0.01, 10),
      between(0.01, 10),
      2 + i * 16,
      between(0, 5),
    ]);
    assertEquals(corners.length, 24);
    for (let j = 0; j < 24; j += 3) {
      assert(
        Math.abs(corners[j]) <= 1.000001 &&
          Math.abs(corners[j + 1]) <= 1.000001,
      );
      assert(corners[j + 2] >= -1e-6 && corners[j + 2] <= 1.000001);
    }
  }
});

Deno.test("[stress] HDR transfers, constant sky quadrature and local-light falloff retain finite bounds", () => {
  for (let i = 0; i < 96; i++) {
    const c = [between(-0.1, 8), between(-0.1, 8), between(-0.1, 8), random()]
      .map(Math.fround);
    const exponent = Math.fround(between(-126, 126));
    const value = Math.fround(2 ** between(-125, 125));
    const display = call("display", [...c, between(-10, 10), exponent, value]);
    near(display.slice(0, 4), c, 0.00004);
    assert(display.slice(4, 7).every((x) => x >= 0 && x <= 1.000001));
    assertEquals(display[7], c[3]);
    assertAlmostEquals(display[8] / 2 ** exponent, 1, 0.00002);
    assertAlmostEquals(display[9], Math.log2(value), 0.00002);
    const radiance = [random(), random(), random()].map(Math.fround);
    near(
      call("irradiance", [...radiance, ...vector()]),
      radiance.map((x) => x * Math.PI),
      0.00001,
    );
    const p = vector().map(Math.fround),
      distance = Math.hypot(...p),
      range = Math.fround(between(1, 10));
    const light = call("local_light", [...p, ...radiance, range]);
    let attenuation = 0;
    if (distance < range) {
      attenuation = (1 - (distance / range) ** 4) ** 2 /
        Math.max(distance ** 2, 0.0001);
    }
    near(light.slice(3), radiance.map((x) => x * attenuation), 0.000002);
  }
});

Deno.test("[stress] audio matches independent pan, distance, Doppler and envelope arithmetic", () => {
  for (let i = 0; i < 128; i++) {
    const p = vector().map(Math.fround),
      listener = vector().map((v) => Math.fround(v * 100)),
      emitter = vector().map((v) => Math.fround(v * 100));
    const gain = Math.fround(between(0, 4));
    const direction = normalized(p),
      distance = Math.hypot(...p),
      blocked = i % 2;
    const result = call("sound", [
      ...p,
      ...listener,
      ...emitter,
      gain,
      blocked,
      2,
      0.5,
      -0.2,
      0.8,
    ]);
    let expectedGain = gain * Math.max(0, Math.min(1, (100 - distance) / 99)) /
      (1 + Math.max(0, distance - 1));
    let cutoff = 20000;
    if (blocked) {
      expectedGain *= 0.25;
      cutoff = 1200;
    }
    const rate = Math.max(
      0.5,
      Math.min(
        2,
        Math.max(34.3, 343 + dot(listener, direction)) /
          Math.max(34.3, 343 + dot(emitter, direction)),
      ),
    );
    near(result, [expectedGain, direction[0], rate, cutoff, 0.05], 2e-6);
  }
});

Deno.test("[stress] root motion unwraps signed loops and events preserve exact temporal order", () => {
  for (const previous of [-8, -1.75, -0.25, 0, 0.25, 1.75]) {
    for (const delta of [-4, -0.5, 0, 0.5, 4, 31]) {
      const current = previous + delta;
      const result = call("root", [previous, current]);
      assertAlmostEquals(result[0], delta * 10, 1e-5);
      near([result[1], result[3]], [0, 0]);
      assertAlmostEquals(Math.hypot(...result.slice(1, 5)), 1, 1e-6);
      // Integer phase boundaries have an independently known one-radian loop.
      if (Number.isInteger(previous) && Number.isInteger(current)) {
        assertAlmostEquals(
          Math.abs(
            result[2] * Math.sin(delta / 2) + result[4] * Math.cos(delta / 2),
          ),
          1,
          2e-6,
        );
      }
      const expected: number[] = [];
      for (
        let cycle = Math.floor(previous);
        cycle <= Math.floor(current);
        cycle++
      ) {
        for (const [phase, id] of [[0, 7], [0.25, 9], [0.75, 13]]) {
          if (cycle + phase > previous && cycle + phase <= current) {
            expected.push(id);
          }
        }
      }
      assertEquals(result.slice(5), expected);
      assertEquals(result, call("root", [previous, current]));
    }
  }
});

Deno.test("[stress] 240 ballistic and steering updates stay bounded and reproducible", () => {
  function trajectory() {
    const dt = Math.fround(1 / 120),
      acceleration = [0, -9.8, 0].map(Math.fround);
    let state = [1, 2, 3, 4, 5, -2, 0],
      position = [1, 2, 3],
      velocity = [4, 5, -2];
    for (let i = 0; i < 240; i++) {
      state = call("ballistic", [...state.slice(0, 7), ...acceleration, dt]);
      assert(state[7] >= 0 && state[7] < 13);
      const chase = call("chase", [
        ...position,
        ...velocity,
        0,
        0,
        0,
        5,
        3,
        0.05,
        0.2,
        10,
      ]);
      assert(Math.hypot(...chase.slice(0, 3)) <= 5.000001);
      assert(Math.hypot(...chase.slice(3, 6)) <= 10.000002);
      near(chase.slice(6), [0, -2, 0], 1e-5);
      velocity = velocity.map((v, j) => Math.fround(v + chase[j + 3] * dt));
      position = position.map((p, j) => Math.fround(p + velocity[j] * dt));
    }
    const elapsed = dt * 240;
    near(state.slice(0, 3), [
      1 + 4 * elapsed,
      2 + 5 * elapsed + 0.5 * acceleration[1] * elapsed ** 2,
      3 - 2 * elapsed,
    ], 0.00003);
    near(state.slice(3, 6), [4, 5 + acceleration[1] * elapsed, -2], 0.00004);
    assert(Math.hypot(...position) < 0.5);
    return [...state, ...position, ...velocity];
  }
  assertEquals(trajectory(), trajectory());
});

Deno.test("[stress] 16384 animation crossings keep exact order and bounded reusable guest memory", async () => {
  const probe = await compile(
    new URL("./numeric-stress.blot", import.meta.url),
  );
  try {
    const args = new Float32Array([0, 32, 1]);
    const expected = Array.from(
      { length: 16384 },
      (_, i) => 2147483648 + (i + 1) % 512,
    );
    const before = probe.guest.memoryBytes();
    assertEquals(
      Array.from(probe.guest.call("event_workload", args) as Uint32Array),
      expected,
    );
    const warmed = probe.guest.memoryBytes();
    assert(
      warmed <= 1024 * 1024,
      `event output committed ${warmed} bytes from ${before} initial bytes`,
    );
    for (let replay = 0; replay < 4; replay++) {
      assertEquals(
        Array.from(probe.guest.call("event_workload", args) as Uint32Array),
        expected,
      );
      assertEquals(probe.guest.memoryBytes(), warmed);
    }
  } finally {
    await probe.dispose();
  }
});

Deno.test("[stress] counted event output preserves rounded endpoints and duplicate crossing times", () => {
  for (
    const row of [
      [-32, 0, 1, 1],
      [-16777216, -16777184, 1, 1],
      [16777184, 16777216, 1, 1],
      [0.1, 0.4, 0, 1],
      [-0.31, 0.91, 1, 0.3],
    ]
  ) {
    const [previous, current, looping, duration] = row.map(Math.fround);
    const expected: number[] = [];
    let first = 0, final = 0;
    if (looping) {
      first = Math.floor(Math.fround(previous / duration));
      final = Math.floor(Math.fround(current / duration));
    }
    for (let cycle = first; cycle <= final; cycle++) {
      for (let event = 0; event < 512; event++) {
        const phase = Math.fround(event / 512 * duration);
        let time = phase;
        if (looping) time = Math.fround(Math.fround(cycle * duration) + phase);
        if (time > previous && time <= current) {
          expected.push(2147483648 + event);
        }
      }
    }
    assertEquals(
      Array.from(
        fixture.guest.call(
          "event_workload",
          new Float32Array(row),
        ) as Uint32Array,
      ),
      expected,
    );
  }
});
Deno.test.afterAll(() => fixture.dispose());

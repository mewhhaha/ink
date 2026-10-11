import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const start = performance.now();
const fixture = await compile(new URL("./game_modules.blot", import.meta.url));
const compileMs = performance.now() - start;
function call(name: string, values: number[]) {
  return Array.from(
    fixture.guest.call(name, new Float32Array(values)) as Float32Array,
  );
}
function near(a: number[], b: number[], tolerance = 2e-5) {
  assertEquals(a.length, b.length);
  for (let i = 0; i < a.length; i++) assertAlmostEquals(a[i], b[i], tolerance);
}
function rotate(v: number[], yaw: number, pitch: number) {
  const [x, y, z] = v;
  const py = y * Math.cos(pitch) - z * Math.sin(pitch);
  const pz = y * Math.sin(pitch) + z * Math.cos(pitch);
  return [
    x * Math.cos(yaw) + pz * Math.sin(yaw),
    py,
    -x * Math.sin(yaw) + pz * Math.cos(yaw),
  ];
}
Deno.test("camera projection, matrix, picking, round trips and both depth conventions", () => {
  for (const orthographic of [0, 1]) {
    for (const reversed of [0, 1]) {
      const height = 1.3, aspect = 1.7, n = 0.2, f = 200;
      for (const local of [[0, 0, -n], [0.5, -0.4, -4], [0, 0, -f]]) {
        const position = [3, -2, 7], yaw = 0.6, pitch = -0.3;
        const world = rotate(local, yaw, pitch).map((v, i) => v + position[i]);
        const r = call("camera_probe", [
          height,
          aspect,
          n,
          f,
          reversed,
          orthographic,
          ...position,
          yaw,
          pitch,
          ...world,
          0,
        ]);
        let sy = 1 / Math.tan(height / 2), w = -local[2];
        let a = f / (n - f), b = n * a;
        if (orthographic) {
          sy = 2 / height;
          w = 1;
          a = 1 / (n - f);
          b = n * a;
        }
        let depth = (a * local[2] + b) / w;
        if (reversed) depth = 1 - depth;
        near(r.slice(0, 3), [
          local[0] * sy / aspect / w,
          local[1] * sy / w,
          depth,
        ]);
        // Standard forward depth loses precision at the far plane in F32.
        near(r.slice(3, 6), world, 0.04);
        const matrix = r.slice(13);
        const clip = [0, 0, 0, 0];
        for (let row = 0; row < 4; row++) {
          for (let col = 0; col < 4; col++) {
            clip[row] += matrix[col * 4 + row] * [...world, 1][col];
          }
        }
        near(clip.slice(0, 3).map((v) => v / clip[3]), r.slice(0, 3));
        let direction = [0, 0, -1];
        if (!orthographic) {
          direction = local.map((v) => v / Math.hypot(...local));
        }
        near(r.slice(9, 12), rotate(direction, yaw, pitch));
      }
    }
  }
});
Deno.test("frustum keeps intersecting spheres and rejects each outside plane", () => {
  const args = [Math.PI / 2, 1, 1, 10, 0, 0, 0, 0, 0, 0, 0];
  for (
    const [p, radius, expected] of [
      [[0, 0, -5], 0, 1],
      [[0, 0, 1], 0.5, 0],
      [[0, 0, -11], 0.5, 0],
      [[7, 0, -5], 0.5, 0],
      [[-7, 0, -5], 0.5, 0],
      [[0, 7, -5], 0.5, 0],
      [[0, -7, -5], 0.5, 0],
      [[5.3, 0, -5], 0.5, 1],
    ] as [number[], number, number][]
  ) assertEquals(call("camera_probe", [...args, ...p, radius])[12], expected);
});
function referenceSpring(
  x: number,
  v: number,
  target: number,
  w: number,
  z: number,
  dt: number,
) {
  x -= target;
  if (w === 0) return [target + x + v * dt, v];
  if (z === 1) {
    const b = v + w * x, e = Math.exp(-w * dt);
    return [target + (x + b * dt) * e, (v - w * b * dt) * e];
  }
  if (z < 1) {
    const a = z * w,
      b = w * Math.sqrt(1 - z * z),
      e = Math.exp(-a * dt),
      sn = Math.sin(b * dt),
      cs = Math.cos(b * dt);
    return [
      target + e * (x * cs + (v + a * x) * sn / b),
      e * (v * cs - (a * v + w * w * x) * sn / b),
    ];
  }
  const root = Math.sqrt(z * z - 1),
    r1 = -w / (z + root),
    r2 = -w * (z + root),
    c1 = (v - r2 * x) / (r1 - r2),
    c2 = x - c1;
  return [
    target + c1 * Math.exp(r1 * dt) + c2 * Math.exp(r2 * dt),
    r1 * c1 * Math.exp(r1 * dt) + r2 * c2 * Math.exp(r2 * dt),
  ];
}
Deno.test("analytic springs match host reference and timestep composition in all regimes", () => {
  for (const damping of [0, 0.3, 0.99, 1, 1.01, 2, 10]) {
    for (const dt of [0.001, 0.2, 2]) {
      const full = call("spring_probe", [3, -2, 1, 5, damping, dt, 0.3]);
      near(full.slice(0, 2), referenceSpring(3, -2, 1, 5, damping, dt), 8e-5);
      const half = call("spring_probe", [3, -2, 1, 5, damping, dt / 2, 0.3]);
      near(
        call("spring_probe", [...half.slice(0, 2), 1, 5, damping, dt / 2, 0.3])
          .slice(0, 2),
        full.slice(0, 2),
        5e-5,
      );
      near(full.slice(2, 8), [0.468, 0.216, 0.48, 1.26, 0.216, 0.16308]);
      near(
        full.slice(8),
        Array(2).fill(referenceSpring(0, 1, 0, 5, damping, dt)[0]),
      );
    }
  }
});
Deno.test("particles are seeded, ballistic, stable, immutable and expire", () => {
  const r = call("particle_probe", [123, 20, 0.5]);
  assertEquals(call("particle_probe", [123, 20, 0.5]), r);
  assertEquals(r[0], 20);
  near(r.slice(1, 4), [r[10] * 0.5, r[11] * 0.5 - 9 * 0.125, r[12] * 0.5]);
  near(r.slice(4, 7), [r[10], r[11] - 4.5, r[12]]);
  assertEquals(r[7], 0.5);
  assertEquals(r[13], 0);
  assert(r[8] >= 2.5 && r[8] < 3.5);
  assertEquals(call("particle_probe", [123, 20, 4]), [0]);
  assert(call("particle_probe", [124, 20, 0.5])[1] !== r[1]);
});
Deno.test("skeletal samples, masked blend, loop root motion and ordered event crossings", () => {
  let r = call("animation_probe", [0.8, 2.2, 1]);
  near(r.slice(0, 3), [2, 1, 2]);
  assertAlmostEquals(r[3], 1 + 2 * Math.cos(0.1), 0.002);
  const angleAt = (t: number) =>
    Math.atan2(t * Math.sin(0.5), 1 - t + t * Math.cos(0.5));
  const rootHalfAngle = 1 + angleAt(0.2) - angleAt(0.8);
  near(r.slice(4, 8), [
    14,
    1,
    Math.sin(rootHalfAngle),
    Math.cos(rootHalfAngle),
  ]);
  assertEquals(r.slice(8), [7, 9, 7]);
  r = call("animation_probe", [-0.2, 0, 1]);
  assertEquals(r.slice(8), [7]);
  assertAlmostEquals(r[4], 2, 1e-5);
  r = call("animation_probe", [0, 0.5, 0]);
  assertEquals(r.slice(8), [9]);
  r = call("animation_probe", [2.2, 0.8, 1]);
  assertAlmostEquals(r[4], -14, 1e-5);
  assertEquals(r.slice(8), []);
});
Deno.test("placement spacing survives adjacent chunk seams and generation order", () => {
  function points(x: number, z: number, w: number, d: number, seed = 123) {
    const flat = call("placement_probe", [seed, 1, 1.2, x, z, w, d]);
    const p: number[][] = [];
    for (let i = 0; i < flat.length; i += 2) p.push(flat.slice(i, i + 2));
    return p;
  }
  const full = points(-4, -3, 8, 6);
  const chunks = [...points(0, -3, 4, 6), ...points(-4, -3, 4, 6)];
  const ordered = (p: number[][]) => p.map((v) => JSON.stringify(v)).sort();
  assertEquals(ordered(chunks), ordered(full));
  assertEquals(points(-4, -3, 8, 6), full);
  function candidate(x: number, z: number) {
    const priority = randomNext(
      Math.imul(
        randomNext(
          (Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ 123 ^
            2246822519) >>> 0,
        ),
        3266489917,
      ) >>> 0,
    );
    const a = randomNext(priority), b = randomNext(a);
    return {
      x,
      z,
      priority,
      point: [
        Math.fround(x + (a >>> 8) / 16777216),
        Math.fround(z + (b >>> 8) / 16777216),
      ],
    };
  }
  const reference: number[][] = [];
  for (let z = -3; z < 3; z++) {
    for (let x = -4; x < 4; x++) {
      const c = candidate(x, z);
      let accepted = true;
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (dx === 0 && dz === 0) continue;
          const other = candidate(x + dx, z + dz);
          if (
            other.priority < c.priority &&
            Math.hypot(
                other.point[0] - c.point[0],
                other.point[1] - c.point[1],
              ) < 1.2
          ) accepted = false;
        }
      }
      if (accepted) reference.push(c.point);
    }
  }
  assertEquals(full, reference);
  assert(full.length > 5);
  for (let i = 0; i < full.length; i++) {
    for (let j = i + 1; j < full.length; j++) {
      assert(
        Math.hypot(full[i][0] - full[j][0], full[i][1] - full[j][1]) >=
          1.2 - 1e-6,
      );
    }
  }
  assert(JSON.stringify(points(-4, -3, 8, 6, 124)) !== JSON.stringify(full));
});
Deno.test("debug boxes, capsules and GPU vertices have meaningful geometry", () => {
  assertEquals(call("debug_probe", [0]), [12, 52, 168, 1, 0.5, 0, 1]);
});
Deno.test("[stress] 10k culling/particles and 100-bone workload stays bounded", () => {
  const before = performance.now();
  const r = call("workload", [10000]);
  assert(r[0] > 4000 && r[0] < 10000);
  assertEquals(r[1], 10000);
  const expected = Array.from({ length: 100 }, (_, i) => Math.cos(i * 0.1))
    .reduce((sum, value) => sum + value, 0);
  assertAlmostEquals(r[2], expected, 0.0002);
  console.log(
    `game modules compile ${
      compileMs.toFixed(1)
    } ms; 10k cull + particles + 100 bones ${
      (performance.now() - before).toFixed(2)
    } ms`,
  );
});
function randomNext(state: number) {
  if (state === 0) state = 2654435769;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}
Deno.test("full-width seeds preserve emission partitioning", () => {
  for (const seed of [0, 123, 0x80000001, 0xffffffff]) {
    const values = fixture.guest.call("seed_probe", seed) as Uint32Array;
    let expected = seed;
    for (let i = 0; i < 15; i++) expected = randomNext(expected);
    assertEquals(values[0], expected);
    assertEquals(values[0], values[1]);
    assertEquals(values[2], values[3]);
    assertEquals(values[4], values[5]);
  }
});
Deno.test("AABB intersection, free springs and sprite edge cases", () => {
  assertEquals(call("edge_probe", [0]), [1, 4, 2, 3, 7, 0]);
});
Deno.test("debug rays, contact normals, closed paths and offset terrain", () => {
  assertEquals(call("geometry_probe", [0]), [
    3,
    4,
    3,
    3,
    4.5,
    5,
    3,
    12,
    8,
    2,
    18,
    12,
    2,
    22,
  ]);
});
Deno.test("billboard quaternion, nonuniform size, in-plane rotation and atlas UVs", () => {
  for (const yaw of [0, 0.7]) {
    for (const pitch of [0, -0.3]) {
      for (const spin of [0, Math.PI / 2, -0.4]) {
        const r = call("billboard_probe", [
          3,
          4,
          5,
          2,
          4,
          yaw,
          pitch,
          spin,
          7,
          4,
          2,
        ]);
        const expected: number[] = [];
        for (const [x, y] of [[-1, -2], [1, -2], [1, 2], [-1, 2]]) {
          const local = [
            x * Math.cos(spin) - y * Math.sin(spin),
            x * Math.sin(spin) + y * Math.cos(spin),
            0,
          ];
          expected.push(
            ...rotate(local, yaw, pitch).map((v, i) => v + [3, 4, 5][i]),
          );
        }
        near(r.slice(0, 12), expected);
        near(r.slice(12), [0.75, 1, 1, 1, 1, 0.5, 0.75, 0.5]);
      }
    }
  }
  const base = [0, 0, 0, 1, 1, 0, 0, 0];
  assertEquals(call("billboard_probe", [...base, 0, 0, 2]).length, 12);
  near(
    call("billboard_probe", [...base, 15, 4, 2]).slice(12),
    call("billboard_probe", [...base, 7, 4, 2]).slice(12),
  );
});
Deno.test("sprite triangle streams preserve winding, frames, tint and stable particle order", () => {
  const values = call("sprite_probe", [0.25, 0, 0, 0, 1]);
  assertEquals(values.length, 108);
  const expectedCorners = [[0, 1, 3], [2, 1, 3], [2, 3, 3], [0, 3, 3]];
  const expectedUV = [[0.5, 1], [0.75, 1], [0.75, 0.5], [0.5, 0.5]];
  const indices = [0, 1, 2, 0, 2, 3];
  for (let i = 0; i < 6; i++) {
    near(values.slice(i * 9, (i + 1) * 9), [
      ...expectedCorners[indices[i]],
      ...expectedUV[indices[i]],
      0.2,
      0.4,
      0.6,
      0.8,
    ]);
  }
  // Triangle cross product points to +Z, toward an identity camera.
  const p = values.slice(0, 3),
    q = values.slice(9, 12),
    r = values.slice(18, 21);
  assert((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]) > 0);
  near(values.slice(54, 57), [-1.5, -0.5, 2]);
  const held = call("sprite_probe", [2, Math.PI / 2, 0.4, -0.2, 0]);
  near(held.slice(3, 5), [0.75, 1]);
  for (let i = 0; i < 6; i++) {
    const [x, y] = [[-1, -1], [1, -1], [1, 1], [-1, 1]][indices[i]];
    const expected = rotate([-y, x, 0], 0.4, -0.2).map((v, j) =>
      v + [1, 2, 3][j]
    );
    near(held.slice(i * 9, i * 9 + 3), expected);
  }

  const count = fixture.guest.call("sprite_workload", 10000);
  assertEquals(count, 540000);
});
Deno.test.afterAll(async () => await fixture.dispose());

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./transform.blot", import.meta.url));
const { guest } = fixture;
const identity2 = [0, 0, 1, 0, 0, 1];
const identity3 = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

function call(name: string, values: number[]) {
  return Array.from(guest.call(name, new Float32Array(values)) as Float32Array);
}

function near(actual: number[], expected: number[], tolerance = 1e-5) {
  assertEquals(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    assertAlmostEquals(actual[index], expected[index], tolerance);
  }
}

function vector(basis: number[], v: number[], dimensions: number) {
  return Array.from({ length: dimensions }, (_, row) => {
    let sum = 0;
    for (let column = 0; column < dimensions; column++) {
      sum += basis[dimensions + column * dimensions + row] * v[column];
    }
    return sum;
  });
}

function point(basis: number[], p: number[], dimensions: number) {
  return vector(basis, p, dimensions).map((value, row) => value + basis[row]);
}

function compose(parent: number[], child: number[], dimensions: number) {
  const result = point(parent, child.slice(0, dimensions), dimensions);
  for (let column = 0; column < dimensions; column++) {
    const start = dimensions + column * dimensions;
    result.push(
      ...vector(parent, child.slice(start, start + dimensions), dimensions),
    );
  }
  return result;
}

function pose2(values: number[]) {
  const [x, y, angle, sx, sy] = values;
  const c = Math.cos(angle), s = Math.sin(angle);
  return [x, y, c * sx, s * sx, -s * sy, c * sy];
}

function pose3(values: number[]) {
  const [px, py, pz, x, y, z, w, sx, sy, sz] = values;
  return [
    px,
    py,
    pz,
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
  ];
}

Deno.test("affine identities preserve points and vectors", () => {
  near(call("identity", [0]), [...identity2, ...identity3]);
  near(call("affine2", [...identity2, ...identity2, 3, -4]).slice(6, 10), [
    3,
    -4,
    3,
    -4,
  ]);
  near(call("affine3", [...identity3, ...identity3, 3, -4, 5]).slice(12, 18), [
    3,
    -4,
    5,
    3,
    -4,
    5,
  ]);
});

Deno.test("2D rotated nonuniform parents retain the composed shear", () => {
  const parentPose = [10, 20, Math.PI / 2, 2, 3];
  const childPose = [1, 2, Math.PI / 4, 4, 1];
  const parent = call("interpolate2", [...parentPose, ...parentPose, 0]).slice(
    5,
  );
  const child = call("interpolate2", [...childPose, ...childPose, 0]).slice(5);
  near(parent, pose2(parentPose));
  near(child, pose2(childPose));
  const p = [2, -3];
  const result = call("affine2", [...parent, ...child, ...p]);
  near(result.slice(0, 6), compose(pose2(parentPose), pose2(childPose), 2));
  near(result.slice(6, 8), point(parent, point(child, p, 2), 2));
  near(result.slice(8, 10), vector(parent, vector(child, p, 2), 2));
  assertEquals(
    Math.abs(result[2] * result[4] + result[3] * result[5]) > 1,
    true,
  );
  assertEquals(result[10], 1);
  near(point(result.slice(11), result.slice(6, 8), 2), p);
});

Deno.test("3D rotated nonuniform parents retain the composed shear", () => {
  const half = Math.SQRT1_2;
  const parentPose = [10, -3, 7, 0, 0, half, half, 2, 3, 4];
  const childPose = [
    1,
    2,
    -1,
    0,
    Math.sin(Math.PI / 8),
    0,
    Math.cos(Math.PI / 8),
    1,
    2,
    3,
  ];
  const parent = call("interpolate3", [...parentPose, ...parentPose, 0]).slice(
    10,
  );
  const child = call("interpolate3", [...childPose, ...childPose, 0]).slice(10);
  near(parent, pose3(parentPose));
  near(child, pose3(childPose));
  const p = [2, -3, 4];
  const result = call("affine3", [...parent, ...child, ...p]);
  near(
    result.slice(0, 12),
    compose(pose3(parentPose), pose3(childPose), 3),
    2e-5,
  );
  near(result.slice(12, 15), point(parent, point(child, p, 3), 3), 2e-5);
  near(result.slice(15, 18), vector(parent, vector(child, p, 3), 3), 2e-5);
  let shear = 0;
  for (let row = 0; row < 3; row++) shear += result[3 + row] * result[9 + row];
  assertEquals(Math.abs(shear) > 1, true);
  assertEquals(result[18], 1);
  near(point(result.slice(19), result.slice(12, 15), 3), p, 2e-5);
});

Deno.test("inverse round trips affine bases with shear, reflection and tiny scales", () => {
  for (let index = 0; index < 40; index++) {
    const a = index / 13;
    const basis2 = [a, -a, 2 + a, 0.25, 0.75, -3 - a];
    const p2 = [3 - a, a + 2];
    const r2 = call("affine2", [...basis2, ...identity2, ...p2]);
    assertEquals(r2[10], 1);
    near(point(r2.slice(11), r2.slice(6, 8), 2), p2, 1e-5);
    near(compose(basis2, r2.slice(11), 2), identity2, 1e-5);
    const basis3 = [
      a,
      -a,
      a * 2,
      3 + a,
      0.25,
      0.5,
      1,
      -4 - a,
      0.75,
      -0.5,
      0.25,
      2 + a,
    ];
    const p3 = [2, a - 1, 3 + a];
    const r3 = call("affine3", [...basis3, ...identity3, ...p3]);
    assertEquals(r3[18], 1);
    near(point(r3.slice(19), r3.slice(12, 15), 3), p3, 1e-5);
    near(compose(basis3, r3.slice(19), 3), identity3, 1e-5);
  }
  assertEquals(
    call("affine2", [0, 0, 1e-6, 0, 0, 1e-6, ...identity2, 1, 2])[10],
    1,
  );
  assertEquals(
    call("affine3", [
      0,
      0,
      0,
      1e-6,
      0,
      0,
      0,
      1e-6,
      0,
      0,
      0,
      1e-6,
      ...identity3,
      1,
      2,
      3,
    ])[18],
    1,
  );
});

Deno.test("singular and non-finite bases have no inverse", () => {
  for (
    const basis of [[0, 0, 1, 2, 2, 4], [0, 0, 0, 0, 0, 1], [
      0,
      0,
      Infinity,
      0,
      0,
      1,
    ]]
  ) {
    assertEquals(call("affine2", [...basis, ...identity2, 1, 2])[10], 0);
  }
  for (
    const basis of [
      [0, 0, 0, 1, 2, 3, 2, 4, 6, 0, 0, 1],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
      [0, 0, 0, NaN, 0, 0, 0, 1, 0, 0, 0, 1],
    ]
  ) assertEquals(call("affine3", [...basis, ...identity3, 1, 2, 3])[18], 0);
});

Deno.test("translation changes points while directions keep their magnitude and sign", () => {
  const r2 = call("affine2", [10, -20, -2, 0, 0, 3, ...identity2, 1, 2]);
  near(r2.slice(6, 10), [8, -14, -2, 6]);
  const r3 = call("affine3", [
    10,
    -20,
    30,
    -2,
    0,
    0,
    0,
    3,
    0,
    0,
    0,
    4,
    ...identity3,
    1,
    2,
    -3,
  ]);
  near(r3.slice(12, 18), [8, -14, 18, -2, 6, -12]);
});

Deno.test("2D pose interpolation takes the short angle arc and preserves endpoint geometry", () => {
  const a = [1, 2, 170 * Math.PI / 180, 2, 3];
  const b = [5, -2, -170 * Math.PI / 180, 4, 1];
  near(call("interpolate2", [...a, ...b, 0]).slice(5), pose2(a));
  near(call("interpolate2", [...a, ...b, 1]).slice(5), pose2(b));
  const middle = call("interpolate2", [...a, ...b, 0.5]);
  near(middle.slice(0, 5), [3, 0, Math.PI, 3, 2]);
  near(middle.slice(5), [3, 0, -3, 0, 0, -2]);
});

Deno.test("3D pose interpolation preserves endpoints and handles antipodal quaternions", () => {
  const a = [1, 2, 3, 0, 0, 0, 1, 2, 3, 4];
  const b = [5, -2, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 4, 1, 2];
  near(call("interpolate3", [...a, ...b, 0]).slice(10), pose3(a));
  near(call("interpolate3", [...a, ...b, 1]).slice(10), pose3(b));
  const middle = call("interpolate3", [...a, ...b, 0.5]);
  near(middle.slice(0, 3), [3, 0, 2]);
  near(middle.slice(7, 10), [3, 2, 3]);
  near(middle.slice(3, 7), [
    0,
    Math.sin(Math.PI / 8),
    0,
    Math.cos(Math.PI / 8),
  ]);
  const opposite = b.slice();
  for (let index = 3; index < 7; index++) opposite[index] *= -1;
  for (const weight of [0, 0.25, 0.5, 0.75, 1]) {
    near(call("interpolate3", [...b, ...opposite, weight]).slice(10), pose3(b));
  }
});

Deno.test.afterAll(() => fixture.dispose());

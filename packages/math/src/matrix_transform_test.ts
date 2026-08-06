import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  mat3,
  mat3_inverse,
  mat4,
  mat4_identity,
  mat4_inverse,
  mat4_multiply,
  mat4_transform_affine_point,
  mat4_transform_direction,
  mat4_transform_normal,
} from "./matrix.ts";
import {
  quat_from_axis_angle,
  quat_identity,
  quat_rotate_vec3,
  quat_slerp,
} from "./quaternion.ts";
import {
  mat4_decompose,
  transform,
  transform_compose,
  transform_inverse,
  transform_to_mat4,
} from "./transform.ts";
import { vec3 } from "./vector.ts";

function assert_matrix_almost_equals(
  actual: readonly number[],
  expected: readonly number[],
): void {
  assertEquals(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    assertAlmostEquals(
      actual[index],
      expected[index],
      1e-8,
      `matrix index ${index}`,
    );
  }
}

Deno.test("matrix inverse composes with its source to identity", () => {
  const source = mat4([
    2,
    0,
    0,
    0,
    0,
    3,
    0,
    0,
    0,
    0,
    4,
    0,
    5,
    6,
    7,
    1,
  ]);
  const inverse = mat4_inverse(source);
  if (!inverse.ok) {
    throw new Error(
      `expected invertible matrix, received pivot ${inverse.pivot}`,
    );
  }
  assert_matrix_almost_equals(
    mat4_multiply(source, inverse.value),
    mat4_identity(),
  );
});

Deno.test("matrix inverses return an explicit singular failure", () => {
  const singular3 = mat3([1, 0, 0, 0, 0, 0, 0, 0, 1]);
  const singular4 = mat4([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assertEquals(mat3_inverse(singular3), {
    ok: false,
    reason: "singular",
    pivot: 0,
  });
  assertEquals(mat4_inverse(singular4), {
    ok: false,
    reason: "singular",
    pivot: 0,
  });
});

Deno.test("matrix boundaries reject non-finite values and invalid epsilon", () => {
  assertThrows(
    () => mat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, Infinity, 0, 0, 0, 0, 1]),
    Error,
    "mat4[10] must be finite, received Infinity",
  );
  assertThrows(
    () => mat4_inverse(mat4_identity(), -1),
    Error,
    "inverse epsilon must be non-negative, received -1",
  );
});

Deno.test("point, direction, and normal transforms have distinct semantics", () => {
  const matrix = mat4([
    2,
    0,
    0,
    0,
    0,
    4,
    0,
    0,
    0,
    0,
    1,
    0,
    10,
    20,
    30,
    1,
  ]);
  assertEquals(
    mat4_transform_affine_point(matrix, vec3(1, 1, 1)),
    vec3(12, 24, 31),
  );
  assertEquals(mat4_transform_direction(matrix, vec3(1, 1, 1)), vec3(2, 4, 1));
  const normal = mat4_transform_normal(matrix, vec3(1, 1, 0));
  if (!normal.ok) {
    throw new Error(
      `expected normal transform, received pivot ${normal.pivot}`,
    );
  }
  assertEquals(normal.value, vec3(0.5, 0.25, 0));
});

Deno.test("quaternions rotate around right-handed positive axes", () => {
  const rotation = quat_from_axis_angle(vec3(0, 1, 0), Math.PI / 2);
  const rotated = quat_rotate_vec3(rotation, vec3(0, 0, -1));
  assertAlmostEquals(rotated.x, -1, 1e-9);
  assertAlmostEquals(rotated.y, 0, 1e-9);
  assertAlmostEquals(rotated.z, 0, 1e-9);
  const halfway = quat_slerp(quat_identity(), rotation, 0.5);
  assertAlmostEquals(
    quat_rotate_vec3(halfway, vec3(0, 0, -1)).x,
    -Math.SQRT1_2,
  );
});

Deno.test("transform matrices apply scale then rotation then translation", () => {
  const value = transform(
    vec3(10, 0, 0),
    quat_from_axis_angle(vec3(0, 1, 0), Math.PI / 2),
    vec3(2, 2, 2),
  );
  const transformed = mat4_transform_affine_point(
    transform_to_mat4(value),
    vec3(0, 0, -1),
  );
  assertAlmostEquals(transformed.x, 8, 1e-9);
  assertAlmostEquals(transformed.y, 0, 1e-9);
  assertAlmostEquals(transformed.z, 0, 1e-9);
});

Deno.test("transform decomposition round-trips translation rotation and scale", () => {
  const source = transform(
    vec3(3, -4, 5),
    quat_from_axis_angle(vec3(1, 2, 3), 0.7),
    vec3(2, 3, 4),
  );
  const decomposed = mat4_decompose(transform_to_mat4(source));
  if (!decomposed.ok) {
    throw new Error(
      `decomposition failed: ${decomposed.reason} ${decomposed.evidence}`,
    );
  }
  assert_matrix_almost_equals(
    transform_to_mat4(decomposed.value),
    transform_to_mat4(source),
  );
});

Deno.test("generated affine transforms decompose and invert consistently", () => {
  for (let index = 1; index <= 64; index++) {
    const source = transform(
      vec3(index - 32, index / 7, -index / 3),
      quat_from_axis_angle(vec3(index, index + 1, index + 2), index / 20),
      vec3(0.5 + index / 10, 1 + index / 11, 2 + index / 12),
    );
    const matrix = transform_to_mat4(source);
    const decomposed = mat4_decompose(matrix);
    if (!decomposed.ok) {
      throw new Error(
        `generated decomposition ${index} failed: ${decomposed.reason} ${decomposed.evidence}`,
      );
    }
    assert_matrix_almost_equals(transform_to_mat4(decomposed.value), matrix);
    const inverse = mat4_inverse(matrix);
    if (!inverse.ok) {
      throw new Error(
        `generated inverse ${index} failed at pivot ${inverse.pivot}`,
      );
    }
    assert_matrix_almost_equals(
      mat4_multiply(matrix, inverse.value),
      mat4_identity(),
    );
  }
});

Deno.test("TRS composition reports shear that cannot be represented", () => {
  const parent = transform(
    vec3(0, 0, 0),
    quat_from_axis_angle(vec3(0, 1, 0), Math.PI / 4),
    vec3(2, 1, 1),
  );
  const local = transform(
    vec3(0, 0, 0),
    quat_from_axis_angle(vec3(0, 0, 1), Math.PI / 4),
    vec3(1, 1, 1),
  );
  const composed = transform_compose(parent, local);
  if (composed.ok) {
    throw new Error("expected non-uniform rotated composition to shear");
  }
  assertEquals(composed.reason, "sheared");
});

Deno.test("uniform transform composition and inversion remain representable as TRS", () => {
  const parent = transform(vec3(1, 0, 0), quat_identity(), vec3(2, 2, 2));
  const local = transform(vec3(0, 3, 0), quat_identity(), vec3(0.5, 0.5, 0.5));
  const composed = transform_compose(parent, local);
  if (!composed.ok) {
    throw new Error(
      `composition failed: ${composed.reason} ${composed.evidence}`,
    );
  }
  assertEquals(composed.value.position, vec3(1, 6, 0));
  assertEquals(composed.value.scale, vec3(1, 1, 1));
  const inverse = transform_inverse(composed.value);
  if (!inverse.ok) {
    throw new Error(`inverse failed: ${inverse.reason} ${inverse.evidence}`);
  }
  assert_matrix_almost_equals(
    mat4_multiply(
      transform_to_mat4(composed.value),
      transform_to_mat4(inverse.value),
    ),
    mat4_identity(),
  );
});

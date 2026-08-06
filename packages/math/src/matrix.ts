import { DEFAULT_EPSILON, finite_number } from "./scalar.ts";
import { type Vec3, vec3, type Vec4, vec4 } from "./vector.ts";

declare const mat3_brand: unique symbol;
declare const mat4_brand: unique symbol;

export type Mat3 =
  & readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  & { readonly [mat3_brand]: true };

export type Mat4 =
  & readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  & { readonly [mat4_brand]: true };

export type MatrixInverseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "singular"; readonly pivot: number };

export type HomogeneousProjectionResult =
  | { readonly ok: true; readonly value: Vec3 }
  | {
    readonly ok: false;
    readonly reason: "zero_homogeneous_w";
    readonly w: number;
  };

export function mat3(values: readonly number[]): Mat3 {
  if (values.length !== 9) {
    throw new Error(`mat3 requires 9 values, received ${values.length}`);
  }
  return Object.freeze(
    values.map((value, index) => finite_number(value, `mat3[${index}]`)),
  ) as unknown as Mat3;
}

export function mat4(values: readonly number[]): Mat4 {
  if (values.length !== 16) {
    throw new Error(`mat4 requires 16 values, received ${values.length}`);
  }
  return Object.freeze(
    values.map((value, index) => finite_number(value, `mat4[${index}]`)),
  ) as unknown as Mat4;
}

export function mat3_identity(): Mat3 {
  return mat3([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

export function mat4_identity(): Mat4 {
  return mat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function mat3_multiply(left: Mat3, right: Mat3): Mat3 {
  const result: number[] = [];
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) {
      result[column * 3 + row] = left[row] * right[column * 3] +
        left[3 + row] * right[column * 3 + 1] +
        left[6 + row] * right[column * 3 + 2];
    }
  }
  return mat3(result);
}

export function mat4_multiply(left: Mat4, right: Mat4): Mat4 {
  const result: number[] = [];
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      result[column * 4 + row] = left[row] * right[column * 4] +
        left[4 + row] * right[column * 4 + 1] +
        left[8 + row] * right[column * 4 + 2] +
        left[12 + row] * right[column * 4 + 3];
    }
  }
  return mat4(result);
}

export function mat3_transpose(matrix: Mat3): Mat3 {
  return mat3([
    matrix[0],
    matrix[3],
    matrix[6],
    matrix[1],
    matrix[4],
    matrix[7],
    matrix[2],
    matrix[5],
    matrix[8],
  ]);
}

export function mat4_transpose(matrix: Mat4): Mat4 {
  return mat4([
    matrix[0],
    matrix[4],
    matrix[8],
    matrix[12],
    matrix[1],
    matrix[5],
    matrix[9],
    matrix[13],
    matrix[2],
    matrix[6],
    matrix[10],
    matrix[14],
    matrix[3],
    matrix[7],
    matrix[11],
    matrix[15],
  ]);
}

export function mat3_determinant(matrix: Mat3): number {
  return finite_number(
    matrix[0] * (matrix[4] * matrix[8] - matrix[7] * matrix[5]) -
      matrix[3] * (matrix[1] * matrix[8] - matrix[7] * matrix[2]) +
      matrix[6] * (matrix[1] * matrix[5] - matrix[4] * matrix[2]),
    "mat3 determinant",
  );
}

export function mat3_inverse(
  matrix: Mat3,
  epsilon = DEFAULT_EPSILON,
): MatrixInverseResult<Mat3> {
  finite_number(epsilon, "inverse epsilon");
  if (epsilon < 0) {
    throw new Error(
      `inverse epsilon must be non-negative, received ${epsilon}`,
    );
  }
  const determinant = mat3_determinant(matrix);
  if (Math.abs(determinant) <= epsilon) {
    return { ok: false, reason: "singular", pivot: determinant };
  }
  const inverse_determinant = 1 / determinant;
  return {
    ok: true,
    value: mat3([
      (matrix[4] * matrix[8] - matrix[5] * matrix[7]) * inverse_determinant,
      (matrix[2] * matrix[7] - matrix[1] * matrix[8]) * inverse_determinant,
      (matrix[1] * matrix[5] - matrix[2] * matrix[4]) * inverse_determinant,
      (matrix[5] * matrix[6] - matrix[3] * matrix[8]) * inverse_determinant,
      (matrix[0] * matrix[8] - matrix[2] * matrix[6]) * inverse_determinant,
      (matrix[2] * matrix[3] - matrix[0] * matrix[5]) * inverse_determinant,
      (matrix[3] * matrix[7] - matrix[4] * matrix[6]) * inverse_determinant,
      (matrix[1] * matrix[6] - matrix[0] * matrix[7]) * inverse_determinant,
      (matrix[0] * matrix[4] - matrix[1] * matrix[3]) * inverse_determinant,
    ]),
  };
}

export function mat4_inverse(
  matrix: Mat4,
  epsilon = DEFAULT_EPSILON,
): MatrixInverseResult<Mat4> {
  finite_number(epsilon, "inverse epsilon");
  if (epsilon < 0) {
    throw new Error(
      `inverse epsilon must be non-negative, received ${epsilon}`,
    );
  }
  const rows = Array.from({ length: 4 }, (_, row) => [
    matrix[row],
    matrix[4 + row],
    matrix[8 + row],
    matrix[12 + row],
    row === 0 ? 1 : 0,
    row === 1 ? 1 : 0,
    row === 2 ? 1 : 0,
    row === 3 ? 1 : 0,
  ]);
  for (let pivot_column = 0; pivot_column < 4; pivot_column++) {
    let pivot_row = pivot_column;
    for (let row = pivot_column + 1; row < 4; row++) {
      if (
        Math.abs(rows[row][pivot_column]) >
          Math.abs(rows[pivot_row][pivot_column])
      ) pivot_row = row;
    }
    const pivot = rows[pivot_row][pivot_column];
    if (Math.abs(pivot) <= epsilon) {
      return { ok: false, reason: "singular", pivot };
    }
    [rows[pivot_column], rows[pivot_row]] = [
      rows[pivot_row],
      rows[pivot_column],
    ];
    for (let column = 0; column < 8; column++) {
      rows[pivot_column][column] /= pivot;
    }
    for (let row = 0; row < 4; row++) {
      if (row === pivot_column) continue;
      const factor = rows[row][pivot_column];
      for (let column = 0; column < 8; column++) {
        rows[row][column] -= factor * rows[pivot_column][column];
      }
    }
  }
  const inverse: number[] = [];
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) inverse.push(rows[row][4 + column]);
  }
  return { ok: true, value: mat4(inverse) };
}

export function mat3_transform_vec3(matrix: Mat3, vector: Vec3): Vec3 {
  return vec3(
    matrix[0] * vector.x + matrix[3] * vector.y + matrix[6] * vector.z,
    matrix[1] * vector.x + matrix[4] * vector.y + matrix[7] * vector.z,
    matrix[2] * vector.x + matrix[5] * vector.y + matrix[8] * vector.z,
  );
}

export function mat4_transform_homogeneous(matrix: Mat4, vector: Vec4): Vec4 {
  return vec4(
    matrix[0] * vector.x + matrix[4] * vector.y + matrix[8] * vector.z +
      matrix[12] * vector.w,
    matrix[1] * vector.x + matrix[5] * vector.y + matrix[9] * vector.z +
      matrix[13] * vector.w,
    matrix[2] * vector.x + matrix[6] * vector.y + matrix[10] * vector.z +
      matrix[14] * vector.w,
    matrix[3] * vector.x + matrix[7] * vector.y + matrix[11] * vector.z +
      matrix[15] * vector.w,
  );
}

export function mat4_transform_point(
  matrix: Mat4,
  point: Vec3,
): HomogeneousProjectionResult {
  const transformed = mat4_transform_homogeneous(
    matrix,
    vec4(point.x, point.y, point.z, 1),
  );
  if (Math.abs(transformed.w) <= DEFAULT_EPSILON) {
    return { ok: false, reason: "zero_homogeneous_w", w: transformed.w };
  }
  return {
    ok: true,
    value: vec3(
      transformed.x / transformed.w,
      transformed.y / transformed.w,
      transformed.z / transformed.w,
    ),
  };
}

export function mat4_transform_affine_point(matrix: Mat4, point: Vec3): Vec3 {
  return vec3(
    matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z +
      matrix[12],
    matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z +
      matrix[13],
    matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z +
      matrix[14],
  );
}

export function mat4_transform_direction(matrix: Mat4, direction: Vec3): Vec3 {
  return vec3(
    matrix[0] * direction.x + matrix[4] * direction.y + matrix[8] * direction.z,
    matrix[1] * direction.x + matrix[5] * direction.y + matrix[9] * direction.z,
    matrix[2] * direction.x + matrix[6] * direction.y +
      matrix[10] * direction.z,
  );
}

export function mat4_normal_matrix(matrix: Mat4): MatrixInverseResult<Mat3> {
  const linear = mat3([
    matrix[0],
    matrix[1],
    matrix[2],
    matrix[4],
    matrix[5],
    matrix[6],
    matrix[8],
    matrix[9],
    matrix[10],
  ]);
  const inverse = mat3_inverse(linear);
  if (!inverse.ok) return inverse;
  return { ok: true, value: mat3_transpose(inverse.value) };
}

export function mat4_transform_normal(
  matrix: Mat4,
  normal: Vec3,
): MatrixInverseResult<Vec3> {
  const normal_matrix = mat4_normal_matrix(matrix);
  if (!normal_matrix.ok) return normal_matrix;
  return { ok: true, value: mat3_transform_vec3(normal_matrix.value, normal) };
}

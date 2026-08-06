import { approximately_equal, finite_number, lerp } from "./scalar.ts";

declare const vec2_brand: unique symbol;
declare const vec3_brand: unique symbol;
declare const vec4_brand: unique symbol;

export interface Vec2 {
  readonly x: number;
  readonly y: number;
  readonly [vec2_brand]: true;
}

export interface Vec3 extends Vec2 {
  readonly z: number;
  readonly [vec3_brand]: true;
}

export interface Vec4 extends Vec3 {
  readonly w: number;
  readonly [vec4_brand]: true;
}

export function vec2(x: number, y: number): Vec2 {
  return Object.freeze({
    x: finite_number(x, "vec2.x"),
    y: finite_number(y, "vec2.y"),
  }) as Vec2;
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return Object.freeze({
    x: finite_number(x, "vec3.x"),
    y: finite_number(y, "vec3.y"),
    z: finite_number(z, "vec3.z"),
  }) as Vec3;
}

export function vec4(x: number, y: number, z: number, w: number): Vec4 {
  return Object.freeze({
    x: finite_number(x, "vec4.x"),
    y: finite_number(y, "vec4.y"),
    z: finite_number(z, "vec4.z"),
    w: finite_number(w, "vec4.w"),
  }) as Vec4;
}

export function vec2_add(left: Vec2, right: Vec2): Vec2 {
  return vec2(left.x + right.x, left.y + right.y);
}

export function vec2_subtract(left: Vec2, right: Vec2): Vec2 {
  return vec2(left.x - right.x, left.y - right.y);
}

export function vec2_scale(vector: Vec2, factor: number): Vec2 {
  finite_number(factor, "vec2 scale");
  return vec2(vector.x * factor, vector.y * factor);
}

export function vec2_dot(left: Vec2, right: Vec2): number {
  return finite_number(left.x * right.x + left.y * right.y, "vec2 dot product");
}

export function vec2_length_squared(vector: Vec2): number {
  return vec2_dot(vector, vector);
}

export function vec2_length(vector: Vec2): number {
  return Math.sqrt(vec2_length_squared(vector));
}

export function vec2_normalize(vector: Vec2): Vec2 {
  const length = vec2_length(vector);
  if (length === 0) {
    throw new Error(`cannot normalize zero vec2 (${vector.x}, ${vector.y})`);
  }
  return vec2_scale(vector, 1 / length);
}

export function vec2_lerp(start: Vec2, finish: Vec2, amount: number): Vec2 {
  return vec2(lerp(start.x, finish.x, amount), lerp(start.y, finish.y, amount));
}

export function vec2_approximately_equal(
  left: Vec2,
  right: Vec2,
  epsilon?: number,
): boolean {
  return approximately_equal(left.x, right.x, epsilon) &&
    approximately_equal(left.y, right.y, epsilon);
}

export function vec3_add(left: Vec3, right: Vec3): Vec3 {
  return vec3(left.x + right.x, left.y + right.y, left.z + right.z);
}

export function vec3_subtract(left: Vec3, right: Vec3): Vec3 {
  return vec3(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function vec3_scale(vector: Vec3, factor: number): Vec3 {
  finite_number(factor, "vec3 scale");
  return vec3(vector.x * factor, vector.y * factor, vector.z * factor);
}

export function vec3_dot(left: Vec3, right: Vec3): number {
  return finite_number(
    left.x * right.x + left.y * right.y + left.z * right.z,
    "vec3 dot product",
  );
}

export function vec3_cross(left: Vec3, right: Vec3): Vec3 {
  return vec3(
    left.y * right.z - left.z * right.y,
    left.z * right.x - left.x * right.z,
    left.x * right.y - left.y * right.x,
  );
}

export function vec3_length_squared(vector: Vec3): number {
  return vec3_dot(vector, vector);
}

export function vec3_length(vector: Vec3): number {
  return Math.sqrt(vec3_length_squared(vector));
}

export function vec3_normalize(vector: Vec3): Vec3 {
  const length = vec3_length(vector);
  if (length === 0) {
    throw new Error(
      `cannot normalize zero vec3 (${vector.x}, ${vector.y}, ${vector.z})`,
    );
  }
  return vec3_scale(vector, 1 / length);
}

export function vec3_lerp(start: Vec3, finish: Vec3, amount: number): Vec3 {
  return vec3(
    lerp(start.x, finish.x, amount),
    lerp(start.y, finish.y, amount),
    lerp(start.z, finish.z, amount),
  );
}

export function vec3_approximately_equal(
  left: Vec3,
  right: Vec3,
  epsilon?: number,
): boolean {
  return approximately_equal(left.x, right.x, epsilon) &&
    approximately_equal(left.y, right.y, epsilon) &&
    approximately_equal(left.z, right.z, epsilon);
}

export function vec4_add(left: Vec4, right: Vec4): Vec4 {
  return vec4(
    left.x + right.x,
    left.y + right.y,
    left.z + right.z,
    left.w + right.w,
  );
}

export function vec4_subtract(left: Vec4, right: Vec4): Vec4 {
  return vec4(
    left.x - right.x,
    left.y - right.y,
    left.z - right.z,
    left.w - right.w,
  );
}

export function vec4_scale(vector: Vec4, factor: number): Vec4 {
  finite_number(factor, "vec4 scale");
  return vec4(
    vector.x * factor,
    vector.y * factor,
    vector.z * factor,
    vector.w * factor,
  );
}

export function vec4_dot(left: Vec4, right: Vec4): number {
  return finite_number(
    left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w,
    "vec4 dot product",
  );
}

export function vec4_lerp(start: Vec4, finish: Vec4, amount: number): Vec4 {
  return vec4(
    lerp(start.x, finish.x, amount),
    lerp(start.y, finish.y, amount),
    lerp(start.z, finish.z, amount),
    lerp(start.w, finish.w, amount),
  );
}

export function vec4_approximately_equal(
  left: Vec4,
  right: Vec4,
  epsilon?: number,
): boolean {
  return approximately_equal(left.x, right.x, epsilon) &&
    approximately_equal(left.y, right.y, epsilon) &&
    approximately_equal(left.z, right.z, epsilon) &&
    approximately_equal(left.w, right.w, epsilon);
}

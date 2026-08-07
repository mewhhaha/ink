import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  approximately_equal,
  clamp,
  inverse_lerp,
  lerp,
  shortest_angle_delta,
  wrap,
} from "./scalar.ts";
import {
  vec2,
  vec2_normalize,
  vec3,
  vec3_add,
  vec3_cross,
  vec3_dot,
  vec3_lerp,
  vec3_normalize,
  vec4,
} from "./vector.ts";

Deno.test("scalar operations clamp, interpolate, and wrap finite values", () => {
  assertEquals(clamp(12, 0, 10), 10);
  assertEquals(lerp(10, 20, 0.25), 12.5);
  assertEquals(lerp(-Number.MAX_VALUE, Number.MAX_VALUE, 0.5), 0);
  assertEquals(inverse_lerp(10, 20, 12.5), 0.25);
  assertEquals(wrap(-1, 0, 4), 3);
  assertAlmostEquals(shortest_angle_delta(Math.PI - 0.1, -Math.PI + 0.1), 0.2);
  assertEquals(approximately_equal(1, 1 + 1e-10), true);
});

Deno.test("scalar boundaries reject invalid ranges with their values", () => {
  assertThrows(() => clamp(1, 3, 2), Error, "minimum 3 exceeds maximum 2");
  assertThrows(() => wrap(1, 2, 2), Error, "wrap range [2, 2)");
  assertThrows(
    () => lerp(0, Infinity, 0.5),
    Error,
    "finish must be finite, received Infinity",
  );
});

Deno.test("vector construction creates frozen finite values", () => {
  const value = vec4(1, 2, 3, 4);
  assertEquals(
    { x: value.x, y: value.y, z: value.z, w: value.w },
    { x: 1, y: 2, z: 3, w: 4 },
  );
  assertEquals(Object.isFrozen(value), true);
  assertThrows(
    () => vec2(0, Number.NaN),
    Error,
    "vec2.y must be finite, received NaN",
  );
});

Deno.test("vec3 operations preserve right-handed cross products", () => {
  const right = vec3(1, 0, 0);
  const up = vec3(0, 1, 0);
  assertEquals(vec3_cross(right, up), vec3(0, 0, 1));
  assertEquals(vec3_dot(right, up), 0);
  assertEquals(vec3_add(right, up), vec3(1, 1, 0));
  assertEquals(vec3_lerp(right, up, 0.5), vec3(0.5, 0.5, 0));
});

Deno.test("normalization returns unit vectors and rejects zero vectors", () => {
  const normalized = vec3_normalize(vec3(3, 4, 0));
  assertAlmostEquals(normalized.x, 0.6);
  assertAlmostEquals(normalized.y, 0.8);
  assertThrows(
    () => vec2_normalize(vec2(0, 0)),
    Error,
    "cannot normalize zero vec2 (0, 0)",
  );
});

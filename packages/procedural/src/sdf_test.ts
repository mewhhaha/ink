import { vec3 } from "@ink/math/vector.ts";
import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  box_distance_field,
  intersection_distance_field,
  offset_distance_field,
  smooth_union_distance_field,
  sphere_distance_field,
  subtract_distance_field,
  union_distance_field,
} from "./sdf.ts";

Deno.test("sphere and box distance fields preserve signed distances", () => {
  const sphere = sphere_distance_field(vec3(0, 0, 0), 2);
  assertEquals(sphere.sample(vec3(0, 0, 0)), -2);
  assertEquals(sphere.sample(vec3(2, 0, 0)), 0);
  assertEquals(sphere.sample(vec3(5, 0, 0)), 3);
  const box = box_distance_field(vec3(0, 0, 0), vec3(1, 2, 3));
  assertEquals(box.sample(vec3(0, 0, 0)), -1);
  assertEquals(box.sample(vec3(1, 2, 3)), 0);
});

Deno.test("distance field boolean operations retain inside and outside semantics", () => {
  const left = sphere_distance_field(vec3(-1, 0, 0), 2);
  const right = sphere_distance_field(vec3(1, 0, 0), 2);
  assert(union_distance_field([left, right]).sample(vec3(-2.5, 0, 0)) < 0);
  assert(intersection_distance_field([left, right]).sample(vec3(0, 0, 0)) < 0);
  assert(subtract_distance_field(left, right).sample(vec3(0, 0, 0)) >= 0);
});

Deno.test("smooth union and offsets produce finite continuous boundaries", () => {
  const left = sphere_distance_field(vec3(-1, 0, 0), 1);
  const right = sphere_distance_field(vec3(1, 0, 0), 1);
  const joined = smooth_union_distance_field(left, right, 0.5);
  assertAlmostEquals(joined.sample(vec3(0, 0, 0)), -0.125);
  assertEquals(offset_distance_field(left, 0.25).sample(vec3(0, 0, 0)), -0.25);
  assertThrows(
    () =>
      union_distance_field([{ sample: () => Number.NaN }]).sample(
        vec3(0, 0, 0),
      ),
    Error,
    "union field 0 sample",
  );
});

function assert(condition: boolean): asserts condition {
  if (!condition) throw new Error("assertion failed");
}

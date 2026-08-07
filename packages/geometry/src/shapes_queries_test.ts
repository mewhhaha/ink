import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { quat_from_axis_angle, quat_identity } from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  aabb_contains_point,
  aabb_overlap,
  capsule_contains_point,
  closest_point_on_segment,
  closest_point_on_triangle,
  obb_contains_point,
  ray_aabb_intersection,
  ray_plane_intersection,
  ray_sphere_intersection,
  ray_triangle_intersection,
  sphere_aabb_overlap,
  sphere_contains_point,
  sphere_overlap,
  sweep_sphere_aabb,
} from "./queries.ts";
import {
  aabb,
  aabb_surface_area,
  capsule,
  line_segment,
  obb,
  plane,
  ray,
  sphere,
  triangle,
} from "./shapes.ts";

Deno.test("shape constructors normalize meaningful invariants", () => {
  const cast = ray(vec3(1, 2, 3), vec3(0, 0, -4));
  assertEquals(cast.direction, vec3(0, 0, -1));
  const clipping_plane = plane(vec3(0, 2, 0), -4);
  assertEquals(clipping_plane.normal, vec3(0, 1, 0));
  assertEquals(clipping_plane.offset, -2);
});

Deno.test("shape constructors reject degenerate and inverted inputs with evidence", () => {
  assertThrows(
    () => line_segment(vec3(1, 2, 3), vec3(1, 2, 3)),
    Error,
    "line segment endpoints are both (1, 2, 3)",
  );
  assertThrows(
    () => triangle(vec3(0, 0, 0), vec3(1, 0, 0), vec3(2, 0, 0)),
    Error,
    "triangle is degenerate",
  );
  assertThrows(
    () => sphere(vec3(0, 0, 0), 0),
    Error,
    "sphere radius must be positive, received 0",
  );
  assertThrows(
    () => aabb(vec3(2, 0, 0), vec3(1, 1, 1)),
    Error,
    "AABB minimum (2, 0, 0) exceeds maximum (1, 1, 1)",
  );
  assertThrows(
    () =>
      aabb_surface_area(
        aabb(
          vec3(0, 0, 0),
          vec3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE),
        ),
      ),
    Error,
    "AABB surface area must be finite, received Infinity",
  );
});

Deno.test("closest-point queries clamp to segments and triangle features", () => {
  const segment = line_segment(vec3(0, 0, 0), vec3(2, 0, 0));
  assertEquals(closest_point_on_segment(vec3(3, 1, 0), segment), vec3(2, 0, 0));
  const surface = triangle(vec3(0, 0, 0), vec3(2, 0, 0), vec3(0, 2, 0));
  assertEquals(
    closest_point_on_triangle(vec3(0.5, 0.5, 3), surface),
    vec3(0.5, 0.5, 0),
  );
  assertEquals(
    closest_point_on_triangle(vec3(3, 0, 0), surface),
    vec3(2, 0, 0),
  );
});

Deno.test("point containment distinguishes boundaries from interiors", () => {
  const bounds = aabb(vec3(-1, -1, -1), vec3(1, 1, 1));
  assertEquals(aabb_contains_point(bounds, vec3(0, 0, 0)), "inside");
  assertEquals(aabb_contains_point(bounds, vec3(1, 0, 0)), "boundary");
  assertEquals(
    sphere_contains_point(sphere(vec3(0, 0, 0), 1), vec3(1, 0, 0)),
    "boundary",
  );
  assertEquals(
    capsule_contains_point(
      capsule(line_segment(vec3(0, -1, 0), vec3(0, 1, 0)), 1),
      vec3(1, 0, 0),
    ),
    "boundary",
  );
  const rotated = obb(
    vec3(0, 0, 0),
    vec3(2, 1, 1),
    quat_from_axis_angle(vec3(0, 1, 0), Math.PI / 2),
  );
  assertEquals(obb_contains_point(rotated, vec3(0, 0, 1.5)), "inside");
});

Deno.test("overlap queries classify touching as contact", () => {
  const left = aabb(vec3(0, 0, 0), vec3(1, 1, 1));
  const touching = aabb(vec3(1, 0, 0), vec3(2, 1, 1));
  assertEquals(aabb_overlap(left, touching), "touching");
  assertEquals(
    sphere_overlap(sphere(vec3(0, 0, 0), 1), sphere(vec3(2, 0, 0), 1)),
    "touching",
  );
  assertEquals(sphere_aabb_overlap(sphere(vec3(2, 0, 0), 1), left), "touching");
});

Deno.test("parallel and coplanar rays return distinct plane results", () => {
  const ground = plane(vec3(0, 1, 0), 0);
  assertEquals(
    ray_plane_intersection(ray(vec3(0, 1, 0), vec3(1, 0, 0)), ground),
    null,
  );
  const coplanar = ray_plane_intersection(
    ray(vec3(0, 0, 0), vec3(1, 0, 0)),
    ground,
  );
  assertEquals(coplanar?.feature, "coplanar");
  assertEquals(coplanar?.distance, 0);
});

Deno.test("ray hits carry distance position normal and surface identity", () => {
  const ball_hit = ray_sphere_intersection(
    ray(vec3(0, 0, 3), vec3(0, 0, -1)),
    sphere(vec3(0, 0, 0), 1),
  );
  assertEquals(ball_hit?.distance, 2);
  assertEquals(ball_hit?.position, vec3(0, 0, 1));
  assertEquals(ball_hit?.normal, vec3(0, 0, 1));
  const box_hit = ray_aabb_intersection(
    ray(vec3(-2, 0, 0), vec3(1, 0, 0)),
    aabb(vec3(-1, -1, -1), vec3(1, 1, 1)),
  );
  assertEquals(box_hit?.feature, "x_min");
  assertEquals(box_hit?.distance, 1);
  const triangle_hit = ray_triangle_intersection(
    ray(vec3(0.25, 0.25, 1), vec3(0, 0, -1)),
    triangle(vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)),
  );
  assertEquals(triangle_hit?.feature, "front");
  assertEquals(triangle_hit?.position, vec3(0.25, 0.25, 0));
});

Deno.test("ray queries handle parallel slabs, coplanar triangles, and large coordinates", () => {
  const bounds = aabb(
    vec3(1_000_000_000, -1, -1),
    vec3(1_000_000_002, 1, 1),
  );
  const hit = ray_aabb_intersection(
    ray(vec3(999_999_990, 0, 0), vec3(1, 0, 0)),
    bounds,
  );
  assertAlmostEquals(hit?.distance ?? -1, 10);
  assertEquals(
    ray_aabb_intersection(ray(vec3(999_999_990, 2, 0), vec3(1, 0, 0)), bounds),
    null,
  );
  const surface = triangle(vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0));
  assertEquals(
    ray_triangle_intersection(ray(vec3(0.25, 0.25, 0), vec3(1, 0, 0)), surface),
    null,
  );
});

Deno.test("sphere sweep reports first conservative contact", () => {
  const hit = sweep_sphere_aabb(
    sphere(vec3(-3, 0, 0), 0.5),
    vec3(1, 0, 0),
    10,
    aabb(vec3(-1, -1, -1), vec3(1, 1, 1)),
  );
  assertEquals(hit?.feature, "surface");
  assertEquals(hit?.distance, 1.5);
  assertEquals(hit?.position, vec3(-1, 0, 0));
});

Deno.test("identity OBB preserves local containment", () => {
  const bounds = obb(vec3(1, 2, 3), vec3(1, 1, 1), quat_identity());
  assertEquals(obb_contains_point(bounds, vec3(1, 2, 3)), "inside");
});

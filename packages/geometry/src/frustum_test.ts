import { assertEquals } from "@std/assert";
import { mat4_multiply } from "@ink/math/matrix.ts";
import { look_at_view, perspective_projection } from "@ink/math/projection.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  frustum_contains_aabb,
  frustum_contains_sphere,
  frustum_from_view_projection,
} from "./frustum.ts";
import { aabb, sphere } from "./shapes.ts";

Deno.test("WebGPU frustum extraction classifies near, far, side, and interior bounds", () => {
  const projection = perspective_projection({
    vertical_fov_radians: Math.PI / 2,
    aspect_ratio: 1,
    near_plane: 1,
    far_plane: 10,
  });
  const view = look_at_view(vec3(0, 0, 0), vec3(0, 0, -1), vec3(0, 1, 0));
  const value = frustum_from_view_projection(mat4_multiply(projection, view));
  assertEquals(
    frustum_contains_sphere(value, sphere(vec3(0, 0, -5), 0.5)),
    "inside",
  );
  assertEquals(
    frustum_contains_sphere(value, sphere(vec3(0, 0, -0.75), 0.5)),
    "intersecting",
  );
  assertEquals(
    frustum_contains_sphere(value, sphere(vec3(0, 0, -12), 0.5)),
    "outside",
  );
  assertEquals(
    frustum_contains_sphere(value, sphere(vec3(8, 0, -5), 0.5)),
    "outside",
  );
  assertEquals(
    frustum_contains_aabb(value, aabb(vec3(-1, -1, -6), vec3(1, 1, -4))),
    "inside",
  );
  assertEquals(
    frustum_contains_aabb(value, aabb(vec3(-1, -1, -1), vec3(1, 1, 0))),
    "intersecting",
  );
});

import { assert, assertEquals, assertThrows } from "@std/assert";
import { mesh_topology } from "@ink/geometry/mesh.ts";
import {
  quat_from_axis_angle,
  quat_rotate_vec3,
} from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  collide_shapes,
  epa_penetration,
  gjk_intersection,
  rigid_pose,
} from "./collision.ts";
import {
  box_shape,
  capsule_shape,
  convex_hull_shape,
  heightfield_shape,
  shape_mass_properties,
  sphere_shape,
  triangle_mesh_shape,
} from "./shapes.ts";

Deno.test("shape constructors reject invalid geometric domains", () => {
  assertThrows(() => sphere_shape(0), Error, "sphere radius");
  assertThrows(() => capsule_shape(-1, 1), Error, "half-height");
  assertThrows(() => box_shape(vec3(1, 0, 1)), Error, "half-extents");
  assertThrows(
    () =>
      convex_hull_shape([
        vec3(0, 0, 0),
        vec3(1, 0, 0),
        vec3(2, 0, 0),
        vec3(3, 0, 0),
      ]),
    Error,
    "collinear",
  );
  assertThrows(
    () =>
      heightfield_shape({
        width: 2,
        depth: 2,
        spacing: 1,
        heights: new Float32Array(3),
      }),
    Error,
    "must equal 4",
  );
});

Deno.test("primitive mass properties use declared density", () => {
  const properties = shape_mass_properties(sphere_shape(1), 3);
  assert(Math.abs(properties.mass - 4 * Math.PI) < 1e-12);
  assertEquals(properties.center, vec3(0, 0, 0));
  assert(properties.inertia.x > 0);
});

Deno.test("GJK and penetration estimation classify separated and overlapping convex shapes", () => {
  const box = box_shape(vec3(1, 1, 1));
  const origin = rigid_pose(vec3(0, 0, 0));
  const overlapping = rigid_pose(vec3(1.5, 0, 0));
  const separated = rigid_pose(vec3(4, 0, 0));
  assert(gjk_intersection(box, origin, box, overlapping).intersects);
  assert(!gjk_intersection(box, origin, box, separated).intersects);
  const penetration = epa_penetration(box, origin, box, overlapping);
  assert(penetration !== null);
  assert(Math.abs(penetration.depth - 0.5) < 1e-9);
});

Deno.test("sphere and oriented box contact returns a stable manifold normal", () => {
  const rotation = quat_from_axis_angle(vec3(0, 0, 1), Math.PI / 6);
  const contact = collide_shapes(
    sphere_shape(1),
    rigid_pose(quat_rotate_vec3(rotation, vec3(0, 1.5, 0))),
    box_shape(vec3(2, 1, 2)),
    rigid_pose(vec3(0, 0, 0), rotation),
  );
  assert(contact !== null);
  assert(Math.abs(contact.normal.y + Math.cos(Math.PI / 6)) < 1e-9);
  assert(Math.abs(contact.normal.x - 0.5) < 1e-9);
  assert(Math.abs(contact.penetration - 0.5) < 1e-9);
});

Deno.test("static mesh and heightfield shapes preserve immutable collision sources", () => {
  const topology = mesh_topology(
    [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 0, 1)],
    [0, 1, 2],
  );
  const mesh = triangle_mesh_shape(topology);
  const heights = new Float32Array([0, 1, 2, 3]);
  const terrain = heightfield_shape({
    width: 2,
    depth: 2,
    spacing: 2,
    heights,
  });
  heights[0] = 99;
  assertEquals(mesh.bounds.maximum, vec3(1, 0, 1));
  assertEquals(terrain.heights[0], 0);
  assertEquals(terrain.bounds.maximum, vec3(2, 3, 2));
});

Deno.test("heightfield contacts respect sampled surfaces and authored holes", () => {
  const terrain = heightfield_shape({
    width: 2,
    depth: 2,
    spacing: 1,
    heights: new Float32Array([0, 0, 0, 0]),
  });
  const contact = collide_shapes(
    sphere_shape(1),
    rigid_pose(vec3(0.5, 0.5, 0.5)),
    terrain,
    rigid_pose(vec3(0, 0, 0)),
  );
  assert(contact !== null);
  assertEquals(contact.normal, vec3(0, -1, 0));
  assert(Math.abs(contact.penetration - 0.5) < 1e-9);
  const hole = heightfield_shape({
    width: 2,
    depth: 2,
    spacing: 1,
    heights: new Float32Array([0, 0, 0, 0]),
    holes: new Uint8Array([1]),
  });
  assertEquals(
    collide_shapes(
      sphere_shape(1),
      rigid_pose(vec3(0.5, 0.5, 0.5)),
      hole,
      rigid_pose(vec3(0, 0, 0)),
    ),
    null,
  );
});

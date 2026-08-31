import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { quat_from_axis_angle } from "@ink/math/quaternion.ts";
import { vec3 } from "@ink/math/vector.ts";
import { collision_gizmos } from "./experimental/gizmos.ts";
import { physics_world_id } from "./identity.ts";
import { rigid_pose } from "./collision.ts";
import { box_shape, sphere_shape } from "./shapes.ts";
import { type PhysicsMutationResult, PhysicsWorld } from "./world.ts";

function created<Id>(result: PhysicsMutationResult<Id>): Id {
  if (result.type === "failed") throw new Error(result.reason);
  return result.id;
}

Deno.test("collision gizmos extract oriented boxes and filter areas", () => {
  const world = new PhysicsWorld({
    id: physics_world_id("gizmo-test"),
    fixed_step_seconds: 1 / 60,
    gravity: vec3(0, 0, 0),
  });
  const box = created(world.create_shape(box_shape(vec3(1, 2, 3))));
  const sphere = created(world.create_shape(sphere_shape(1)));
  const collision_body = created(world.create_body({
    motion: "static",
    pose: rigid_pose(
      vec3(0, 0, 0),
      quat_from_axis_angle(vec3(0, 0, 1), Math.PI / 2),
    ),
  }));
  const area_body = created(world.create_body({ motion: "static" }));
  const collision = created(world.create_collider({
    body: collision_body,
    shape: box,
  }));
  const area = created(world.create_area({ body: area_body, shape: sphere }));

  const all = collision_gizmos(world.snapshot(), "all");
  assertEquals(all.map(({ collider }) => collider), [collision, area]);
  assertEquals(all[0].category, "collision");
  assertEquals(all[0].lines.length, 12);
  assertAlmostEquals(all[0].lines[0].start.x, 2);
  assertAlmostEquals(all[0].lines[0].start.y, -1);
  assertAlmostEquals(all[0].lines[0].finish.x, 2);
  assertAlmostEquals(all[0].lines[0].finish.y, 1);
  assertEquals(
    collision_gizmos(world.snapshot(), "areas").map(({ collider }) => collider),
    [area],
  );
  assertEquals(collision_gizmos(world.snapshot(), "none"), []);
  assertThrows(
    () => collision_gizmos(world.snapshot(), "maybe" as never),
    Error,
    'physics gizmo visibility "maybe" is unsupported',
  );
});

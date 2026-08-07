import { assert, assertEquals } from "@std/assert";
import { vec2 } from "@ink/math/vector.ts";
import { physics_world_id, type ShapeId } from "./identity.ts";
import type { PhysicsMutationResult } from "./world.ts";
import { box_shape_2d, circle_shape_2d, CollisionWorld2d } from "./world_2d.ts";

function created<Id>(result: PhysicsMutationResult<Id>): Id {
  if (result.type === "failed") throw new Error(result.reason);
  return result.id;
}

function collision_world_2d(): CollisionWorld2d {
  return new CollisionWorld2d({
    id: physics_world_id("2d-test"),
    fixed_step_seconds: 1 / 60,
  });
}

Deno.test("2D collision worlds raycast circles and boxes in distance order", () => {
  const world = collision_world_2d();
  const circle = created(world.create_shape(circle_shape_2d(0.5)));
  const box = created(world.create_shape(box_shape_2d(vec2(0.5, 1))));
  const near = created(world.create_collision({
    shape: circle,
    position: vec2(2, 0),
  }));
  const far = created(world.create_collision({
    shape: box,
    position: vec2(4, 0),
  }));

  const hits = world.raycast(vec2(0, 0), vec2(1, 0), 10);
  assertEquals(hits.map(({ collision }) => collision), [near, far]);
  assertEquals(hits.map(({ distance }) => distance), [1.5, 3.5]);
  assertEquals(
    world.overlap_shape(circle, { position: vec2(2.25, 0) }),
    [near],
  );
  assertEquals(
    world.shape_cast(circle, { position: vec2(0, 0) }, vec2(1, 0), 10)[0]
      .collision,
    near,
  );
});

Deno.test("2D areas emit enter, stay, and exit without blocking collisions", () => {
  const world = collision_world_2d();
  const circle: ShapeId = created(world.create_shape(circle_shape_2d(1)));
  const area = created(world.create_area({
    shape: circle,
    position: vec2(0, 0),
  }));
  const collision = created(world.create_collision({
    shape: circle,
    position: vec2(1, 0),
  }));

  assertEquals(world.step().areas, [{
    type: "entered",
    area,
    other: collision,
  }]);
  assertEquals(world.step().areas, [{
    type: "stayed",
    area,
    other: collision,
  }]);
  assertEquals(world.raycast(vec2(-3, 0), vec2(1, 0), 10).length, 1);
  assertEquals(
    world.raycast(vec2(-3, 0), vec2(1, 0), 10, { include_areas: true })
      .length,
    2,
  );

  assertEquals(world.set_pose(collision, { position: vec2(4, 0) }), {
    type: "changed",
  });
  assertEquals(world.step().areas, [{
    type: "exited",
    area,
    other: collision,
  }]);
  assertEquals(world.destroy_collision(collision), { type: "changed" });
  const stale = world.destroy_collision(collision);
  assert(stale.type === "failed");
  assert(stale.reason.includes("missing or stale"));
  assertEquals(world.destroy_area(area), { type: "changed" });
});

Deno.test("2D collision steps report overlapping solid objects", () => {
  const world = collision_world_2d();
  const circle = created(world.create_shape(circle_shape_2d(1)));
  const first = created(world.create_collision({
    shape: circle,
    position: vec2(0, 0),
  }));
  const second = created(world.create_collision({
    shape: circle,
    position: vec2(1, 0),
  }));

  assertEquals(world.step().collisions, [{ first, second }]);
});

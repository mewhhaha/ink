import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { mesh_topology } from "@ink/geometry/mesh.ts";
import { ray } from "@ink/geometry/shapes.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  type BodyId,
  type ColliderId,
  physics_world_id,
  type ShapeId,
} from "./identity.ts";
import { rigid_pose } from "./collision.ts";
import {
  box_shape,
  heightfield_shape,
  sphere_shape,
  triangle_mesh_shape,
} from "./shapes.ts";
import {
  type PhysicsMutationResult,
  type PhysicsSnapshot,
  PhysicsWorld,
} from "./world.ts";

function created_id<Id>(result: PhysicsMutationResult<Id>): Id {
  if (result.type === "failed") throw new Error(result.reason);
  return result.id;
}

function simulation(
  options: { gravity?: ReturnType<typeof vec3>; sleep_seconds?: number } = {},
) {
  return new PhysicsWorld({
    id: physics_world_id("test"),
    fixed_step_seconds: 1 / 60,
    gravity: options.gravity,
    sleep_seconds: options.sleep_seconds,
  });
}

function shape(world: PhysicsWorld, radius = 0.5): ShapeId {
  return created_id(world.create_shape(sphere_shape(radius)));
}

function body(
  world: PhysicsWorld,
  motion: "static" | "kinematic" | "dynamic",
  y = 0,
): BodyId {
  return created_id(
    world.create_body({ motion, pose: rigid_pose(vec3(0, y, 0)) }),
  );
}

function collider(
  world: PhysicsWorld,
  target_body: BodyId,
  target_shape: ShapeId,
  sensor = false,
): ColliderId {
  return created_id(
    world.create_collider({ body: target_body, shape: target_shape, sensor }),
  );
}

Deno.test("stale body handles never affect a reused allocation", () => {
  const world = simulation();
  const stale = body(world, "dynamic");
  assertEquals(world.destroy_body(stale), { type: "changed" });
  const current = body(world, "dynamic");
  assertEquals(current.index, stale.index);
  assertEquals(current.generation, stale.generation + 1);
  const result = world.apply_impulse(stale, vec3(5, 0, 0));
  assertEquals(result.type, "failed");
  if (result.type === "failed") assertMatch(result.reason, /missing or stale/);
  assertEquals(world.body_state(current)?.linear_velocity, vec3(0, 0, 0));
});

Deno.test("dynamic bodies reject triangle meshes with body and shape evidence", () => {
  const world = simulation();
  const dynamic = body(world, "dynamic");
  const topology = mesh_topology(
    [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 0, 1)],
    [0, 1, 2],
  );
  const mesh = created_id(world.create_shape(triangle_mesh_shape(topology)));
  const result = world.create_collider({ body: dynamic, shape: mesh });
  assertEquals(result.type, "failed");
  if (result.type === "failed") {
    assertMatch(
      result.reason,
      new RegExp(`body ${dynamic.index}:${dynamic.generation}`),
    );
    assertMatch(
      result.reason,
      new RegExp(`shape ${mesh.index}:${mesh.generation}`),
    );
  }
});

Deno.test("fixed stepping produces resting contacts and eventually sleeps", () => {
  const world = simulation({ sleep_seconds: 0.15 });
  const ground_shape = created_id(
    world.create_shape(box_shape(vec3(5, 0.5, 5))),
  );
  collider(world, body(world, "static", -0.5), ground_shape);
  const ball = body(world, "dynamic", 3);
  collider(world, ball, shape(world));
  let contact_count = 0;
  for (let index = 0; index < 240; index++) {
    contact_count += world.step().contacts.length;
  }
  const state = world.body_state(ball)!;
  assert(contact_count > 0);
  assert(Math.abs(state.pose.position.y - 0.5) < 0.08);
  assert(state.sleeping);
});

Deno.test("solver restitution reverses impact velocity", () => {
  const world = simulation({ gravity: vec3(0, 0, 0) });
  const first = body(world, "dynamic");
  const second = created_id(world.create_body({
    motion: "dynamic",
    pose: rigid_pose(vec3(1.5, 0, 0)),
    linear_velocity: vec3(-4, 0, 0),
  }));
  const ball = shape(world, 1);
  const material = {
    friction: 0,
    restitution: 1,
    combination: "maximum" as const,
  };
  created_id(world.create_collider({ body: first, shape: ball, material }));
  created_id(world.create_collider({ body: second, shape: ball, material }));
  world.step();
  assert(world.body_state(first)!.linear_velocity.x < 0);
  assert(world.body_state(second)!.linear_velocity.x > -4);
});

Deno.test("collision filters suppress pairs and sensors emit ordered lifecycle events", () => {
  const world = simulation({ gravity: vec3(0, 0, 0) });
  const sensor_body = body(world, "static");
  const moving_body = body(world, "kinematic", 0.5);
  const ball = shape(world, 1);
  const sensor = created_id(
    world.create_collider({ body: sensor_body, shape: ball, sensor: true }),
  );
  const moving = collider(world, moving_body, ball);
  assertEquals(world.step().triggers, [{
    type: "entered",
    first: sensor,
    second: moving,
  }]);
  assertEquals(world.step().triggers, [{
    type: "stayed",
    first: sensor,
    second: moving,
  }]);
  world.set_kinematic_pose(moving_body, rigid_pose(vec3(0, 5, 0)));
  assertEquals(world.step().triggers, [{
    type: "exited",
    first: sensor,
    second: moving,
  }]);

  const filtered = simulation({ gravity: vec3(0, 0, 0) });
  const shared = shape(filtered, 1);
  const one = body(filtered, "dynamic");
  const two = body(filtered, "dynamic", 0.5);
  created_id(
    filtered.create_collider({
      body: one,
      shape: shared,
      filter: { membership: 1, collides_with: 1, group: -7 },
    }),
  );
  created_id(
    filtered.create_collider({
      body: two,
      shape: shared,
      filter: { membership: 1, collides_with: 1, group: -7 },
    }),
  );
  assertEquals(filtered.step().contacts.length, 0);
});

Deno.test("queries are ordered by distance then stable collider identity", () => {
  const world = simulation({ gravity: vec3(0, 0, 0) });
  const ball = shape(world);
  for (const x of [4, 2, 2]) {
    const target = created_id(
      world.create_body({ motion: "static", pose: rigid_pose(vec3(x, 0, 0)) }),
    );
    collider(world, target, ball);
  }
  const hits = world.raycast(ray(vec3(0, 0, 0), vec3(1, 0, 0)), 10);
  assertEquals(hits.map(({ distance }) => distance), [1.5, 1.5, 3.5]);
  assert(hits[0].collider.index < hits[1].collider.index);
  assertEquals(
    world.closest_points(vec3(0, 0, 0), 10).map(({ distance }) => distance),
    [1.5, 1.5, 3.5],
  );
  assertThrows(
    () => world.raycast(ray(vec3(0, 0, 0), vec3(1, 0, 0)), 10, { mask: -1 }),
    Error,
    "must be unsigned 32-bit",
  );
});

Deno.test("continuous motion stops before tunneling through a thin obstacle", () => {
  const world = simulation({ gravity: vec3(0, 0, 0) });
  const wall_shape = created_id(
    world.create_shape(box_shape(vec3(0.05, 2, 2))),
  );
  const wall = created_id(
    world.create_body({ motion: "static", pose: rigid_pose(vec3(2, 0, 0)) }),
  );
  collider(world, wall, wall_shape);
  const projectile = created_id(world.create_body({
    motion: "dynamic",
    pose: rigid_pose(vec3(0, 0, 0)),
    linear_velocity: vec3(240, 0, 0),
    continuous: true,
  }));
  collider(world, projectile, shape(world, 0.1));
  const step = world.step();
  assertEquals(step.diagnostics.ccd_casts, 1);
  assert(world.body_state(projectile)!.pose.position.x < 2);
});

Deno.test("distance joints constrain separation and break thresholds retire joints", () => {
  const world = simulation({ gravity: vec3(0, 0, 0) });
  const first = body(world, "static");
  const second = created_id(
    world.create_body({ motion: "dynamic", pose: rigid_pose(vec3(4, 0, 0)) }),
  );
  created_id(world.create_joint({
    first,
    second,
    definition: { type: "distance", minimum: 1, maximum: 2 },
  }));
  for (let index = 0; index < 30; index++) world.step();
  assert(world.body_state(second)!.pose.position.x <= 2.01);

  const third = created_id(
    world.create_body({ motion: "dynamic", pose: rigid_pose(vec3(10, 0, 0)) }),
  );
  created_id(world.create_joint({
    first,
    second: third,
    definition: {
      type: "spring",
      rest_length: 0,
      stiffness: 10,
      damping: 0,
      break_force: 0.001,
    },
  }));
  assertEquals(world.step().broken_joints.length, 1);
});

Deno.test("snapshot restore reproduces subsequent poses, contacts, events, and sleep state", () => {
  const world = simulation();
  const ground_shape = created_id(
    world.create_shape(box_shape(vec3(3, 0.5, 3))),
  );
  collider(world, body(world, "static", -0.5), ground_shape);
  const ball = body(world, "dynamic", 1);
  collider(world, ball, shape(world));
  for (let index = 0; index < 20; index++) world.step();
  const snapshot = world.snapshot();
  const first = Array.from({ length: 20 }, () => world.step());
  assertEquals(world.restore(snapshot), { type: "changed" });
  const second = Array.from({ length: 20 }, () => world.step());
  assertEquals(second, first);
});

Deno.test("malformed snapshot restore is atomic and retains the live world", () => {
  const world = simulation();
  const target_shape = shape(world);
  collider(world, body(world, "static"), target_shape);
  const before = world.snapshot();
  const malformed = structuredClone(before) as PhysicsSnapshot;
  const mutable_shape = malformed.colliders[0].shape as {
    index: number;
    generation: number;
  };
  mutable_shape.index = 99;
  const result = world.restore(malformed);
  assertEquals(result.type, "failed");
  assertEquals(world.snapshot(), before);
});

Deno.test("snapshots detach mutable collision sample buffers", () => {
  const world = simulation();
  created_id(world.create_shape(heightfield_shape({
    width: 2,
    depth: 2,
    spacing: 1,
    heights: new Float32Array([0, 1, 2, 3]),
  })));
  const snapshot = world.snapshot();
  const saved_shape = snapshot.shapes[0].shape;
  if (saved_shape.type !== "heightfield") throw new Error(saved_shape.type);
  saved_shape.heights[0] = 99;
  const current_shape = world.snapshot().shapes[0].shape;
  if (current_shape.type !== "heightfield") throw new Error(current_shape.type);
  assertEquals(current_shape.heights[0], 0);
});

Deno.test("origin rebasing preserves relative poses and query results", () => {
  const world = simulation({ gravity: vec3(0, 0, 0) });
  const target = created_id(
    world.create_body({ motion: "static", pose: rigid_pose(vec3(101, 0, 0)) }),
  );
  collider(world, target, shape(world));
  assertEquals(
    world.raycast(ray(vec3(100, 0, 0), vec3(1, 0, 0)), 5)[0].distance,
    0.5,
  );
  world.rebase(vec3(100, 0, 0));
  assertEquals(
    world.raycast(ray(vec3(0, 0, 0), vec3(1, 0, 0)), 5)[0].distance,
    0.5,
  );
});

Deno.test("fixed-step contract rejects variable deltas", () => {
  const world = simulation();
  assertThrows(() => world.step(1 / 30), Error, "requires fixed step");
});

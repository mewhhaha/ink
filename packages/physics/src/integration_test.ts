import { assert, assertEquals } from "@std/assert";
import { quat_identity } from "@ink/math/quaternion.ts";
import { transform } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import { scene_id } from "@ink/scene/identity.ts";
import { Scene } from "@ink/scene/scene.ts";
import { global_position } from "@ink/world/identity.ts";
import { create_terrain } from "@ink/world/terrain.ts";
import {
  heightfield_from_terrain,
  pull_scene_kinematics,
  scene_pose_writes,
  step_with_ecs,
} from "./adapters.ts";
import { rigid_pose } from "./collision.ts";
import { type BodyId, physics_world_id } from "./identity.ts";
import { box_shape, sphere_shape } from "./shapes.ts";
import {
  type BodyState,
  type PhysicsMutationResult,
  PhysicsWorld,
} from "./world.ts";

function created<Id>(result: PhysicsMutationResult<Id>): Id {
  if (result.type === "failed") throw new Error(result.reason);
  return result.id;
}

function world(gravity = vec3(0, -9.81, 0)): PhysicsWorld {
  return new PhysicsWorld({
    id: physics_world_id("integration"),
    fixed_step_seconds: 1 / 60,
    gravity,
  });
}

Deno.test("a three-body stack settles in stable vertical order", () => {
  const simulation = world();
  const ground_shape = created(
    simulation.create_shape(box_shape(vec3(4, 0.5, 4))),
  );
  const ground = created(
    simulation.create_body({
      motion: "static",
      pose: rigid_pose(vec3(0, -0.5, 0)),
    }),
  );
  created(simulation.create_collider({ body: ground, shape: ground_shape }));
  const ball_shape = created(simulation.create_shape(sphere_shape(0.5)));
  const bodies = [1, 2.05, 3.1].map((y) => {
    const body = created(
      simulation.create_body({
        motion: "dynamic",
        pose: rigid_pose(vec3(0, y, 0)),
      }),
    );
    created(simulation.create_collider({ body, shape: ball_shape }));
    return body;
  });
  for (let index = 0; index < 360; index++) simulation.step();
  const heights = bodies.map((body) =>
    simulation.body_state(body)!.pose.position.y
  );
  assert(heights[0] < heights[1] && heights[1] < heights[2]);
  assert(heights[0] > 0.4);
});

Deno.test("contact friction removes tangential speed while mass scales impulses", () => {
  const simulation = world();
  const ground_shape = created(
    simulation.create_shape(box_shape(vec3(20, 0.5, 20))),
  );
  const ground = created(
    simulation.create_body({
      motion: "static",
      pose: rigid_pose(vec3(0, -0.5, 0)),
    }),
  );
  created(simulation.create_collider({
    body: ground,
    shape: ground_shape,
    material: { friction: 1, restitution: 0, combination: "maximum" },
  }));
  const slider = created(simulation.create_body({
    motion: "dynamic",
    pose: rigid_pose(vec3(0, 0.5, 0)),
    linear_velocity: vec3(6, 0, 0),
  }));
  const ball = created(simulation.create_shape(sphere_shape(0.5)));
  created(simulation.create_collider({
    body: slider,
    shape: ball,
    material: { friction: 1, restitution: 0, combination: "maximum" },
  }));
  for (let index = 0; index < 120; index++) simulation.step();
  assert(Math.abs(simulation.body_state(slider)!.linear_velocity.x) < 1);

  const light = created(simulation.create_body({ motion: "dynamic", mass: 1 }));
  const heavy = created(
    simulation.create_body({ motion: "dynamic", mass: 10 }),
  );
  simulation.apply_impulse(light, vec3(10, 0, 0));
  simulation.apply_impulse(heavy, vec3(10, 0, 0));
  assertEquals(simulation.body_state(light)!.linear_velocity.x, 10);
  assertEquals(simulation.body_state(heavy)!.linear_velocity.x, 1);
});

Deno.test("joint families accept normalized axes, limits, motors, and break policies", () => {
  const simulation = world(vec3(0, 0, 0));
  const first = created(simulation.create_body({ motion: "static" }));
  const definitions = [
    { type: "fixed" as const },
    { type: "ball" as const },
    { type: "distance" as const, minimum: 0, maximum: 2 },
    { type: "spring" as const, rest_length: 1, stiffness: 20, damping: 2 },
    {
      type: "hinge" as const,
      axis: vec3(0, 2, 0),
      minimum_angle: -1,
      maximum_angle: 1,
      motor: { target_velocity: 2, maximum_force: 10 },
    },
    {
      type: "slider" as const,
      axis: vec3(2, 0, 0),
      minimum: -1,
      maximum: 1,
      motor: { target_velocity: 1, maximum_force: 5 },
    },
  ];
  for (const [index, definition] of definitions.entries()) {
    const second = created(
      simulation.create_body({
        motion: "dynamic",
        pose: rigid_pose(vec3(index + 1, 0, 0)),
      }),
    );
    assertEquals(
      simulation.create_joint({ first, second, definition }).type,
      "created",
    );
  }
  assertEquals(simulation.step().diagnostics.islands, definitions.length);
});

Deno.test("character mover steps over a low obstacle and blocks against a tall wall", () => {
  const simulation = world(vec3(0, 0, 0));
  const character_shape = created(simulation.create_shape(sphere_shape(0.25)));
  const low_shape = created(
    simulation.create_shape(box_shape(vec3(0.2, 0.2, 1))),
  );
  const low = created(
    simulation.create_body({
      motion: "static",
      pose: rigid_pose(vec3(1, 0.2, 0)),
    }),
  );
  created(simulation.create_collider({ body: low, shape: low_shape }));
  const stepped = simulation.move_character({
    shape: character_shape,
    pose: rigid_pose(vec3(0, 0.25, 0)),
    displacement: vec3(2, 0, 0),
    step_height: 0.5,
    maximum_slope_radians: Math.PI / 4,
    skin: 0.01,
  });
  assert(stepped.pose.position.x > 1.5);
  assert(stepped.pose.position.y > 0.25);

  const wall_shape = created(
    simulation.create_shape(box_shape(vec3(0.2, 2, 1))),
  );
  const wall = created(
    simulation.create_body({
      motion: "static",
      pose: rigid_pose(vec3(4, 1, 0)),
    }),
  );
  created(simulation.create_collider({ body: wall, shape: wall_shape }));
  const blocked = simulation.move_character({
    shape: character_shape,
    pose: rigid_pose(vec3(2, 0.25, 0)),
    displacement: vec3(4, 0, 0),
    step_height: 0,
    maximum_slope_radians: Math.PI / 4,
    skin: 0.01,
  });
  assert(blocked.pose.position.x < 4);
});

Deno.test("scene and ECS ports transfer kinematic inputs and immutable outputs", () => {
  const simulation = world(vec3(0, 0, 0));
  const kinematic = created(simulation.create_body({ motion: "kinematic" }));
  const scene = new Scene({ id: scene_id("physics-scene") });
  const created_node = scene.create_node({
    local_transform: transform(vec3(3, 2, 1), quat_identity(), vec3(1, 1, 1)),
  });
  if (created_node.type !== "created") throw new Error(created_node.reason);
  assertEquals(
    pull_scene_kinematics(simulation, scene.snapshot(), [{
      node: created_node.id,
      body: kinematic,
    }]),
    [],
  );
  assertEquals(simulation.body_state(kinematic)!.pose.position, vec3(3, 2, 1));
  assertEquals(
    scene_pose_writes([simulation.body_state(kinematic)!], [{
      node: created_node.id,
      body: kinematic,
    }])[0].node,
    created_node.id,
  );

  const published: BodyState[] = [];
  const outputs = step_with_ecs(simulation, {
    kinematic_inputs: () => [{
      entity: "player",
      body: kinematic,
      pose: rigid_pose(vec3(4, 2, 1)),
    }],
    entity_for_body: (body: BodyId) =>
      body.index === kinematic.index ? "player" : undefined,
    publish: (values) => published.push(...values.map(({ state }) => state)),
  });
  assertEquals(outputs[0].state.pose.position, vec3(4, 2, 1));
  assertEquals(published.length, 1);
});

Deno.test("terrain adapter preserves samples and holes for static collision", () => {
  const terrain = create_terrain({
    origin: global_position(0, 0, vec3(0, 0, 0), 64),
    width: 2,
    depth: 2,
    spacing: 1,
    heights: new Float32Array([0, 1, 2, 3]),
    holes: new Uint8Array([1]),
  });
  const collision = heightfield_from_terrain(terrain);
  assertEquals([...collision.heights], [0, 1, 2, 3]);
  assertEquals([...collision.holes], [1]);
});

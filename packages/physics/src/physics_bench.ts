import { ray } from "@ink/geometry/shapes.ts";
import { vec3 } from "@ink/math/vector.ts";
import { gjk_intersection, rigid_pose } from "./collision.ts";
import { physics_world_id } from "./identity.ts";
import { box_shape, sphere_shape } from "./shapes.ts";
import { type PhysicsMutationResult, PhysicsWorld } from "./world.ts";

function created<Id>(result: PhysicsMutationResult<Id>): Id {
  if (result.type === "failed") throw new Error(result.reason);
  return result.id;
}

function benchmark_world(name: string, gravity = vec3(0, 0, 0)): PhysicsWorld {
  return new PhysicsWorld({
    id: physics_world_id(name),
    fixed_step_seconds: 1 / 60,
    gravity,
  });
}

function broadphase_fixture(): PhysicsWorld {
  const world = benchmark_world("broadphase");
  const shape = created(world.create_shape(sphere_shape(0.45)));
  for (let index = 0; index < 256; index++) {
    const body = created(world.create_body({
      motion: "static",
      pose: rigid_pose(vec3(index % 16, Math.floor(index / 16), 0)),
    }));
    created(world.create_collider({ body, shape }));
  }
  return world;
}

function solver_fixture(): PhysicsWorld {
  const world = benchmark_world("solver", vec3(0, -9.81, 0));
  const ground_shape = created(world.create_shape(box_shape(vec3(8, 0.5, 8))));
  const ground = created(
    world.create_body({ motion: "static", pose: rigid_pose(vec3(0, -0.5, 0)) }),
  );
  created(world.create_collider({ body: ground, shape: ground_shape }));
  const ball = created(world.create_shape(sphere_shape(0.5)));
  for (let index = 0; index < 32; index++) {
    const body = created(world.create_body({
      motion: "dynamic",
      pose: rigid_pose(
        vec3((index % 4) * 1.05, 0.6 + Math.floor(index / 4) * 1.05, 0),
      ),
    }));
    created(world.create_collider({ body, shape: ball }));
  }
  for (let index = 0; index < 60; index++) world.step();
  return world;
}

function query_fixture(): PhysicsWorld {
  const world = benchmark_world("queries");
  const shape = created(world.create_shape(sphere_shape(0.25)));
  for (let index = 0; index < 512; index++) {
    const body = created(world.create_body({
      motion: "static",
      pose: rigid_pose(vec3(index * 0.75 + 1, 0, 0)),
    }));
    created(world.create_collider({ body, shape }));
  }
  return world;
}

const broadphase = broadphase_fixture();
const solver = solver_fixture();
const queries = query_fixture();
const convex = box_shape(vec3(1, 1, 1));
const origin = rigid_pose(vec3(0, 0, 0));
const overlap = rigid_pose(vec3(1.5, 0.1, 0.1));

Deno.bench("broadphase and pair persistence for 256 colliders", () => {
  broadphase.step();
});

Deno.bench("GJK narrowphase for 1,000 overlapping boxes", () => {
  for (let index = 0; index < 1_000; index++) {
    gjk_intersection(convex, origin, convex, overlap);
  }
});

Deno.bench("sequential solver for a 32-body stack", () => {
  solver.step();
});

Deno.bench("ordered ray query across 512 colliders", () => {
  queries.raycast(ray(vec3(0, 0, 0), vec3(1, 0, 0)), 500);
});

Deno.bench("sleeping-world fixed step", () => {
  broadphase.step();
});

Deno.bench("snapshot 512 static colliders", () => {
  queries.snapshot();
});

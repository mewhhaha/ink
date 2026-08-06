import type { MeshTopology } from "@ink/geometry/mesh.ts";
import { mat4_decompose, transform } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import type { SceneNodeId } from "@ink/scene/identity.ts";
import type { SceneSnapshot } from "@ink/scene/scene.ts";
import type { GlobalPosition, LocalOrigin } from "@ink/world/identity.ts";
import { global_to_local } from "@ink/world/identity.ts";
import type { TerrainDescriptor } from "@ink/world/terrain.ts";
import { rigid_pose, type RigidPose } from "./collision.ts";
import type { BodyId, ShapeId } from "./identity.ts";
import { heightfield_shape, triangle_mesh_shape } from "./shapes.ts";
import type { BodyState, PhysicsWorld } from "./world.ts";

export interface ScenePhysicsBinding {
  readonly node: SceneNodeId;
  readonly body: BodyId;
  readonly shape?: ShapeId;
}

export type SceneKinematicFailure =
  | { readonly type: "missing_node"; readonly binding: ScenePhysicsBinding }
  | {
    readonly type: "invalid_transform";
    readonly binding: ScenePhysicsBinding;
    readonly reason: string;
  }
  | {
    readonly type: "physics_rejected";
    readonly binding: ScenePhysicsBinding;
    readonly reason: string;
  };

export interface ScenePoseWrite {
  readonly node: SceneNodeId;
  readonly pose: RigidPose;
}

export function pull_scene_kinematics(
  world: PhysicsWorld,
  snapshot: SceneSnapshot,
  bindings: readonly ScenePhysicsBinding[],
): readonly SceneKinematicFailure[] {
  const failures: SceneKinematicFailure[] = [];
  for (const binding of ordered_bindings(bindings)) {
    const node = snapshot.nodes.find(({ id }) =>
      id.index === binding.node.index &&
      id.generation === binding.node.generation
    );
    if (node === undefined) {
      failures.push({ type: "missing_node", binding });
      continue;
    }
    const decomposed = mat4_decompose(node.world_transform);
    if (!decomposed.ok) {
      failures.push({
        type: "invalid_transform",
        binding,
        reason: `${decomposed.reason} evidence ${decomposed.evidence}`,
      });
      continue;
    }
    const changed = world.set_kinematic_pose(
      binding.body,
      rigid_pose(decomposed.value.position, decomposed.value.rotation),
    );
    if (changed.type === "failed") {
      failures.push({
        type: "physics_rejected",
        binding,
        reason: changed.reason,
      });
    }
  }
  return Object.freeze(failures.map((failure) => Object.freeze(failure)));
}

export function scene_pose_writes(
  states: readonly BodyState[],
  bindings: readonly ScenePhysicsBinding[],
): readonly ScenePoseWrite[] {
  const by_body = new Map(
    states.map((state) => [`${state.id.index}:${state.id.generation}`, state]),
  );
  return Object.freeze(
    ordered_bindings(bindings).flatMap((binding) => {
      const state = by_body.get(
        `${binding.body.index}:${binding.body.generation}`,
      );
      return state === undefined
        ? []
        : [Object.freeze({ node: binding.node, pose: state.pose })];
    }),
  );
}

export interface PhysicsEcsKinematicInput<Entity> {
  readonly entity: Entity;
  readonly body: BodyId;
  readonly pose: RigidPose;
}

export interface PhysicsEcsOutput<Entity> {
  readonly entity: Entity;
  readonly state: BodyState;
}

export interface PhysicsEcsPort<Entity> {
  kinematic_inputs(): readonly PhysicsEcsKinematicInput<Entity>[];
  entity_for_body(body: BodyId): Entity | undefined;
  publish(outputs: readonly PhysicsEcsOutput<Entity>[]): void;
}

export function step_with_ecs<Entity>(
  world: PhysicsWorld,
  port: PhysicsEcsPort<Entity>,
): readonly PhysicsEcsOutput<Entity>[] {
  for (const input of port.kinematic_inputs()) {
    const changed = world.set_kinematic_pose(input.body, input.pose);
    if (changed.type === "failed") {
      throw new Error(
        `ECS kinematic body ${input.body.index}:${input.body.generation} was rejected: ${changed.reason}`,
      );
    }
  }
  const step = world.step();
  const outputs = Object.freeze(step.poses.flatMap((state) => {
    const entity = port.entity_for_body(state.id);
    return entity === undefined ? [] : [Object.freeze({ entity, state })];
  }));
  port.publish(outputs);
  return outputs;
}

export function heightfield_from_terrain(terrain: TerrainDescriptor) {
  return heightfield_shape({
    width: terrain.width,
    depth: terrain.depth,
    spacing: terrain.spacing,
    heights: terrain.heights,
    holes: terrain.holes,
  });
}

export function static_mesh_from_topology(topology: MeshTopology) {
  return triangle_mesh_shape(topology);
}

export function terrain_local_pose(
  terrain_origin: GlobalPosition,
  simulation_origin: LocalOrigin,
  cell_size: number,
): RigidPose {
  return rigid_pose(
    global_to_local(terrain_origin, simulation_origin, cell_size),
  );
}

export function pose_to_scene_transform(pose: RigidPose) {
  return transform(pose.position, pose.rotation, vec3(1, 1, 1));
}

function ordered_bindings(
  bindings: readonly ScenePhysicsBinding[],
): ScenePhysicsBinding[] {
  return [...bindings].sort((left, right) =>
    left.node.index - right.node.index ||
    left.node.generation - right.node.generation ||
    left.body.index - right.body.index ||
    left.body.generation - right.body.generation
  );
}

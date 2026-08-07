import type { AssetId } from "@ink/assets/identity.ts";
import type { SceneNodeId } from "@ink/scene/identity.ts";
import type { Mat4 } from "@ink/math/matrix.ts";
import type { Transform } from "@ink/math/transform.ts";
import type { AnimationClip } from "./clip.ts";
import type { GraphOutput } from "./graph.ts";
import { blend_poses, type Pose, skin_matrices } from "./pose.ts";
import type { JointId, Skeleton } from "./skeleton.ts";

export interface SceneJointBinding {
  readonly joint: JointId;
  readonly node: SceneNodeId;
}
export interface SceneTransformWrite {
  readonly node: SceneNodeId;
  readonly local_transform: Transform;
}
export function scene_transform_writes(
  skeleton: Skeleton,
  pose: Pose,
  bindings: readonly SceneJointBinding[],
): readonly SceneTransformWrite[] {
  if (pose.transforms.length !== skeleton.joints.length) {
    throw new Error(
      `scene animation skeleton ${skeleton.asset} has ${skeleton.joints.length} joints but pose has ${pose.transforms.length}`,
    );
  }
  return Object.freeze(
    [...bindings].sort((left, right) =>
      left.node.index - right.node.index ||
      left.node.generation - right.node.generation
    ).map((binding) => {
      const index = skeleton.joint_indices.get(binding.joint);
      if (index === undefined) {
        throw new Error(
          `scene animation binding references missing skeleton ${skeleton.asset} joint ${binding.joint}`,
        );
      }
      return Object.freeze({
        node: binding.node,
        local_transform: pose.transforms[index],
      });
    }),
  );
}

export interface RenderingAnimationOutput {
  readonly skin_matrices: readonly Mat4[];
  readonly morph_weights: ReadonlyMap<string, number>;
}
export function rendering_output(
  skeleton: Skeleton,
  output: GraphOutput,
): RenderingAnimationOutput {
  return Object.freeze({
    skin_matrices: skin_matrices(skeleton, output.pose),
    morph_weights: output.morph_weights,
  });
}

export interface RagdollPoseInput {
  readonly pose: Pose;
  readonly weight: number;
}
export function compose_ragdoll(
  animation: Pose,
  ragdoll: RagdollPoseInput,
): Pose {
  return blend_poses(animation, ragdoll.pose, ragdoll.weight);
}

export interface AnimationEcsOutput<Entity> {
  readonly entity: Entity;
  readonly output: GraphOutput;
}
export interface AnimationEcsPort<Entity> {
  entity_for_instance(instance: string): Entity | undefined;
  publish(outputs: readonly AnimationEcsOutput<Entity>[]): void;
}
export function publish_ecs_output<Entity>(
  port: AnimationEcsPort<Entity>,
  instance: string,
  output: GraphOutput,
): void {
  const entity = port.entity_for_instance(instance);
  if (entity !== undefined) {
    port.publish(Object.freeze([Object.freeze({ entity, output })]));
  }
}

export interface DecodedGltfAnimation {
  readonly asset: AssetId<"animation">;
  readonly clip: AnimationClip;
}
export interface GltfAnimationDecoder {
  decode(
    asset: AssetId<"gltf.animation">,
    skeleton: Skeleton,
  ): DecodedGltfAnimation;
}

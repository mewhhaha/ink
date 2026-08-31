import type { Mat4 } from "@ink/math/matrix.ts";
import { mat4_multiply } from "@ink/math/matrix.ts";
import {
  quat_identity,
  quat_inverse,
  quat_multiply,
  quat_slerp,
} from "@ink/math/quaternion.ts";
import type { Transform } from "@ink/math/transform.ts";
import { transform, transform_to_mat4 } from "@ink/math/transform.ts";
import {
  vec3,
  vec3_add,
  vec3_lerp,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type { Skeleton } from "./skeleton.ts";
import { joint_id, require_joint } from "./skeleton.ts";

export interface Pose {
  readonly transforms: readonly Transform[];
}
export interface JointMask {
  readonly weights: readonly number[];
}

export function bind_pose(skeleton: Skeleton): Pose {
  return Object.freeze({
    transforms: Object.freeze(
      skeleton.joints.map(({ bind_transform }) => bind_transform),
    ),
  });
}

export function create_pose(
  skeleton: Skeleton,
  transforms: readonly Transform[],
): Pose {
  if (transforms.length !== skeleton.joints.length) {
    throw new Error(
      `skeleton ${skeleton.asset} has ${skeleton.joints.length} joints but pose has ${transforms.length}`,
    );
  }
  return Object.freeze({ transforms: Object.freeze([...transforms]) });
}

export function create_joint_mask(
  skeleton: Skeleton,
  weights: Readonly<Record<string, number>>,
  descendants = false,
): JointMask {
  const result = skeleton.joints.map(() => 0);
  for (const [source, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(`joint mask ${source} weight ${weight} must be in 0..1`);
    }
    const index = require_joint(skeleton, joint_id(source), "joint mask");
    result[index] = weight;
    if (descendants) {
      for (let child = index + 1; child < skeleton.joints.length; child++) {
        if (is_descendant(skeleton, child, index)) result[child] = weight;
      }
    }
  }
  return Object.freeze({ weights: Object.freeze(result) });
}

export function blend_poses(
  first: Pose,
  second: Pose,
  weight: number,
  mask?: JointMask,
): Pose {
  if (first.transforms.length !== second.transforms.length) {
    throw new Error(
      `cannot blend poses of ${first.transforms.length} and ${second.transforms.length} joints`,
    );
  }
  assert_mask_length(mask, first.transforms.length);
  const blend_weight = checked_weight(weight);
  return Object.freeze({
    transforms: Object.freeze(first.transforms.map((source, index) => {
      const amount = blend_weight * (mask?.weights[index] ?? 1);
      const target = second.transforms[index];
      return transform(
        vec3_lerp(source.position, target.position, amount),
        quat_slerp(source.rotation, target.rotation, amount),
        vec3_lerp(source.scale, target.scale, amount),
      );
    })),
  });
}

export function additive_pose(
  base: Pose,
  additive: Pose,
  reference: Pose,
  weight: number,
  mask?: JointMask,
): Pose {
  if (
    base.transforms.length !== additive.transforms.length ||
    base.transforms.length !== reference.transforms.length
  ) throw new Error("additive poses must have equal joint counts");
  assert_mask_length(mask, base.transforms.length);
  const blend_weight = checked_weight(weight);
  return Object.freeze({
    transforms: Object.freeze(base.transforms.map((source, index) => {
      const amount = blend_weight * (mask?.weights[index] ?? 1);
      const target = additive.transforms[index];
      const origin = reference.transforms[index];
      const rotation_delta = quat_multiply(
        target.rotation,
        quat_inverse(origin.rotation),
      );
      return transform(
        vec3_add(
          source.position,
          vec3_scale(vec3_subtract(target.position, origin.position), amount),
        ),
        quat_multiply(
          quat_slerp(quat_identity(), rotation_delta, amount),
          source.rotation,
        ),
        vec3(
          source.scale.x * (1 + (target.scale.x / origin.scale.x - 1) * amount),
          source.scale.y * (1 + (target.scale.y / origin.scale.y - 1) * amount),
          source.scale.z * (1 + (target.scale.z / origin.scale.z - 1) * amount),
        ),
      );
    })),
  });
}

export function global_pose_matrices(
  skeleton: Skeleton,
  pose: Pose,
): readonly Mat4[] {
  assert_pose_joint_count(skeleton, pose, "global pose");
  const matrices: Mat4[] = [];
  for (const [index, local] of pose.transforms.entries()) {
    const matrix = transform_to_mat4(local);
    const parent = skeleton.joints[index].parent;
    matrices.push(
      parent === null ? matrix : mat4_multiply(matrices[parent], matrix),
    );
  }
  return Object.freeze(matrices);
}

export function skin_matrices(skeleton: Skeleton, pose: Pose): readonly Mat4[] {
  return Object.freeze(
    global_pose_matrices(skeleton, pose).map((matrix, index) =>
      mat4_multiply(matrix, skeleton.joints[index].inverse_bind_matrix)
    ),
  );
}

function checked_weight(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`animation weight ${value} must be in 0..1`);
  }
  return value;
}
function assert_mask_length(mask: JointMask | undefined, joints: number): void {
  if (mask === undefined) return;
  if (mask.weights.length !== joints) {
    throw new Error(
      `animation mask has ${mask.weights.length} weights for ${joints} joints`,
    );
  }
  for (const [index, weight] of mask.weights.entries()) {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(
        `animation mask joint ${index} weight ${weight} must be in 0..1`,
      );
    }
  }
}
function assert_pose_joint_count(
  skeleton: Skeleton,
  pose: Pose,
  context: string,
): void {
  if (pose.transforms.length === skeleton.joints.length) return;
  throw new Error(
    `${context} skeleton ${skeleton.asset} has ${skeleton.joints.length} joints but pose has ${pose.transforms.length}`,
  );
}
function is_descendant(
  skeleton: Skeleton,
  child: number,
  ancestor: number,
): boolean {
  let parent = skeleton.joints[child].parent;
  while (parent !== null) {
    if (parent === ancestor) return true;
    parent = skeleton.joints[parent].parent;
  }
  return false;
}

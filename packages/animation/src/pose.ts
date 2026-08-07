import type { Mat4 } from "@ink/math/matrix.ts";
import { mat4_multiply } from "@ink/math/matrix.ts";
import {
  quat_from_axis_angle,
  quat_identity,
  quat_inverse,
  quat_multiply,
  quat_rotate_vec3,
  quat_slerp,
} from "@ink/math/quaternion.ts";
import type { Transform } from "@ink/math/transform.ts";
import { transform, transform_to_mat4 } from "@ink/math/transform.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_add,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_lerp,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type { JointId, Skeleton } from "./skeleton.ts";
import { require_joint } from "./skeleton.ts";

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
    const index = require_joint(skeleton, source as JointId, "joint mask");
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

export function apply_two_bone_ik(
  skeleton: Skeleton,
  pose: Pose,
  root: JointId,
  middle: JointId,
  tip: JointId,
  target: Vec3,
  pole: Vec3,
  weight = 1,
): Pose {
  assert_pose_joint_count(skeleton, pose, "two-bone IK");
  const blend_weight = checked_weight(weight);
  const root_index = require_joint(skeleton, root, "two-bone IK");
  const middle_index = require_joint(skeleton, middle, "two-bone IK");
  const tip_index = require_joint(skeleton, tip, "two-bone IK");
  if (
    skeleton.joints[middle_index].parent !== root_index ||
    skeleton.joints[tip_index].parent !== middle_index
  ) {
    throw new Error(
      `two-bone IK ${root}/${middle}/${tip} is not a direct chain`,
    );
  }
  const globals = global_pose_matrices(skeleton, pose);
  const root_position = vec3(
    globals[root_index][12],
    globals[root_index][13],
    globals[root_index][14],
  );
  const current = vec3_subtract(
    vec3(
      globals[tip_index][12],
      globals[tip_index][13],
      globals[tip_index][14],
    ),
    root_position,
  );
  const desired = vec3_subtract(target, root_position);
  if (vec3_length(current) === 0 || vec3_length(desired) === 0) return pose;
  const axis = vec3_cross(current, desired);
  const cosine = Math.max(
    -1,
    Math.min(1, vec3_dot(vec3_normalize(current), vec3_normalize(desired))),
  );
  const rotation = vec3_length(axis) < 1e-9
    ? pose.transforms[root_index].rotation
    : quat_multiply(
      quat_from_axis_angle(axis, Math.acos(cosine) * blend_weight),
      pose.transforms[root_index].rotation,
    );
  const transforms = [...pose.transforms];
  transforms[root_index] = transform(
    transforms[root_index].position,
    rotation,
    transforms[root_index].scale,
  );
  const upper_length = vec3_length(pose.transforms[middle_index].position);
  const lower_length = vec3_length(pose.transforms[tip_index].position);
  if (upper_length === 0 || lower_length === 0) {
    throw new Error(
      `two-bone IK ${root}/${middle}/${tip} contains zero-length bind segments ${upper_length}/${lower_length}`,
    );
  }
  const target_distance = Math.max(
    Math.abs(upper_length - lower_length) + 1e-6,
    Math.min(upper_length + lower_length - 1e-6, vec3_length(desired)),
  );
  const knee_cosine = Math.max(
    -1,
    Math.min(
      1,
      (upper_length ** 2 + lower_length ** 2 - target_distance ** 2) /
        (2 * upper_length * lower_length),
    ),
  );
  const bend_radians = Math.PI - Math.acos(knee_cosine);
  const bend_axis = vec3_cross(desired, vec3_subtract(pole, root_position));
  if (vec3_length(bend_axis) > 1e-9 && bend_radians > 1e-9) {
    transforms[middle_index] = transform(
      transforms[middle_index].position,
      quat_multiply(
        quat_from_axis_angle(
          bend_axis,
          bend_radians * blend_weight,
        ),
        transforms[middle_index].rotation,
      ),
      transforms[middle_index].scale,
    );
  }
  return create_pose(skeleton, transforms);
}

export function apply_look_at(
  skeleton: Skeleton,
  pose: Pose,
  joint: JointId,
  target: Vec3,
  forward = vec3(0, 0, 1),
  maximum_radians = Math.PI,
  weight = 1,
): Pose {
  assert_pose_joint_count(skeleton, pose, "look-at constraint");
  const blend_weight = checked_weight(weight);
  if (!Number.isFinite(maximum_radians) || maximum_radians < 0) {
    throw new Error(
      `look-at maximum radians ${maximum_radians} must be nonnegative`,
    );
  }
  const index = require_joint(skeleton, joint, "look-at constraint");
  const globals = global_pose_matrices(skeleton, pose);
  const position = vec3(
    globals[index][12],
    globals[index][13],
    globals[index][14],
  );
  const desired = vec3_subtract(target, position);
  if (vec3_length(desired) === 0) return pose;
  const current = quat_rotate_vec3(pose.transforms[index].rotation, forward);
  const axis = vec3_cross(current, desired);
  if (vec3_length(axis) < 1e-9) return pose;
  const angle = Math.min(
    maximum_radians,
    Math.acos(
      Math.max(
        -1,
        Math.min(1, vec3_dot(vec3_normalize(current), vec3_normalize(desired))),
      ),
    ),
  );
  const transforms = [...pose.transforms];
  const source = transforms[index];
  transforms[index] = transform(
    source.position,
    quat_multiply(
      quat_from_axis_angle(axis, angle * blend_weight),
      source.rotation,
    ),
    source.scale,
  );
  return create_pose(skeleton, transforms);
}

export const apply_aim = apply_look_at;

export function retarget_pose(
  source_skeleton: Skeleton,
  target_skeleton: Skeleton,
  source_pose: Pose,
): Pose {
  assert_pose_joint_count(source_skeleton, source_pose, "retarget source");
  const by_semantic = new Map<string, number>();
  for (const joint of source_skeleton.joints) {
    if (joint.retarget !== undefined) {
      by_semantic.set(joint.retarget.semantic, joint.index);
    }
  }
  const transforms = target_skeleton.joints.map((joint) => {
    if (joint.retarget === undefined) return joint.bind_transform;
    const source_index = by_semantic.get(joint.retarget.semantic);
    if (source_index === undefined) return joint.bind_transform;
    const source_joint = source_skeleton.joints[source_index];
    const source = source_pose.transforms[source_index];
    const source_scale = source_joint.retarget?.translation_scale ?? 1;
    const target_scale = joint.retarget.translation_scale ?? 1;
    return transform(
      vec3_scale(source.position, target_scale / source_scale),
      source.rotation,
      source.scale,
    );
  });
  return create_pose(target_skeleton, transforms);
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

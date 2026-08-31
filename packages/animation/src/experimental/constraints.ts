import {
  quat_from_axis_angle,
  quat_multiply,
  quat_rotate_vec3,
} from "@ink/math/quaternion.ts";
import { transform } from "@ink/math/transform.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import {
  vec3,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_normalize,
  vec3_subtract,
} from "@ink/math/vector.ts";
import { create_pose, global_pose_matrices, type Pose } from "../pose.ts";
import type { JointId, Skeleton } from "../skeleton.ts";
import { require_joint } from "../skeleton.ts";

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
        quat_from_axis_angle(bend_axis, bend_radians * blend_weight),
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

function checked_weight(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`animation weight ${value} must be in 0..1`);
  }
  return value;
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

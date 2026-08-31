import { transform } from "@ink/math/transform.ts";
import { vec3_scale } from "@ink/math/vector.ts";
import { create_pose, type Pose } from "../pose.ts";
import type { JointId, Skeleton } from "../skeleton.ts";
import { joint_id, require_joint } from "../skeleton.ts";

declare const retarget_semantic_brand: unique symbol;
export type RetargetSemantic = string & {
  readonly [retarget_semantic_brand]: true;
};

export interface RetargetJointMappingSource {
  readonly joint: string;
  readonly semantic: string;
  readonly translation_scale?: number;
}

export interface RetargetJointMapping {
  readonly joint: JointId;
  readonly joint_index: number;
  readonly semantic: RetargetSemantic;
  readonly translation_scale: number;
}

export interface RetargetProfile {
  readonly skeleton: Skeleton;
  readonly mappings: readonly RetargetJointMapping[];
}

export interface RetargetPoseSource {
  readonly profile: RetargetProfile;
  readonly pose: Pose;
}

export function create_retarget_profile(
  skeleton: Skeleton,
  sources: readonly RetargetJointMappingSource[],
): RetargetProfile {
  const mapped_joints = new Set<JointId>();
  const joints_by_semantic = new Map<RetargetSemantic, JointId>();
  const mappings = sources.map((source) => {
    const joint = joint_id(source.joint);
    const joint_index = require_joint(skeleton, joint, "retarget profile");
    if (mapped_joints.has(joint)) {
      throw new Error(
        `retarget profile ${skeleton.asset} repeats joint ${joint}`,
      );
    }
    const semantic_source = source.semantic.trim();
    if (semantic_source.length === 0) {
      throw new Error(
        `retarget profile ${skeleton.asset} joint ${joint} semantic cannot be empty`,
      );
    }
    const semantic = semantic_source as RetargetSemantic;
    const existing_joint = joints_by_semantic.get(semantic);
    if (existing_joint !== undefined) {
      throw new Error(
        `retarget profile ${skeleton.asset} joints ${existing_joint} and ${joint} repeat semantic ${semantic}`,
      );
    }
    const translation_scale = source.translation_scale ?? 1;
    if (!Number.isFinite(translation_scale) || translation_scale <= 0) {
      throw new Error(
        `retarget profile ${skeleton.asset} joint ${joint} translation scale ${translation_scale} must be positive`,
      );
    }
    mapped_joints.add(joint);
    joints_by_semantic.set(semantic, joint);
    return Object.freeze({
      joint,
      joint_index,
      semantic,
      translation_scale,
    });
  });
  return Object.freeze({
    skeleton,
    mappings: Object.freeze(mappings),
  });
}

export function retarget_pose(
  source: RetargetPoseSource,
  target: RetargetProfile,
): Pose {
  if (
    source.pose.transforms.length !== source.profile.skeleton.joints.length
  ) {
    throw new Error(
      `retarget source skeleton ${source.profile.skeleton.asset} has ${source.profile.skeleton.joints.length} joints but pose has ${source.pose.transforms.length}`,
    );
  }
  const source_by_semantic = new Map(
    source.profile.mappings.map((mapping) => [mapping.semantic, mapping]),
  );
  const target_by_index = new Map(
    target.mappings.map((mapping) => [mapping.joint_index, mapping]),
  );
  const transforms = target.skeleton.joints.map((joint) => {
    const target_mapping = target_by_index.get(joint.index);
    if (target_mapping === undefined) return joint.bind_transform;
    const source_mapping = source_by_semantic.get(target_mapping.semantic);
    if (source_mapping === undefined) return joint.bind_transform;
    const source_transform = source.pose.transforms[source_mapping.joint_index];
    return transform(
      vec3_scale(
        source_transform.position,
        target_mapping.translation_scale / source_mapping.translation_scale,
      ),
      source_transform.rotation,
      source_transform.scale,
    );
  });
  return create_pose(target.skeleton, transforms);
}

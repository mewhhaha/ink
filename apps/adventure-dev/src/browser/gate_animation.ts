import { create_clip, sample_clip } from "@ink/animation/clip.ts";
import {
  bind_pose,
  blend_poses,
  global_pose_matrices,
} from "@ink/animation/pose.ts";
import { create_skeleton, joint_id } from "@ink/animation/skeleton.ts";
import { asset_id } from "@ink/assets/identity.ts";
import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import { quat_from_axis_angle, quat_identity } from "@ink/math/quaternion.ts";
import { transform_identity } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";

const gate_object_id = 106;
const gate_joint = joint_id("oak-gate-hinge");
const gate_skeleton = create_skeleton(
  asset_id<"skeleton">("adventure/oak-gate.skeleton"),
  [{ id: gate_joint, bind_transform: transform_identity() }],
);
const gate_clip = create_clip(gate_skeleton, {
  asset: asset_id<"animation">("adventure/oak-gate-open.animation"),
  duration: 1,
  looping: false,
  tracks: [{
    joint: gate_joint,
    interpolation: "linear",
    positions: [
      { time: 0, value: vec3(0, 0, 0) },
      { time: 1, value: vec3(-1.6, 0, -1.4) },
    ],
    rotations: [
      { time: 0, value: quat_identity() },
      {
        time: 1,
        value: quat_from_axis_angle(vec3(0, 1, 0), -Math.PI * 0.44),
      },
    ],
  }],
  properties: [],
  morphs: [],
  events: [],
});

export interface AdventureGateAnimation {
  readonly sample_time: number;
  readonly position_offset: readonly [number, number, number];
  readonly rotation_y_radians: number;
  readonly scale: readonly [number, number, number];
  readonly rendered_visible: true;
}

export function adventure_gate_animation(
  snapshot: RenderSnapshot,
): AdventureGateAnimation {
  const gate = snapshot.objects.find(({ id }) => id === gate_object_id);
  if (gate === undefined) {
    throw new Error(
      `adventure animation snapshot omitted oak gate ${gate_object_id}`,
    );
  }
  const sample_time = gate.visible ? 0 : 1;
  const sampled = sample_clip(gate_skeleton, gate_clip, sample_time);
  const pose = blend_poses(
    bind_pose(gate_skeleton),
    sampled.pose,
    sample_time,
  );
  const matrix = global_pose_matrices(gate_skeleton, pose)[0];
  const rotation = pose.transforms[0].rotation;
  const position_offset: [number, number, number] = [
    matrix[12],
    matrix[13],
    matrix[14],
  ];
  const scale: [number, number, number] = [
    Math.hypot(matrix[0], matrix[1], matrix[2]),
    Math.hypot(matrix[4], matrix[5], matrix[6]),
    Math.hypot(matrix[8], matrix[9], matrix[10]),
  ];
  return Object.freeze({
    sample_time,
    position_offset: Object.freeze(position_offset),
    rotation_y_radians: 2 * Math.atan2(rotation.y, rotation.w),
    scale: Object.freeze(scale),
    rendered_visible: true,
  });
}

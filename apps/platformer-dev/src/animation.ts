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

const player_object_id = 10;
const platform_object_minimum = 100;
const player_joint = joint_id("player-body");
const player_skeleton = create_skeleton(
  asset_id<"skeleton">("platformer/player.skeleton"),
  [{ id: player_joint, bind_transform: transform_identity() }],
);
const jump_clip = create_clip(player_skeleton, {
  asset: asset_id<"animation">("platformer/player-jump.animation"),
  duration: 1,
  looping: false,
  tracks: [{
    joint: player_joint,
    interpolation: "linear",
    positions: [
      { time: 0, value: vec3(0, 0, 0) },
      { time: 0.5, value: vec3(0, 0.22, 0) },
      { time: 1, value: vec3(0, -0.14, 0) },
    ],
    rotations: [
      { time: 0, value: quat_identity() },
      {
        time: 0.5,
        value: quat_from_axis_angle(vec3(0, 0, 1), -0.24),
      },
      {
        time: 1,
        value: quat_from_axis_angle(vec3(0, 0, 1), 0.14),
      },
    ],
    scales: [
      { time: 0, value: vec3(1, 1, 1) },
      { time: 0.5, value: vec3(0.82, 1.18, 1) },
      { time: 1, value: vec3(1.18, 0.84, 1) },
    ],
  }],
  properties: [],
  morphs: [],
  events: [],
});

export interface PlatformerPlayerAnimation {
  readonly sample_time: number;
  readonly position_offset: readonly [number, number, number];
  readonly rotation_z_radians: number;
  readonly scale: readonly [number, number, number];
}

export function platformer_player_animation(
  snapshot: RenderSnapshot,
): PlatformerPlayerAnimation {
  const player = snapshot.objects.find(({ id }) => id === player_object_id);
  if (player === undefined) {
    throw new Error(
      `platformer animation snapshot omitted player ${player_object_id}`,
    );
  }
  const support_top = snapshot.objects
    .filter(({ id, visible }) => id >= platform_object_minimum && visible)
    .filter((platform) => {
      const player_left = player.position[0] - player.scale[0] / 2;
      const player_right = player.position[0] + player.scale[0] / 2;
      const platform_left = platform.position[0] - platform.scale[0] / 2;
      const platform_right = platform.position[0] + platform.scale[0] / 2;
      return player_right > platform_left && player_left < platform_right;
    })
    .map((platform) => platform.position[1] + platform.scale[1] / 2)
    .filter((top) => top <= player.position[1])
    .reduce((highest, top) => Math.max(highest, top), Number.NEGATIVE_INFINITY);
  const grounded_center = Number.isFinite(support_top)
    ? support_top + player.scale[1] / 2
    : player.position[1];
  const authored_jump_height = player.scale[1] * 0.75;
  const sample_time = Math.max(
    0,
    Math.min(1, (player.position[1] - grounded_center) / authored_jump_height),
  );
  const sampled = sample_clip(player_skeleton, jump_clip, sample_time);
  const pose = blend_poses(
    bind_pose(player_skeleton),
    sampled.pose,
    Math.min(1, sample_time * 2),
  );
  const matrix = global_pose_matrices(player_skeleton, pose)[0];
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
    rotation_z_radians: 2 * Math.atan2(rotation.z, rotation.w),
    scale: Object.freeze(scale),
  });
}

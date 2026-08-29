import type { GameAction } from "@ink/blot/protocol.ts";

export interface DungeonDebugCamera {
  readonly yaw: number;
  readonly pitch: number;
  readonly offset_x: number;
  readonly offset_y: number;
  readonly offset_z: number;
  readonly zoom: number;
}

export interface DungeonDebugMovement {
  readonly forward: number;
  readonly right: number;
  readonly vertical: number;
}

export const default_dungeon_debug_camera: DungeonDebugCamera = {
  yaw: -320_000,
  pitch: -620_000,
  offset_x: 0,
  offset_y: -900_000,
  offset_z: 0,
  zoom: 900_000,
};

const debug_camera_event = 41;
const camera_value_offset = 10_000_000;

export function orbit_dungeon_debug_camera(
  camera: DungeonDebugCamera,
  movement_x: number,
  movement_y: number,
): DungeonDebugCamera {
  return {
    ...camera,
    yaw: normalize_angle(camera.yaw + Math.round(movement_x * 8_000)),
    pitch: clamp(
      camera.pitch + Math.round(movement_y * 8_000),
      -1_350_000,
      -120_000,
    ),
  };
}

export function pan_dungeon_debug_camera(
  camera: DungeonDebugCamera,
  movement_x: number,
  movement_y: number,
): DungeonDebugCamera {
  const units_per_pixel = 12_000 * default_dungeon_debug_camera.zoom /
    camera.zoom;
  return {
    ...camera,
    offset_x: clamp(
      camera.offset_x + Math.round(movement_x * units_per_pixel),
      -12_000_000,
      12_000_000,
    ),
    offset_y: clamp(
      camera.offset_y - Math.round(movement_y * units_per_pixel),
      -12_000_000,
      12_000_000,
    ),
  };
}

export function dolly_dungeon_debug_camera(
  camera: DungeonDebugCamera,
  wheel_delta_y: number,
): DungeonDebugCamera {
  return {
    ...camera,
    zoom: clamp(
      Math.round(camera.zoom * Math.exp(-wheel_delta_y * 0.001)),
      400_000,
      1_800_000,
    ),
  };
}

export function move_dungeon_debug_camera(
  camera: DungeonDebugCamera,
  movement: DungeonDebugMovement,
  elapsed_milliseconds: number,
  speed_multiplier = 1,
): DungeonDebugCamera {
  if (!Number.isFinite(elapsed_milliseconds) || elapsed_milliseconds < 0) {
    throw new Error(
      `debug camera elapsed milliseconds ${elapsed_milliseconds} must be finite and nonnegative`,
    );
  }
  if (!Number.isFinite(speed_multiplier) || speed_multiplier <= 0) {
    throw new Error(
      `debug camera speed multiplier ${speed_multiplier} must be finite and positive`,
    );
  }
  const ground_length = Math.hypot(movement.forward, movement.right);
  const ground_scale = ground_length > 1 ? 1 / ground_length : 1;
  const forward = movement.forward * ground_scale;
  const right = movement.right * ground_scale;
  const distance = Math.min(elapsed_milliseconds, 100) / 1_000 * 3_600_000 *
    speed_multiplier;
  const yaw = camera.yaw / 1_000_000;
  return {
    ...camera,
    offset_x: clamp(
      camera.offset_x + Math.round(
        (Math.sin(yaw) * forward - Math.cos(yaw) * right) * distance,
      ),
      -12_000_000,
      12_000_000,
    ),
    offset_y: clamp(
      camera.offset_y - Math.round(movement.vertical * distance),
      -12_000_000,
      12_000_000,
    ),
    offset_z: clamp(
      camera.offset_z + Math.round(
        (Math.cos(yaw) * forward + Math.sin(yaw) * right) * distance,
      ),
      -12_000_000,
      12_000_000,
    ),
  };
}

export function dungeon_debug_camera_updates(
  previous: DungeonDebugCamera,
  camera: DungeonDebugCamera,
): readonly Extract<GameAction, { readonly type: "custom" }>[] {
  const updates: Extract<GameAction, { readonly type: "custom" }>[] = [];
  if (camera.yaw !== previous.yaw) updates.push(camera_update(0, camera.yaw));
  if (camera.pitch !== previous.pitch) {
    updates.push(camera_update(1, camera.pitch));
  }
  if (camera.offset_x !== previous.offset_x) {
    updates.push(camera_update(2, camera.offset_x));
  }
  if (camera.offset_y !== previous.offset_y) {
    updates.push(camera_update(3, camera.offset_y));
  }
  if (camera.zoom !== previous.zoom) {
    updates.push(camera_update(4, camera.zoom));
  }
  if (camera.offset_z !== previous.offset_z) {
    updates.push(camera_update(5, camera.offset_z));
  }
  return updates;
}

function camera_update(
  target: number,
  value: number,
): Extract<GameAction, { readonly type: "custom" }> {
  return {
    type: "custom",
    kind: debug_camera_event,
    target,
    value: value + camera_value_offset,
  };
}

function normalize_angle(angle: number): number {
  const full_turn = Math.PI * 2_000_000;
  const normalized = (angle + Math.PI * 1_000_000) % full_turn;
  return Math.round(
    (normalized < 0 ? normalized + full_turn : normalized) -
      Math.PI * 1_000_000,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

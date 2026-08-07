import type { InputFrame } from "@ink/input/model.ts";
import {
  quat_from_axis_angle,
  quat_multiply,
  quat_rotate_vec3,
} from "@ink/math/quaternion.ts";
import { finite_number } from "@ink/math/scalar.ts";
import {
  type Vec3,
  vec3,
  vec3_add,
  vec3_lerp,
  vec3_scale,
} from "@ink/math/vector.ts";
import type { CameraPose } from "./model.ts";

export interface FirstPersonState {
  readonly position: Vec3;
  readonly yaw: number;
  readonly pitch: number;
}

export interface FirstPersonControls {
  readonly move_action: string;
  readonly look_action: string;
  readonly vertical_action?: string;
  readonly move_speed: number;
  readonly look_speed: number;
}

export interface OrbitState {
  readonly target: Vec3;
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
}

export interface OrbitControls {
  readonly orbit_action: string;
  readonly zoom_action: string;
  readonly orbit_speed: number;
  readonly zoom_speed: number;
  readonly minimum_distance: number;
  readonly maximum_distance: number;
}

export interface PanZoomState {
  readonly center: Vec3;
  readonly vertical_size: number;
}

export interface PanZoomControls {
  readonly pan_action: string;
  readonly zoom_action: string;
  readonly pan_speed: number;
  readonly zoom_speed: number;
  readonly minimum_size: number;
  readonly maximum_size: number;
}

export interface FollowState {
  readonly position: Vec3;
}

export interface ShakeState {
  readonly seed: number;
  readonly elapsed_seconds: number;
  readonly duration_seconds: number;
  readonly amplitude: number;
  readonly frequency: number;
}

export function update_first_person(
  state: FirstPersonState,
  controls: FirstPersonControls,
  input: InputFrame,
  delta_seconds: number,
): { readonly state: FirstPersonState; readonly pose: CameraPose } {
  parse_delta(delta_seconds);
  const move_speed = positive(controls.move_speed, "first-person move speed");
  const look_speed = positive(controls.look_speed, "first-person look speed");
  const move = axis2_action(input, controls.move_action);
  const look = axis2_action(input, controls.look_action);
  const yaw = state.yaw - look.x * look_speed * delta_seconds;
  const pitch = Math.max(
    -Math.PI / 2 + 0.001,
    Math.min(
      Math.PI / 2 - 0.001,
      state.pitch - look.y * look_speed * delta_seconds,
    ),
  );
  const rotation = yaw_pitch_rotation(yaw, pitch);
  const local_motion = vec3(
    move.x,
    scalar_action(input, controls.vertical_action),
    -move.y,
  );
  const position = vec3_add(
    state.position,
    vec3_scale(
      quat_rotate_vec3(rotation, local_motion),
      move_speed * delta_seconds,
    ),
  );
  const next = { position, yaw, pitch };
  return { state: next, pose: { position, rotation } };
}

export function update_orbit(
  state: OrbitState,
  controls: OrbitControls,
  input: InputFrame,
  delta_seconds: number,
): { readonly state: OrbitState; readonly pose: CameraPose } {
  parse_delta(delta_seconds);
  const orbit = axis2_action(input, controls.orbit_action);
  const yaw = state.yaw -
    orbit.x * positive(controls.orbit_speed, "orbit speed") * delta_seconds;
  const pitch = Math.max(
    -Math.PI / 2 + 0.001,
    Math.min(
      Math.PI / 2 - 0.001,
      state.pitch - orbit.y * controls.orbit_speed * delta_seconds,
    ),
  );
  const minimum = positive(controls.minimum_distance, "minimum orbit distance");
  const maximum = positive(controls.maximum_distance, "maximum orbit distance");
  if (maximum < minimum) {
    throw new Error(
      `maximum orbit distance ${maximum} is below minimum ${minimum}`,
    );
  }
  const distance = Math.max(
    minimum,
    Math.min(
      maximum,
      state.distance * Math.exp(
        scalar_action(input, controls.zoom_action) *
          positive(controls.zoom_speed, "orbit zoom speed") * delta_seconds,
      ),
    ),
  );
  const rotation = yaw_pitch_rotation(yaw, pitch);
  const position = vec3_add(
    state.target,
    quat_rotate_vec3(rotation, vec3(0, 0, distance)),
  );
  return {
    state: { ...state, distance, yaw, pitch },
    pose: { position, rotation },
  };
}

export function update_pan_zoom(
  state: PanZoomState,
  controls: PanZoomControls,
  input: InputFrame,
  delta_seconds: number,
): PanZoomState {
  parse_delta(delta_seconds);
  const pan = axis2_action(input, controls.pan_action);
  const pan_speed = positive_or_zero(controls.pan_speed, "pan speed");
  const minimum = positive(controls.minimum_size, "minimum orthographic size");
  const maximum = positive(controls.maximum_size, "maximum orthographic size");
  if (maximum < minimum) {
    throw new Error(
      `maximum orthographic size ${maximum} is below minimum ${minimum}`,
    );
  }
  const vertical_size = Math.max(
    minimum,
    Math.min(
      maximum,
      state.vertical_size * Math.exp(
        scalar_action(input, controls.zoom_action) *
          positive(controls.zoom_speed, "pan zoom speed") * delta_seconds,
      ),
    ),
  );
  const center = vec3_add(
    state.center,
    vec3(
      pan.x * pan_speed * vertical_size * delta_seconds,
      pan.y * pan_speed * vertical_size * delta_seconds,
      0,
    ),
  );
  return { center, vertical_size };
}

export function update_follow(
  state: FollowState,
  target: Vec3,
  response_per_second: number,
  delta_seconds: number,
): FollowState {
  parse_delta(delta_seconds);
  const response = positive(response_per_second, "follow response");
  const amount = 1 - Math.exp(-response * delta_seconds);
  return { position: vec3_lerp(state.position, target, amount) };
}

export function apply_shake(
  pose: CameraPose,
  state: ShakeState,
  delta_seconds: number,
): { readonly pose: CameraPose; readonly state: ShakeState } {
  parse_delta(delta_seconds);
  if (!Number.isSafeInteger(state.seed)) {
    throw new Error(
      `shake seed ${JSON.stringify(state.seed)} must be a safe integer`,
    );
  }
  const duration = positive(state.duration_seconds, "shake duration");
  const amplitude = positive_or_zero(state.amplitude, "shake amplitude");
  const frequency = positive(state.frequency, "shake frequency");
  const previous_elapsed = positive_or_zero(
    state.elapsed_seconds,
    "shake elapsed seconds",
  );
  const elapsed_seconds = Math.min(
    duration,
    previous_elapsed + delta_seconds,
  );
  const envelope = 1 - elapsed_seconds / duration;
  const phase = elapsed_seconds * frequency * Math.PI * 2;
  const offset = vec3(
    Math.sin(phase + hash_phase(state.seed, 0)),
    Math.sin(phase * 1.17 + hash_phase(state.seed, 1)),
    Math.sin(phase * 0.83 + hash_phase(state.seed, 2)),
  );
  return {
    pose: {
      ...pose,
      position: vec3_add(
        pose.position,
        vec3_scale(offset, amplitude * envelope),
      ),
    },
    state: { ...state, elapsed_seconds },
  };
}

function yaw_pitch_rotation(yaw: number, pitch: number) {
  return quat_multiply(
    quat_from_axis_angle(vec3(0, 1, 0), yaw),
    quat_from_axis_angle(vec3(1, 0, 0), pitch),
  );
}

function axis2_action(frame: InputFrame, id: string) {
  const action = frame.actions.find((candidate) => candidate.id === id);
  return action?.value.type === "axis2" ? action.value.value : { x: 0, y: 0 };
}

function scalar_action(frame: InputFrame, id: string | undefined): number {
  if (id === undefined) return 0;
  const action = frame.actions.find((candidate) => candidate.id === id);
  return action?.value.type === "scalar" ? action.value.value : 0;
}

function parse_delta(value: number): void {
  finite_number(value, "camera controller delta seconds");
  if (value < 0) {
    throw new Error(`camera controller delta ${value} cannot be negative`);
  }
}

function positive(value: number, label: string): number {
  finite_number(value, label);
  if (value <= 0) throw new Error(`${label} ${value} must be positive`);
  return value;
}

function positive_or_zero(value: number, label: string): number {
  finite_number(value, label);
  if (value < 0) throw new Error(`${label} ${value} cannot be negative`);
  return value;
}

function hash_phase(seed: number, axis: number): number {
  let value = (seed ^ (axis * 0x9e37_79b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0_aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a_2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 0xffff_ffff * Math.PI * 2;
}

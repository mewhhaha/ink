import {
  type Vec3,
  vec3,
  vec3_cross,
  vec3_dot,
  vec3_length,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type {
  AudioEmitter,
  AudioListener,
  ConeAttenuation,
  DistanceAttenuation,
  SpatialPlayback,
} from "./model.ts";

export interface SpatialMix extends SpatialPlayback {
  readonly web_audio_position: Vec3;
}

export function spatial_mix(
  emitter: AudioEmitter,
  listener: AudioListener,
  distance: DistanceAttenuation,
  cone: ConeAttenuation | undefined,
  doppler_factor: number,
  speed_of_sound = 343,
): SpatialMix {
  if (!Number.isFinite(doppler_factor) || doppler_factor < 0) {
    throw new Error(
      `audio Doppler factor ${
        JSON.stringify(doppler_factor)
      } must be nonnegative`,
    );
  }
  if (!Number.isFinite(speed_of_sound) || speed_of_sound <= 0) {
    throw new Error(
      `audio speed of sound ${JSON.stringify(speed_of_sound)} must be positive`,
    );
  }
  const listener_forward = vec3_normalize(listener.forward);
  const listener_up = vec3_normalize(listener.up);
  const right = vec3_normalize(vec3_cross(listener_forward, listener_up));
  const displacement = vec3_subtract(emitter.position, listener.position);
  const separation = vec3_length(displacement);
  const direction = separation === 0
    ? listener_forward
    : vec3_scale(displacement, 1 / separation);
  const distance_gain = distance_attenuation(separation, distance);
  const cone_gain = cone === undefined
    ? 1
    : cone_attenuation(emitter.forward, vec3_scale(direction, -1), cone);
  const radial_listener = vec3_dot(listener.velocity, direction);
  const radial_emitter = vec3_dot(emitter.velocity, direction);
  const doppler_pitch = resolve_doppler_pitch(
    radial_listener,
    radial_emitter,
    doppler_factor,
    speed_of_sound,
  );
  return {
    gain: distance_gain * cone_gain,
    pan: Math.max(-1, Math.min(1, vec3_dot(direction, right))),
    doppler_pitch,
    web_audio_position: ink_to_web_audio(displacement),
  };
}

function resolve_doppler_pitch(
  radial_listener: number,
  radial_emitter: number,
  doppler_factor: number,
  speed_of_sound: number,
): number {
  if (doppler_factor === 0) return 1;
  const maximum_radial_speed = speed_of_sound / doppler_factor;
  const listener_speed = Math.max(
    -maximum_radial_speed,
    Math.min(maximum_radial_speed, radial_listener),
  );
  const emitter_speed = Math.max(
    -maximum_radial_speed,
    Math.min(maximum_radial_speed, radial_emitter),
  );
  const numerator = speed_of_sound - doppler_factor * listener_speed;
  const denominator = speed_of_sound - doppler_factor * emitter_speed;
  if (denominator <= 0) return 2;
  return Math.max(0.5, Math.min(2, numerator / denominator));
}

export function distance_attenuation(
  distance: number,
  settings: DistanceAttenuation,
): number {
  if (!Number.isFinite(distance) || distance < 0) {
    throw new Error(
      `audio distance ${JSON.stringify(distance)} must be nonnegative`,
    );
  }
  if (settings.type === "none") return 1;
  const reference = positive(settings.reference_distance, "reference distance");
  const maximum = positive(settings.maximum_distance, "maximum distance");
  const rolloff = nonnegative(settings.rolloff, "distance rolloff");
  if (maximum < reference) {
    throw new Error(
      `audio maximum distance ${maximum} is below reference ${reference}`,
    );
  }
  const clamped = Math.max(reference, Math.min(maximum, distance));
  if (settings.type === "linear") {
    if (maximum === reference) return distance <= reference ? 1 : 0;
    return Math.max(
      0,
      1 - rolloff * (clamped - reference) / (maximum - reference),
    );
  }
  if (settings.type === "inverse") {
    return reference / (reference + rolloff * (clamped - reference));
  }
  return Math.pow(clamped / reference, -rolloff);
}

export function cone_attenuation(
  emitter_forward: Vec3,
  direction_to_listener: Vec3,
  cone: ConeAttenuation,
): number {
  if (
    !Number.isFinite(cone.inner_angle_radians) ||
    cone.inner_angle_radians < 0 ||
    !Number.isFinite(cone.outer_angle_radians) ||
    cone.outer_angle_radians < cone.inner_angle_radians ||
    cone.outer_angle_radians > Math.PI * 2
  ) {
    throw new Error(
      `audio cone angles ${
        JSON.stringify(cone)
      } need 0 <= inner <= outer <= 2pi`,
    );
  }
  if (
    !Number.isFinite(cone.outer_gain) || cone.outer_gain < 0 ||
    cone.outer_gain > 1
  ) {
    throw new Error(
      `audio cone outer gain ${
        JSON.stringify(cone.outer_gain)
      } must be in 0..1`,
    );
  }
  const cosine = Math.max(
    -1,
    Math.min(
      1,
      vec3_dot(
        vec3_normalize(emitter_forward),
        vec3_normalize(direction_to_listener),
      ),
    ),
  );
  const angle = Math.acos(cosine) * 2;
  if (angle <= cone.inner_angle_radians) return 1;
  if (angle >= cone.outer_angle_radians) return cone.outer_gain;
  const amount = (angle - cone.inner_angle_radians) /
    (cone.outer_angle_radians - cone.inner_angle_radians);
  return 1 + (cone.outer_gain - 1) * amount;
}

export function ink_to_web_audio(position: Vec3): Vec3 {
  return vec3(position.x, position.y, position.z);
}

export function rebase_audio_position(position: Vec3, shift: Vec3): Vec3 {
  return vec3_subtract(position, shift);
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`audio ${label} ${JSON.stringify(value)} must be positive`);
  }
  return value;
}

function nonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `audio ${label} ${JSON.stringify(value)} must be nonnegative`,
    );
  }
  return value;
}

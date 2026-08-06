import type { AssetId } from "@ink/assets/identity.ts";
import type { Quat } from "@ink/math/quaternion.ts";
import { quat_slerp } from "@ink/math/quaternion.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3, vec3_lerp, vec3_subtract } from "@ink/math/vector.ts";
import { transform } from "@ink/math/transform.ts";
import type { JointId, Skeleton } from "./skeleton.ts";
import { require_joint } from "./skeleton.ts";
import { bind_pose, create_pose, type Pose } from "./pose.ts";

export type Interpolation = "step" | "linear" | "cubic";
export interface ScalarKey {
  readonly time: number;
  readonly value: number;
  readonly in_tangent?: number;
  readonly out_tangent?: number;
}
export interface Vec3Key {
  readonly time: number;
  readonly value: Vec3;
  readonly in_tangent?: Vec3;
  readonly out_tangent?: Vec3;
}
export interface QuatKey {
  readonly time: number;
  readonly value: Quat;
}
export interface JointTrack {
  readonly joint: JointId;
  readonly interpolation: Interpolation;
  readonly positions?: readonly Vec3Key[];
  readonly rotations?: readonly QuatKey[];
  readonly scales?: readonly Vec3Key[];
}
export interface PropertyTrack {
  readonly property: string;
  readonly interpolation: Interpolation;
  readonly keys: readonly ScalarKey[];
  readonly default_value: number;
}
export interface MorphTrack {
  readonly morph: string;
  readonly interpolation: Interpolation;
  readonly keys: readonly ScalarKey[];
  readonly default_weight: number;
}
export interface ClipEvent {
  readonly time: number;
  readonly name: string;
  readonly payload?: string;
}
export interface AnimationClip {
  readonly asset: AssetId<"animation">;
  readonly duration: number;
  readonly looping: boolean;
  readonly tracks: readonly JointTrack[];
  readonly properties: readonly PropertyTrack[];
  readonly morphs: readonly MorphTrack[];
  readonly events: readonly ClipEvent[];
  readonly root_joint?: JointId;
}
export interface ClipSample {
  readonly pose: Pose;
  readonly properties: ReadonlyMap<string, number>;
  readonly morph_weights: ReadonlyMap<string, number>;
}
export interface TraversedEvent extends ClipEvent {
  readonly occurrence_time: number;
}
export interface RootMotionDelta {
  readonly translation: Vec3;
}

export function create_clip(
  skeleton: Skeleton,
  source: AnimationClip,
): AnimationClip {
  if (!Number.isFinite(source.duration) || source.duration <= 0) {
    throw new Error(
      `animation ${source.asset} duration ${source.duration} must be positive`,
    );
  }
  const joints = new Set<string>();
  for (const track of source.tracks) {
    require_joint(skeleton, track.joint, `animation ${source.asset}`);
    if (joints.has(track.joint)) {
      throw new Error(
        `animation ${source.asset} repeats joint track ${track.joint}`,
      );
    }
    joints.add(track.joint);
    parse_keys(
      source.asset,
      track.positions ?? [],
      source.duration,
      `${track.joint} positions`,
    );
    parse_keys(
      source.asset,
      track.rotations ?? [],
      source.duration,
      `${track.joint} rotations`,
    );
    parse_keys(
      source.asset,
      track.scales ?? [],
      source.duration,
      `${track.joint} scales`,
    );
  }
  const properties = parse_scalar_tracks(
    source.asset,
    source.properties,
    source.duration,
    "property",
  );
  const morphs = parse_scalar_tracks(
    source.asset,
    source.morphs,
    source.duration,
    "morph",
  );
  const events = [...source.events].map((event, index) => {
    if (
      !Number.isFinite(event.time) || event.time < 0 ||
      event.time > source.duration
    ) {
      throw new Error(
        `animation ${source.asset} event ${index} time ${event.time} is outside 0..${source.duration}`,
      );
    }
    const name = event.name.trim();
    if (name.length === 0) {
      throw new Error(
        `animation ${source.asset} event ${index} name cannot be empty`,
      );
    }
    return Object.freeze({ ...event, name });
  }).sort((left, right) =>
    left.time - right.time || left.name.localeCompare(right.name)
  );
  if (source.root_joint !== undefined) {
    require_joint(
      skeleton,
      source.root_joint,
      `animation ${source.asset} root motion`,
    );
  }
  const tracks = source.tracks.map((track) =>
    Object.freeze({
      ...track,
      ...(track.positions === undefined
        ? {}
        : { positions: Object.freeze([...track.positions]) }),
      ...(track.rotations === undefined
        ? {}
        : { rotations: Object.freeze([...track.rotations]) }),
      ...(track.scales === undefined
        ? {}
        : { scales: Object.freeze([...track.scales]) }),
    })
  );
  return Object.freeze({
    ...source,
    tracks: Object.freeze(tracks),
    properties: Object.freeze(properties as PropertyTrack[]),
    morphs: Object.freeze(morphs as MorphTrack[]),
    events: Object.freeze(events),
  });
}

export function sample_clip(
  skeleton: Skeleton,
  clip: AnimationClip,
  time: number,
): ClipSample {
  const sampled_time = clip_time(clip, time);
  const transforms = [...bind_pose(skeleton).transforms];
  for (const track of clip.tracks) {
    const index = require_joint(
      skeleton,
      track.joint,
      `animation ${clip.asset}`,
    );
    const fallback = transforms[index];
    transforms[index] = transform(
      track.positions === undefined
        ? fallback.position
        : sample_vec3(track.positions, sampled_time, track.interpolation),
      track.rotations === undefined
        ? fallback.rotation
        : sample_quat(track.rotations, sampled_time, track.interpolation),
      track.scales === undefined
        ? fallback.scale
        : sample_vec3(track.scales, sampled_time, track.interpolation),
    );
  }
  return Object.freeze({
    pose: create_pose(skeleton, transforms),
    properties: new Map(
      clip.properties.map((
        track,
      ) => [
        track.property,
        sample_scalar(
          track.keys,
          sampled_time,
          track.interpolation,
          track.default_value,
        ),
      ]),
    ),
    morph_weights: new Map(
      clip.morphs.map((
        track,
      ) => [
        track.morph,
        sample_scalar(
          track.keys,
          sampled_time,
          track.interpolation,
          track.default_weight,
        ),
      ]),
    ),
  });
}

export function traverse_events(
  clip: AnimationClip,
  previous_time: number,
  current_time: number,
): readonly TraversedEvent[] {
  if (previous_time === current_time || clip.events.length === 0) {
    return Object.freeze([]);
  }
  const forward = current_time > previous_time;
  const occurrences: TraversedEvent[] = [];
  const minimum_loop = clip.looping
    ? Math.floor(Math.min(previous_time, current_time) / clip.duration) - 1
    : 0;
  const maximum_loop = clip.looping
    ? Math.floor(Math.max(previous_time, current_time) / clip.duration) + 1
    : 0;
  for (let loop = minimum_loop; loop <= maximum_loop; loop++) {
    for (const event of clip.events) {
      const occurrence_time = event.time + loop * clip.duration;
      if (
        forward
          ? occurrence_time > previous_time && occurrence_time <= current_time
          : occurrence_time < previous_time && occurrence_time >= current_time
      ) {
        occurrences.push(Object.freeze({ ...event, occurrence_time }));
      }
    }
  }
  return Object.freeze(
    occurrences.sort((left, right) =>
      forward
        ? left.occurrence_time - right.occurrence_time ||
          left.name.localeCompare(right.name)
        : right.occurrence_time - left.occurrence_time ||
          left.name.localeCompare(right.name)
    ),
  );
}

export function root_motion_delta(
  _skeleton: Skeleton,
  clip: AnimationClip,
  previous_time: number,
  current_time: number,
): RootMotionDelta {
  if (clip.root_joint === undefined || previous_time === current_time) {
    return Object.freeze({ translation: vec3(0, 0, 0) });
  }
  const track = clip.tracks.find(({ joint }) => joint === clip.root_joint);
  if (track?.positions === undefined) {
    return Object.freeze({ translation: vec3(0, 0, 0) });
  }
  const sample_unwrapped = (time: number): Vec3 => {
    if (!clip.looping) {
      return sample_vec3(
        track.positions!,
        clip_time(clip, time),
        track.interpolation,
      );
    }
    const loop = Math.floor(time / clip.duration);
    const local = time - loop * clip.duration;
    const start = sample_vec3(track.positions!, 0, track.interpolation);
    const finish = sample_vec3(
      track.positions!,
      clip.duration,
      track.interpolation,
    );
    const cycle = vec3_subtract(finish, start);
    const sampled = sample_vec3(track.positions!, local, track.interpolation);
    return vec3(
      sampled.x + cycle.x * loop,
      sampled.y + cycle.y * loop,
      sampled.z + cycle.z * loop,
    );
  };
  return Object.freeze({
    translation: vec3_subtract(
      sample_unwrapped(current_time),
      sample_unwrapped(previous_time),
    ),
  });
}

export interface CompressionResult {
  readonly clip: AnimationClip;
  readonly removed_keys: number;
  readonly maximum_error: number;
}
export function compress_clip(
  skeleton: Skeleton,
  clip: AnimationClip,
  maximum_error: number,
): CompressionResult {
  if (!Number.isFinite(maximum_error) || maximum_error < 0) {
    throw new Error(
      `animation compression error ${maximum_error} must be nonnegative`,
    );
  }
  let removed_keys = 0;
  let measured = 0;
  const tracks = clip.tracks.map((track) => ({
    ...track,
    ...(track.positions === undefined ? {} : {
      positions: reduce_vec3(
        track.positions,
        maximum_error,
        (error) => measured = Math.max(measured, error),
        () => removed_keys++,
      ),
    }),
    ...(track.scales === undefined ? {} : {
      scales: reduce_vec3(
        track.scales,
        maximum_error,
        (error) => measured = Math.max(measured, error),
        () => removed_keys++,
      ),
    }),
    ...(track.rotations === undefined ? {} : {
      rotations: reduce_quat(
        track.rotations,
        maximum_error,
        (error) => measured = Math.max(measured, error),
        () => removed_keys++,
      ),
    }),
  }));
  const compressed = create_clip(skeleton, { ...clip, tracks });
  return Object.freeze({
    clip: compressed,
    removed_keys,
    maximum_error: measured,
  });
}

function sample_scalar(
  keys: readonly ScalarKey[],
  time: number,
  interpolation: Interpolation,
  fallback: number,
): number {
  if (keys.length === 0) return fallback;
  const segment = key_segment(keys, time);
  if (segment.first === segment.second || interpolation === "step") {
    return segment.first.value;
  }
  const amount = (time - segment.first.time) /
    (segment.second.time - segment.first.time);
  if (interpolation !== "cubic") {
    return segment.first.value +
      (segment.second.value - segment.first.value) * amount;
  }
  return hermite(
    segment.first.value,
    segment.first.out_tangent ?? 0,
    segment.second.value,
    segment.second.in_tangent ?? 0,
    amount,
    segment.second.time - segment.first.time,
  );
}
function sample_vec3(
  keys: readonly Vec3Key[],
  time: number,
  interpolation: Interpolation,
): Vec3 {
  const segment = key_segment(keys, time);
  if (segment.first === segment.second || interpolation === "step") {
    return segment.first.value;
  }
  const amount = (time - segment.first.time) /
    (segment.second.time - segment.first.time);
  if (interpolation !== "cubic") {
    return vec3_lerp(segment.first.value, segment.second.value, amount);
  }
  const duration = segment.second.time - segment.first.time;
  const first_tangent = segment.first.out_tangent ?? vec3(0, 0, 0);
  const second_tangent = segment.second.in_tangent ?? vec3(0, 0, 0);
  return vec3(
    hermite(
      segment.first.value.x,
      first_tangent.x,
      segment.second.value.x,
      second_tangent.x,
      amount,
      duration,
    ),
    hermite(
      segment.first.value.y,
      first_tangent.y,
      segment.second.value.y,
      second_tangent.y,
      amount,
      duration,
    ),
    hermite(
      segment.first.value.z,
      first_tangent.z,
      segment.second.value.z,
      second_tangent.z,
      amount,
      duration,
    ),
  );
}
function sample_quat(
  keys: readonly QuatKey[],
  time: number,
  interpolation: Interpolation,
): Quat {
  const segment = key_segment(keys, time);
  if (segment.first === segment.second || interpolation === "step") {
    return segment.first.value;
  }
  return quat_slerp(
    segment.first.value,
    segment.second.value,
    (time - segment.first.time) / (segment.second.time - segment.first.time),
  );
}
function key_segment<Key extends { time: number }>(
  keys: readonly Key[],
  time: number,
): { first: Key; second: Key } {
  if (time <= keys[0].time) return { first: keys[0], second: keys[0] };
  for (let index = 1; index < keys.length; index++) {
    if (time <= keys[index].time) {
      return { first: keys[index - 1], second: keys[index] };
    }
  }
  return { first: keys.at(-1)!, second: keys.at(-1)! };
}
function clip_time(clip: AnimationClip, time: number): number {
  if (!Number.isFinite(time)) {
    throw new Error(
      `animation ${clip.asset} sample time ${time} must be finite`,
    );
  }
  if (!clip.looping) return Math.max(0, Math.min(clip.duration, time));
  return ((time % clip.duration) + clip.duration) % clip.duration;
}
function hermite(
  a: number,
  out_tangent: number,
  b: number,
  in_tangent: number,
  amount: number,
  duration: number,
): number {
  const t2 = amount * amount;
  const t3 = t2 * amount;
  return (2 * t3 - 3 * t2 + 1) * a +
    (t3 - 2 * t2 + amount) * out_tangent * duration + (-2 * t3 + 3 * t2) * b +
    (t3 - t2) * in_tangent * duration;
}
function parse_keys(
  asset: AssetId<"animation">,
  keys: readonly { time: number }[],
  duration: number,
  label: string,
): void {
  let previous = -Infinity;
  for (const [index, key] of keys.entries()) {
    if (
      !Number.isFinite(key.time) || key.time < 0 || key.time > duration ||
      key.time <= previous
    ) {
      throw new Error(
        `animation ${asset} ${label} key ${index} time ${key.time} must be ordered in 0..${duration}`,
      );
    }
    previous = key.time;
  }
}
function parse_scalar_tracks<T extends PropertyTrack | MorphTrack>(
  asset: AssetId<"animation">,
  tracks: readonly T[],
  duration: number,
  label: string,
): readonly T[] {
  const ids = new Set<string>();
  return tracks.map((track) => {
    const id = "property" in track ? track.property : track.morph;
    if (ids.has(id)) {
      throw new Error(`animation ${asset} repeats ${label} track ${id}`);
    }
    ids.add(id);
    parse_keys(asset, track.keys, duration, `${label} ${id}`);
    return Object.freeze({
      ...track,
      keys: Object.freeze([...track.keys]),
    }) as unknown as T;
  });
}
function reduce_vec3(
  keys: readonly Vec3Key[],
  limit: number,
  measure: (error: number) => void,
  removed: () => void,
): readonly Vec3Key[] {
  return reduce_keys(
    keys,
    (first, middle, last) => {
      const sampled = vec3_lerp(
        first.value,
        last.value,
        (middle.time - first.time) / (last.time - first.time),
      );
      return Math.hypot(
        sampled.x - middle.value.x,
        sampled.y - middle.value.y,
        sampled.z - middle.value.z,
      );
    },
    limit,
    measure,
    removed,
  );
}
function reduce_quat(
  keys: readonly QuatKey[],
  limit: number,
  measure: (error: number) => void,
  removed: () => void,
): readonly QuatKey[] {
  return reduce_keys(
    keys,
    (first, middle, last) => {
      const sampled = quat_slerp(
        first.value,
        last.value,
        (middle.time - first.time) / (last.time - first.time),
      );
      return 2 *
        Math.acos(
          Math.min(
            1,
            Math.abs(
              sampled.x * middle.value.x + sampled.y * middle.value.y +
                sampled.z * middle.value.z + sampled.w * middle.value.w,
            ),
          ),
        );
    },
    limit,
    measure,
    removed,
  );
}
function reduce_keys<Key>(
  keys: readonly Key[],
  error: (first: Key, middle: Key, last: Key) => number,
  limit: number,
  measure: (error: number) => void,
  removed: () => void,
): readonly Key[] {
  if (keys.length < 3) return keys;
  const result: Key[] = [keys[0]];
  for (let index = 1; index < keys.length - 1; index++) {
    const candidate = error(result.at(-1)!, keys[index], keys[index + 1]);
    measure(candidate);
    if (candidate <= limit) removed();
    else result.push(keys[index]);
  }
  result.push(keys.at(-1)!);
  return Object.freeze(result);
}

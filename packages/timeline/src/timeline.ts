import type { AssetRef } from "@ink/assets/identity.ts";
import type { Transform } from "@ink/math/transform.ts";
import { transform_lerp } from "@ink/math/transform.ts";
import { lerp } from "@ink/math/scalar.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import { vec3_lerp } from "@ink/math/vector.ts";

declare const timeline_id_brand: unique symbol;
declare const timeline_track_id_brand: unique symbol;
declare const timeline_clip_id_brand: unique symbol;

export type TimelineId = string & { readonly [timeline_id_brand]: true };
export type TimelineTrackId = string & {
  readonly [timeline_track_id_brand]: true;
};
export type TimelineClipId = string & {
  readonly [timeline_clip_id_brand]: true;
};

export interface TimelineBinding {
  readonly subsystem: string;
  readonly target: string;
  readonly property: string;
}

export interface ScalarKey {
  readonly time: number;
  readonly value: number;
}

export interface VectorKey {
  readonly time: number;
  readonly value: Vec3;
}

export interface TransformKey {
  readonly time: number;
  readonly value: Transform;
}

export interface DiscreteKey {
  readonly time: number;
  readonly value: string | number | boolean;
}

interface BoundTrack {
  readonly id: TimelineTrackId;
  readonly binding: TimelineBinding;
}

export type TimelineValueTrack =
  | (BoundTrack & {
    readonly type: "scalar";
    readonly interpolation: "step" | "linear";
    readonly keys: readonly ScalarKey[];
  })
  | (BoundTrack & {
    readonly type: "vector";
    readonly interpolation: "step" | "linear";
    readonly keys: readonly VectorKey[];
  })
  | (BoundTrack & {
    readonly type: "transform";
    readonly interpolation: "step" | "linear";
    readonly keys: readonly TransformKey[];
  })
  | (BoundTrack & {
    readonly type: "discrete";
    readonly keys: readonly DiscreteKey[];
  });

export interface TimelineClip {
  readonly id: TimelineClipId;
  readonly start: number;
  readonly duration: number;
  readonly content: AssetRef;
  readonly offset?: number;
  readonly rate?: number;
}

export interface TimelineClipTrack {
  readonly type: "clips";
  readonly id: TimelineTrackId;
  readonly binding: TimelineBinding;
  readonly clips: readonly TimelineClip[];
}

export interface TimelineEvent {
  readonly time: number;
  readonly name: string;
  readonly payload?: string;
}

export interface TimelineEventTrack {
  readonly type: "events";
  readonly id: TimelineTrackId;
  readonly events: readonly TimelineEvent[];
}

export type TimelineTrack =
  | TimelineValueTrack
  | TimelineClipTrack
  | TimelineEventTrack;

export interface TimelineDefinition {
  readonly id: TimelineId;
  readonly duration: number;
  readonly playback: "once" | "loop";
  readonly tracks: readonly TimelineTrack[];
}

export type TimelineValue = string | number | boolean | Vec3 | Transform;

export interface EvaluatedTimelineValue {
  readonly track: TimelineTrackId;
  readonly binding: TimelineBinding;
  readonly value: TimelineValue;
}

export interface ActiveTimelineClip {
  readonly track: TimelineTrackId;
  readonly binding: TimelineBinding;
  readonly clip: TimelineClipId;
  readonly content: AssetRef;
  readonly local_time: number;
}

export interface TimelineFrame {
  readonly timeline: TimelineId;
  readonly requested_time: number;
  readonly playhead: number;
  readonly finished: boolean;
  readonly values: readonly EvaluatedTimelineValue[];
  readonly clips: readonly ActiveTimelineClip[];
}

export interface TraversedTimelineEvent extends TimelineEvent {
  readonly track: TimelineTrackId;
  readonly occurrence_time: number;
}

export function timeline_id(value: string): TimelineId {
  return parse_identity(value, "timeline id") as TimelineId;
}

export function timeline_track_id(value: string): TimelineTrackId {
  return parse_identity(value, "timeline track id") as TimelineTrackId;
}

export function timeline_clip_id(value: string): TimelineClipId {
  return parse_identity(value, "timeline clip id") as TimelineClipId;
}

export function create_timeline(
  definition: TimelineDefinition,
): TimelineDefinition {
  const id = timeline_id(definition.id);
  if (definition.playback !== "once" && definition.playback !== "loop") {
    throw new Error(
      `timeline ${id} playback ${
        JSON.stringify(definition.playback)
      } is unsupported`,
    );
  }
  if (!Number.isFinite(definition.duration) || definition.duration <= 0) {
    throw new Error(
      `timeline ${id} duration ${definition.duration} must be finite and positive`,
    );
  }
  const track_ids = new Set<string>();
  const value_bindings = new Set<string>();
  const tracks = definition.tracks.map((track) => {
    const untrusted_track = track as {
      readonly id?: unknown;
      readonly type?: unknown;
    };
    if (
      untrusted_track.type !== "scalar" && untrusted_track.type !== "vector" &&
      untrusted_track.type !== "transform" &&
      untrusted_track.type !== "discrete" &&
      untrusted_track.type !== "clips" && untrusted_track.type !== "events"
    ) {
      throw new Error(
        `timeline ${id} track ${JSON.stringify(untrusted_track.id)} type ${
          JSON.stringify(untrusted_track.type)
        } is unsupported`,
      );
    }
    const track_id = timeline_track_id(track.id);
    if (track_ids.has(track_id)) {
      throw new Error(`timeline ${id} repeats track ${track_id}`);
    }
    track_ids.add(track_id);
    if (track.type === "events") {
      return Object.freeze({
        type: "events",
        id: track_id,
        events: Object.freeze(
          parse_events({ ...track, id: track_id }, definition),
        ),
      });
    }
    const binding = parse_binding(track.binding, track_id);
    if (track.type === "clips") {
      return Object.freeze({
        type: "clips",
        id: track_id,
        binding,
        clips: Object.freeze(parse_clips({
          ...track,
          id: track_id,
          binding,
        }, definition)),
      });
    }
    if (
      track.type !== "discrete" && track.interpolation !== "step" &&
      track.interpolation !== "linear"
    ) {
      throw new Error(
        `timeline track ${track_id} interpolation ${
          JSON.stringify(track.interpolation)
        } is unsupported`,
      );
    }
    const binding_key = JSON.stringify([
      binding.subsystem,
      binding.target,
      binding.property,
    ]);
    if (value_bindings.has(binding_key)) {
      throw new Error(
        `timeline ${id} binds more than one value track to ${binding.subsystem}:${binding.target}:${binding.property}`,
      );
    }
    value_bindings.add(binding_key);
    if (track.type === "scalar") {
      return Object.freeze({
        type: "scalar",
        id: track_id,
        binding,
        interpolation: track.interpolation,
        keys: Object.freeze(
          parse_keys({ ...track, id: track_id }, definition, (key, index) => {
            if (!Number.isFinite(key.value)) {
              throw new Error(
                `timeline track ${track_id} key ${index} value must be finite`,
              );
            }
          }),
        ),
      });
    }
    if (track.type === "vector") {
      return Object.freeze({
        type: "vector",
        id: track_id,
        binding,
        interpolation: track.interpolation,
        keys: Object.freeze(
          parse_keys({ ...track, id: track_id }, definition, (key, index) => {
            require_finite_components(
              `timeline track ${track_id} key ${index} vector`,
              [key.value.x, key.value.y, key.value.z],
            );
          }),
        ),
      });
    }
    if (track.type === "transform") {
      return Object.freeze({
        type: "transform",
        id: track_id,
        binding,
        interpolation: track.interpolation,
        keys: Object.freeze(
          parse_keys({ ...track, id: track_id }, definition, (key, index) => {
            require_finite_components(
              `timeline track ${track_id} key ${index} transform`,
              [
                key.value.position.x,
                key.value.position.y,
                key.value.position.z,
                key.value.rotation.x,
                key.value.rotation.y,
                key.value.rotation.z,
                key.value.rotation.w,
                key.value.scale.x,
                key.value.scale.y,
                key.value.scale.z,
              ],
            );
          }),
        ),
      });
    }
    return Object.freeze({
      type: "discrete",
      id: track_id,
      binding,
      keys: Object.freeze(
        parse_keys({ ...track, id: track_id }, definition, (key, index) => {
          if (
            typeof key.value !== "string" && typeof key.value !== "boolean" &&
            (typeof key.value !== "number" || !Number.isFinite(key.value))
          ) {
            throw new Error(
              `timeline track ${track_id} key ${index} discrete value ${
                String(key.value)
              } is invalid`,
            );
          }
        }),
      ),
    });
  });
  return Object.freeze({
    id,
    duration: definition.duration,
    playback: definition.playback,
    tracks: Object.freeze(tracks),
  });
}

export function evaluate_timeline(
  timeline: TimelineDefinition,
  requested_time: number,
): TimelineFrame {
  if (!Number.isFinite(requested_time)) {
    throw new Error(
      `timeline ${timeline.id} playhead ${requested_time} must be finite`,
    );
  }
  const playhead = timeline.playback === "loop"
    ? positive_modulo(requested_time, timeline.duration)
    : Math.min(Math.max(requested_time, 0), timeline.duration);
  const values: EvaluatedTimelineValue[] = [];
  const clips: ActiveTimelineClip[] = [];
  for (const track of timeline.tracks) {
    if (track.type === "events") continue;
    if (track.type === "clips") {
      for (const clip of track.clips) {
        if (playhead < clip.start || playhead >= clip.start + clip.duration) {
          continue;
        }
        clips.push(Object.freeze({
          track: track.id,
          binding: track.binding,
          clip: clip.id,
          content: clip.content,
          local_time: (clip.offset ?? 0) +
            (playhead - clip.start) * (clip.rate ?? 1),
        }));
      }
      continue;
    }
    values.push(Object.freeze({
      track: track.id,
      binding: track.binding,
      value: sample_value_track(track, playhead),
    }));
  }
  return Object.freeze({
    timeline: timeline.id,
    requested_time,
    playhead,
    finished: timeline.playback === "once" &&
      requested_time >= timeline.duration,
    values: Object.freeze(values),
    clips: Object.freeze(clips),
  });
}

export function traverse_timeline_events(
  timeline: TimelineDefinition,
  previous_time: number,
  current_time: number,
): readonly TraversedTimelineEvent[] {
  if (!Number.isFinite(previous_time) || !Number.isFinite(current_time)) {
    throw new Error(
      `timeline ${timeline.id} event range ${previous_time}..${current_time} must be finite`,
    );
  }
  if (previous_time === current_time) return Object.freeze([]);
  const forward = current_time > previous_time;
  const start = timeline.playback === "once"
    ? Math.min(Math.max(previous_time, 0), timeline.duration)
    : previous_time;
  const finish = timeline.playback === "once"
    ? Math.min(Math.max(current_time, 0), timeline.duration)
    : current_time;
  if (start === finish) return Object.freeze([]);
  const first_loop = timeline.playback === "loop"
    ? Math.floor(Math.min(start, finish) / timeline.duration) - 1
    : 0;
  const last_loop = timeline.playback === "loop"
    ? Math.floor(Math.max(start, finish) / timeline.duration) + 1
    : 0;
  const traversed: TraversedTimelineEvent[] = [];
  for (const track of timeline.tracks) {
    if (track.type !== "events") continue;
    for (let loop = first_loop; loop <= last_loop; loop += 1) {
      for (const event of track.events) {
        const occurrence_time = event.time + loop * timeline.duration;
        const crossed = forward
          ? occurrence_time > start && occurrence_time <= finish
          : occurrence_time < start && occurrence_time >= finish;
        if (!crossed) continue;
        traversed.push(Object.freeze({
          ...event,
          track: track.id,
          occurrence_time,
        }));
      }
    }
  }
  return Object.freeze(
    traversed.sort((left, right) =>
      (forward
        ? left.occurrence_time - right.occurrence_time
        : right.occurrence_time - left.occurrence_time) ||
      left.track.localeCompare(right.track) ||
      left.name.localeCompare(right.name)
    ),
  );
}

function parse_clips(
  track: TimelineClipTrack,
  timeline: TimelineDefinition,
): readonly TimelineClip[] {
  const clip_ids = new Set<string>();
  return [...track.clips].map((clip) => {
    const id = timeline_clip_id(clip.id);
    if (clip_ids.has(id)) {
      throw new Error(`timeline track ${track.id} repeats clip ${id}`);
    }
    clip_ids.add(id);
    parse_time(clip.start, timeline, `clip ${id} start`);
    if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
      throw new Error(
        `timeline track ${track.id} clip ${id} duration ${clip.duration} must be finite and positive`,
      );
    }
    if (clip.start + clip.duration > timeline.duration) {
      throw new Error(
        `timeline track ${track.id} clip ${id} ends at ${
          clip.start + clip.duration
        } beyond duration ${timeline.duration}`,
      );
    }
    if (
      clip.offset !== undefined &&
      (!Number.isFinite(clip.offset) || clip.offset < 0)
    ) {
      throw new Error(
        `timeline track ${track.id} clip ${id} offset ${clip.offset} must be finite and nonnegative`,
      );
    }
    if (
      clip.rate !== undefined &&
      (!Number.isFinite(clip.rate) || clip.rate === 0)
    ) {
      throw new Error(
        `timeline track ${track.id} clip ${id} rate ${clip.rate} must be finite and nonzero`,
      );
    }
    const final_local_time = (clip.offset ?? 0) +
      clip.duration * (clip.rate ?? 1);
    if (!Number.isFinite(final_local_time)) {
      throw new Error(
        `timeline track ${track.id} clip ${id} final local time ${final_local_time} must be finite`,
      );
    }
    return Object.freeze({
      id,
      start: clip.start,
      duration: clip.duration,
      content: Object.freeze({ ...clip.content }),
      ...(clip.offset === undefined ? {} : { offset: clip.offset }),
      ...(clip.rate === undefined ? {} : { rate: clip.rate }),
    });
  }).sort((left, right) =>
    left.start - right.start || left.id.localeCompare(right.id)
  );
}

function parse_events(
  track: TimelineEventTrack,
  timeline: TimelineDefinition,
): readonly TimelineEvent[] {
  return [...track.events].map((event, index) => {
    parse_time(event.time, timeline, `event ${index}`);
    if (timeline.playback === "loop" && event.time === timeline.duration) {
      throw new Error(
        `timeline track ${track.id} event ${index} at duration ${timeline.duration} duplicates the next loop boundary`,
      );
    }
    if (typeof event.name !== "string") {
      throw new Error(
        `timeline track ${track.id} event ${index} name must be a string`,
      );
    }
    const name = event.name.trim();
    if (name.length === 0) {
      throw new Error(
        `timeline track ${track.id} event ${index} name cannot be empty`,
      );
    }
    return Object.freeze({ ...event, name });
  }).sort((left, right) =>
    left.time - right.time || left.name.localeCompare(right.name)
  );
}

function parse_keys<Key extends { readonly time: number }>(
  track: { readonly id: TimelineTrackId; readonly keys: readonly Key[] },
  timeline: TimelineDefinition,
  validate_value?: (key: Key, index: number) => void,
): readonly Key[] {
  if (track.keys.length === 0) {
    throw new Error(`timeline track ${track.id} requires at least one key`);
  }
  const keys = [...track.keys].sort((left, right) => left.time - right.time);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    parse_time(key.time, timeline, `track ${track.id} key ${index}`);
    if (index > 0 && keys[index - 1].time === key.time) {
      throw new Error(
        `timeline track ${track.id} repeats key time ${key.time}`,
      );
    }
    validate_value?.(key, index);
  }
  return keys.map((key) => Object.freeze({ ...key }));
}

function sample_value_track(
  track: TimelineValueTrack,
  time: number,
): TimelineValue {
  if (track.type === "scalar") {
    return sample_keys(
      track.keys,
      time,
      track.interpolation,
      lerp,
    );
  }
  if (track.type === "vector") {
    return sample_keys(track.keys, time, track.interpolation, vec3_lerp);
  }
  if (track.type === "transform") {
    return sample_keys(track.keys, time, track.interpolation, transform_lerp);
  }
  return sample_keys(track.keys, time, "step", (start) => start);
}

function sample_keys<Value>(
  keys: readonly { readonly time: number; readonly value: Value }[],
  time: number,
  interpolation: "step" | "linear",
  interpolate: (start: Value, finish: Value, amount: number) => Value,
): Value {
  if (time <= keys[0].time) return keys[0].value;
  const next_index = keys.findIndex((key) => key.time >= time);
  if (next_index < 0) return keys.at(-1)!.value;
  const previous = keys[next_index - 1];
  const next = keys[next_index];
  if (interpolation === "step") return previous.value;
  const amount = (time - previous.time) / (next.time - previous.time);
  return interpolate(previous.value, next.value, amount);
}

function parse_binding(
  binding: TimelineBinding,
  track: TimelineTrackId,
): TimelineBinding {
  return Object.freeze({
    subsystem: parse_identity(
      binding.subsystem,
      `timeline track ${track} subsystem`,
    ),
    target: parse_identity(binding.target, `timeline track ${track} target`),
    property: parse_identity(
      binding.property,
      `timeline track ${track} property`,
    ),
  });
}

function parse_time(
  value: number,
  timeline: TimelineDefinition,
  label: string,
): void {
  if (!Number.isFinite(value) || value < 0 || value > timeline.duration) {
    throw new Error(
      `timeline ${timeline.id} ${label} time ${value} must be within 0..${timeline.duration}`,
    );
  }
}

function parse_identity(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} ${JSON.stringify(value)} must be a string`);
  }
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:/-]+$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be nonempty and stable`,
    );
  }
  return parsed;
}

function require_finite_components(
  label: string,
  components: readonly number[],
): void {
  const invalid = components.findIndex((component) =>
    !Number.isFinite(component)
  );
  if (invalid >= 0) {
    throw new Error(
      `${label} component ${invalid} ${components[invalid]} must be finite`,
    );
  }
}

function positive_modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

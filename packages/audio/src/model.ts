import type { DecodedAudio } from "@ink/assets/media.ts";
import type { Vec3 } from "@ink/math/vector.ts";

declare const clip_id_brand: unique symbol;
declare const stream_id_brand: unique symbol;
declare const voice_id_brand: unique symbol;
declare const emitter_id_brand: unique symbol;
declare const listener_id_brand: unique symbol;
declare const bus_id_brand: unique symbol;
declare const effect_id_brand: unique symbol;

export type ClipId = string & { readonly [clip_id_brand]: true };
export type StreamId = string & { readonly [stream_id_brand]: true };
export type VoiceId = string & { readonly [voice_id_brand]: true };
export type EmitterId = string & { readonly [emitter_id_brand]: true };
export type ListenerId = string & { readonly [listener_id_brand]: true };
export type BusId = string & { readonly [bus_id_brand]: true };
export type EffectId = string & { readonly [effect_id_brand]: true };

export interface AudioClip {
  readonly id: ClipId;
  readonly revision: number;
  readonly decoded: DecodedAudio;
}

export interface AudioStream {
  readonly id: StreamId;
  readonly revision: number;
  readonly duration_seconds?: number;
}

export interface AudioEmitter {
  readonly id: EmitterId;
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly velocity: Vec3;
}

export interface AudioListener {
  readonly id: ListenerId;
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
  readonly velocity: Vec3;
}

export type DistanceAttenuation =
  | {
    readonly type: "linear" | "inverse" | "exponential";
    readonly reference_distance: number;
    readonly maximum_distance: number;
    readonly rolloff: number;
  }
  | { readonly type: "none" };

export interface ConeAttenuation {
  readonly inner_angle_radians: number;
  readonly outer_angle_radians: number;
  readonly outer_gain: number;
}

export interface SpatialSettings {
  readonly emitter: EmitterId;
  readonly distance: DistanceAttenuation;
  readonly cone?: ConeAttenuation;
  readonly doppler_factor: number;
}

export interface LoopSettings {
  readonly start_seconds: number;
  readonly end_seconds: number;
}

export interface PlayCommand {
  readonly type: "play";
  readonly sequence: number;
  readonly presentation_time_seconds: number;
  readonly source:
    | { readonly type: "clip"; readonly id: ClipId }
    | { readonly type: "stream"; readonly id: StreamId };
  readonly bus: BusId;
  readonly gain: number;
  readonly pitch: number;
  readonly priority: number;
  readonly fade_seconds: number;
  readonly loop?: LoopSettings;
  readonly spatial?: SpatialSettings;
  readonly concurrency_group?: string;
}

export type AudioCommand =
  | PlayCommand
  | {
    readonly type: "stop";
    readonly sequence: number;
    readonly presentation_time_seconds: number;
    readonly voice: VoiceId;
    readonly fade_seconds: number;
  }
  | {
    readonly type: "pause" | "resume";
    readonly sequence: number;
    readonly presentation_time_seconds: number;
    readonly voice?: VoiceId;
  }
  | {
    readonly type: "bus_gain";
    readonly sequence: number;
    readonly presentation_time_seconds: number;
    readonly bus: BusId;
    readonly gain: number;
    readonly fade_seconds: number;
  };

export interface AudioCommandBatch {
  readonly commands: readonly AudioCommand[];
}

export type AudioDeviceState =
  | { readonly type: "unavailable"; readonly reason: string }
  | { readonly type: "blocked"; readonly reason: string }
  | { readonly type: "suspended" }
  | { readonly type: "running" }
  | { readonly type: "interrupted"; readonly reason: string }
  | { readonly type: "recovering"; readonly attempt: number };

export function clip_id(value: string): ClipId {
  return identity(value, "clip") as ClipId;
}

export function stream_id(value: string): StreamId {
  return identity(value, "stream") as StreamId;
}

export function voice_id(value: string): VoiceId {
  return identity(value, "voice") as VoiceId;
}

export function emitter_id(value: string): EmitterId {
  return identity(value, "emitter") as EmitterId;
}

export function listener_id(value: string): ListenerId {
  return identity(value, "listener") as ListenerId;
}

export function bus_id(value: string): BusId {
  return identity(value, "bus") as BusId;
}

export function effect_id(value: string): EffectId {
  return identity(value, "effect") as EffectId;
}

export function command_batch(
  commands: readonly AudioCommand[],
): AudioCommandBatch {
  const ordered = [...commands].sort((left, right) =>
    left.sequence - right.sequence
  );
  for (const [index, command] of ordered.entries()) {
    if (!Number.isSafeInteger(command.sequence) || command.sequence < 0) {
      throw new Error(
        `audio command ${index} sequence ${
          JSON.stringify(command.sequence)
        } must be nonnegative`,
      );
    }
    if (ordered[index - 1]?.sequence === command.sequence) {
      throw new Error(
        `audio command sequence ${command.sequence} appears more than once`,
      );
    }
    if (
      !Number.isFinite(command.presentation_time_seconds) ||
      command.presentation_time_seconds < 0
    ) {
      throw new Error(
        `audio command ${command.sequence} presentation time ${
          JSON.stringify(command.presentation_time_seconds)
        } must be nonnegative`,
      );
    }
    if (
      "fade_seconds" in command &&
      (!Number.isFinite(command.fade_seconds) || command.fade_seconds < 0)
    ) {
      throw new Error(
        `audio command ${command.sequence} fade ${
          JSON.stringify(command.fade_seconds)
        } must be nonnegative`,
      );
    }
    if (command.type === "play") validate_play(command);
    if (
      command.type === "bus_gain" &&
      (!Number.isFinite(command.gain) || command.gain < 0)
    ) {
      throw new Error(
        `audio command ${command.sequence} gain ${
          JSON.stringify(command.gain)
        } must be nonnegative`,
      );
    }
  }
  return { commands: ordered };
}

function validate_play(command: PlayCommand): void {
  if (!Number.isFinite(command.gain) || command.gain < 0) {
    throw new Error(
      `audio play ${command.sequence} gain ${
        JSON.stringify(command.gain)
      } must be nonnegative`,
    );
  }
  if (!Number.isFinite(command.pitch) || command.pitch <= 0) {
    throw new Error(
      `audio play ${command.sequence} pitch ${
        JSON.stringify(command.pitch)
      } must be positive`,
    );
  }
  if (!Number.isSafeInteger(command.priority)) {
    throw new Error(
      `audio play ${command.sequence} priority ${
        JSON.stringify(command.priority)
      } must be a safe integer`,
    );
  }
  if (command.loop !== undefined) {
    if (
      !Number.isFinite(command.loop.start_seconds) ||
      command.loop.start_seconds < 0 ||
      !Number.isFinite(command.loop.end_seconds) ||
      command.loop.end_seconds <= command.loop.start_seconds
    ) {
      throw new Error(
        `audio play ${command.sequence} loop ${
          JSON.stringify(command.loop)
        } needs 0 <= start < end`,
      );
    }
  }
  if (command.concurrency_group !== undefined) {
    identity(command.concurrency_group, "concurrency group");
  }
}

function identity(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(
      `audio ${label} id ${JSON.stringify(value)} cannot be empty`,
    );
  }
  return parsed;
}

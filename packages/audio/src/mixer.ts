import type { Observer } from "@ink/observability/observer.ts";
import {
  type AudioClip,
  type AudioCommandBatch,
  type AudioStream,
  type BusId,
  clip_id,
  type ClipId,
  command_batch,
  type PlayCommand,
  stream_id,
  type StreamId,
  voice_id,
  type VoiceId,
} from "./model.ts";

export interface ConcurrencyLimit {
  readonly group: string;
  readonly maximum_voices: number;
}

export interface VoiceSnapshot {
  readonly id: VoiceId;
  readonly source: PlayCommand["source"];
  readonly bus: BusId;
  readonly sequence: number;
  readonly priority: number;
  readonly gain: number;
  readonly pitch: number;
  readonly started_audio_time: number;
  readonly source_offset_seconds: number;
  readonly loop?: PlayCommand["loop"];
  readonly spatial?: PlayCommand["spatial"];
  readonly concurrency_group?: string;
  readonly paused: boolean;
}

export interface AudioMixSnapshot {
  readonly command_sequence: number;
  readonly paused: boolean;
  readonly voices: readonly VoiceSnapshot[];
  readonly bus_gains: ReadonlyMap<BusId, number>;
}

export type AudioPlanCommand =
  | {
    readonly type: "start";
    readonly voice: VoiceSnapshot;
    readonly fade_seconds: number;
  }
  | {
    readonly type: "stop";
    readonly voice: VoiceId;
    readonly audio_time: number;
    readonly fade_seconds: number;
  }
  | {
    readonly type: "pause" | "resume";
    readonly voice?: VoiceId;
    readonly audio_time: number;
  }
  | {
    readonly type: "bus_gain";
    readonly bus: BusId;
    readonly gain: number;
    readonly audio_time: number;
    readonly fade_seconds: number;
  };

export interface AudioPlan {
  readonly commands: readonly AudioPlanCommand[];
  readonly stolen: readonly VoiceId[];
  readonly dropped_sequences: readonly number[];
}

export type MixerResult =
  | {
    readonly type: "ready";
    readonly plan: AudioPlan;
    readonly snapshot: AudioMixSnapshot;
  }
  | {
    readonly type: "failed";
    readonly sequence: number;
    readonly reason: string;
  };

export interface AudioMixerOptions {
  readonly maximum_voices: number;
  readonly concurrency: readonly ConcurrencyLimit[];
  readonly observer?: Observer;
}

export class AudioMixer {
  readonly #maximum_voices: number;
  readonly #concurrency = new Map<string, number>();
  readonly #observer: Observer | undefined;
  readonly #clips = new Map<ClipId, AudioClip>();
  readonly #streams = new Map<StreamId, AudioStream>();
  #voices = new Map<VoiceId, VoiceSnapshot>();
  #bus_gains = new Map<BusId, number>();
  #last_sequence = -1;
  #clock_offset: number | undefined;
  #paused = false;

  constructor(options: AudioMixerOptions) {
    if (
      !Number.isSafeInteger(options.maximum_voices) ||
      options.maximum_voices <= 0
    ) {
      throw new Error(
        `audio maximum voices ${
          JSON.stringify(options.maximum_voices)
        } must be positive`,
      );
    }
    this.#maximum_voices = options.maximum_voices;
    if (!Array.isArray(options.concurrency)) {
      throw new Error("audio concurrency limits must be an array");
    }
    for (const limit of options.concurrency) {
      if (typeof limit.group !== "string") {
        throw new Error(
          `audio concurrency group ${
            JSON.stringify(limit.group)
          } must be a string`,
        );
      }
      const group = limit.group.trim();
      if (group.length === 0 || this.#concurrency.has(group)) {
        throw new Error(
          `audio concurrency group ${
            JSON.stringify(limit.group)
          } is empty or repeated`,
        );
      }
      if (
        !Number.isSafeInteger(limit.maximum_voices) || limit.maximum_voices <= 0
      ) {
        throw new Error(
          `audio concurrency group ${JSON.stringify(group)} maximum ${
            JSON.stringify(limit.maximum_voices)
          } must be positive`,
        );
      }
      this.#concurrency.set(group, limit.maximum_voices);
    }
    this.#observer = options.observer;
  }

  register_clip(clip: AudioClip): void {
    validate_revision(clip.id, clip.revision);
    validate_decoded_clip(clip);
    const parsed = snapshot_clip(clip);
    if (this.#clips.has(parsed.id)) {
      throw new Error(
        `audio clip ${JSON.stringify(parsed.id)} is already registered`,
      );
    }
    this.#clips.set(parsed.id, parsed);
  }

  register_stream(stream: AudioStream): void {
    validate_revision(stream.id, stream.revision);
    if (
      stream.duration_seconds !== undefined &&
      (!Number.isFinite(stream.duration_seconds) ||
        stream.duration_seconds <= 0)
    ) {
      throw new Error(
        `audio stream ${JSON.stringify(stream.id)} duration ${
          JSON.stringify(stream.duration_seconds)
        } must be positive`,
      );
    }
    const id = stream_id(stream.id);
    if (this.#streams.has(id)) {
      throw new Error(
        `audio stream ${JSON.stringify(id)} is already registered`,
      );
    }
    this.#streams.set(id, Object.freeze({ ...stream, id }));
  }

  replace_clip(
    clip: AudioClip,
  ): { readonly type: "replaced" } | {
    readonly type: "failed";
    readonly reason: string;
  } {
    try {
      validate_revision(clip.id, clip.revision);
      validate_decoded_clip(clip);
    } catch (error) {
      return {
        type: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const parsed = snapshot_clip(clip);
    const current = this.#clips.get(parsed.id);
    if (current !== undefined && clip.revision <= current.revision) {
      return {
        type: "failed",
        reason: `audio clip ${
          JSON.stringify(clip.id)
        } replacement revision ${clip.revision} must exceed ${current.revision}`,
      };
    }
    this.#clips.set(parsed.id, parsed);
    return { type: "replaced" };
  }

  apply(
    batch: AudioCommandBatch,
    presentation_now_seconds: number,
    audio_now_seconds: number,
  ): MixerResult {
    parse_time(presentation_now_seconds, "presentation now");
    parse_time(audio_now_seconds, "audio now");
    let commands: AudioCommandBatch["commands"];
    try {
      commands = command_batch(batch.commands).commands;
    } catch (error) {
      return {
        type: "failed",
        sequence: batch.commands[0]?.sequence ?? -1,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      commands.some((command) => command.sequence <= this.#last_sequence)
    ) {
      const command = commands.find((entry) =>
        entry.sequence <= this.#last_sequence
      )!;
      return {
        type: "failed",
        sequence: command.sequence,
        reason:
          `audio command sequence ${command.sequence} must be greater than applied sequence ${this.#last_sequence}`,
      };
    }
    const offset = this.#clock_offset ??
      audio_now_seconds - presentation_now_seconds;
    const voices = new Map(this.#voices);
    const bus_gains = new Map(this.#bus_gains);
    let paused = this.#paused;
    const plan: AudioPlanCommand[] = [];
    const stolen: VoiceId[] = [];
    const dropped_sequences: number[] = [];

    for (const command of commands) {
      const requested_audio_time = command.presentation_time_seconds + offset;
      if (!Number.isFinite(requested_audio_time)) {
        return {
          type: "failed",
          sequence: command.sequence,
          reason:
            `audio command ${command.sequence} scheduled time ${requested_audio_time} must be finite`,
        };
      }
      const audio_time = Math.max(audio_now_seconds, requested_audio_time);
      if (command.type === "play") {
        const duration = this.#duration(command);
        if (duration.type === "failed") {
          return { ...duration, sequence: command.sequence };
        }
        const lateness = Math.max(0, audio_now_seconds - requested_audio_time) *
          command.pitch;
        if (!Number.isFinite(lateness)) {
          return {
            type: "failed",
            sequence: command.sequence,
            reason:
              `audio play ${command.sequence} source offset ${lateness} must be finite`,
          };
        }
        let source_offset_seconds = lateness;
        if (command.loop !== undefined) {
          const loop_duration = command.loop.end_seconds -
            command.loop.start_seconds;
          source_offset_seconds = command.loop.start_seconds +
            lateness % loop_duration;
        } else if (duration.value !== undefined && lateness >= duration.value) {
          dropped_sequences.push(command.sequence);
          continue;
        }
        const victim = select_victim(
          voices,
          command,
          this.#maximum_voices,
          this.#concurrency.get(command.concurrency_group ?? ""),
        );
        if (victim?.type === "drop") {
          dropped_sequences.push(command.sequence);
          continue;
        }
        if (victim?.type === "steal") {
          voices.delete(victim.voice.id);
          stolen.push(victim.voice.id);
          plan.push({
            type: "stop",
            voice: victim.voice.id,
            audio_time,
            fade_seconds: Math.min(command.fade_seconds, 0.02),
          });
        }
        const id = voice_id(`voice:${command.sequence}`);
        const voice: VoiceSnapshot = Object.freeze({
          id,
          source: command.source,
          bus: command.bus,
          sequence: command.sequence,
          priority: command.priority,
          gain: command.gain,
          pitch: command.pitch,
          started_audio_time: audio_time,
          source_offset_seconds,
          ...(command.loop === undefined ? {} : { loop: command.loop }),
          ...(command.spatial === undefined
            ? {}
            : { spatial: command.spatial }),
          ...(command.concurrency_group === undefined
            ? {}
            : { concurrency_group: command.concurrency_group }),
          paused,
        });
        voices.set(id, voice);
        plan.push({ type: "start", voice, fade_seconds: command.fade_seconds });
      } else if (command.type === "stop") {
        if (voices.delete(command.voice)) {
          plan.push({
            type: "stop",
            voice: command.voice,
            audio_time,
            fade_seconds: command.fade_seconds,
          });
        }
      } else if (command.type === "pause" || command.type === "resume") {
        if (command.voice === undefined) paused = command.type === "pause";
        if (command.voice !== undefined) {
          const voice = voices.get(command.voice);
          if (voice !== undefined) {
            voices.set(
              command.voice,
              Object.freeze({
                ...voice,
                paused: command.type === "pause",
              }),
            );
          }
        } else {
          for (const [id, voice] of voices) {
            voices.set(id, Object.freeze({ ...voice, paused }));
          }
        }
        plan.push({
          type: command.type,
          ...(command.voice === undefined ? {} : { voice: command.voice }),
          audio_time,
        });
      } else if (command.type === "bus_gain") {
        bus_gains.set(command.bus, command.gain);
        plan.push({
          type: "bus_gain",
          bus: command.bus,
          gain: command.gain,
          audio_time,
          fade_seconds: command.fade_seconds,
        });
      }
    }

    this.#clock_offset = offset;
    this.#voices = voices;
    this.#bus_gains = bus_gains;
    this.#paused = paused;
    this.#last_sequence = commands.at(-1)?.sequence ??
      this.#last_sequence;
    const snapshot = this.snapshot();
    this.#observer?.event("audio.commands.applied", {
      command_count: commands.length,
      active_voices: snapshot.voices.length,
      steals: stolen.length,
      dropped: dropped_sequences.length,
    });
    return {
      type: "ready",
      plan: Object.freeze({
        commands: Object.freeze(plan),
        stolen: Object.freeze(stolen),
        dropped_sequences: Object.freeze(dropped_sequences),
      }),
      snapshot,
    };
  }

  snapshot(): AudioMixSnapshot {
    return Object.freeze({
      command_sequence: this.#last_sequence,
      paused: this.#paused,
      voices: Object.freeze(
        [...this.#voices.values()].sort((left, right) =>
          left.sequence - right.sequence
        ),
      ),
      bus_gains: new Map(
        [...this.#bus_gains].sort(([left], [right]) =>
          left.localeCompare(right)
        ),
      ),
    });
  }

  #duration(
    command: PlayCommand,
  ): { readonly type: "ready"; readonly value: number | undefined } | {
    readonly type: "failed";
    readonly reason: string;
  } {
    if (command.source.type === "clip") {
      const clip = this.#clips.get(command.source.id);
      return clip === undefined
        ? {
          type: "failed",
          reason: `audio clip ${
            JSON.stringify(command.source.id)
          } is not registered`,
        }
        : {
          type: "ready",
          value: clip.decoded.frame_count / clip.decoded.sample_rate,
        };
    }
    const stream = this.#streams.get(command.source.id);
    return stream === undefined
      ? {
        type: "failed",
        reason: `audio stream ${
          JSON.stringify(command.source.id)
        } is not registered`,
      }
      : { type: "ready", value: stream.duration_seconds };
  }
}

type VictimResult =
  | { readonly type: "steal"; readonly voice: VoiceSnapshot }
  | { readonly type: "drop" }
  | undefined;

function select_victim(
  voices: ReadonlyMap<VoiceId, VoiceSnapshot>,
  command: PlayCommand,
  maximum_voices: number,
  group_limit: number | undefined,
): VictimResult {
  const group = command.concurrency_group;
  const group_voices = group === undefined
    ? []
    : [...voices.values()].filter((voice) => voice.concurrency_group === group);
  const candidates =
    group_limit !== undefined && group_voices.length >= group_limit
      ? group_voices
      : voices.size >= maximum_voices
      ? [...voices.values()]
      : [];
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) =>
    left.priority - right.priority || left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
  const victim = candidates[0];
  return command.priority < victim.priority
    ? { type: "drop" }
    : { type: "steal", voice: victim };
}

function validate_revision(id: string, revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(
      `audio source ${JSON.stringify(id)} revision ${
        JSON.stringify(revision)
      } must be nonnegative`,
    );
  }
}

function validate_decoded_clip(clip: AudioClip): void {
  if (
    !Number.isFinite(clip.decoded.sample_rate) || clip.decoded.sample_rate <= 0
  ) {
    throw new Error(
      `audio clip ${
        JSON.stringify(clip.id)
      } sample rate is ${clip.decoded.sample_rate}`,
    );
  }
  if (
    !Number.isSafeInteger(clip.decoded.frame_count) ||
    clip.decoded.frame_count < 0
  ) {
    throw new Error(
      `audio clip ${
        JSON.stringify(clip.id)
      } frame count is ${clip.decoded.frame_count}`,
    );
  }
  if (
    !Array.isArray(clip.decoded.channels) ||
    clip.decoded.channels.length === 0 ||
    clip.decoded.channels.some((channel) =>
      channel.length !== clip.decoded.frame_count
    )
  ) {
    throw new Error(
      `audio clip ${
        JSON.stringify(clip.id)
      } channel lengths do not match frame count`,
    );
  }
  for (const [channel_index, channel] of clip.decoded.channels.entries()) {
    if (!(channel instanceof Float32Array)) {
      throw new Error(
        `audio clip ${
          JSON.stringify(clip.id)
        } channel ${channel_index} must be a Float32Array`,
      );
    }
    const sample = channel.findIndex((value) => !Number.isFinite(value));
    if (sample >= 0) {
      throw new Error(
        `audio clip ${
          JSON.stringify(clip.id)
        } channel ${channel_index} sample ${sample} must be finite`,
      );
    }
  }
}

function snapshot_clip(clip: AudioClip): AudioClip {
  return Object.freeze({
    id: clip_id(clip.id),
    revision: clip.revision,
    decoded: Object.freeze({
      sample_rate: clip.decoded.sample_rate,
      frame_count: clip.decoded.frame_count,
      channels: Object.freeze(
        clip.decoded.channels.map((channel) => new Float32Array(channel)),
      ),
    }),
  });
}

function parse_time(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `audio ${label} ${JSON.stringify(value)} must be finite and nonnegative`,
    );
  }
}

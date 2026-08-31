import {
  AudioDevice,
  type AudioOutput,
  create_web_audio_output,
} from "@ink/audio/device.ts";
import { AudioGraph } from "@ink/audio/graph.ts";
import { AudioMixer } from "@ink/audio/mixer.ts";
import {
  type AudioDeviceState,
  bus_id,
  clip_id,
  type ClipId,
} from "@ink/audio/model.ts";
import type { AssetId } from "@ink/assets/identity.ts";
import type { Observer } from "@ink/observability/observer.ts";

const command_capacity = 6;
const effects_bus = bus_id("roleplaying.effects");

export interface RoleplayingAcceptedAudioCommand {
  readonly cue: string;
  readonly sequence: number;
}

export interface RoleplayingAudioSnapshot {
  readonly accepted: readonly RoleplayingAcceptedAudioCommand[];
  readonly command_capacity: number;
  readonly retained_commands: number;
  readonly state: AudioDeviceState["type"];
}

export interface RoleplayingAudioOptions {
  readonly output?: AudioOutput;
  readonly observer?: Observer;
  readonly now_seconds?: () => number;
}

export class RoleplayingAudio {
  readonly #device: AudioDevice;
  readonly #mixer: AudioMixer;
  readonly #now_seconds: () => number;
  readonly #installed_cues = new Set<ClipId>();
  #accepted: RoleplayingAcceptedAudioCommand[] = [];
  #sequence = 0;

  constructor(options: RoleplayingAudioOptions = {}) {
    this.#device = new AudioDevice({
      output: options.output,
      maximum_retained_commands: command_capacity,
      observer: options.observer,
    });
    this.#mixer = new AudioMixer({
      maximum_voices: command_capacity,
      concurrency: [{
        group: "roleplaying.effects",
        maximum_voices: command_capacity,
      }],
      observer: options.observer,
    });
    this.#now_seconds = options.now_seconds ??
      (() => performance.now() / 1_000);
    this.#device.install_graph(new AudioGraph({
      master: effects_bus,
      buses: [{
        id: effects_bus,
        gain: 0.2,
        effects: [],
        sends: [],
      }],
    }).snapshot());
  }

  async activate(): Promise<AudioDeviceState> {
    return await this.#device.activate();
  }

  play(cue: AssetId<"audio">): RoleplayingAcceptedAudioCommand {
    const clip = clip_id(cue);
    if (!this.#installed_cues.has(clip)) {
      const decoded = roleplaying_tone(clip);
      this.#mixer.register_clip(decoded);
      this.#device.install_clip(decoded);
      this.#installed_cues.add(clip);
    }
    const presentation_time_seconds = this.#now_seconds();
    const sequence = this.#sequence++;
    const mixed = this.#mixer.apply(
      {
        commands: [{
          type: "play",
          sequence,
          presentation_time_seconds,
          source: { type: "clip", id: clip },
          bus: effects_bus,
          gain: 1,
          pitch: 1,
          priority: sequence,
          fade_seconds: 0.01,
          concurrency_group: "roleplaying.effects",
        }],
      },
      presentation_time_seconds,
      this.#device.current_time_seconds ?? 0,
    );
    if (mixed.type === "failed") {
      throw new Error(
        `role-playing audio cue ${
          JSON.stringify(clip)
        } failed: ${mixed.reason}`,
      );
    }
    this.#device.submit(mixed.plan);
    const accepted = Object.freeze({ cue: String(clip), sequence });
    this.#accepted = [...this.#accepted, accepted].slice(-command_capacity);
    return accepted;
  }

  snapshot(): RoleplayingAudioSnapshot {
    return Object.freeze({
      accepted: Object.freeze(
        this.#accepted.map((command) => Object.freeze({ ...command })),
      ),
      command_capacity,
      retained_commands: this.#device.retained_commands.length,
      state: this.#device.state.type,
    });
  }

  async close(): Promise<void> {
    await this.#device.close();
  }
}

export function create_browser_roleplaying_audio(
  observer: Observer,
): RoleplayingAudio {
  return new RoleplayingAudio({
    output: create_web_audio_output(),
    observer,
  });
}

function roleplaying_tone(id: ClipId) {
  const sample_rate = 24_000;
  const frame_count = 2_400;
  const frequency = 300 + stable_frequency_offset(id);
  const channel = new Float32Array(frame_count);
  for (let frame = 0; frame < frame_count; frame += 1) {
    const fade = 1 - frame / frame_count;
    channel[frame] = Math.sin(
      2 * Math.PI * frequency * frame / sample_rate,
    ) * fade;
  }
  return Object.freeze({
    id,
    revision: 0,
    decoded: Object.freeze({
      sample_rate,
      frame_count,
      channels: Object.freeze([channel]),
    }),
  });
}

function stable_frequency_offset(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 360;
  }
  return hash;
}

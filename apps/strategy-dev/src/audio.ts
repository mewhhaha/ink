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

const effects_bus = bus_id("strategy.effects");

export interface StrategyAudioHostEvidence {
  readonly state: AudioDeviceState["type"];
  readonly submitted_cues: number;
}

export class StrategyAudio {
  readonly #device: AudioDevice;
  readonly #mixer = new AudioMixer({
    maximum_voices: 12,
    concurrency: [{ group: "strategy.effects", maximum_voices: 6 }],
  });
  readonly #installed_cues = new Set<ClipId>();
  #sequence = 0;
  #submitted_cues = 0;

  constructor(output?: AudioOutput) {
    this.#device = new AudioDevice({
      output,
      maximum_retained_commands: 12,
    });
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

  play(cue: AssetId<"audio">): AudioDeviceState {
    const source = clip_id(cue);
    if (!this.#installed_cues.has(source)) {
      const clip = effect_tone(source);
      this.#mixer.register_clip(clip);
      this.#device.install_clip(clip);
      this.#installed_cues.add(source);
    }
    const presentation_time_seconds = performance.now() / 1_000;
    const mixed = this.#mixer.apply(
      {
        commands: [{
          type: "play",
          sequence: this.#sequence++,
          presentation_time_seconds,
          source: { type: "clip", id: source },
          bus: effects_bus,
          gain: 1,
          pitch: 1,
          priority: 1,
          fade_seconds: 0.01,
          concurrency_group: "strategy.effects",
        }],
      },
      presentation_time_seconds,
      this.#device.current_time_seconds ?? 0,
    );
    if (mixed.type === "failed") {
      throw new Error(
        `strategy audio cue ${JSON.stringify(source)} failed: ${mixed.reason}`,
      );
    }
    this.#device.submit(mixed.plan);
    this.#submitted_cues += 1;
    return this.#device.state;
  }

  evidence(): StrategyAudioHostEvidence {
    return Object.freeze({
      state: this.#device.state.type,
      submitted_cues: this.#submitted_cues,
    });
  }

  async close(): Promise<void> {
    await this.#device.close();
  }
}

export function create_browser_strategy_audio(): StrategyAudio {
  return new StrategyAudio(create_web_audio_output());
}

function effect_tone(id: ClipId) {
  const sample_rate = 24_000;
  const frame_count = 2_400;
  const frequency = 180 + stable_frequency_offset(id);
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
    hash = (hash * 31 + character.charCodeAt(0)) % 540;
  }
  return hash;
}

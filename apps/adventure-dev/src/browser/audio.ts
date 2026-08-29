import {
  AudioDevice,
  type AudioOutput,
  WebAudioOutput,
} from "@ink/audio/device.ts";
import { AudioGraph } from "@ink/audio/graph.ts";
import { AudioMixer } from "@ink/audio/mixer.ts";
import {
  type AudioDeviceState,
  bus_id,
  clip_id,
  type ClipId,
} from "@ink/audio/model.ts";
import type { GameStatus } from "@ink/blot/protocol.ts";

const master_bus = bus_id("adventure.master");
const key_cue = clip_id("adventure.key");
const gate_cue = clip_id("adventure.gate");
const exit_cue = clip_id("adventure.exit");

export class AdventureAudio {
  readonly #device: AudioDevice;
  readonly #mixer = new AudioMixer({ maximum_voices: 4, concurrency: [] });
  #sequence = 0;
  #last_status: string | undefined;

  constructor(output?: AudioOutput) {
    this.#device = new AudioDevice({
      output,
      maximum_retained_commands: 4,
    });
    const graph = new AudioGraph({
      master: master_bus,
      buses: [{
        id: master_bus,
        gain: 0.22,
        effects: [],
        sends: [],
      }],
    }).snapshot();
    this.#device.install_graph(graph);
    for (
      const [id, frequency] of [
        [key_cue, 880],
        [gate_cue, 330],
        [exit_cue, 660],
      ] as const
    ) {
      const clip = tone(id, frequency);
      this.#mixer.register_clip(clip);
      this.#device.install_clip(clip);
    }
  }

  get state(): AudioDeviceState {
    return this.#device.state;
  }

  async activate(): Promise<AudioDeviceState> {
    return await this.#device.activate();
  }

  cue(status: GameStatus): void {
    const fingerprint = `${status.done}:${status.label}:${status.value}`;
    if (fingerprint === this.#last_status) return;
    this.#last_status = fingerprint;
    const clip = status.done
      ? exit_cue
      : status.label === "Brass key acquired"
      ? key_cue
      : status.label === "Oak gate unlocked"
      ? gate_cue
      : undefined;
    if (clip === undefined) return;

    const presentation_time_seconds = performance.now() / 1_000;
    const mixed = this.#mixer.apply(
      {
        commands: [{
          type: "play",
          sequence: this.#sequence++,
          presentation_time_seconds,
          source: { type: "clip", id: clip },
          bus: master_bus,
          gain: 1,
          pitch: 1,
          priority: status.done ? 10 : 1,
          fade_seconds: 0.01,
        }],
      },
      presentation_time_seconds,
      this.#device.current_time_seconds ?? 0,
    );
    if (mixed.type === "failed") {
      throw new Error(
        `adventure audio cue ${JSON.stringify(clip)} failed: ${mixed.reason}`,
      );
    }
    this.#device.submit(mixed.plan);
  }

  async close(): Promise<void> {
    await this.#device.close();
  }
}

export function create_browser_adventure_audio(): AdventureAudio {
  if (typeof AudioContext === "undefined") return new AdventureAudio();
  try {
    return new AdventureAudio(new WebAudioOutput(new AudioContext()));
  } catch (error) {
    console.warn("Web Audio output is unavailable", error);
    return new AdventureAudio();
  }
}

function tone(id: ClipId, frequency: number) {
  const sample_rate = 24_000;
  const frame_count = 2_400;
  const channel = new Float32Array(frame_count);
  for (let frame = 0; frame < frame_count; frame += 1) {
    const fade = 1 - frame / frame_count;
    channel[frame] = Math.sin(2 * Math.PI * frequency * frame / sample_rate) *
      fade;
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

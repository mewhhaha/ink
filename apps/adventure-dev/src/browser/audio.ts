import {
  AudioDevice,
  type AudioOutput,
  WebAudioOutput,
} from "@ink/audio/device.ts";
import { AudioGraph } from "@ink/audio/graph.ts";
import { AudioMixer } from "@ink/audio/mixer.ts";
import {
  type AudioDeviceState,
  type AudioEmitter,
  type AudioListener,
  bus_id,
  clip_id,
  type ClipId,
  emitter_id,
  listener_id,
} from "@ink/audio/model.ts";
import { spatial_mix } from "@ink/audio/spatial.ts";
import type { AssetId } from "@ink/assets/identity.ts";
import type { RenderSnapshot, SceneObjectCommand } from "@ink/blot/protocol.ts";
import { vec3 } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import { adventure_gate_animation } from "./gate_animation.ts";

const master_bus = bus_id("adventure.master");
const key_cue = clip_id("adventure.key");
const gate_cue = clip_id("adventure.gate");
const exit_cue = clip_id("adventure.exit");
const listener_identity = listener_id("adventure.player-listener");
const distance_attenuation = Object.freeze({
  type: "inverse" as const,
  reference_distance: 0.5,
  maximum_distance: 20,
  rolloff: 1,
});

export interface AdventureSpatialPlayback {
  readonly cue: AssetId<"audio">;
  readonly emitter_position: readonly [number, number, number];
  readonly listener_position: readonly [number, number, number];
  readonly gain: number;
  readonly pan: number;
  readonly doppler_pitch: number;
}

export interface AdventureAudioOptions {
  readonly output?: AudioOutput;
  readonly observer?: Observer;
}

export class AdventureAudio {
  readonly #device: AudioDevice;
  readonly #mixer: AudioMixer;
  #sequence = 0;

  constructor(options: AdventureAudioOptions = {}) {
    this.#device = new AudioDevice({
      output: options.output,
      maximum_retained_commands: 4,
      observer: options.observer,
    });
    this.#mixer = new AudioMixer({
      maximum_voices: 4,
      concurrency: [],
      observer: options.observer,
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

  play(
    cue: AssetId<"audio">,
    snapshot: RenderSnapshot,
  ): AdventureSpatialPlayback {
    const clip = clip_id(cue);
    const spatial = adventure_spatial_playback(cue, snapshot);
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
          priority: clip === exit_cue ? 10 : 1,
          fade_seconds: 0.01,
          spatial: {
            gain: spatial.gain,
            pan: spatial.pan,
            doppler_pitch: spatial.doppler_pitch,
          },
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
    return spatial;
  }

  async close(): Promise<void> {
    await this.#device.close();
  }
}

export function create_browser_adventure_audio(
  observer?: Observer,
): AdventureAudio {
  if (typeof AudioContext === "undefined") {
    return new AdventureAudio({ observer });
  }
  try {
    return new AdventureAudio({
      output: new WebAudioOutput(new AudioContext()),
      observer,
    });
  } catch (error) {
    console.warn("Web Audio output is unavailable", error);
    return new AdventureAudio({ observer });
  }
}

export function adventure_spatial_playback(
  cue: AssetId<"audio">,
  snapshot: RenderSnapshot,
): AdventureSpatialPlayback {
  const clip = clip_id(cue);
  const listener = adventure_listener(snapshot);
  const emitter = adventure_emitter(clip, snapshot);
  const mix = spatial_mix(
    emitter,
    listener,
    distance_attenuation,
    undefined,
    1,
  );
  return Object.freeze({
    cue,
    emitter_position: Object.freeze(
      [
        emitter.position.x,
        emitter.position.y,
        emitter.position.z,
      ] as const,
    ),
    listener_position: Object.freeze(
      [
        listener.position.x,
        listener.position.y,
        listener.position.z,
      ] as const,
    ),
    gain: mix.gain,
    pan: mix.pan,
    doppler_pitch: mix.doppler_pitch,
  });
}

function adventure_listener(snapshot: RenderSnapshot): AudioListener {
  const player = required_object(snapshot, 10);
  const root = snapshot.nodes.find(({ id }) => id === 1);
  if (root === undefined) {
    throw new Error("adventure audio snapshot is missing camera-intent node 1");
  }
  const yaw = root.rotation_radians[1];
  return Object.freeze({
    id: listener_identity,
    position: scene_position(player.position),
    forward: vec3(Math.sin(yaw), 0, -Math.cos(yaw)),
    up: vec3(0, 1, 0),
    velocity: vec3(0, 0, 0),
  });
}

function adventure_emitter(
  cue: ClipId,
  snapshot: RenderSnapshot,
): AudioEmitter {
  if (cue === key_cue) {
    const key = required_object(snapshot, 11);
    return Object.freeze({
      id: emitter_id("adventure.key-emitter"),
      position: scene_position(key.position),
      forward: vec3(0, 0, -1),
      velocity: vec3(0, 0, 0),
    });
  }
  if (cue === gate_cue) {
    const gate = required_object(snapshot, 106);
    const animation = adventure_gate_animation(snapshot);
    const position = scene_position(gate.position);
    return Object.freeze({
      id: emitter_id("adventure.gate-emitter"),
      position: vec3(
        position.x + animation.position_offset[0],
        position.y + animation.position_offset[1],
        position.z + animation.position_offset[2],
      ),
      forward: vec3(0, 0, -1),
      velocity: vec3(
        animation.position_offset[0],
        animation.position_offset[1],
        animation.position_offset[2],
      ),
    });
  }
  if (cue === exit_cue) {
    const player = required_object(snapshot, 10);
    return Object.freeze({
      id: emitter_id("adventure.exit-emitter"),
      position: scene_position(player.position),
      forward: vec3(0, 0, -1),
      velocity: vec3(0, 0, 0),
    });
  }
  throw new Error(`adventure audio cue ${JSON.stringify(cue)} is unsupported`);
}

function required_object(
  snapshot: RenderSnapshot,
  id: number,
): SceneObjectCommand {
  const object = snapshot.objects.find((candidate) => candidate.id === id);
  if (object === undefined) {
    throw new Error(`adventure audio snapshot is missing object ${id}`);
  }
  return object;
}

function scene_position(
  position: readonly [number, number, number],
) {
  return vec3(
    position[0] / 1_000_000,
    position[1] / 1_000_000,
    position[2] / 1_000_000,
  );
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

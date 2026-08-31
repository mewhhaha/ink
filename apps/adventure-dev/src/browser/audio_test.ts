import type { AudioOutput } from "@ink/audio/device.ts";
import type { AudioGraphSnapshot } from "@ink/audio/graph.ts";
import type { AudioPlan } from "@ink/audio/mixer.ts";
import type { AudioClip } from "@ink/audio/model.ts";
import { asset_id } from "@ink/assets/identity.ts";
import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { AdventureAudio } from "./audio.ts";

Deno.test("adventure cues submit authored spatial playback to the canonical audio device", async () => {
  const output = new RecordingAudioOutput();
  const audio = new AdventureAudio({ output });
  assertEquals((await audio.activate()).type, "running");

  const key = audio.play(asset_id<"audio">("adventure.key"), snapshot(false));
  assert(key.gain > 0 && key.gain < 1);
  assert(Math.abs(key.pan) > 0.8);
  assertEquals(key.doppler_pitch, 1);

  const gate = audio.play(
    asset_id<"audio">("adventure.gate"),
    snapshot(true),
  );
  assert(gate.gain > 0 && gate.gain < 1);
  assertNotEquals(gate.doppler_pitch, 1);

  const exit = audio.play(
    asset_id<"audio">("adventure.exit"),
    snapshot(true, 4_750_000),
  );
  assertEquals(exit.gain, 1);
  assertEquals(exit.pan, 0);
  assertEquals(exit.doppler_pitch, 1);

  assertEquals(output.plans.length, 3);
  for (const [index, spatial] of [key, gate, exit].entries()) {
    const command = output.plans[index].commands[0];
    assertEquals(command.type, "start");
    if (command.type === "start") {
      assertEquals(command.voice.spatial, {
        gain: spatial.gain,
        pan: spatial.pan,
        doppler_pitch: spatial.doppler_pitch,
      });
    }
  }
  await audio.close();
  assertEquals(output.closed, true);
});

Deno.test("adventure spatial cues remain safe when audio output is unavailable", async () => {
  const audio = new AdventureAudio();
  assertEquals(audio.state.type, "unavailable");
  audio.play(asset_id<"audio">("adventure.key"), snapshot(false));
  audio.play(asset_id<"audio">("adventure.gate"), snapshot(true));
  audio.play(
    asset_id<"audio">("adventure.exit"),
    snapshot(true, 4_750_000),
  );
  assertEquals((await audio.activate()).type, "unavailable");
  await audio.close();
});

function snapshot(
  gate_open: boolean,
  player_z = 2_000_000,
): RenderSnapshot {
  return Object.freeze({
    camera: Object.freeze({
      type: "perspective" as const,
      position: Object.freeze([0, 3, 5.8] as const),
      target: Object.freeze([-0.8, 1.4, 3.4] as const),
      clear_color: Object.freeze([0.012, 0.018, 0.032] as const),
      vertical_fov_radians: 1.240499,
    }),
    directional_light: Object.freeze({
      type: "directional_light",
      color: Object.freeze([1, 1, 1] as const),
      direction: Object.freeze([0, -1, 0] as const),
      intensity: 1,
    }),
    environment: Object.freeze({
      ambient_light: Object.freeze([0.28, 0.24, 0.2] as const),
      fog_color: Object.freeze([0.012, 0.018, 0.032] as const),
      fog_density: 0.003,
      exposure_ev100: 0.75,
      bloom_intensity: 0.08,
    }),
    nodes: Object.freeze([scene_node(1, -0.32)]),
    objects: Object.freeze([
      scene_object(10, [0, 500_000, player_z], true),
      scene_object(11, [3_000_000, 1_150_000, 2_000_000], !gate_open),
      scene_object(106, [0, 0, 4_500_000], !gate_open),
    ]),
    resources: Object.freeze([]),
  });
}

function scene_node(id: number, yaw: number) {
  return Object.freeze({
    type: "scene_node" as const,
    id,
    parent: null,
    rotation_radians: Object.freeze([0, yaw, 0] as const),
    position: Object.freeze([0, 0, 0] as const),
    scale: Object.freeze([1, 1, 1] as const),
    visible: true,
  });
}

function scene_object(
  id: number,
  position: readonly [number, number, number],
  visible: boolean,
) {
  return Object.freeze({
    type: "scene_object" as const,
    id,
    mesh: 0,
    parent: 1,
    color: Object.freeze([1, 1, 1] as const),
    emissive: 0,
    texture: null,
    texture_offset: Object.freeze([0, 0] as const),
    secondary_texture: null,
    texture_scale: Object.freeze([1, 1] as const),
    blend_edges: 0,
    variation_seed: 0,
    surface_mode: 0 as const,
    path_connections: 0,
    rotation_radians: Object.freeze([0, 0, 0] as const),
    position,
    scale: Object.freeze([1, 1, 1] as const),
    visible,
  });
}

class RecordingAudioOutput implements AudioOutput {
  current_time_seconds = 0;
  plans: AudioPlan[] = [];
  closed = false;

  install_clip(_clip: AudioClip): void {}

  install_graph(_graph: AudioGraphSnapshot): void {}

  apply(plan: AudioPlan): void {
    this.plans.push(plan);
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

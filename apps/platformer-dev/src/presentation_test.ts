import type { BlotPresentation } from "@ink/blot/runtime.ts";
import { runtime_sequence } from "@ink/runtime/session.ts";
import { assertEquals, assertNotEquals } from "@std/assert";
import { present_platformer } from "./presentation.ts";

const presentation: BlotPresentation = {
  observation: {
    sequence: runtime_sequence(5),
    outcome: "running",
    projection: "orthographic",
    camera_zoom: 0.7,
    regions: [],
    status: { done: false, label: "First steps", value: "Run" },
    actions: [],
  },
  snapshot: {
    projection: "orthographic",
    camera_zoom: 0.7,
    directional_light: {
      type: "directional_light",
      color: [1, 1, 1],
      direction: [0, 0, -1],
      intensity: 0,
    },
    nodes: [],
    resources: [],
    objects: [{
      type: "scene_object",
      id: 100,
      mesh: 0,
      parent: null,
      color: [0.28, 0.62, 1],
      emissive: 0,
      texture: null,
      texture_offset: [0, 0],
      secondary_texture: null,
      texture_scale: [1, 1],
      blend_edges: 0,
      variation_seed: 0,
      surface_mode: 0,
      path_connections: 0,
      rotation_radians: [0, 0, 0],
      position: [3_000_000, 2_000_000, 0],
      scale: [700_000, 1_000_000, 200_000],
      visible: true,
    }, {
      type: "scene_object",
      id: 101,
      mesh: 0,
      parent: null,
      color: [0.24, 0.9, 0.42],
      emissive: 0.18,
      texture: null,
      texture_offset: [0, 0],
      secondary_texture: null,
      texture_scale: [1, 1],
      blend_edges: 0,
      variation_seed: 1,
      surface_mode: 0,
      path_connections: 0,
      rotation_radians: [0, 0, 0],
      position: [29_500_000, 4_000_000, 100_000],
      scale: [3_000_000, 4_000_000, 200_000],
      visible: true,
    }],
  },
};

Deno.test("platformer presentation applies deterministic animation and visibility LOD", () => {
  const full = present_platformer(presentation, { width: 960, height: 540 });
  const compact = present_platformer(presentation, { width: 320, height: 180 });
  assertNotEquals(
    full.snapshot.objects[0].scale,
    presentation.snapshot.objects[0].scale,
  );
  assertEquals(full.snapshot.objects[1].emissive, 0.24);
  assertEquals(compact.snapshot.objects[1].emissive, 0.08);
  assertEquals(full.observation, presentation.observation);
});

import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import { validate_render_scene } from "@ink/rendering/renderer.ts";
import {
  adventure_render_scene,
  type AdventureRenderAssets,
} from "./rendering.ts";
import { adventure_gate_animation } from "./gate_animation.ts";
import { initial_adventure_presentation_settings } from "./presentation.ts";

const snapshot: RenderSnapshot = {
  camera: {
    type: "orthographic",
    position: [2, 5, 9],
    target: [1, 2, 3],
    clear_color: [0.03, 0.04, 0.05],
    vertical_size: 8.25,
  },
  directional_light: {
    type: "directional_light",
    color: [1, 0.9, 0.8],
    direction: [-0.4, -1, -0.3],
    intensity: 1.5,
  },
  environment: {
    ambient_light: [0.17, 0.23, 0.31],
    fog_color: [0.07, 0.08, 0.09],
    fog_density: 0.021,
    exposure_ev100: 1.25,
    bloom_intensity: 0.33,
  },
  nodes: [{
    type: "scene_node",
    id: 1,
    parent: null,
    rotation_radians: [0, 0, 0],
    position: [1_000_000, 0, 0],
    scale: [1_000_000, 1_000_000, 1_000_000],
    visible: true,
  }],
  objects: [{
    type: "scene_object",
    id: 106,
    mesh: 7,
    parent: 1,
    color: [0.3, 0.5, 0.7],
    emissive: 2,
    texture: null,
    texture_offset: [0, 0],
    secondary_texture: null,
    texture_scale: [1, 1],
    blend_edges: 0,
    variation_seed: 0,
    surface_mode: 0,
    path_connections: 0,
    rotation_radians: [0, 0, 0],
    position: [0, 2_000_000, 0],
    scale: [1_000_000, 1_000_000, 1_000_000],
    visible: true,
  }],
  resources: [],
};

const assets: AdventureRenderAssets = {
  meshes: [{
    id: 7,
    vertices: new Float32Array([
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      1,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      0,
      1,
    ]),
    indices: new Uint32Array([0, 1, 2]),
  }],
  textures: [],
};

Deno.test("adventure snapshots become canonical render scenes", () => {
  const scene = adventure_render_scene(
    snapshot,
    assets,
    4,
    initial_adventure_presentation_settings,
  );

  validate_render_scene(scene);
  assertEquals(scene.hierarchy.revision, 4);
  assertEquals(scene.camera.projection.type, "orthographic");
  if (scene.camera.projection.type === "orthographic") {
    assertAlmostEquals(scene.camera.projection.vertical_size, 8.25);
  }
  assertEquals(
    [
      scene.camera.pose.position.x,
      scene.camera.pose.position.y,
      scene.camera.pose.position.z,
    ],
    [2, 5, 9],
  );
  assertEquals(scene.camera.clear, {
    type: "color",
    color: [0.03, 0.04, 0.05, 1],
  });
  assertEquals(
    [
      scene.environment.ambient_light.r,
      scene.environment.ambient_light.g,
      scene.environment.ambient_light.b,
    ],
    [0.17, 0.23, 0.31],
  );
  assertEquals(scene.environment.fog_density, 0.021);
  assertEquals(scene.environment.exposure_ev100, 1.25);
  assertEquals(scene.environment.bloom_intensity, 0.33);
  const object = scene.objects[0];
  if (object.shape !== "mesh") {
    throw new Error(`adventure object rendered as ${object.shape}`);
  }
  assertEquals(object.mesh, scene.meshes[0].id);
  const emissive = object.material.parameters.emissive;
  assertEquals([emissive.r, emissive.g, emissive.b], [0.6, 1, 1.4]);
});

Deno.test("oak gate visibility selects a sampled pose that changes its rendered transform", () => {
  const closed = adventure_gate_animation(snapshot);
  assertEquals(closed.sample_time, 0);
  assertAlmostEquals(closed.rotation_y_radians, 0);

  const open_snapshot: RenderSnapshot = {
    ...snapshot,
    objects: snapshot.objects.map((object) => ({ ...object, visible: false })),
  };
  const open = adventure_gate_animation(open_snapshot);
  assertEquals(open.sample_time, 1);
  assertAlmostEquals(open.rotation_y_radians, -Math.PI * 0.44);
  assertEquals(open.position_offset, [-1.6, 0, -1.4]);

  const scene = adventure_render_scene(
    open_snapshot,
    assets,
    5,
    initial_adventure_presentation_settings,
  );
  const gate = scene.hierarchy.nodes.find(({ id }) => id.index === 106);
  assertEquals(gate?.active, true);
  assertAlmostEquals(gate?.local_transform.position.x ?? Number.NaN, -1.6);
  assertAlmostEquals(gate?.local_transform.position.z ?? Number.NaN, -1.4);
});

Deno.test("host debug camera transforms the Blot camera without changing the snapshot", () => {
  const scene = adventure_render_scene(snapshot, assets, 6, {
    ...initial_adventure_presentation_settings,
    host_camera: {
      yaw_radians: Math.PI / 2,
      pitch_radians: Math.PI / 2,
      position_offset: [3, -2, 1],
      distance_scale: 0.5,
    },
  });

  assertAlmostEquals(scene.camera.pose.position.x, 7);
  assertAlmostEquals(scene.camera.pose.position.y, 0.5);
  assertAlmostEquals(scene.camera.pose.position.z, 5.5);
  assertEquals(snapshot.camera.position, [2, 5, 9]);
  assertEquals(snapshot.nodes[0].position, [1_000_000, 0, 0]);
});

Deno.test("adventure snapshots reject missing render assets", () => {
  assertThrows(
    () =>
      adventure_render_scene(snapshot, { meshes: [], textures: [] }, 0, {
        ...initial_adventure_presentation_settings,
      }),
    Error,
    "object 106 selects missing mesh 7",
  );
});

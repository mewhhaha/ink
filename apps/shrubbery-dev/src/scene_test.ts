import { assert, assertEquals } from "@std/assert";
import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import { validate_render_scene } from "@ink/rendering/renderer.ts";
import { shrubbery_scene } from "./scene.ts";

Deno.test("shrubbery rendering uses the camera and environment published by Blot", () => {
  const snapshot: RenderSnapshot = {
    camera: {
      type: "perspective",
      position: [3, 8, 12],
      target: [1, 2, 4],
      clear_color: [0.11, 0.22, 0.33],
      vertical_fov_radians: 0.73,
    },
    directional_light: {
      type: "directional_light",
      color: [0.91, 0.72, 0.53],
      direction: [-0.2, -1, -0.4],
      intensity: 1.7,
    },
    environment: {
      ambient_light: [0.12, 0.23, 0.34],
      fog_color: [0.04, 0.05, 0.06],
      fog_density: 0.019,
      exposure_ev100: 0.45,
      bloom_intensity: 0.17,
    },
    nodes: [],
    objects: [{
      type: "scene_object",
      id: 42,
      mesh: 0,
      parent: null,
      color: [0.2, 0.6, 0.3],
      emissive: 0,
      texture: null,
      texture_offset: [0, 0],
      secondary_texture: null,
      texture_scale: [1, 1],
      blend_edges: 0,
      variation_seed: 42,
      surface_mode: 0,
      path_connections: 0,
      rotation_radians: [0, 0, 0],
      position: [2_000_000, 3_000_000, 4_000_000],
      scale: [500_000, 500_000, 500_000],
      visible: true,
    }],
    resources: [],
  };

  const scene = shrubbery_scene(snapshot);
  validate_render_scene(scene);

  assertEquals(scene.camera.projection.type, "perspective");
  assertEquals([
    scene.camera.pose.position.x,
    scene.camera.pose.position.y,
    scene.camera.pose.position.z,
  ], [3, 8, 12]);
  assertEquals(scene.camera.clear, {
    type: "color",
    color: [0.11, 0.22, 0.33, 1],
  });
  assertEquals([
    scene.environment.ambient_light.r,
    scene.environment.ambient_light.g,
    scene.environment.ambient_light.b,
  ], [0.12, 0.23, 0.34]);
  assertEquals([
    scene.environment.fog_color.r,
    scene.environment.fog_color.g,
    scene.environment.fog_color.b,
  ], [0.04, 0.05, 0.06]);
  assertEquals(scene.environment.fog_density, 0.019);
  assertEquals(scene.environment.exposure_ev100, 0.45);
  assertEquals(scene.environment.bloom_intensity, 0.17);
  const light = scene.lights[0];
  assert(light?.type === "directional");
  assertEquals(light.illuminance_lux, 17_000);
  assertEquals([light.color.r, light.color.g, light.color.b], [
    0.91,
    0.72,
    0.53,
  ]);
  const voxel = scene.hierarchy.nodes.find(({ id }) => id.index === 1);
  assert(voxel !== undefined);
  assertEquals([
    voxel.local_transform.position.x,
    voxel.local_transform.position.y,
    voxel.local_transform.position.z,
  ], [2, 3, 4]);
  assertEquals([
    voxel.local_transform.scale.x,
    voxel.local_transform.scale.y,
    voxel.local_transform.scale.z,
  ], [0.5, 0.5, 0.5]);
});

import { assertThrows } from "@std/assert";
import {
  simple3d_mesh_id,
  type Simple3dScene,
  validate_simple3d_scene,
} from "./simple3d.ts";

Deno.test("simple 3D scenes reject duplicate object identities", () => {
  const object = {
    id: "plinth",
    shape: "cube",
    position: [0, 0, 0],
    rotation_y_radians: 0,
    scale: [1, 1, 1],
    material: {
      albedo: [0.5, 0.5, 0.5],
      emissive: [0, 0, 0],
      metallic: 0,
      roughness: 0.5,
    },
  } as const;
  const scene: Simple3dScene = {
    camera: {
      position: [0, 2, 5],
      target: [0, 0, 0],
      vertical_fov_radians: 1,
    },
    clear_color: [0, 0, 0],
    ambient_color: [0.1, 0.1, 0.1],
    directional_light: {
      color: [1, 1, 1],
      direction: [0, -1, 0.2],
      intensity: 1,
    },
    point_lights: [],
    spot_lights: [],
    fog_color: [0, 0, 0],
    fog_density: 0,
    exposure: 0,
    bloom_intensity: 0,
    meshes: [],
    objects: [object, object],
  };

  assertThrows(
    () => validate_simple3d_scene(scene),
    Error,
    'repeats object id "plinth"',
  );
});

Deno.test("simple 3D scenes reject objects that select a missing imported mesh", () => {
  const scene: Simple3dScene = {
    camera: {
      position: [0, 2, 5],
      target: [0, 0, 0],
      vertical_fov_radians: 1,
    },
    clear_color: [0, 0, 0],
    ambient_color: [0.1, 0.1, 0.1],
    directional_light: {
      color: [1, 1, 1],
      direction: [0, -1, 0.2],
      intensity: 1,
    },
    point_lights: [],
    spot_lights: [],
    fog_color: [0, 0, 0],
    fog_density: 0,
    exposure: 0,
    bloom_intensity: 0,
    meshes: [],
    objects: [{
      id: "missing-statue",
      shape: "mesh",
      mesh: simple3d_mesh_id("statue"),
      position: [0, 0, 0],
      rotation_y_radians: 0,
      scale: [1, 1, 1],
      material: {
        albedo: [0.5, 0.5, 0.5],
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 0.5,
      },
    }],
  };

  assertThrows(
    () => validate_simple3d_scene(scene),
    Error,
    'selects missing mesh "statue"',
  );
});

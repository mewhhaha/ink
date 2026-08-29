import type { StaticGltfScene } from "@ink/assets/gltf_model.ts";
import {
  simple3d_mesh_id,
  type Simple3dMaterial,
  type Simple3dObject,
  type Simple3dScene,
} from "@ink/rendering/simple3d.ts";

const brass: Simple3dMaterial = {
  albedo: [0.74, 0.42, 0.09],
  emissive: [0, 0, 0],
  metallic: 1,
  roughness: 0.18,
};
const ceramic: Simple3dMaterial = {
  albedo: [0.17, 0.43, 0.75],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.34,
};
const stone: Simple3dMaterial = {
  albedo: [0.28, 0.25, 0.22],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.92,
};

export function lighting_scene(
  elapsed_seconds: number,
  reference_scene: StaticGltfScene,
): Simple3dScene {
  const imported_objects: readonly Simple3dObject[] = reference_scene.meshes
    .map((mesh, index) => ({
      id: `bevy-reference-${index}`,
      shape: "mesh",
      mesh: simple3d_mesh_id(mesh.id),
      position: [0, 0, 0],
      rotation_y_radians: 0,
      scale: [1, 1, 1],
      material: mesh.material,
    }));
  const camera_sway = Math.sin(elapsed_seconds * 0.08) * 0.16;
  return {
    camera: {
      position: [-1.7 + camera_sway, 1.5, 4.5],
      target: [-1.5, 1.7, 3.5],
      vertical_fov_radians: 0.78,
    },
    clear_color: [0.006, 0.01, 0.022],
    ambient_color: [0.04, 0.045, 0.055],
    directional_light: {
      color: [0.72, 0.8, 1],
      direction: [-0.52, -1, -0.3],
      intensity: 0.45,
    },
    point_lights: [
      {
        color: [1, 0.22, 0.035],
        position: [-1.4, 1.1, 5],
        intensity: 3.2,
        range: 8,
      },
      {
        color: [0.07, 0.3, 1],
        position: [1.8, 2.5, 1],
        intensity: 2.8,
        range: 8,
      },
      {
        color: [1, 0.63, 0.16],
        position: [-2.2, 3.8, -2.8],
        intensity: 2.4,
        range: 9,
      },
      {
        color: [0.6, 0.12, 1],
        position: [2.1, 1.4, -4.2],
        intensity: 2.2,
        range: 8,
      },
    ],
    spot_lights: [
      {
        color: [1, 0.72, 0.42],
        position: [-2.4, 5.4, 3.5],
        direction: [0.25, -1, -0.35],
        intensity: 3.5,
        range: 15,
        outer_angle_radians: 0.48,
      },
      {
        color: [0.28, 0.48, 1],
        position: [2.2, 4.8, -1.5],
        direction: [-0.25, -1, 0.25],
        intensity: 3,
        range: 15,
        outer_angle_radians: 0.55,
      },
    ],
    fog_color: [0.025, 0.04, 0.075],
    fog_density: 0.025,
    exposure: -1.15,
    bloom_intensity: 0.2,
    meshes: reference_scene.meshes.map((mesh) => ({
      id: simple3d_mesh_id(mesh.id),
      vertices: mesh.vertices,
    })),
    objects: [
      ...imported_objects,
      {
        id: "rough-stone",
        shape: "sphere",
        position: [-0.75, 0.48, 2.25],
        rotation_y_radians: 0,
        scale: [0.42, 0.42, 0.42],
        material: stone,
      },
      {
        id: "glazed-ceramic",
        shape: "sphere",
        position: [0.25, 0.48, 2.25],
        rotation_y_radians: 0,
        scale: [0.42, 0.42, 0.42],
        material: ceramic,
      },
      {
        id: "polished-brass",
        shape: "sphere",
        position: [1.25, 0.48, 2.25],
        rotation_y_radians: 0,
        scale: [0.42, 0.42, 0.42],
        material: brass,
      },
      {
        id: "emissive-lamp",
        shape: "sphere",
        position: [0.25, 1.5 + Math.sin(elapsed_seconds) * 0.05, 2.25],
        rotation_y_radians: 0,
        scale: [0.14, 0.14, 0.14],
        material: {
          albedo: [0.12, 0.3, 0.5],
          emissive: [0.15, 2.4, 8],
          metallic: 0,
          roughness: 0.12,
        },
      },
    ],
  };
}

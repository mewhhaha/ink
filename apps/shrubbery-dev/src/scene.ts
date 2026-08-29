import type { Simple3dObject, Simple3dScene } from "@ink/rendering/simple3d.ts";
import type { ShrubberyVoxel } from "./runtime.ts";

export function shrubbery_scene(
  voxels: readonly ShrubberyVoxel[],
  elapsed_seconds: number,
): Simple3dScene {
  const orbit = elapsed_seconds * 0.16;
  const objects: Simple3dObject[] = [
    {
      id: "ground",
      shape: "plane",
      position: [0, -0.14, 0],
      rotation_y_radians: 0,
      scale: [24, 1, 24],
      material: {
        albedo: [0.09, 0.14, 0.075],
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 0.94,
      },
    },
    ...voxels.map((voxel, index) => ({
      id: `voxel-${index}`,
      shape: "cube" as const,
      position: [voxel.x, voxel.y + voxel.scale / 2, voxel.z] as const,
      rotation_y_radians: 0,
      scale: [voxel.scale, voxel.scale, voxel.scale] as const,
      material: {
        albedo: voxel.color,
        emissive: [0, 0, 0] as const,
        metallic: 0,
        roughness: 0.88,
      },
    })),
  ];
  return {
    camera: {
      position: [Math.sin(orbit) * 16, 9, Math.cos(orbit) * 16],
      target: [0, 2.1, 0],
      vertical_fov_radians: 0.85,
    },
    clear_color: [0.016, 0.025, 0.045],
    ambient_color: [0.08, 0.11, 0.16],
    directional_light: {
      color: [1, 0.86, 0.65],
      direction: [-0.5, -1, -0.32],
      intensity: 2.2,
    },
    point_lights: [],
    spot_lights: [],
    fog_color: [0.03, 0.055, 0.075],
    fog_density: 0.013,
    exposure: -0.25,
    bloom_intensity: 0.08,
    meshes: [],
    textures: [],
    objects,
  };
}

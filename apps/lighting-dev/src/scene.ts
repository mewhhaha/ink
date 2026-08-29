import type { StaticGltfScene } from "@ink/assets/gltf_model.ts";
import {
  simple3d_mesh_id,
  simple3d_texture_id,
  type Simple3dMaterial,
  type Simple3dObject,
  type Simple3dScene,
  type Simple3dTexture,
  type Simple3dVector,
} from "@ink/rendering/simple3d.ts";

export type LightingReference = "bistro" | "caldera" | "fog-room";

interface ReferencePresentation {
  readonly description: string;
  readonly source: string;
  readonly title: string;
}

interface ScenePresentation {
  readonly ambient_color: Simple3dVector;
  readonly bloom_intensity: number;
  readonly camera: Simple3dScene["camera"];
  readonly clear_color: Simple3dVector;
  readonly exposure: number;
  readonly fog_color: Simple3dVector;
  readonly fog_density: number;
  readonly point_lights: Simple3dScene["point_lights"];
  readonly spot_lights: Simple3dScene["spot_lights"];
  readonly sun_intensity: number;
  readonly test_objects: readonly Simple3dObject[];
}

export const reference_presentations: Readonly<
  Record<LightingReference, ReferencePresentation>
> = {
  bistro: {
    title: "Bistro street",
    description:
      "NVIDIA's Amazon Lumberyard Bistro Exterior from Bevy's large-scene example, shown from an elevated overview camera.",
    source: "/assets/reference/BistroExterior.glb",
  },
  caldera: {
    title: "Caldera hotel",
    description:
      "Activision's Caldera Hotel 01 building shell, using Bevy's model scale and first benchmark camera.",
    source: "/assets/reference/CalderaHotel.glb",
  },
  "fog-room": {
    title: "Fog room",
    description:
      "Bevy's compact volumetric-fog room with Ink's directional shadows, local lights, metal, emissive bloom, fog, and ACES tone mapping.",
    source: "/assets/bevy/VolumetricFogExample.glb",
  },
};

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
const caldera_palette: readonly Simple3dVector[] = [
  [0.62, 0.49, 0.35],
  [0.76, 0.68, 0.54],
  [0.42, 0.48, 0.5],
  [0.34, 0.39, 0.28],
  [0.58, 0.36, 0.27],
];

export function lighting_scene(
  elapsed_seconds: number,
  reference_scene: StaticGltfScene,
  reference: LightingReference = "fog-room",
  textures: readonly Simple3dTexture[] = [],
): Simple3dScene {
  const imported_objects: readonly Simple3dObject[] = reference_scene.meshes
    .map((mesh, index) => ({
      id: `${reference}-reference-${index}`,
      shape: "mesh",
      mesh: simple3d_mesh_id(mesh.id),
      position: [0, 0, 0],
      rotation_y_radians: 0,
      scale: [1, 1, 1],
      material: reference === "caldera"
        ? caldera_material(index)
        : mesh.material,
    }));
  const presentation = scene_presentation(reference, elapsed_seconds);
  return {
    camera: presentation.camera,
    clear_color: presentation.clear_color,
    ambient_color: presentation.ambient_color,
    directional_light: {
      color: [1, 0.9, 0.78],
      direction: [-0.52, -1, -0.3],
      intensity: presentation.sun_intensity,
    },
    point_lights: presentation.point_lights,
    spot_lights: presentation.spot_lights,
    fog_color: presentation.fog_color,
    fog_density: presentation.fog_density,
    exposure: presentation.exposure,
    bloom_intensity: presentation.bloom_intensity,
    meshes: reference_scene.meshes.map((mesh) => ({
      id: simple3d_mesh_id(mesh.id),
      vertices: mesh.vertices,
      ...(mesh.material.base_color_texture === undefined ? {} : {
        base_color_texture: simple3d_texture_id(
          mesh.material.base_color_texture,
        ),
      }),
    })),
    textures,
    objects: [...imported_objects, ...presentation.test_objects],
  };
}

function caldera_material(index: number): Simple3dMaterial {
  return {
    albedo: caldera_palette[index % caldera_palette.length],
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 0.72,
  };
}

function scene_presentation(
  reference: LightingReference,
  elapsed_seconds: number,
): ScenePresentation {
  if (reference === "bistro") {
    const sway = Math.sin(elapsed_seconds * 0.08) * 0.2;
    return daylight(
      [20 + sway, 62, -105],
      [20, 8, 0],
      [0.24, 0.38, 0.58],
      [0.82, 0.84, 0.9],
      0.35,
    );
  }
  if (reference === "caldera") {
    const sway = Math.sin(elapsed_seconds * 0.08) * 0.35;
    return daylight(
      [-20.15 + sway, 16.82, 42.81],
      [-8.33, 7.29, 29.78],
      [0.22, 0.34, 0.52],
      [0.2, 0.22, 0.25],
      -0.35,
    );
  }
  return fog_room(elapsed_seconds);
}

function daylight(
  position: Simple3dVector,
  target: Simple3dVector,
  sky: Simple3dVector,
  ambient_color: Simple3dVector,
  exposure: number,
): ScenePresentation {
  return {
    camera: { position, target, vertical_fov_radians: Math.PI / 3 },
    clear_color: sky,
    ambient_color,
    point_lights: [],
    spot_lights: [],
    fog_color: sky,
    fog_density: 0.0015,
    exposure,
    bloom_intensity: 0.08,
    sun_intensity: 2.4,
    test_objects: [],
  };
}

function fog_room(elapsed_seconds: number): ScenePresentation {
  const camera_sway = Math.sin(elapsed_seconds * 0.08) * 0.16;
  return {
    camera: {
      position: [-1.7 + camera_sway, 1.5, 4.5],
      target: [-1.5, 1.7, 3.5],
      vertical_fov_radians: 0.78,
    },
    clear_color: [0.006, 0.01, 0.022],
    ambient_color: [0.04, 0.045, 0.055],
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
    sun_intensity: 0.45,
    test_objects: material_test_objects(elapsed_seconds),
  };
}

function material_test_objects(
  elapsed_seconds: number,
): readonly Simple3dObject[] {
  return [
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
  ];
}

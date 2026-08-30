import type {
  StaticGltfMaterial,
  StaticGltfMesh,
  StaticGltfScene,
} from "@ink/assets/gltf_model.ts";
import {
  simple3d_mesh_id,
  simple3d_texture_id,
  type Simple3dCamera,
  type Simple3dMaterial,
  type Simple3dMesh,
  type Simple3dObject,
  type Simple3dScene,
  type Simple3dTexture,
  type Simple3dTextureId,
  type Simple3dVector,
} from "@ink/rendering/simple3d.ts";

export type LightingReference = "bistro" | "caldera" | "fog-room";
export type ReferenceTextureUsage = "base-color" | "normal";

export interface LightingSettings {
  readonly ambient_intensity: number;
  readonly exposure: number;
  readonly fog_density: number;
  readonly sun_intensity: number;
}

export interface ReferencePresentation {
  readonly camera: Simple3dCamera;
  readonly description: string;
  readonly move_speed: number;
  readonly settings: LightingSettings;
  readonly source: string;
  readonly title: string;
}

export interface LightingReferenceModel {
  readonly meshes: readonly Simple3dMesh[];
  readonly objects: readonly Simple3dObject[];
  readonly reference: LightingReference;
  readonly source_mesh_count: number;
  readonly textures: readonly Simple3dTexture[];
  readonly triangle_count: number;
}

interface ScenePresentation {
  readonly ambient_color: Simple3dVector;
  readonly bloom_intensity: number;
  readonly clear_color: Simple3dVector;
  readonly directional_color: Simple3dVector;
  readonly fog_color: Simple3dVector;
  readonly point_lights: Simple3dScene["point_lights"];
  readonly spot_lights: Simple3dScene["spot_lights"];
  readonly test_objects: readonly Simple3dObject[];
}

interface MeshGroup {
  readonly base_color_texture?: Simple3dTextureId;
  readonly material: Simple3dMaterial;
  readonly meshes: StaticGltfMesh[];
  readonly normal_texture?: Simple3dTextureId;
}

export const caldera_surface_texture_id = simple3d_texture_id(
  "caldera/masonry",
);

export const reference_presentations: Readonly<
  Record<LightingReference, ReferencePresentation>
> = {
  bistro: {
    title: "Bistro street",
    description: "NVIDIA Bistro Exterior",
    move_speed: 18,
    source: "/reference/BistroExterior.glb",
    camera: {
      position: [20, 62, -105],
      target: [20, 8, 0],
      vertical_fov_radians: Math.PI / 3,
    },
    settings: {
      ambient_intensity: 1,
      exposure: 0.16,
      fog_density: 0.001,
      sun_intensity: 4.8,
    },
  },
  caldera: {
    title: "Caldera hotel",
    description: "Activision Caldera Hotel 01",
    move_speed: 8,
    source: "/reference/CalderaHotel.glb",
    camera: {
      position: [-20.15, 16.82, 42.81],
      target: [-8.33, 7.29, 29.78],
      vertical_fov_radians: Math.PI / 3,
    },
    settings: {
      ambient_intensity: 1,
      exposure: -0.28,
      fog_density: 0.0015,
      sun_intensity: 3.6,
    },
  },
  "fog-room": {
    title: "Fog room",
    description: "Bevy volumetric fog room",
    move_speed: 3,
    source: "/bevy/VolumetricFogExample.glb",
    camera: {
      position: [-1.7, 1.5, 4.5],
      target: [-1.5, 1.7, 3.5],
      vertical_fov_radians: 0.78,
    },
    settings: {
      ambient_intensity: 1,
      exposure: -1.15,
      fog_density: 0.025,
      sun_intensity: 0.45,
    },
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
  [0.73, 0.62, 0.47],
  [0.87, 0.81, 0.68],
  [0.56, 0.62, 0.61],
  [0.48, 0.52, 0.42],
  [0.69, 0.45, 0.35],
];

export function reference_texture_id(
  source_id: string,
  usage: ReferenceTextureUsage,
): Simple3dTextureId {
  return simple3d_texture_id(`${source_id}#${usage}`);
}

export function prepare_lighting_reference(
  scene: StaticGltfScene,
  reference: LightingReference,
  textures: readonly Simple3dTexture[],
): LightingReferenceModel {
  const groups = [...group_meshes(scene.meshes, reference).values()];
  const meshes = groups.map(merge_mesh_group);
  const objects: readonly Simple3dObject[] = meshes.map((mesh, index) => ({
    id: `${reference}-surface-${index}`,
    shape: "mesh",
    mesh: mesh.id,
    position: [0, 0, 0],
    rotation_y_radians: 0,
    scale: [1, 1, 1],
    material: groups[index].material,
  }));
  return {
    meshes,
    objects,
    reference,
    source_mesh_count: scene.meshes.length,
    textures,
    triangle_count: scene.meshes.reduce(
      (count, mesh) => count + mesh.indices.length / 3,
      0,
    ),
  };
}

export function lighting_scene(
  elapsed_seconds: number,
  model: LightingReferenceModel,
  camera: Simple3dCamera,
  settings: LightingSettings,
): Simple3dScene {
  const presentation = scene_presentation(model.reference, elapsed_seconds);
  const ambient_color: Simple3dVector = [
    presentation.ambient_color[0] * settings.ambient_intensity,
    presentation.ambient_color[1] * settings.ambient_intensity,
    presentation.ambient_color[2] * settings.ambient_intensity,
  ];
  return {
    camera,
    clear_color: presentation.clear_color,
    ambient_color,
    directional_light: {
      color: presentation.directional_color,
      direction: [-0.52, -1, -0.3],
      intensity: settings.sun_intensity,
    },
    point_lights: presentation.point_lights,
    spot_lights: presentation.spot_lights,
    fog_color: presentation.fog_color,
    fog_density: settings.fog_density,
    exposure: settings.exposure,
    bloom_intensity: presentation.bloom_intensity,
    meshes: model.meshes,
    textures: model.textures,
    objects: presentation.test_objects.length === 0
      ? model.objects
      : [...model.objects, ...presentation.test_objects],
  };
}

function group_meshes(
  meshes: readonly StaticGltfMesh[],
  reference: LightingReference,
): ReadonlyMap<string, MeshGroup> {
  const groups = new Map<string, MeshGroup>();
  for (const [index, mesh] of meshes.entries()) {
    const material = reference === "caldera"
      ? caldera_material(index)
      : mesh.material;
    const base_color_texture = reference === "caldera"
      ? caldera_surface_texture_id
      : rendered_texture(mesh.material, "base-color");
    const normal_texture = rendered_texture(mesh.material, "normal");
    const key = JSON.stringify([
      material.albedo,
      material.emissive,
      material.metallic,
      material.roughness,
      base_color_texture,
      normal_texture,
    ]);
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.meshes.push(mesh);
      continue;
    }
    groups.set(key, {
      ...(base_color_texture === undefined ? {} : { base_color_texture }),
      material,
      meshes: [mesh],
      ...(normal_texture === undefined ? {} : { normal_texture }),
    });
  }
  return groups;
}

function rendered_texture(
  material: StaticGltfMaterial,
  usage: ReferenceTextureUsage,
): Simple3dTextureId | undefined {
  const source = usage === "base-color"
    ? material.base_color_texture
    : material.normal_texture;
  return source === undefined ? undefined : reference_texture_id(source, usage);
}

function merge_mesh_group(group: MeshGroup, group_index: number): Simple3dMesh {
  const vertex_float_count = group.meshes.reduce(
    (count, mesh) => count + mesh.vertices.length,
    0,
  );
  const index_count = group.meshes.reduce(
    (count, mesh) => count + mesh.indices.length,
    0,
  );
  const vertices = new Float32Array(vertex_float_count);
  const indices = new Uint32Array(index_count);
  let vertex_offset = 0;
  let index_offset = 0;
  for (const mesh of group.meshes) {
    vertices.set(mesh.vertices, vertex_offset * 8);
    for (const index of mesh.indices) {
      indices[index_offset] = index + vertex_offset;
      index_offset += 1;
    }
    vertex_offset += mesh.vertices.length / 8;
  }
  return {
    ...(group.base_color_texture === undefined
      ? {}
      : { base_color_texture: group.base_color_texture }),
    id: simple3d_mesh_id(`reference-surface-${group_index}`),
    indices,
    ...(group.normal_texture === undefined
      ? {}
      : { normal_texture: group.normal_texture }),
    vertices,
  };
}

function caldera_material(index: number): Simple3dMaterial {
  return {
    albedo: caldera_palette[index % caldera_palette.length],
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 0.82,
  };
}

function scene_presentation(
  reference: LightingReference,
  elapsed_seconds: number,
): ScenePresentation {
  if (reference === "bistro") {
    return {
      ambient_color: [0.42, 0.46, 0.54],
      bloom_intensity: 0.06,
      clear_color: [0.18, 0.32, 0.54],
      directional_color: [1, 0.91, 0.78],
      fog_color: [0.18, 0.32, 0.54],
      point_lights: [],
      spot_lights: [],
      test_objects: [],
    };
  }
  if (reference === "caldera") {
    return {
      ambient_color: [0.18, 0.2, 0.22],
      bloom_intensity: 0.05,
      clear_color: [0.22, 0.34, 0.52],
      directional_color: [1, 0.9, 0.75],
      fog_color: [0.22, 0.34, 0.52],
      point_lights: [],
      spot_lights: [],
      test_objects: [],
    };
  }
  return fog_room(elapsed_seconds);
}

function fog_room(elapsed_seconds: number): ScenePresentation {
  return {
    clear_color: [0.006, 0.01, 0.022],
    ambient_color: [0.04, 0.045, 0.055],
    directional_color: [1, 0.9, 0.78],
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
    bloom_intensity: 0.2,
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

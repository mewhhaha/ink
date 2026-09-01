import type {
  StaticGltfMaterial,
  StaticGltfMesh,
  StaticGltfScene,
} from "@ink/assets/prepared_scene.ts";
import { light_id } from "@ink/lighting/identity.ts";
import { create_light } from "@ink/lighting/light.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import {
  type BuiltInGeometry,
  perspective_render_camera,
  render_color,
  render_directional_light,
  render_material,
  render_mesh_id,
  render_mesh_metadata,
  render_node_id,
  render_point_light,
  render_scene_hierarchy,
  render_scene_node,
  render_spot_light,
  render_texture_id,
  type RenderCamera,
  type RenderMaterialInput,
  type RenderMesh,
  type RenderMeshId,
  type RenderMeshMetadata,
  type RenderObject,
  type RenderScene,
  type RenderTexture,
  type RenderTextureId,
  type RenderVector,
} from "@ink/rendering/renderer.ts";
import {
  cornell_camera,
  cornell_camera_target,
  cornell_lighting_settings,
} from "./cornell_scene.ts";
import type { LightingTechniqueSupport } from "./technique.ts";

export type PreparedLightingReference = "bistro" | "caldera" | "fog-room";
export type LightingReference = "cornell" | PreparedLightingReference;
export type FogMaterialResponse = "authored" | "diffuse_control";
export type ReferenceNormalResponse = "authored" | "flat_control";
export type ReferenceTextureUsage = "base-color" | "normal";

export interface LightingSettings {
  readonly ambient_intensity: number;
  readonly exposure: number;
  readonly fog_density: number;
  readonly sun_intensity: number;
}

export interface ReferencePresentation {
  readonly camera: RenderCamera;
  readonly camera_target: RenderVector;
  readonly description: string;
  readonly move_speed: number;
  readonly settings: LightingSettings;
  readonly technique_support: LightingTechniqueSupport;
  readonly title: string;
}

export interface LightingReferenceModel {
  readonly meshes: readonly RenderMesh[];
  readonly mesh_metadata: RenderMeshMetadata;
  readonly objects: readonly LightingRenderObject[];
  readonly reference: PreparedLightingReference;
  readonly source_mesh_count: number;
  readonly textures: readonly RenderTexture[];
  readonly triangle_count: number;
}

interface ScenePresentation {
  readonly ambient_color: RenderVector;
  readonly bloom_intensity: number;
  readonly clear_color: RenderVector;
  readonly directional_color: RenderVector;
  readonly directional_direction: RenderVector;
  readonly fog_color: RenderVector;
  readonly point_lights: readonly PointLightDescription[];
  readonly rectangular_lights: readonly RectangularLightDescription[];
  readonly spot_lights: readonly SpotLightDescription[];
  readonly test_objects: readonly LightingRenderObject[];
}

interface PointLightDescription {
  readonly color: RenderVector;
  readonly position: RenderVector;
  readonly intensity: number;
  readonly range: number;
}

interface SpotLightDescription extends PointLightDescription {
  readonly direction: RenderVector;
  readonly outer_angle_radians: number;
}

interface RectangularLightDescription {
  readonly color: RenderVector;
  readonly luminance_nits: number;
  readonly normal: RenderVector;
  readonly position: RenderVector;
  readonly range: number;
  readonly size: readonly [number, number];
  readonly tangent: RenderVector;
}

interface LightingRenderObjectProperties {
  readonly id: string;
  readonly position: RenderVector;
  readonly rotation_y_radians: number;
  readonly scale: RenderVector;
  readonly material: RenderMaterialInput;
}

type LightingRenderObject =
  & LightingRenderObjectProperties
  & (
    | { readonly shape: BuiltInGeometry }
    | { readonly shape: "mesh"; readonly mesh: RenderMeshId }
  );

interface MeshGroup {
  readonly base_color_texture?: RenderTextureId;
  readonly material: RenderMaterialInput;
  readonly meshes: StaticGltfMesh[];
  readonly normal_texture?: RenderTextureId;
}

export const reference_presentations: Readonly<
  Record<LightingReference, ReferencePresentation>
> = {
  cornell: {
    title: "Cornell box",
    description: "Cornell Program of Computer Graphics benchmark",
    move_speed: 0.5,
    camera: cornell_camera,
    camera_target: cornell_camera_target,
    settings: cornell_lighting_settings,
    technique_support: { type: "raster_and_path_traced" },
  },
  bistro: {
    title: "Bistro street",
    description: "NVIDIA Bistro Exterior",
    move_speed: 18,
    camera: perspective_render_camera("lighting.bistro", {
      position: [20, 62, -105],
      target: [20, 8, 0],
      vertical_fov_radians: Math.PI / 3,
      clear_color: [0.18, 0.32, 0.54],
    }),
    camera_target: [20, 8, 0],
    settings: {
      ambient_intensity: 1,
      exposure: -0.35,
      fog_density: 0.001,
      sun_intensity: 2.2,
    },
    technique_support: {
      type: "raster_only",
      reason: "Bistro remains a raster stress scene.",
    },
  },
  caldera: {
    title: "Caldera hotel",
    description: "Activision Caldera Hotel 01",
    move_speed: 8,
    camera: perspective_render_camera("lighting.caldera", {
      position: [-20.15, 16.82, 42.81],
      target: [-8.33, 7.29, 29.78],
      vertical_fov_radians: Math.PI / 3,
      clear_color: [0.22, 0.34, 0.52],
    }),
    camera_target: [-8.33, 7.29, 29.78],
    settings: {
      ambient_intensity: 1,
      exposure: -0.28,
      fog_density: 0.0015,
      sun_intensity: 3.6,
    },
    technique_support: {
      type: "raster_only",
      reason: "Caldera path tracing requires digest-keyed acceleration data.",
    },
  },
  "fog-room": {
    title: "Fog room",
    description: "Bevy volumetric fog room",
    move_speed: 3,
    camera: perspective_render_camera("lighting.fog-room", {
      position: [0.25, 1.45, 5.5],
      target: [0.25, 0.59, 2.25],
      vertical_fov_radians: 0.72,
      clear_color: [0.006, 0.01, 0.022],
    }),
    camera_target: [0.25, 0.59, 2.25],
    settings: {
      ambient_intensity: 1,
      exposure: -0.55,
      fog_density: 0.025,
      sun_intensity: 0.45,
    },
    technique_support: { type: "raster_and_path_traced" },
  },
};

const brass: RenderMaterialInput = {
  albedo: [0.74, 0.42, 0.09],
  emissive: [0, 0, 0],
  metallic: 1,
  roughness: 0.18,
};
const ceramic: RenderMaterialInput = {
  albedo: [0.17, 0.43, 0.75],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.34,
};
const diffuse_brass: RenderMaterialInput = {
  ...brass,
  metallic: 0,
  roughness: 1,
};
const diffuse_ceramic: RenderMaterialInput = {
  ...ceramic,
  roughness: 1,
};
const stone: RenderMaterialInput = {
  albedo: [0.28, 0.25, 0.22],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.92,
};
const material_stage: RenderMaterialInput = {
  albedo: [0.38, 0.4, 0.44],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.88,
};
export function reference_texture_id(
  source_id: string,
  usage: ReferenceTextureUsage,
): RenderTextureId {
  return render_texture_id(`${source_id}#${usage}`);
}

export function prepare_lighting_reference(
  scene: StaticGltfScene,
  reference: PreparedLightingReference,
  textures: readonly RenderTexture[],
): LightingReferenceModel {
  const groups = [...group_meshes(scene.meshes, reference).values()];
  const meshes = groups.map(merge_mesh_group);
  const objects: readonly LightingRenderObject[] = meshes.map((
    mesh,
    index,
  ) => ({
    id: `${reference}-surface-${index}`,
    shape: "mesh",
    mesh: mesh.id,
    position: [0, 0, 0],
    rotation_y_radians: 0,
    scale: [1, 1, 1],
    material: {
      ...groups[index].material,
      ...(groups[index].base_color_texture === undefined
        ? {}
        : { base_color_texture: groups[index].base_color_texture }),
      ...(groups[index].normal_texture === undefined
        ? {}
        : { normal_texture: groups[index].normal_texture }),
    },
  }));
  return {
    meshes,
    mesh_metadata: render_mesh_metadata(meshes),
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
  camera: RenderCamera,
  settings: LightingSettings,
  fog_material_response: FogMaterialResponse,
  reference_normal_response: ReferenceNormalResponse,
): RenderScene {
  const presentation = scene_presentation(
    model.reference,
    elapsed_seconds,
    fog_material_response,
  );
  const ambient_color: RenderVector = [
    presentation.ambient_color[0] * settings.ambient_intensity,
    presentation.ambient_color[1] * settings.ambient_intensity,
    presentation.ambient_color[2] * settings.ambient_intensity,
  ];
  const objects = presentation.test_objects.length === 0
    ? model.objects
    : [...model.objects, ...presentation.test_objects];
  const nodes = objects.map((object, index) =>
    render_scene_node(index, {
      position: object.position,
      rotation: { type: "y_axis", radians: object.rotation_y_radians },
      scale: object.scale,
    })
  );
  const rendered_camera: RenderCamera = {
    ...camera,
    clear: {
      type: "color",
      color: [
        presentation.clear_color[0],
        presentation.clear_color[1],
        presentation.clear_color[2],
        1,
      ],
    },
  };
  return {
    camera: rendered_camera,
    hierarchy: render_scene_hierarchy(
      `lighting/${model.reference}`,
      Math.max(0, Math.floor(elapsed_seconds * 1_000)),
      nodes,
    ),
    lights: [
      render_directional_light(`lighting.${model.reference}.sun`, {
        color: presentation.directional_color,
        direction: presentation.directional_direction,
        illuminance_lux: settings.sun_intensity * 10_000,
      }),
      ...presentation.point_lights.map((light, index) =>
        render_point_light(`lighting.${model.reference}.point-${index}`, {
          color: light.color,
          position: light.position,
          intensity_candela: light.intensity,
          range: light.range,
        })
      ),
      ...presentation.rectangular_lights.map((light, index) =>
        create_light({
          id: light_id(`lighting.${model.reference}.rectangle-${index}`),
          revision: 0,
          color: render_color(light.color),
          layers: 0xffff_ffff,
          importance: 1,
          shadow: { type: "off" },
          type: "rectangular",
          position: vec3(...light.position),
          normal: vec3(...light.normal),
          tangent: vec3(...light.tangent),
          size: vec2(...light.size),
          luminance_nits: light.luminance_nits * settings.sun_intensity,
          range: light.range,
          two_sided: false,
        })
      ),
      ...presentation.spot_lights.map((light, index) =>
        render_spot_light(`lighting.${model.reference}.spot-${index}`, {
          color: light.color,
          position: light.position,
          direction: light.direction,
          intensity_candela: light.intensity,
          range: light.range,
          outer_angle_radians: light.outer_angle_radians,
        })
      ),
    ],
    environment: {
      ambient_light: render_color(ambient_color),
      fog_color: render_color(presentation.fog_color),
      fog_density: settings.fog_density,
      exposure_ev100: settings.exposure,
      bloom_intensity: presentation.bloom_intensity,
    },
    meshes: model.meshes,
    mesh_metadata: model.mesh_metadata,
    mesh_revision: 0,
    textures: model.textures,
    objects: objects.map((object, index) =>
      rendered_object(object, index, reference_normal_response)
    ),
  };
}

function rendered_object(
  object: LightingRenderObject,
  index: number,
  normal_response: ReferenceNormalResponse,
): RenderObject {
  const material: RenderMaterialInput = normal_response === "authored"
    ? object.material
    : {
      albedo: object.material.albedo,
      ...(object.material.base_color_texture === undefined
        ? {}
        : { base_color_texture: object.material.base_color_texture }),
      emissive: object.material.emissive,
      metallic: object.material.metallic,
      roughness: object.material.roughness,
    };
  const properties = {
    id: object.id,
    node: render_node_id(index),
    material: render_material(`lighting/${object.id}`, material),
  };
  return object.shape === "mesh"
    ? { ...properties, shape: "mesh", mesh: object.mesh }
    : { ...properties, shape: object.shape };
}

function group_meshes(
  meshes: readonly StaticGltfMesh[],
  reference: PreparedLightingReference,
): ReadonlyMap<string, MeshGroup> {
  const groups = new Map<string, MeshGroup>();
  for (const mesh of meshes) {
    const source_material = mesh.material;
    const material: RenderMaterialInput = {
      albedo: source_material.albedo,
      emissive: [0, 0, 0],
      metallic: reference === "bistro" ? 0 : source_material.metallic,
      roughness: source_material.roughness,
    };
    const base_color_texture = rendered_texture(
      mesh.material,
      "base-color",
    );
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
): RenderTextureId | undefined {
  const source = usage === "base-color"
    ? material.base_color_texture
    : material.normal_texture;
  return source === undefined ? undefined : reference_texture_id(source, usage);
}

function merge_mesh_group(group: MeshGroup, group_index: number): RenderMesh {
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
    id: render_mesh_id(`reference-surface-${group_index}`),
    indices,
    vertices,
  };
}

function scene_presentation(
  reference: PreparedLightingReference,
  elapsed_seconds: number,
  fog_material_response: FogMaterialResponse,
): ScenePresentation {
  if (reference === "bistro") {
    return {
      ambient_color: [0.13, 0.145, 0.17],
      bloom_intensity: 0.08,
      clear_color: [0.18, 0.32, 0.54],
      directional_color: [1, 0.91, 0.78],
      directional_direction: [0.45, -1, 0.4],
      fog_color: [0.18, 0.32, 0.54],
      point_lights: [],
      rectangular_lights: [],
      spot_lights: [
        {
          color: [1, 0.55, 0.2],
          position: [-8, 20, -18],
          direction: [0.55, -1, 0.65],
          intensity: 9,
          range: 70,
          outer_angle_radians: 0.52,
        },
        {
          color: [0.28, 0.5, 1],
          position: [45, 18, 16],
          direction: [-0.7, -1, -0.35],
          intensity: 7,
          range: 65,
          outer_angle_radians: 0.6,
        },
      ],
      test_objects: [],
    };
  }
  if (reference === "caldera") {
    return {
      ambient_color: [0.065, 0.075, 0.09],
      bloom_intensity: 0.1,
      clear_color: [0.22, 0.34, 0.52],
      directional_color: [1, 0.9, 0.75],
      directional_direction: [-0.52, -1, -0.3],
      fog_color: [0.22, 0.34, 0.52],
      point_lights: [],
      rectangular_lights: [],
      spot_lights: [
        {
          color: [1, 0.48, 0.16],
          position: [-18, 17, 35],
          direction: [0.45, -1, -0.35],
          intensity: 12,
          range: 35,
          outer_angle_radians: 0.48,
        },
        {
          color: [0.25, 0.46, 1],
          position: [1, 15, 24],
          direction: [-0.55, -1, 0.3],
          intensity: 11,
          range: 32,
          outer_angle_radians: 0.55,
        },
      ],
      test_objects: [],
    };
  }
  return fog_room(elapsed_seconds, fog_material_response);
}

function fog_room(
  elapsed_seconds: number,
  material_response: FogMaterialResponse,
): ScenePresentation {
  return {
    clear_color: [0.006, 0.01, 0.022],
    ambient_color: [0.008, 0.01, 0.014],
    directional_color: [1, 0.9, 0.78],
    directional_direction: [-0.52, -1, -0.3],
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
    rectangular_lights: [{
      color: [1, 0.91, 0.78],
      luminance_nits: 100,
      normal: [0.46490839, -0.75347222, 0.46490839],
      position: [-1.2, 3, 0.8],
      range: 10,
      size: [1.4, 0.8],
      tangent: [0.70710678, 0, -0.70710678],
    }],
    spot_lights: [
      {
        color: [1, 0.72, 0.42],
        position: [-2.4, 5.4, 3.5],
        direction: [0.25, -1, -0.35],
        intensity: 8,
        range: 15,
        outer_angle_radians: 0.48,
      },
      {
        color: [0.28, 0.48, 1],
        position: [2.2, 4.8, 3.2],
        direction: [-0.3, -1, -0.2],
        intensity: 7,
        range: 15,
        outer_angle_radians: 0.55,
      },
    ],
    fog_color: [0.025, 0.04, 0.075],
    bloom_intensity: 0.2,
    test_objects: material_test_objects(elapsed_seconds, material_response),
  };
}

function material_test_objects(
  elapsed_seconds: number,
  material_response: FogMaterialResponse,
): readonly LightingRenderObject[] {
  return [
    {
      id: "material-stage",
      shape: "cube",
      position: [0.25, 0.3, 2.25],
      rotation_y_radians: 0,
      scale: [3.2, 0.12, 1.6],
      material: material_stage,
    },
    {
      id: "rough-stone",
      shape: "sphere",
      position: [-0.75, 0.65, 2.25],
      rotation_y_radians: 0,
      scale: [0.58, 0.58, 0.58],
      material: stone,
    },
    {
      id: "glazed-ceramic",
      shape: "sphere",
      position: [0.25, 0.65, 2.25],
      rotation_y_radians: 0,
      scale: [0.58, 0.58, 0.58],
      material: material_response === "authored" ? ceramic : diffuse_ceramic,
    },
    {
      id: "polished-brass",
      shape: "sphere",
      position: [1.25, 0.65, 2.25],
      rotation_y_radians: 0,
      scale: [0.58, 0.58, 0.58],
      material: material_response === "authored" ? brass : diffuse_brass,
    },
    {
      id: "emissive-lamp",
      shape: "sphere",
      position: [0.25, 1.25 + Math.sin(elapsed_seconds) * 0.05, 2.25],
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

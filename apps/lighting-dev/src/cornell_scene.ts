import { light_id } from "@ink/lighting/identity.ts";
import { create_light } from "@ink/lighting/light.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import {
  type BuiltInGeometry,
  perspective_render_camera,
  render_color,
  render_material,
  render_mesh_id,
  render_node_id,
  render_scene_hierarchy,
  render_scene_node,
  render_spot_light,
  type RenderCamera,
  type RenderMaterialInput,
  type RenderMesh,
  type RenderObject,
  type RenderScene,
  type RenderVector,
} from "@ink/rendering/renderer.ts";

export const cornell_dimensions = Object.freeze({
  width: 0.5528,
  height: 0.5488,
  depth: 0.5592,
});

export const cornell_emitter_bounds = Object.freeze({
  minimum_x: 0.213,
  maximum_x: 0.343,
  y: cornell_dimensions.height,
  minimum_z: 0.227,
  maximum_z: 0.332,
});

export const cornell_camera_target: RenderVector = Object.freeze([
  0.278,
  0.273,
  0.3,
]);

export const cornell_camera = perspective_render_camera(
  "lighting.cornell",
  {
    position: [0.278, 0.273, -0.8],
    target: cornell_camera_target,
    vertical_fov_radians: 0.69,
    clear_color: [0, 0, 0],
  },
);

export interface CornellLightingSettings {
  readonly ambient_intensity: number;
  readonly exposure: number;
  readonly fog_density: number;
  readonly sun_intensity: number;
}

export const cornell_lighting_settings: CornellLightingSettings = Object.freeze(
  {
    ambient_intensity: 1,
    exposure: -1.25,
    fog_density: 0,
    sun_intensity: 1,
  },
);

export interface CornellSceneOptions {
  readonly camera?: RenderCamera;
  readonly light_representation?: "area" | "raster_preview";
  readonly settings?: CornellLightingSettings;
}

interface CornellObjectDescription {
  readonly id: string;
  readonly material: RenderMaterialInput;
  readonly position: RenderVector;
  readonly rotation: Parameters<typeof render_scene_node>[1]["rotation"];
  readonly scale: RenderVector;
  readonly shape: BuiltInGeometry | "emitter";
}

const white_diffuse = Object.freeze(
  {
    albedo: [0.725, 0.71, 0.68],
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 0.82,
  } satisfies RenderMaterialInput,
);
const green_diffuse = Object.freeze(
  {
    albedo: [0.14, 0.45, 0.091],
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 0.82,
  } satisfies RenderMaterialInput,
);
const red_diffuse = Object.freeze(
  {
    albedo: [0.63, 0.065, 0.05],
    emissive: [0, 0, 0],
    metallic: 0,
    roughness: 0.82,
  } satisfies RenderMaterialInput,
);
const emitter = Object.freeze(
  {
    albedo: [1, 0.92, 0.74],
    emissive: [15.6, 12, 4.98],
    metallic: 0,
    roughness: 0.25,
  } satisfies RenderMaterialInput,
);
const rough_metal = Object.freeze(
  {
    albedo: [0.78, 0.64, 0.38],
    emissive: [0, 0, 0],
    metallic: 1,
    roughness: 0.28,
  } satisfies RenderMaterialInput,
);
const mirror = Object.freeze(
  {
    albedo: [0.98, 0.98, 0.98],
    emissive: [0, 0, 0],
    metallic: 1,
    roughness: 0,
  } satisfies RenderMaterialInput,
);
const mirror_only = Object.freeze(
  {
    albedo: [0.025, 0.12, 0.95],
    emissive: [0.02, 0.12, 5.5],
    metallic: 0,
    roughness: 0.2,
  } satisfies RenderMaterialInput,
);

const room_width = cornell_dimensions.width;
const room_height = cornell_dimensions.height;
const room_depth = cornell_dimensions.depth;
const emitter_width = cornell_emitter_bounds.maximum_x -
  cornell_emitter_bounds.minimum_x;
const emitter_depth = cornell_emitter_bounds.maximum_z -
  cornell_emitter_bounds.minimum_z;
const emitter_center_x = (cornell_emitter_bounds.minimum_x +
  cornell_emitter_bounds.maximum_x) / 2;
const emitter_center_z = (cornell_emitter_bounds.minimum_z +
  cornell_emitter_bounds.maximum_z) / 2;

const cornell_objects: readonly CornellObjectDescription[] = Object.freeze([
  surface("cornell.wall.floor", white_diffuse, {
    position: [room_width / 2, 0, room_depth / 2],
    scale: [room_width, 1, room_depth],
  }),
  surface("cornell.wall.ceiling-front", white_diffuse, {
    position: [
      room_width / 2,
      room_height,
      cornell_emitter_bounds.minimum_z / 2,
    ],
    scale: [room_width, 1, cornell_emitter_bounds.minimum_z],
  }),
  surface("cornell.wall.ceiling-back", white_diffuse, {
    position: [
      room_width / 2,
      room_height,
      (cornell_emitter_bounds.maximum_z + room_depth) / 2,
    ],
    scale: [
      room_width,
      1,
      room_depth - cornell_emitter_bounds.maximum_z,
    ],
  }),
  surface("cornell.wall.ceiling-green-side", white_diffuse, {
    position: [
      cornell_emitter_bounds.minimum_x / 2,
      room_height,
      emitter_center_z,
    ],
    scale: [cornell_emitter_bounds.minimum_x, 1, emitter_depth],
  }),
  surface("cornell.wall.ceiling-red-side", white_diffuse, {
    position: [
      (cornell_emitter_bounds.maximum_x + room_width) / 2,
      room_height,
      emitter_center_z,
    ],
    scale: [room_width - cornell_emitter_bounds.maximum_x, 1, emitter_depth],
  }),
  surface("cornell.wall.back", white_diffuse, {
    position: [room_width / 2, room_height / 2, room_depth],
    rotation: { type: "euler_xyz", radians: [Math.PI / 2, 0, 0] },
    scale: [room_width, 1, room_height],
  }),
  surface("cornell.wall.green-right", green_diffuse, {
    position: [0, room_height / 2, room_depth / 2],
    rotation: { type: "euler_xyz", radians: [0, 0, -Math.PI / 2] },
    scale: [room_height, 1, room_depth],
  }),
  surface("cornell.wall.red-left", red_diffuse, {
    position: [room_width, room_height / 2, room_depth / 2],
    rotation: { type: "euler_xyz", radians: [0, 0, Math.PI / 2] },
    scale: [room_height, 1, room_depth],
  }),
  {
    id: "cornell.emitter",
    material: emitter,
    position: [0, 0, 0],
    rotation: { type: "y_axis", radians: 0 },
    scale: [1, 1, 1],
    shape: "emitter",
  },
  {
    id: "cornell.rough-metal",
    material: rough_metal,
    position: [0.165, 0.105, 0.325],
    rotation: { type: "y_axis", radians: 0 },
    scale: [0.105, 0.105, 0.105],
    shape: "sphere",
  },
  {
    id: "cornell.white-block",
    material: white_diffuse,
    position: [0.4, 0.075, 0.265],
    rotation: { type: "y_axis", radians: -0.22 },
    scale: [0.075, 0.075, 0.075],
    shape: "cube",
  },
  {
    id: "cornell.mirror",
    material: mirror,
    position: [room_width / 2, 0.315, room_depth - 0.008],
    rotation: { type: "y_axis", radians: 0 },
    scale: [0.12, 0.145, 0.004],
    shape: "cube",
  },
  {
    id: "cornell.mirror-only-object",
    material: mirror_only,
    position: [room_width / 2, 0.273, -1.12],
    rotation: { type: "y_axis", radians: 0 },
    scale: [0.08, 0.08, 0.08],
    shape: "sphere",
  },
]);

const emitter_mesh: RenderMesh = Object.freeze({
  id: render_mesh_id("cornell/emitter"),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  vertices: new Float32Array([
    cornell_emitter_bounds.minimum_x,
    cornell_emitter_bounds.y,
    cornell_emitter_bounds.minimum_z,
    0,
    -1,
    0,
    0,
    0,
    cornell_emitter_bounds.maximum_x,
    cornell_emitter_bounds.y,
    cornell_emitter_bounds.minimum_z,
    0,
    -1,
    0,
    1,
    0,
    cornell_emitter_bounds.maximum_x,
    cornell_emitter_bounds.y,
    cornell_emitter_bounds.maximum_z,
    0,
    -1,
    0,
    1,
    1,
    cornell_emitter_bounds.minimum_x,
    cornell_emitter_bounds.y,
    cornell_emitter_bounds.maximum_z,
    0,
    -1,
    0,
    0,
    1,
  ]),
});

export function cornell_scene(options: CornellSceneOptions = {}): RenderScene {
  const camera = options.camera ?? cornell_camera;
  const light_representation = options.light_representation ?? "area";
  const settings = options.settings ?? cornell_lighting_settings;
  const nodes = cornell_objects.map((object, index) =>
    render_scene_node(index, {
      position: object.position,
      rotation: object.rotation,
      scale: object.scale,
    })
  );
  const objects: readonly RenderObject[] = cornell_objects.map(
    (object, index) => {
      const emissive: RenderVector = [
        object.material.emissive[0] * settings.sun_intensity,
        object.material.emissive[1] * settings.sun_intensity,
        object.material.emissive[2] * settings.sun_intensity,
      ];
      const material = object.shape === "emitter"
        ? { ...object.material, emissive }
        : object.material;
      const properties = {
        id: object.id,
        material: render_material(`lighting/${object.id}`, material),
        node: render_node_id(index),
      };
      return object.shape === "emitter"
        ? { ...properties, shape: "mesh", mesh: emitter_mesh.id }
        : { ...properties, shape: object.shape };
    },
  );
  const ceiling_light = settings.sun_intensity === 0
    ? undefined
    : create_light({
      id: light_id("lighting.cornell.ceiling-emitter"),
      revision: 0,
      color: render_color([1, 0.92, 0.74]),
      layers: 0xffff_ffff,
      importance: 1,
      shadow: { type: "off" },
      type: "rectangular",
      position: vec3(emitter_center_x, room_height, emitter_center_z),
      normal: vec3(0, -1, 0),
      tangent: vec3(1, 0, 0),
      size: vec2(emitter_width, emitter_depth),
      luminance_nits: 15.6 * settings.sun_intensity,
      range: 4,
      two_sided: false,
    });
  const raster_preview_light = settings.sun_intensity === 0 ||
      light_representation === "area"
    ? undefined
    : render_spot_light("lighting.cornell.raster-preview", {
      color: [1, 0.92, 0.74],
      position: [emitter_center_x, room_height - 0.002, emitter_center_z],
      direction: [0, -1, 0],
      intensity_candela: 7 * settings.sun_intensity,
      range: 1.1,
      outer_angle_radians: 1.15,
    });
  const lights = [ceiling_light, raster_preview_light].filter(
    (light) => light !== undefined,
  );
  const ambient_intensity = light_representation === "raster_preview"
    ? 0.08
    : 0.001;
  return Object.freeze({
    camera,
    hierarchy: render_scene_hierarchy("lighting/cornell", 0, nodes),
    lights: Object.freeze(lights),
    environment: Object.freeze({
      ambient_light: render_color([
        ambient_intensity * settings.ambient_intensity,
        ambient_intensity * settings.ambient_intensity,
        ambient_intensity * settings.ambient_intensity,
      ]),
      fog_color: render_color([0, 0, 0]),
      fog_density: settings.fog_density,
      exposure_ev100: settings.exposure,
      bloom_intensity: 0.02,
    }),
    meshes: Object.freeze([emitter_mesh]),
    textures: Object.freeze([]),
    objects: Object.freeze(objects),
  });
}

function surface(
  id: string,
  material: RenderMaterialInput,
  transform: {
    readonly position: RenderVector;
    readonly rotation?: CornellObjectDescription["rotation"];
    readonly scale: RenderVector;
  },
): CornellObjectDescription {
  return {
    id,
    material,
    position: transform.position,
    rotation: transform.rotation ?? { type: "y_axis", radians: 0 },
    scale: transform.scale,
    shape: "plane",
  };
}

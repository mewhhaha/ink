import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import {
  type BuiltInGeometry,
  orthographic_render_camera,
  perspective_render_camera,
  render_color,
  render_directional_light,
  render_material,
  render_node_id,
  render_scene_hierarchy,
  render_scene_node,
  type RenderMaterialInput,
  type RenderScene,
  type RenderVector,
} from "@ink/rendering/renderer.ts";

interface ShrubberyRenderObject {
  readonly id: string;
  readonly shape: BuiltInGeometry;
  readonly position: RenderVector;
  readonly scale: RenderVector;
  readonly material: RenderMaterialInput;
}

export function shrubbery_scene(
  snapshot: RenderSnapshot,
): RenderScene {
  const authored_objects: readonly ShrubberyRenderObject[] = [
    {
      id: "ground",
      shape: "plane",
      position: [0, -0.14, 0],
      scale: [24, 1, 24],
      material: {
        albedo: [0.09, 0.14, 0.075],
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 0.94,
      },
    },
    ...snapshot.objects.map<ShrubberyRenderObject>((object, index) => ({
      id: `voxel-${index}`,
      shape: "cube",
      position: scaled_vector(object.position),
      scale: scaled_vector(object.scale),
      material: {
        albedo: object.color,
        emissive: [0, 0, 0],
        metallic: 0,
        roughness: 0.88,
      },
    })),
  ];
  const nodes = authored_objects.map((object, index) =>
    render_scene_node(index, {
      position: object.position,
      rotation: { type: "y_axis", radians: 0 },
      scale: object.scale,
    })
  );
  const camera = snapshot.camera.type === "perspective"
    ? perspective_render_camera("shrubbery.camera", {
      position: snapshot.camera.position,
      target: snapshot.camera.target,
      vertical_fov_radians: snapshot.camera.vertical_fov_radians,
      clear_color: snapshot.camera.clear_color,
    })
    : orthographic_render_camera("shrubbery.camera", {
      position: snapshot.camera.position,
      target: snapshot.camera.target,
      vertical_size: snapshot.camera.vertical_size,
      clear_color: snapshot.camera.clear_color,
    });
  return {
    camera,
    hierarchy: render_scene_hierarchy("shrubbery", 0, nodes),
    lights: [render_directional_light("shrubbery.sun", {
      color: snapshot.directional_light.color,
      direction: snapshot.directional_light.direction,
      illuminance_lux: snapshot.directional_light.intensity * 10_000,
    })],
    environment: {
      ambient_light: render_color(snapshot.environment.ambient_light),
      fog_color: render_color(snapshot.environment.fog_color),
      fog_density: snapshot.environment.fog_density,
      exposure_ev100: snapshot.environment.exposure_ev100,
      bloom_intensity: snapshot.environment.bloom_intensity,
    },
    meshes: [],
    textures: [],
    objects: authored_objects.map((object, index) => ({
      id: object.id,
      shape: object.shape,
      node: render_node_id(index),
      material: render_material(`shrubbery/${object.id}`, object.material),
    })),
  };
}

function scaled_vector(
  vector: readonly [number, number, number],
): RenderVector {
  return [
    vector[0] / 1_000_000,
    vector[1] / 1_000_000,
    vector[2] / 1_000_000,
  ];
}

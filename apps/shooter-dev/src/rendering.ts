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
  type RenderObject,
  type RenderScene,
  type RenderVector,
} from "@ink/rendering/renderer.ts";
import { visibility_id } from "@ink/visibility/model.ts";

const built_in_geometry = new Map<number, BuiltInGeometry>([
  [0, "cube"],
  [1, "sphere"],
]);

export function shooter_render_scene(
  snapshot: RenderSnapshot,
  revision: number,
): RenderScene {
  if (snapshot.resources.length > 0) {
    throw new Error(
      `shooter snapshot declares ${snapshot.resources.length} external resources; the arena accepts built-in geometry only`,
    );
  }
  const nodes = [
    ...snapshot.nodes.map((node) =>
      render_scene_node(node.id, {
        position: scaled_vector(node.position),
        rotation: { type: "euler_xyz", radians: node.rotation_radians },
        scale: scaled_vector(node.scale),
        ...(node.parent === null
          ? {}
          : { parent: render_node_id(node.parent) }),
        visible: node.visible,
      })
    ),
    ...snapshot.objects.map((object) =>
      render_scene_node(object.id, {
        position: scaled_vector(object.position),
        rotation: { type: "euler_xyz", radians: object.rotation_radians },
        scale: scaled_vector(object.scale),
        ...(object.parent === null
          ? {}
          : { parent: render_node_id(object.parent) }),
        visible: object.visible,
      })
    ),
  ];
  const objects = snapshot.objects.map<RenderObject>((object) => {
    const shape = built_in_geometry.get(object.mesh);
    if (shape === undefined) {
      throw new Error(
        `shooter object ${object.id} selects unsupported built-in mesh ${object.mesh}`,
      );
    }
    if (object.texture !== null || object.secondary_texture !== null) {
      throw new Error(
        `shooter object ${object.id} selects an external texture`,
      );
    }
    return {
      id: `shooter-object-${object.id}`,
      shape,
      node: render_node_id(object.id),
      material: render_material(`shooter/object-${object.id}`, {
        albedo: object.color,
        emissive: [
          object.color[0] * object.emissive,
          object.color[1] * object.emissive,
          object.color[2] * object.emissive,
        ],
        metallic: object.surface_mode === 4 ? 0.45 : 0.08,
        roughness: object.surface_mode === 4 ? 0.3 : 0.64,
      }),
      raster_visibility: {
        id: visibility_id(`shooter.arena.object-${object.id}`),
      },
    };
  });
  const camera = snapshot.camera.type === "perspective"
    ? perspective_render_camera("shooter.arena", {
      position: snapshot.camera.position,
      target: snapshot.camera.target,
      clear_color: snapshot.camera.clear_color,
      vertical_fov_radians: snapshot.camera.vertical_fov_radians,
    })
    : orthographic_render_camera("shooter.arena", {
      position: snapshot.camera.position,
      target: snapshot.camera.target,
      clear_color: snapshot.camera.clear_color,
      vertical_size: snapshot.camera.vertical_size,
    });
  return {
    camera,
    hierarchy: render_scene_hierarchy("shooter/arena", revision, nodes),
    lights: [render_directional_light("shooter.authored-light", {
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
    objects,
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

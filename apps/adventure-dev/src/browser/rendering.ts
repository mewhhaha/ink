import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import {
  orthographic_render_camera,
  perspective_render_camera,
  render_color,
  render_directional_light,
  render_material,
  render_mesh_id,
  render_node_id,
  render_scene_hierarchy,
  render_scene_node,
  type RenderMesh,
  type RenderObject,
  type RenderScene,
  type RenderTexture,
} from "@ink/rendering/renderer.ts";
import { adventure_gate_animation } from "./gate_animation.ts";
import type { AdventurePresentationSettings } from "./presentation.ts";

export interface AdventureRenderAssets {
  readonly meshes: readonly {
    readonly id: number;
    readonly vertices: Float32Array;
    readonly indices: Uint32Array;
  }[];
  readonly textures: readonly {
    readonly id: number;
    readonly texture: RenderTexture;
  }[];
}

export function adventure_render_scene(
  snapshot: RenderSnapshot,
  assets: AdventureRenderAssets,
  revision: number,
  presentation: AdventurePresentationSettings,
): RenderScene {
  const gate_animation = adventure_gate_animation(snapshot);
  const base_camera = snapshot.camera;
  const host_camera = presentation.host_camera;
  const camera_target: readonly [number, number, number] = [
    base_camera.target[0] + host_camera.position_offset[0],
    base_camera.target[1] + host_camera.position_offset[1],
    base_camera.target[2] + host_camera.position_offset[2],
  ];
  const relative_x = base_camera.position[0] - base_camera.target[0];
  const relative_y = base_camera.position[1] - base_camera.target[1];
  const relative_z = base_camera.position[2] - base_camera.target[2];
  const yaw_cosine = Math.cos(host_camera.yaw_radians);
  const yaw_sine = Math.sin(host_camera.yaw_radians);
  const yaw_x = yaw_cosine * relative_x + yaw_sine * relative_z;
  const yaw_z = -yaw_sine * relative_x + yaw_cosine * relative_z;
  const pitch_cosine = Math.cos(host_camera.pitch_radians);
  const pitch_sine = Math.sin(host_camera.pitch_radians);
  const pitch_y = pitch_cosine * relative_y - pitch_sine * yaw_z;
  const pitch_z = pitch_sine * relative_y + pitch_cosine * yaw_z;
  const camera_position: readonly [number, number, number] = [
    camera_target[0] + yaw_x * host_camera.distance_scale,
    camera_target[1] + pitch_y * host_camera.distance_scale,
    camera_target[2] + pitch_z * host_camera.distance_scale,
  ];
  const camera = base_camera.type === "perspective"
    ? perspective_render_camera("adventure.preview", {
      position: camera_position,
      target: camera_target,
      clear_color: base_camera.clear_color,
      vertical_fov_radians: base_camera.vertical_fov_radians,
    })
    : orthographic_render_camera("adventure.preview", {
      position: camera_position,
      target: camera_target,
      clear_color: base_camera.clear_color,
      vertical_size: base_camera.vertical_size,
    });
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
    ...snapshot.objects.map((object) => {
      const position = scaled_vector(object.position);
      const scale = scaled_vector(object.scale);
      return render_scene_node(object.id, {
        position: object.id === 106
          ? [
            position[0] + gate_animation.position_offset[0],
            position[1] + gate_animation.position_offset[1],
            position[2] + gate_animation.position_offset[2],
          ]
          : position,
        rotation: object.id === 106
          ? { type: "y_axis", radians: gate_animation.rotation_y_radians }
          : { type: "euler_xyz", radians: object.rotation_radians },
        scale: object.id === 106
          ? [
            scale[0] * gate_animation.scale[0],
            scale[1] * gate_animation.scale[1],
            scale[2] * gate_animation.scale[2],
          ]
          : scale,
        ...(object.parent === null
          ? {}
          : { parent: render_node_id(object.parent) }),
        visible: object.id === 106
          ? gate_animation.rendered_visible
          : object.visible,
      });
    }),
  ];
  const mesh_assets = new Map(assets.meshes.map((mesh) => [mesh.id, mesh]));
  const texture_assets = new Map(
    assets.textures.map(({ id, texture }) => [id, texture]),
  );
  const meshes = new Map<string, RenderMesh>();
  const objects = snapshot.objects.map<RenderObject>((object) => {
    const source = mesh_assets.get(object.mesh);
    if (source === undefined) {
      throw new Error(
        `adventure object ${object.id} selects missing mesh ${object.mesh}`,
      );
    }
    const texture = object.texture === null
      ? undefined
      : texture_assets.get(object.texture);
    if (object.texture !== null && texture === undefined) {
      throw new Error(
        `adventure object ${object.id} selects missing texture ${object.texture}`,
      );
    }
    const mesh_id = render_mesh_id(
      `adventure/${object.mesh}`,
    );
    if (!meshes.has(mesh_id)) {
      meshes.set(mesh_id, {
        id: mesh_id,
        vertices: source.vertices,
        indices: source.indices,
      });
    }
    return {
      id: `adventure-object-${object.id}`,
      shape: "mesh",
      mesh: mesh_id,
      node: render_node_id(object.id),
      material: render_material(`adventure/object-${object.id}`, {
        albedo: object.color,
        ...(texture === undefined ? {} : { base_color_texture: texture.id }),
        emissive: [
          object.color[0] * object.emissive,
          object.color[1] * object.emissive,
          object.color[2] * object.emissive,
        ],
        metallic: object.surface_mode === 4 ? 0.25 : 0,
        roughness: object.surface_mode === 4 ? 0.48 : 0.82,
      }),
    };
  });
  return {
    camera,
    hierarchy: render_scene_hierarchy("adventure/preview", revision, nodes),
    lights: [render_directional_light("adventure.sun", {
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
    meshes: [...meshes.values()],
    textures: assets.textures.map(({ texture }) => texture),
    objects,
  };
}

function scaled_vector(
  vector: readonly [number, number, number],
): readonly [number, number, number] {
  return [
    vector[0] / 1_000_000,
    vector[1] / 1_000_000,
    vector[2] / 1_000_000,
  ];
}

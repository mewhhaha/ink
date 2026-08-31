import { mesh_topology, type MeshTopology } from "@ink/geometry/mesh.ts";
import {
  vec2,
  vec3,
  vec3_cross,
  vec3_length_squared,
  vec3_subtract,
} from "@ink/math/vector.ts";
import {
  next_path_tracing_accumulation,
} from "@ink/ray-tracing/accumulation.ts";
import {
  ray_tracing_geometry_id,
  ray_tracing_instance_id,
  ray_tracing_scene_revision,
  type RayTracingInstanceId,
} from "@ink/ray-tracing/identity.ts";
import type {
  IndexedRayTracingGeometry,
  PackedRayTracingBvhNode,
  PackedRayTracingScene,
  PathTracingFrame,
  PathTracingPresentationState,
  RayTracingAccelerationUpdate,
  RayTracingSceneInput,
} from "@ink/ray-tracing/scene.ts";
import { ray_tracing_material_identity } from "@ink/ray-tracing/scene.ts";
import {
  build_ray_tracing_scene,
  plan_ray_tracing_acceleration_update,
  update_ray_tracing_scene,
} from "@ink/ray-tracing/scene.ts";
import { resolve_scene } from "@ink/scene/hierarchy.ts";
import { scene_node_key } from "@ink/scene/identity.ts";
import type {
  BuiltInGeometry,
  RenderMesh,
  RenderScene,
  RenderTechnique,
} from "./renderer.ts";

export type RendererAccelerationUpdate =
  | { readonly type: "initialize" }
  | RayTracingAccelerationUpdate;

export interface PathTracingGpuUploads {
  readonly blas: boolean;
  readonly geometry: boolean;
  readonly instances: boolean;
  readonly lights: boolean;
  readonly materials: boolean;
  readonly triangles: boolean;
  readonly tlas: boolean;
}

export interface PathTracingFrameHistory {
  readonly source: RayTracingSceneInput;
  readonly packed_scene: PackedRayTracingScene;
  readonly accumulation?: PathTracingFrame;
}

export interface PathTracingFrameRequest {
  readonly source: RayTracingSceneInput;
  readonly presentation: PathTracingPresentationState;
  readonly camera_moving: boolean;
}

export type PathTracingFramePlan =
  | {
    readonly type: "raster_preview";
    readonly reason: "camera_motion";
    readonly next_history: PathTracingFrameHistory | undefined;
  }
  | {
    readonly type: "path_traced";
    readonly acceleration: RendererAccelerationUpdate;
    readonly accumulation: PathTracingFrame;
    readonly packed_scene: PackedRayTracingScene;
    readonly uploads: PathTracingGpuUploads;
    readonly next_history: PathTracingFrameHistory;
  };

export interface PackedRayTracingGpuScene {
  readonly blas: Uint8Array;
  readonly blas_indices: Uint8Array;
  readonly geometries: Uint8Array;
  readonly instances: Uint8Array;
  readonly lights: Uint8Array;
  readonly materials: Uint8Array;
  readonly triangles: Uint8Array;
  readonly tlas: Uint8Array;
  readonly tlas_indices: Uint8Array;
}

export interface PathTracingTextureLayer {
  readonly layer: number;
  readonly width_scale: number;
  readonly height_scale: number;
}

export interface PathTracingTextureLayers {
  readonly base_color: ReadonlyMap<string, PathTracingTextureLayer>;
  readonly normal: ReadonlyMap<string, PathTracingTextureLayer>;
}

export interface BuiltInPathTracingGeometry {
  readonly first_vertex: number;
  readonly vertex_count: number;
  readonly vertices: Float32Array;
}

interface PathTracingGeometryAttributes {
  readonly topology: MeshTopology;
  readonly vertex_normals: readonly ReturnType<typeof vec3>[];
}

export interface PathTracingRenderSceneSnapshot {
  readonly presentation: PathTracingPresentationState;
  readonly source: RayTracingSceneInput;
  readonly instance_objects: readonly {
    readonly instance: RayTracingInstanceId;
    readonly object_id: string;
  }[];
}

export function plan_path_tracing_frame(
  previous: PathTracingFrameHistory | undefined,
  request: PathTracingFrameRequest,
): PathTracingFramePlan {
  if (request.camera_moving) {
    return Object.freeze({
      type: "raster_preview",
      reason: "camera_motion",
      next_history: previous === undefined ? undefined : Object.freeze({
        source: previous.source,
        packed_scene: previous.packed_scene,
      }),
    });
  }

  const acceleration = previous === undefined
    ? Object.freeze({ type: "initialize" } as const)
    : plan_ray_tracing_acceleration_update(previous.source, request.source);
  const accumulation = next_path_tracing_accumulation(
    previous?.accumulation,
    request.presentation,
  );
  const uploads = path_tracing_gpu_uploads(
    previous?.source,
    request.source,
    acceleration,
  );
  const packed_scene = previous !== undefined &&
      previous.source.revision === request.source.revision &&
      Object.values(uploads).every((required) => !required)
    ? previous.packed_scene
    : previous === undefined
    ? build_ray_tracing_scene(request.source)
    : update_ray_tracing_scene(
      previous.source,
      previous.packed_scene,
      request.source,
    );
  const next_history = Object.freeze({
    source: request.source,
    packed_scene,
    accumulation,
  });
  return Object.freeze({
    type: "path_traced",
    acceleration,
    accumulation,
    packed_scene,
    uploads,
    next_history,
  });
}

export function path_tracing_render_scene_snapshot(
  scene: RenderScene,
  built_in_geometry: ReadonlyMap<
    BuiltInGeometry,
    BuiltInPathTracingGeometry
  >,
  viewport: { readonly width: number; readonly height: number },
  technique: Extract<RenderTechnique, { readonly type: "path_traced" }>,
): PathTracingRenderSceneSnapshot {
  const resolved = resolve_scene(scene.hierarchy);
  if (resolved.type !== "ready") {
    throw new Error(
      `path tracing scene ${
        JSON.stringify(scene.hierarchy.id)
      } cannot resolve: ${resolved.reason}`,
    );
  }
  const nodes = new Map(
    resolved.scene.nodes.map((node) => [scene_node_key(node.id), node]),
  );
  const meshes = new Map(scene.meshes.map((mesh) => [mesh.id, mesh]));
  const materials = new Map<
    string,
    RenderScene["objects"][number]["material"]
  >();
  const geometries: IndexedRayTracingGeometry[] = [];
  const instances: RayTracingSceneInput["instances"][number][] = [];
  const instance_objects: {
    readonly instance: RayTracingInstanceId;
    readonly object_id: string;
  }[] = [];
  for (const object of scene.objects) {
    const node = nodes.get(scene_node_key(object.node));
    if (node === undefined || !node.world_active) continue;
    const geometry = object.shape === "mesh"
      ? imported_path_tracing_geometry(meshes.get(object.mesh), object.mesh)
      : built_in_path_tracing_geometry(
        built_in_geometry.get(object.shape),
        object.shape,
      );
    const geometry_id = ray_tracing_geometry_id(
      `render/object/${hex_identity(object.id)}/geometry`,
    );
    const material = ray_tracing_material_identity(object.material);
    geometries.push(Object.freeze({
      id: geometry_id,
      revision: geometry_revision(geometry),
      topology: geometry.topology,
      vertex_normals: geometry.vertex_normals,
      material,
    }));
    const instance = ray_tracing_instance_id(
      `render/object/${hex_identity(object.id)}`,
    );
    instances.push(Object.freeze({
      id: instance,
      revision: numeric_revision(node.world_transform),
      geometry: geometry_id,
      transform: node.world_transform,
    }));
    instance_objects.push(Object.freeze({
      instance,
      object_id: object.id,
    }));
    materials.set(`${material.type}:${material.id}`, object.material);
  }
  const scene_revision = numeric_revision(
    geometries.flatMap((geometry) => [geometry.id, geometry.revision]),
  );
  const transform_revision = numeric_revision(
    instances.flatMap((instance) => [instance.id, instance.revision]),
  );
  const material_records = Object.freeze([...materials.values()]);
  const material_revision = numeric_revision([
    material_records_revision(material_records),
    geometry_material_key(geometries),
  ]);
  const light_revision = numeric_revision([
    scene.environment.ambient_light.r,
    scene.environment.ambient_light.g,
    scene.environment.ambient_light.b,
    light_records_revision(scene.lights),
  ]);
  const camera_revision = numeric_revision(camera_revision_values(scene));
  const exposure_revision = numeric_revision([
    scene.environment.exposure_ev100,
    scene.environment.bloom_intensity,
  ]);
  const fog_revision = numeric_revision([
    scene.environment.fog_density,
    scene.environment.fog_color.r,
    scene.environment.fog_color.g,
    scene.environment.fog_color.b,
  ]);
  const source: RayTracingSceneInput = Object.freeze({
    revision: ray_tracing_scene_revision(scene_revision),
    geometries: Object.freeze(geometries),
    instances: Object.freeze(instances),
    materials: material_records,
    lights: scene.lights,
  });
  const presentation: PathTracingPresentationState = Object.freeze({
    scene_revision: source.revision,
    transform_revision,
    material_revision,
    light_revision,
    camera_revision,
    viewport: Object.freeze({ ...viewport }),
    exposure_revision,
    fog_revision,
    quality: Object.freeze({ ...technique }),
  });
  return Object.freeze({
    source,
    presentation,
    instance_objects: Object.freeze(instance_objects),
  });
}

export function pack_ray_tracing_gpu_scene(
  scene: PackedRayTracingScene,
  texture_layers?: PathTracingTextureLayers,
): PackedRayTracingGpuScene {
  return Object.freeze({
    blas: pack_bvh(scene.blas),
    blas_indices: pack_u32(scene.blas_indices),
    geometries: pack_structs(
      scene.geometries.length,
      16,
      (view, offset, index) => {
        const geometry = scene.geometries[index];
        write_u32(view, offset, geometry.blas_root);
        write_u32(view, offset + 4, geometry.first_triangle);
        write_u32(view, offset + 8, geometry.triangle_count);
        write_u32(view, offset + 12, geometry.revision);
      },
    ),
    instances: pack_structs(
      scene.instances.length,
      144,
      (view, offset, index) => {
        const instance = scene.instances[index];
        write_f32_array(view, offset, instance.transform);
        write_f32_array(view, offset + 64, instance.inverse_transform);
        write_u32(view, offset + 128, instance.geometry_index);
        write_u32(view, offset + 132, instance.revision);
      },
    ),
    lights: pack_structs(scene.lights.length, 80, (view, offset, index) => {
      pack_light(view, offset, scene.lights[index]);
    }),
    materials: pack_structs(
      scene.materials.length,
      80,
      (view, offset, index) => {
        const material = scene.materials[index];
        const parameters = material.record.parameters;
        write_vec3(view, offset, parameters.base_color);
        write_f32(view, offset + 12, parameters.metallic);
        write_vec3(view, offset + 16, parameters.emissive);
        write_f32(view, offset + 28, parameters.perceptual_roughness);
        write_vec3(
          view,
          offset + 32,
          scene.materials[index].record.specular_f0,
        );
        write_f32(view, offset + 44, parameters.emissive_strength);
        const base_color = material_texture_layer(
          material,
          "base_color",
          texture_layers?.base_color,
        );
        const normal = material_texture_layer(
          material,
          "normal",
          texture_layers?.normal,
        );
        write_f32(view, offset + 48, base_color?.layer ?? -1);
        write_f32(view, offset + 52, normal?.layer ?? -1);
        write_f32(view, offset + 56, base_color?.width_scale ?? 1);
        write_f32(view, offset + 60, base_color?.height_scale ?? 1);
        write_f32(view, offset + 64, normal?.width_scale ?? 1);
        write_f32(view, offset + 68, normal?.height_scale ?? 1);
        write_f32(view, offset + 72, parameters.normal_scale);
        write_f32(view, offset + 76, 0);
      },
    ),
    triangles: pack_structs(
      scene.triangles.length,
      128,
      (view, offset, index) => {
        const triangle = scene.triangles[index];
        write_vec3(view, offset, triangle.a);
        write_u32(view, offset + 12, triangle.material_index);
        write_vec3(view, offset + 16, triangle.b);
        write_u32(view, offset + 28, triangle.source_triangle);
        write_vec3(view, offset + 32, triangle.c);
        write_u32(
          view,
          offset + 44,
          (triangle.texture_coordinates === null ? 0 : 1) |
            (triangle.vertex_normals === null ? 0 : 2),
        );
        if (triangle.texture_coordinates !== null) {
          write_f32(view, offset + 48, triangle.texture_coordinates[0].x);
          write_f32(view, offset + 52, triangle.texture_coordinates[0].y);
          write_f32(view, offset + 56, triangle.texture_coordinates[1].x);
          write_f32(view, offset + 60, triangle.texture_coordinates[1].y);
          write_f32(view, offset + 64, triangle.texture_coordinates[2].x);
          write_f32(view, offset + 68, triangle.texture_coordinates[2].y);
        }
        if (triangle.vertex_normals !== null) {
          write_vec3(view, offset + 80, triangle.vertex_normals[0]);
          write_vec3(view, offset + 96, triangle.vertex_normals[1]);
          write_vec3(view, offset + 112, triangle.vertex_normals[2]);
        }
      },
    ),
    tlas: pack_bvh(scene.tlas),
    tlas_indices: pack_u32(scene.tlas_indices),
  });
}

function material_texture_layer(
  material: PackedRayTracingScene["materials"][number],
  semantic: "base_color" | "normal",
  layers: ReadonlyMap<string, PathTracingTextureLayer> | undefined,
): PathTracingTextureLayer | undefined {
  const binding = material.record.textures.find((candidate) =>
    candidate.semantic === semantic
  );
  if (binding === undefined) return undefined;
  const layer = layers?.get(binding.texture);
  if (layer !== undefined) return layer;
  throw new Error(
    `path tracing ${semantic} texture ${
      JSON.stringify(binding.texture)
    } for material ${material.identity.type} ${material.identity.id} has no GPU layer`,
  );
}

function path_tracing_gpu_uploads(
  previous: RayTracingSceneInput | undefined,
  next: RayTracingSceneInput,
  acceleration: RendererAccelerationUpdate,
): PathTracingGpuUploads {
  const initialize = acceleration.type === "initialize";
  const rebuild_blas = acceleration.type === "rebuild_blas_and_tlas";
  const rebuild_tlas = rebuild_blas || acceleration.type === "rebuild_tlas";
  const material_assignment_changed = previous === undefined ||
    geometry_material_key(previous.geometries) !==
      geometry_material_key(next.geometries);
  const material_indices_changed = previous === undefined ||
    material_identity_key(previous.materials) !==
      material_identity_key(next.materials);
  const material_records_changed = previous === undefined ||
    material_records_revision(previous.materials) !==
      material_records_revision(next.materials);
  const light_records_changed = previous === undefined ||
    light_records_revision(previous.lights) !==
      light_records_revision(next.lights);
  return Object.freeze({
    blas: initialize || rebuild_blas,
    geometry: initialize || rebuild_blas,
    instances: initialize || rebuild_tlas,
    lights: initialize || light_records_changed,
    materials: initialize || material_records_changed,
    triangles: initialize || rebuild_blas || material_assignment_changed ||
      material_indices_changed,
    tlas: initialize || rebuild_tlas,
  });
}

function imported_path_tracing_geometry(
  mesh: RenderMesh | undefined,
  id: RenderMesh["id"],
): PathTracingGeometryAttributes {
  if (mesh === undefined) {
    throw new Error(`path tracing mesh ${JSON.stringify(id)} is unavailable`);
  }
  const positions = [];
  const vertex_normals = [];
  const texture_coordinates = [];
  for (let offset = 0; offset < mesh.vertices.length; offset += 8) {
    positions.push(vec3(
      mesh.vertices[offset],
      mesh.vertices[offset + 1],
      mesh.vertices[offset + 2],
    ));
    vertex_normals.push(vec3(
      mesh.vertices[offset + 3],
      mesh.vertices[offset + 4],
      mesh.vertices[offset + 5],
    ));
    texture_coordinates.push(vec2(
      mesh.vertices[offset + 6],
      mesh.vertices[offset + 7],
    ));
  }
  return Object.freeze({
    topology: mesh_topology(
      positions,
      [...mesh.indices],
      texture_coordinates,
    ),
    vertex_normals: Object.freeze(vertex_normals),
  });
}

function built_in_path_tracing_geometry(
  geometry: BuiltInPathTracingGeometry | undefined,
  shape: BuiltInGeometry,
): PathTracingGeometryAttributes {
  if (geometry === undefined) {
    throw new Error(`path tracing built-in ${shape} geometry is unavailable`);
  }
  const positions = [];
  const vertex_normals = [];
  const texture_coordinates = [];
  const indices = [];
  const finish = geometry.first_vertex + geometry.vertex_count;
  for (let vertex = geometry.first_vertex; vertex < finish; vertex += 1) {
    const offset = vertex * 8;
    positions.push(vec3(
      geometry.vertices[offset],
      geometry.vertices[offset + 1],
      geometry.vertices[offset + 2],
    ));
    vertex_normals.push(vec3(
      geometry.vertices[offset + 3],
      geometry.vertices[offset + 4],
      geometry.vertices[offset + 5],
    ));
    texture_coordinates.push(vec2(
      geometry.vertices[offset + 6],
      geometry.vertices[offset + 7],
    ));
  }
  for (let index = 0; index < positions.length; index += 3) {
    const a = positions[index];
    const b = positions[index + 1];
    const c = positions[index + 2];
    if (
      vec3_length_squared(
        vec3_cross(vec3_subtract(b, a), vec3_subtract(c, a)),
      ) === 0
    ) continue;
    indices.push(index, index + 1, index + 2);
  }
  return Object.freeze({
    topology: mesh_topology(positions, indices, texture_coordinates),
    vertex_normals: Object.freeze(vertex_normals),
  });
}

function geometry_revision(geometry: PathTracingGeometryAttributes): number {
  const topology = geometry.topology;
  return numeric_revision([
    ...topology.positions.flatMap((
      position,
    ) => [position.x, position.y, position.z]),
    ...topology.indices,
    ...(topology.texture_coordinates?.flatMap((coordinate) => [
      coordinate.x,
      coordinate.y,
    ]) ?? []),
    ...geometry.vertex_normals.flatMap((normal) => [
      normal.x,
      normal.y,
      normal.z,
    ]),
  ]);
}

function material_revision_values(
  material: RayTracingSceneInput["materials"][number],
): readonly (string | number)[] {
  const parameters = material.parameters;
  return [
    material.definition,
    material.definition_revision,
    material.instance ?? "",
    material.instance_revision ?? 0,
    parameters.base_color.r,
    parameters.base_color.g,
    parameters.base_color.b,
    parameters.base_color.a,
    parameters.metallic,
    parameters.perceptual_roughness,
    parameters.specular_level,
    parameters.normal_scale,
    parameters.emissive.r,
    parameters.emissive.g,
    parameters.emissive.b,
    parameters.emissive_strength,
    material.feature_key,
    ...material.textures.flatMap((binding) => [
      binding.semantic,
      binding.texture,
      binding.color_space,
    ]),
  ];
}

function material_records_revision(
  materials: RayTracingSceneInput["materials"],
): number {
  const ordered = [...materials].sort((left, right) => {
    const left_identity = ray_tracing_material_identity(left);
    const right_identity = ray_tracing_material_identity(right);
    return compare_code_units(
      `${left_identity.type}:${left_identity.id}`,
      `${right_identity.type}:${right_identity.id}`,
    );
  });
  return numeric_revision(ordered.flatMap(material_revision_values));
}

function material_identity_key(
  materials: RayTracingSceneInput["materials"],
): string {
  return materials.map((material) => {
    const identity = ray_tracing_material_identity(material);
    return `${identity.type}:${identity.id}`;
  }).sort(compare_code_units).join("|");
}

function light_revision_values(
  light: RenderScene["lights"][number],
): readonly (string | number | boolean)[] {
  const values: (string | number | boolean)[] = [
    light.id,
    light.revision,
    light.type,
    light.color.r,
    light.color.g,
    light.color.b,
  ];
  switch (light.type) {
    case "directional":
      return [
        ...values,
        light.direction.x,
        light.direction.y,
        light.direction.z,
        light.illuminance_lux,
        light.angular_diameter_radians,
      ];
    case "point":
      return [
        ...values,
        light.position.x,
        light.position.y,
        light.position.z,
        light.intensity_candela,
        light.range,
        light.source_radius,
      ];
    case "spot":
      return [
        ...values,
        light.position.x,
        light.position.y,
        light.position.z,
        light.direction.x,
        light.direction.y,
        light.direction.z,
        light.intensity_candela,
        light.range,
        light.inner_angle_radians,
        light.outer_angle_radians,
        light.source_radius,
      ];
    case "rectangular":
      return [
        ...values,
        light.position.x,
        light.position.y,
        light.position.z,
        light.normal.x,
        light.normal.y,
        light.normal.z,
        light.tangent.x,
        light.tangent.y,
        light.tangent.z,
        light.size.x,
        light.size.y,
        light.luminance_nits,
        light.range,
        light.two_sided,
      ];
    case "environment":
      return [
        ...values,
        light.environment,
        light.intensity,
        light.rotation_radians,
        light.priority,
      ];
  }
}

function light_records_revision(
  lights: RayTracingSceneInput["lights"],
): number {
  const ordered = [...lights].sort((left, right) =>
    compare_code_units(left.id, right.id)
  );
  return numeric_revision(ordered.flatMap(light_revision_values));
}

function camera_revision_values(
  scene: RenderScene,
): readonly (string | number)[] {
  const camera = scene.camera;
  const values: (string | number)[] = [
    camera.id,
    camera.pose.position.x,
    camera.pose.position.y,
    camera.pose.position.z,
    camera.pose.rotation.x,
    camera.pose.rotation.y,
    camera.pose.rotation.z,
    camera.pose.rotation.w,
    camera.projection.type,
    ...Object.values(camera.projection).filter((value): value is number =>
      typeof value === "number"
    ),
    camera.viewport.x,
    camera.viewport.y,
    camera.viewport.width,
    camera.viewport.height,
    camera.layers,
    camera.clear.type,
  ];
  if (camera.clear.type === "color") values.push(...camera.clear.color);
  return values;
}

function numeric_revision(values: readonly unknown[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const bytes = new TextEncoder().encode(`${typeof value}:${String(value)};`);
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

function hex_identity(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function geometry_material_key(
  geometries: RayTracingSceneInput["geometries"],
): string {
  return geometries.map((geometry) =>
    `${geometry.id}:${geometry.material.type}:${geometry.material.id}`
  ).sort(compare_code_units).join("|");
}

function compare_code_units(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function pack_bvh(nodes: readonly PackedRayTracingBvhNode[]): Uint8Array {
  return pack_structs(nodes.length, 48, (view, offset, index) => {
    const node = nodes[index];
    write_vec3(view, offset, node.bounds.minimum);
    write_u32(view, offset + 12, node.type === "branch" ? node.left : 0);
    write_vec3(view, offset + 16, node.bounds.maximum);
    write_u32(view, offset + 28, node.type === "branch" ? node.right : 0);
    write_u32(view, offset + 32, node.type === "leaf" ? node.first_index : 0);
    write_u32(view, offset + 36, node.type === "leaf" ? node.index_count : 0);
    write_u32(view, offset + 40, node.escape);
    write_u32(view, offset + 44, node.type === "leaf" ? 1 : 0);
  });
}

function pack_u32(values: readonly number[]): Uint8Array {
  return pack_structs(values.length, 4, (view, offset, index) => {
    write_u32(view, offset, values[index]);
  });
}

function pack_structs(
  count: number,
  stride: number,
  write: (view: DataView, offset: number, index: number) => void,
): Uint8Array {
  const bytes = new Uint8Array(count * stride);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index += 1) {
    write(view, index * stride, index);
  }
  return bytes;
}

function pack_light(
  view: DataView,
  offset: number,
  light: PackedRayTracingScene["lights"][number],
): void {
  write_vec3(
    view,
    offset,
    light.type === "environment"
      ? { x: 0, y: 0, z: 0 }
      : light.type === "directional"
      ? { x: 0, y: 0, z: 0 }
      : light.position,
  );
  write_f32(
    view,
    offset + 12,
    light.type === "point" || light.type === "spot" ||
      light.type === "rectangular"
      ? light.range
      : 0,
  );
  write_vec3(
    view,
    offset + 16,
    light.type === "directional" || light.type === "spot"
      ? light.direction
      : light.type === "rectangular"
      ? light.normal
      : { x: 0, y: 0, z: 0 },
  );
  write_f32(view, offset + 28, light_type(light));
  write_vec3(view, offset + 32, light.color);
  write_f32(view, offset + 44, light_intensity(light));
  switch (light.type) {
    case "directional":
      write_f32(view, offset + 60, light.angular_diameter_radians);
      break;
    case "point":
      write_f32(view, offset + 60, light.source_radius);
      break;
    case "spot":
      write_f32(view, offset + 60, light.source_radius);
      write_f32(view, offset + 64, light.inner_angle_radians);
      write_f32(view, offset + 68, light.outer_angle_radians);
      break;
    case "rectangular":
      write_vec3(view, offset + 48, light.tangent);
      write_f32(view, offset + 60, light.two_sided ? 1 : 0);
      write_f32(view, offset + 64, light.size.x);
      write_f32(view, offset + 68, light.size.y);
      break;
    case "environment":
      write_f32(view, offset + 64, light.rotation_radians);
      write_f32(view, offset + 68, light.priority);
      break;
  }
}

function light_type(light: PackedRayTracingScene["lights"][number]): number {
  switch (light.type) {
    case "directional":
      return 0;
    case "point":
      return 1;
    case "spot":
      return 2;
    case "rectangular":
      return 3;
    case "environment":
      return 4;
  }
}

function light_intensity(
  light: PackedRayTracingScene["lights"][number],
): number {
  switch (light.type) {
    case "directional":
      return light.illuminance_lux;
    case "point":
    case "spot":
      return light.intensity_candela;
    case "rectangular":
      return light.luminance_nits;
    case "environment":
      return light.intensity;
  }
}

function write_vec3(
  view: DataView,
  offset: number,
  value: { readonly x: number; readonly y: number; readonly z: number } | {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  },
): void {
  if ("x" in value) {
    write_f32(view, offset, value.x);
    write_f32(view, offset + 4, value.y);
    write_f32(view, offset + 8, value.z);
    return;
  }
  write_f32(view, offset, value.r);
  write_f32(view, offset + 4, value.g);
  write_f32(view, offset + 8, value.b);
}

function write_f32_array(
  view: DataView,
  offset: number,
  values: readonly number[],
): void {
  for (const [index, value] of values.entries()) {
    write_f32(view, offset + index * 4, value);
  }
}

function write_f32(view: DataView, offset: number, value: number): void {
  view.setFloat32(offset, value, true);
}

function write_u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

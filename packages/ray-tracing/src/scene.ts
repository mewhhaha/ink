import { build_static_bvh, type StaticBvh } from "@ink/geometry/static_bvh.ts";
import { mesh_topology, type MeshTopology } from "@ink/geometry/mesh.ts";
import { type Aabb, aabb } from "@ink/geometry/shapes.ts";
import { create_light } from "@ink/lighting/light.ts";
import { mat4_inverse, mat4_transform_affine_point } from "@ink/math/matrix.ts";
import { vec3, vec3_length_squared, vec3_normalize } from "@ink/math/vector.ts";
import type { RayTracingGeometryId } from "./identity.ts";
import {
  type IndexedRayTracingGeometry,
  type PackedRayTracingBlas,
  type PackedRayTracingBvhNode,
  type PackedRayTracingGeometry,
  type PackedRayTracingInstance,
  type PackedRayTracingMaterial,
  type PackedRayTracingScene,
  type PackedRayTracingTriangle,
  ray_tracing_material_identity,
  ray_tracing_missing_node,
  type RayTracingAccelerationUpdate,
  type RayTracingBuildLimits,
  type RayTracingMaterialIdentity,
  type RayTracingSceneInput,
} from "./model.ts";

export {
  ray_tracing_material_identity,
  ray_tracing_missing_node,
} from "./model.ts";
export type * from "./model.ts";

export const default_ray_tracing_build_limits: RayTracingBuildLimits = Object
  .freeze({
    maximum_triangles: 0xffff_ffff,
    maximum_materials: 0xffff_ffff,
    maximum_lights: 0xffff_ffff,
    maximum_instances: 0xffff_ffff,
    maximum_blas_nodes: 0xffff_fffe,
    maximum_tlas_nodes: 0xffff_fffe,
  });

export function build_ray_tracing_scene(
  input: RayTracingSceneInput,
  limits: RayTracingBuildLimits = default_ray_tracing_build_limits,
): PackedRayTracingScene {
  return pack_ray_tracing_scene(undefined, input, limits);
}

export function update_ray_tracing_scene(
  previous_input: RayTracingSceneInput,
  previous_scene: PackedRayTracingScene,
  input: RayTracingSceneInput,
  limits: RayTracingBuildLimits = default_ray_tracing_build_limits,
): PackedRayTracingScene {
  return pack_ray_tracing_scene(
    Object.freeze({ input: previous_input, scene: previous_scene }),
    input,
    limits,
  );
}

interface PreviousRayTracingPacking {
  readonly input: RayTracingSceneInput;
  readonly scene: PackedRayTracingScene;
}

interface GeometryPacking {
  readonly source: IndexedRayTracingGeometry;
  readonly triangles: readonly PackedRayTracingTriangle[];
  readonly blas: PackedRayTracingBlas;
}

interface PackedGeometryArrays {
  readonly geometries: readonly PackedRayTracingGeometry[];
  readonly triangles: readonly PackedRayTracingTriangle[];
  readonly blas: readonly PackedRayTracingBvhNode[];
  readonly blas_indices: readonly number[];
}

interface PackedInstanceArrays {
  readonly instances: readonly PackedRayTracingInstance[];
  readonly tlas: readonly PackedRayTracingBvhNode[];
  readonly tlas_indices: readonly number[];
  readonly tlas_root: number | null;
}

function pack_ray_tracing_scene(
  previous: PreviousRayTracingPacking | undefined,
  input: RayTracingSceneInput,
  limits: RayTracingBuildLimits,
): PackedRayTracingScene {
  validate_limits(limits);
  const materials = pack_materials(input.materials, limits.maximum_materials);
  const material_indices = new Map(
    materials.map((material, index) => [
      material_key(material.identity),
      index,
    ]),
  );
  const source_geometries = sorted_unique(
    input.geometries,
    (geometry) => String(geometry.id),
    "ray tracing geometry",
  );
  validate_source_geometries(source_geometries, material_indices);
  const acceleration = previous === undefined
    ? undefined
    : plan_ray_tracing_acceleration_update(previous.input, input);
  const packed_geometry = acceleration?.type === "rebuild_blas_and_tlas" ||
      previous === undefined
    ? rebuild_geometry_arrays(
      source_geometries,
      material_indices,
      limits,
      previous?.scene,
      acceleration?.type === "rebuild_blas_and_tlas"
        ? new Set(acceleration.geometries.map(String))
        : undefined,
    )
    : reuse_geometry_arrays(
      previous.scene,
      source_geometries,
      material_indices,
      limits,
    );
  const packed_instances = previous !== undefined &&
      acceleration?.type === "unchanged"
    ? reuse_instance_arrays(previous.scene, limits)
    : rebuild_instance_arrays(input, packed_geometry.geometries, limits);
  const lights = sorted_unique(
    input.lights.map(create_light),
    (light) => String(light.id),
    "ray tracing light",
  );
  if (lights.length > limits.maximum_lights) {
    throw new Error(
      `ray tracing light capacity ${limits.maximum_lights} is exceeded by light ${
        lights[limits.maximum_lights].id
      }; requested ${lights.length}`,
    );
  }
  return Object.freeze({
    revision: input.revision,
    ...packed_geometry,
    materials,
    lights: Object.freeze(lights),
    ...packed_instances,
  });
}

function validate_source_geometries(
  geometries: readonly IndexedRayTracingGeometry[],
  material_indices: ReadonlyMap<string, number>,
): void {
  for (const geometry of geometries) {
    validate_revision(geometry.revision, `ray tracing geometry ${geometry.id}`);
    if (material_indices.has(material_key(geometry.material))) continue;
    throw new Error(
      `ray tracing geometry ${geometry.id} references missing ${
        material_description(geometry.material)
      }`,
    );
  }
}

function rebuild_geometry_arrays(
  source_geometries: readonly IndexedRayTracingGeometry[],
  material_indices: ReadonlyMap<string, number>,
  limits: RayTracingBuildLimits,
  previous: PackedRayTracingScene | undefined,
  changed_geometry_ids: ReadonlySet<string> | undefined,
): PackedGeometryArrays {
  const previous_geometries = new Map(
    previous?.geometries.map((geometry) => [String(geometry.id), geometry]) ??
      [],
  );
  const geometry_packings = source_geometries.map((geometry) => {
    const previous_geometry = previous_geometries.get(String(geometry.id));
    if (
      previous !== undefined && previous_geometry !== undefined &&
      changed_geometry_ids !== undefined &&
      !changed_geometry_ids.has(String(geometry.id))
    ) {
      return Object.freeze({
        source: geometry,
        triangles: previous.triangles.slice(
          previous_geometry.first_triangle,
          previous_geometry.first_triangle + previous_geometry.triangle_count,
        ),
        blas: previous_geometry.blas,
      });
    }
    return pack_geometry(
      geometry,
      required_material_index(geometry, material_indices),
    );
  });
  return assemble_geometry_arrays(geometry_packings, material_indices, limits);
}

function reuse_geometry_arrays(
  previous: PackedRayTracingScene,
  source_geometries: readonly IndexedRayTracingGeometry[],
  material_indices: ReadonlyMap<string, number>,
  limits: RayTracingBuildLimits,
): PackedGeometryArrays {
  validate_geometry_array_limits(previous, limits);
  const materials_by_geometry = new Map(
    source_geometries.map((geometry) => [
      String(geometry.id),
      required_material_index(geometry, material_indices),
    ]),
  );
  let changed = false;
  const triangles = previous.triangles.map((triangle) => {
    const material_index = materials_by_geometry.get(String(triangle.geometry));
    if (material_index === undefined) {
      throw new Error(
        `packed ray tracing geometry ${triangle.geometry} is absent from the next scene`,
      );
    }
    if (material_index === triangle.material_index) return triangle;
    changed = true;
    return Object.freeze({ ...triangle, material_index });
  });
  return Object.freeze({
    geometries: previous.geometries,
    triangles: changed ? Object.freeze(triangles) : previous.triangles,
    blas: previous.blas,
    blas_indices: previous.blas_indices,
  });
}

function validate_geometry_array_limits(
  scene: PackedRayTracingScene,
  limits: RayTracingBuildLimits,
): void {
  for (const geometry of scene.geometries) {
    const requested_triangles = geometry.first_triangle +
      geometry.triangle_count;
    if (requested_triangles > limits.maximum_triangles) {
      throw new Error(
        `ray tracing triangle capacity ${limits.maximum_triangles} is exceeded by geometry ${geometry.id}; requested ${requested_triangles}`,
      );
    }
    const requested_nodes = geometry.blas_root + geometry.blas.nodes.length;
    if (requested_nodes > limits.maximum_blas_nodes) {
      throw new Error(
        `ray tracing BLAS node capacity ${limits.maximum_blas_nodes} is exceeded by geometry ${geometry.id}; requested ${requested_nodes}`,
      );
    }
  }
}

function pack_geometry(
  geometry: IndexedRayTracingGeometry,
  material_index: number,
): GeometryPacking {
  const topology = normalized_topology(geometry);
  const vertex_normals = normalized_vertex_normals(geometry, topology);
  const triangles: PackedRayTracingTriangle[] = [];
  const entries = pack_geometry_triangles(
    geometry,
    topology,
    vertex_normals,
    material_index,
    triangles,
  );
  const tree = build_static_bvh(entries);
  const nodes: PackedRayTracingBvhNode[] = [];
  const indices: number[] = [];
  const root = append_bvh(tree, nodes, indices);
  if (root === null || tree.root === null) {
    throw new Error(`ray tracing geometry ${geometry.id} has no triangles`);
  }
  return Object.freeze({
    source: geometry,
    triangles: Object.freeze(triangles),
    blas: Object.freeze({
      nodes: Object.freeze(nodes),
      indices: Object.freeze(indices),
      root,
    }),
  });
}

function assemble_geometry_arrays(
  packings: readonly GeometryPacking[],
  material_indices: ReadonlyMap<string, number>,
  limits: RayTracingBuildLimits,
): PackedGeometryArrays {
  const geometries: PackedRayTracingGeometry[] = [];
  const triangles: PackedRayTracingTriangle[] = [];
  const blas: PackedRayTracingBvhNode[] = [];
  const blas_indices: number[] = [];
  for (const packing of packings) {
    const first_triangle = triangles.length;
    const requested_triangles = first_triangle + packing.triangles.length;
    if (requested_triangles > limits.maximum_triangles) {
      throw new Error(
        `ray tracing triangle capacity ${limits.maximum_triangles} is exceeded by geometry ${packing.source.id}; requested ${requested_triangles}`,
      );
    }
    const material_index = required_material_index(
      packing.source,
      material_indices,
    );
    for (const triangle of packing.triangles) {
      triangles.push(
        triangle.material_index === material_index
          ? triangle
          : Object.freeze({ ...triangle, material_index }),
      );
    }
    const requested_nodes = blas.length + packing.blas.nodes.length;
    if (requested_nodes > limits.maximum_blas_nodes) {
      throw new Error(
        `ray tracing BLAS node capacity ${limits.maximum_blas_nodes} is exceeded by geometry ${packing.source.id}; requested ${requested_nodes}`,
      );
    }
    const blas_root = append_packed_blas(
      packing.blas,
      first_triangle,
      blas,
      blas_indices,
    );
    geometries.push(Object.freeze({
      id: packing.source.id,
      revision: packing.source.revision,
      first_triangle,
      triangle_count: packing.triangles.length,
      bounds: packing.blas.nodes[packing.blas.root].bounds,
      blas_root,
      blas: packing.blas,
    }));
  }
  return Object.freeze({
    geometries: Object.freeze(geometries),
    triangles: Object.freeze(triangles),
    blas: Object.freeze(blas),
    blas_indices: Object.freeze(blas_indices),
  });
}

function append_packed_blas(
  source: PackedRayTracingBlas,
  first_triangle: number,
  nodes: PackedRayTracingBvhNode[],
  indices: number[],
): number {
  const first_node = nodes.length;
  const first_index = indices.length;
  const node_index = (index: number): number =>
    index === ray_tracing_missing_node
      ? ray_tracing_missing_node
      : first_node + index;
  for (const node of source.nodes) {
    nodes.push(
      node.type === "branch"
        ? Object.freeze({
          ...node,
          left: node_index(node.left),
          right: node_index(node.right),
          escape: node_index(node.escape),
        })
        : Object.freeze({
          ...node,
          first_index: first_index + node.first_index,
          escape: node_index(node.escape),
        }),
    );
  }
  for (const index of source.indices) indices.push(first_triangle + index);
  return first_node + source.root;
}

function required_material_index(
  geometry: IndexedRayTracingGeometry,
  material_indices: ReadonlyMap<string, number>,
): number {
  const material_index = material_indices.get(material_key(geometry.material));
  if (material_index !== undefined) return material_index;
  throw new Error(
    `ray tracing geometry ${geometry.id} references missing ${
      material_description(geometry.material)
    }`,
  );
}

function rebuild_instance_arrays(
  input: RayTracingSceneInput,
  geometries: readonly PackedRayTracingGeometry[],
  limits: RayTracingBuildLimits,
): PackedInstanceArrays {
  const geometry_indices = new Map(
    geometries.map((geometry, index) => [String(geometry.id), index]),
  );
  const source_instances = sorted_unique(
    input.instances,
    (instance) => String(instance.id),
    "ray tracing instance",
  );
  if (source_instances.length > limits.maximum_instances) {
    const overflow = source_instances[limits.maximum_instances];
    throw new Error(
      `ray tracing instance capacity ${limits.maximum_instances} is exceeded by instance ${overflow.id}; requested ${source_instances.length}`,
    );
  }
  const instances = source_instances.map(
    (instance): PackedRayTracingInstance => {
      validate_revision(
        instance.revision,
        `ray tracing instance ${instance.id}`,
      );
      const geometry_index = geometry_indices.get(String(instance.geometry));
      if (geometry_index === undefined) {
        throw new Error(
          `ray tracing instance ${instance.id} references missing geometry ${instance.geometry}`,
        );
      }
      validate_affine_transform(instance.id, instance.transform);
      const inverse = mat4_inverse(instance.transform);
      if (!inverse.ok) {
        throw new Error(
          `ray tracing instance ${instance.id} transform is singular at pivot ${inverse.pivot}`,
        );
      }
      return Object.freeze({
        id: instance.id,
        revision: instance.revision,
        geometry_index,
        transform: instance.transform,
        inverse_transform: inverse.value,
        bounds: transformed_bounds(
          geometries[geometry_index].bounds,
          instance.transform,
        ),
      });
    },
  );
  const tlas_tree = build_static_bvh(
    instances.map((instance, index) => ({
      bounds: instance.bounds,
      payload: index,
    })),
  );
  if (tlas_tree.nodes.length > limits.maximum_tlas_nodes) {
    throw new Error(
      `ray tracing TLAS node capacity ${limits.maximum_tlas_nodes} is exceeded by ${instances.length} instances; requested ${tlas_tree.nodes.length}`,
    );
  }
  const tlas: PackedRayTracingBvhNode[] = [];
  const tlas_indices: number[] = [];
  const tlas_root = append_bvh(tlas_tree, tlas, tlas_indices);
  return Object.freeze({
    instances: Object.freeze(instances),
    tlas: Object.freeze(tlas),
    tlas_indices: Object.freeze(tlas_indices),
    tlas_root,
  });
}

function reuse_instance_arrays(
  previous: PackedRayTracingScene,
  limits: RayTracingBuildLimits,
): PackedInstanceArrays {
  if (previous.instances.length > limits.maximum_instances) {
    const overflow = previous.instances[limits.maximum_instances];
    throw new Error(
      `ray tracing instance capacity ${limits.maximum_instances} is exceeded by instance ${overflow.id}; requested ${previous.instances.length}`,
    );
  }
  if (previous.tlas.length > limits.maximum_tlas_nodes) {
    throw new Error(
      `ray tracing TLAS node capacity ${limits.maximum_tlas_nodes} is exceeded by ${previous.instances.length} instances; requested ${previous.tlas.length}`,
    );
  }
  return Object.freeze({
    instances: previous.instances,
    tlas: previous.tlas,
    tlas_indices: previous.tlas_indices,
    tlas_root: previous.tlas_root,
  });
}

export function plan_ray_tracing_acceleration_update(
  previous: RayTracingSceneInput,
  next: RayTracingSceneInput,
): RayTracingAccelerationUpdate {
  const previous_geometries = new Map(
    previous.geometries.map((geometry) => [String(geometry.id), geometry]),
  );
  const next_geometries = new Map(
    next.geometries.map((geometry) => [String(geometry.id), geometry]),
  );
  const geometry_ids = [
    ...new Set([
      ...previous_geometries.keys(),
      ...next_geometries.keys(),
    ]),
  ].sort();
  const changed_geometries = geometry_ids.flatMap((id) => {
    const before = previous_geometries.get(id);
    const after = next_geometries.get(id);
    if (before?.revision === after?.revision) return [];
    if (after !== undefined) return [after.id];
    return before === undefined ? [] : [before.id];
  });
  const first_geometry = changed_geometries[0];
  if (first_geometry !== undefined) {
    const geometries: [
      RayTracingGeometryId,
      ...RayTracingGeometryId[],
    ] = [first_geometry, ...changed_geometries.slice(1)];
    return Object.freeze({
      type: "rebuild_blas_and_tlas",
      geometries: Object.freeze(geometries),
    });
  }

  const previous_instances = new Map(
    previous.instances.map((instance) => [String(instance.id), instance]),
  );
  const next_instances = new Map(
    next.instances.map((instance) => [String(instance.id), instance]),
  );
  const instance_ids = new Set([
    ...previous_instances.keys(),
    ...next_instances.keys(),
  ]);
  for (const id of instance_ids) {
    const before = previous_instances.get(id);
    const after = next_instances.get(id);
    if (
      before?.revision !== after?.revision ||
      before?.geometry !== after?.geometry
    ) return Object.freeze({ type: "rebuild_tlas" });
  }
  return Object.freeze({ type: "unchanged" });
}

function pack_materials(
  source: RayTracingSceneInput["materials"],
  maximum_materials: number,
): readonly PackedRayTracingMaterial[] {
  const materials = source.map((record): PackedRayTracingMaterial =>
    Object.freeze({
      identity: ray_tracing_material_identity(record),
      record,
    })
  ).sort((left, right) =>
    compare_code_units(
      material_key(left.identity),
      material_key(right.identity),
    )
  );
  for (let index = 1; index < materials.length; index++) {
    if (
      material_key(materials[index - 1].identity) ===
        material_key(materials[index].identity)
    ) {
      throw new Error(
        `ray tracing ${
          material_description(materials[index].identity)
        } is repeated`,
      );
    }
  }
  if (materials.length > maximum_materials) {
    throw new Error(
      `ray tracing material capacity ${maximum_materials} is exceeded by ${
        material_description(materials[maximum_materials].identity)
      }; requested ${materials.length}`,
    );
  }
  return Object.freeze(materials);
}

function pack_geometry_triangles(
  geometry: IndexedRayTracingGeometry,
  topology: MeshTopology,
  vertex_normals: readonly ReturnType<typeof vec3>[] | null,
  material_index: number,
  triangles: PackedRayTracingTriangle[],
): readonly { readonly bounds: Aabb; readonly payload: number }[] {
  const entries: { readonly bounds: Aabb; readonly payload: number }[] = [];
  for (
    let source_triangle = 0;
    source_triangle < topology.triangle_count;
    source_triangle++
  ) {
    const first_index = source_triangle * 3;
    const indices = [
      topology.indices[first_index],
      topology.indices[first_index + 1],
      topology.indices[first_index + 2],
    ];
    const a = topology.positions[indices[0]];
    const b = topology.positions[indices[1]];
    const c = topology.positions[indices[2]];
    const texture_coordinates: PackedRayTracingTriangle["texture_coordinates"] =
      topology.texture_coordinates === null ? null : Object.freeze([
        topology.texture_coordinates[indices[0]],
        topology.texture_coordinates[indices[1]],
        topology.texture_coordinates[indices[2]],
      ]);
    const triangle_vertex_normals: PackedRayTracingTriangle["vertex_normals"] =
      vertex_normals === null ? null : Object.freeze([
        vertex_normals[indices[0]],
        vertex_normals[indices[1]],
        vertex_normals[indices[2]],
      ]);
    const packed_index = triangles.length;
    triangles.push(Object.freeze({
      geometry: geometry.id,
      source_triangle,
      material_index,
      a,
      b,
      c,
      texture_coordinates,
      vertex_normals: triangle_vertex_normals,
    }));
    entries.push(Object.freeze({
      bounds: aabb(
        vec3(
          Math.min(a.x, b.x, c.x),
          Math.min(a.y, b.y, c.y),
          Math.min(a.z, b.z, c.z),
        ),
        vec3(
          Math.max(a.x, b.x, c.x),
          Math.max(a.y, b.y, c.y),
          Math.max(a.z, b.z, c.z),
        ),
      ),
      payload: packed_index,
    }));
  }
  return entries;
}

function normalized_vertex_normals(
  geometry: IndexedRayTracingGeometry,
  topology: MeshTopology,
): readonly ReturnType<typeof vec3>[] | null {
  if (geometry.vertex_normals === null) return null;
  if (geometry.vertex_normals.length !== topology.positions.length) {
    throw new Error(
      `ray tracing geometry ${geometry.id} has ${topology.positions.length} positions but ${geometry.vertex_normals.length} vertex normals`,
    );
  }
  return Object.freeze(geometry.vertex_normals.map((normal, index) => {
    if (vec3_length_squared(normal) === 0) {
      throw new Error(
        `ray tracing geometry ${geometry.id} vertex normal ${index} is zero`,
      );
    }
    return vec3_normalize(vec3(normal.x, normal.y, normal.z));
  }));
}

function normalized_topology(
  geometry: IndexedRayTracingGeometry,
): MeshTopology {
  try {
    return mesh_topology(
      geometry.topology.positions,
      geometry.topology.indices,
      geometry.topology.texture_coordinates,
    );
  } catch (error) {
    throw new Error(
      `ray tracing geometry ${geometry.id} topology is invalid: ${
        error_message(error)
      }`,
    );
  }
}

function material_key(identity: RayTracingMaterialIdentity): string {
  return `${identity.type}:${identity.id}`;
}

function material_description(identity: RayTracingMaterialIdentity): string {
  return `material ${identity.type} ${identity.id}`;
}

function append_bvh(
  tree: StaticBvh<number>,
  nodes: PackedRayTracingBvhNode[],
  indices: number[],
): number | null {
  if (tree.root === null) return null;
  const subtree_sizes: number[] = [];
  for (let index = 0; index < tree.nodes.length; index++) {
    const node = tree.nodes[index];
    subtree_sizes[index] = node.type === "leaf"
      ? 1
      : 1 + subtree_sizes[node.left] + subtree_sizes[node.right];
  }
  const emit = (source_index: number, escape: number): number => {
    const source = tree.nodes[source_index];
    const target = nodes.length;
    if (source.type === "leaf") {
      const first_index = indices.length;
      for (const entry_index of source.entries) {
        indices.push(tree.entries[entry_index].payload);
      }
      nodes.push(Object.freeze({
        type: "leaf",
        bounds: source.bounds,
        first_index,
        index_count: source.entries.length,
        escape,
      }));
      return target;
    }
    const left = target + 1;
    const right = left + subtree_sizes[source.left];
    nodes.push(Object.freeze({
      type: "branch",
      bounds: source.bounds,
      left,
      right,
      escape,
    }));
    emit(source.left, right);
    emit(source.right, escape);
    return target;
  };
  return emit(tree.root, ray_tracing_missing_node);
}

function transformed_bounds(
  bounds: Aabb,
  transform: PackedRayTracingInstance["transform"],
): Aabb {
  const corners = [
    vec3(bounds.minimum.x, bounds.minimum.y, bounds.minimum.z),
    vec3(bounds.maximum.x, bounds.minimum.y, bounds.minimum.z),
    vec3(bounds.minimum.x, bounds.maximum.y, bounds.minimum.z),
    vec3(bounds.maximum.x, bounds.maximum.y, bounds.minimum.z),
    vec3(bounds.minimum.x, bounds.minimum.y, bounds.maximum.z),
    vec3(bounds.maximum.x, bounds.minimum.y, bounds.maximum.z),
    vec3(bounds.minimum.x, bounds.maximum.y, bounds.maximum.z),
    vec3(bounds.maximum.x, bounds.maximum.y, bounds.maximum.z),
  ].map((corner) => mat4_transform_affine_point(transform, corner));
  return aabb(
    vec3(
      Math.min(...corners.map((corner) => corner.x)),
      Math.min(...corners.map((corner) => corner.y)),
      Math.min(...corners.map((corner) => corner.z)),
    ),
    vec3(
      Math.max(...corners.map((corner) => corner.x)),
      Math.max(...corners.map((corner) => corner.y)),
      Math.max(...corners.map((corner) => corner.z)),
    ),
  );
}

function validate_affine_transform(
  instance: PackedRayTracingInstance["id"],
  transform: PackedRayTracingInstance["transform"],
): void {
  if (
    transform[3] !== 0 || transform[7] !== 0 || transform[11] !== 0 ||
    transform[15] !== 1
  ) {
    throw new Error(
      `ray tracing instance ${instance} transform last row [${transform[3]}, ${
        transform[7]
      }, ${transform[11]}, ${transform[15]}] is not affine`,
    );
  }
}

function validate_revision(value: number, owner: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${owner} revision ${String(value)} must be a nonnegative safe integer`,
    );
  }
}

function validate_limits(limits: RayTracingBuildLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(
        `ray tracing build limit ${name} ${
          String(value)
        } must be an unsigned 32-bit integer`,
      );
    }
  }
}

function sorted_unique<Value>(
  values: readonly Value[],
  identity: (value: Value) => string,
  label: string,
): Value[] {
  const sorted = [...values].sort((left, right) =>
    compare_code_units(identity(left), identity(right))
  );
  for (let index = 1; index < sorted.length; index++) {
    if (identity(sorted[index - 1]) === identity(sorted[index])) {
      throw new Error(
        `${label} identity ${identity(sorted[index])} is repeated`,
      );
    }
  }
  return sorted;
}

function compare_code_units(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { AuthoredAsset } from "./build.ts";
import { asset_id, type AssetId } from "./identity.ts";

export const prepared_static_scene_version = 1 as const;

export interface StaticGltfMaterial {
  readonly albedo: readonly [number, number, number];
  readonly base_color_texture?: string;
  readonly emissive: readonly [number, number, number];
  readonly metallic: number;
  readonly normal_texture?: string;
  readonly roughness: number;
}

export interface StaticGltfMesh {
  readonly id: string;
  readonly indices: Uint32Array;
  readonly material: StaticGltfMaterial;
  readonly vertices: Float32Array;
}

export interface StaticGltfTexture {
  readonly bytes: Uint8Array;
  readonly id: string;
  readonly mime_type: string;
}

export interface StaticGltfScene {
  readonly meshes: readonly StaticGltfMesh[];
  readonly source: string;
  readonly textures: readonly StaticGltfTexture[];
  readonly texture_reference_count: number;
}

export interface PreparedStaticSceneBuild {
  readonly assets: readonly AuthoredAsset[];
  readonly root: AssetId<"prepared-static-scene">;
}

export interface PreparedStaticSceneBuildOptions {
  readonly mesh_chunk_maximum_bytes?: number;
}

interface PreparedMeshChunkReference {
  readonly material_asset: AssetId<"prepared-material-chunk">;
  readonly mesh_asset: AssetId<"prepared-mesh-chunk">;
  readonly mesh_count: number;
}

interface PreparedTextureReference {
  readonly asset: AssetId<"prepared-texture-mip">;
  readonly id: string;
  readonly mime_type: string;
  readonly mip_level: 0;
}

interface PreparedStaticSceneDescriptor {
  readonly mesh_chunks: readonly PreparedMeshChunkReference[];
  readonly source: string;
  readonly texture_reference_count: number;
  readonly textures: readonly PreparedTextureReference[];
  readonly version: typeof prepared_static_scene_version;
}

interface PreparedMaterialRecord {
  readonly id: string;
  readonly material: StaticGltfMaterial;
}

const default_mesh_chunk_maximum_bytes = 8 * 1024 * 1024;
const mesh_chunk_magic = new Uint8Array([73, 78, 75, 77, 69, 83, 72, 1]);
const text_encoder = new TextEncoder();
const text_decoder = new TextDecoder("utf-8", { fatal: true });

export function build_prepared_static_gltf_scene(
  scene_id: string,
  scene: StaticGltfScene,
  options: PreparedStaticSceneBuildOptions = {},
): PreparedStaticSceneBuild {
  const parsed_scene_id = parse_nonempty(scene_id, "prepared scene id");
  const root = asset_id<"prepared-static-scene">(
    `${parsed_scene_id}/scene`,
  );
  const maximum_bytes = options.mesh_chunk_maximum_bytes ??
    default_mesh_chunk_maximum_bytes;
  if (!Number.isSafeInteger(maximum_bytes) || maximum_bytes <= 0) {
    throw new Error(
      `prepared scene mesh chunk maximum bytes ${
        JSON.stringify(maximum_bytes)
      } must be a positive safe integer`,
    );
  }
  const mesh_groups = group_meshes(scene.meshes, maximum_bytes);
  const assets: AuthoredAsset[] = [];
  const mesh_chunks = mesh_groups.map((meshes, chunk_index) => {
    const suffix = chunk_index.toString().padStart(4, "0");
    const mesh_asset = asset_id<"prepared-mesh-chunk">(
      `${parsed_scene_id}/mesh/${suffix}`,
    );
    const material_asset = asset_id<"prepared-material-chunk">(
      `${parsed_scene_id}/material/${suffix}`,
    );
    assets.push({
      id: mesh_asset,
      kind: "prepared-mesh-chunk",
      bytes: encode_mesh_chunk(meshes),
    });
    assets.push({
      id: material_asset,
      kind: "prepared-material-chunk",
      bytes: encode_material_chunk(meshes),
    });
    return Object.freeze({
      material_asset,
      mesh_asset,
      mesh_count: meshes.length,
    });
  });
  const textures = scene.textures.map((texture, texture_index) => {
    const suffix = texture_index.toString().padStart(4, "0");
    const texture_asset = asset_id<"prepared-texture-mip">(
      `${parsed_scene_id}/texture/${suffix}/mip/0`,
    );
    assets.push({
      id: texture_asset,
      kind: "prepared-texture-mip",
      bytes: texture.bytes.slice(),
    });
    return Object.freeze({
      asset: texture_asset,
      id: texture.id,
      mime_type: texture.mime_type,
      mip_level: 0 as const,
    });
  });
  const descriptor: PreparedStaticSceneDescriptor = Object.freeze({
    mesh_chunks: Object.freeze(mesh_chunks),
    source: parse_nonempty(scene.source, "prepared scene source"),
    texture_reference_count: nonnegative_integer(
      scene.texture_reference_count,
      "prepared scene texture reference count",
    ),
    textures: Object.freeze(textures),
    version: prepared_static_scene_version,
  });
  const dependencies = [
    ...mesh_chunks.flatMap(({ material_asset, mesh_asset }) => [
      material_asset,
      mesh_asset,
    ]),
    ...textures.map(({ asset }) => asset),
  ];
  assets.push({
    id: root,
    kind: "prepared-static-scene",
    bytes: text_encoder.encode(`${JSON.stringify(descriptor)}\n`),
    dependencies,
  });
  return { assets: Object.freeze(assets), root };
}

export function decode_prepared_static_gltf_scene(
  descriptor_bytes: Uint8Array,
  descriptor_source: string,
  read_asset: (id: AssetId) => Uint8Array,
): StaticGltfScene {
  const descriptor = parse_descriptor(descriptor_bytes, descriptor_source);
  const meshes: StaticGltfMesh[] = [];
  for (const [chunk_index, chunk] of descriptor.mesh_chunks.entries()) {
    const chunk_meshes = decode_mesh_chunk(
      read_asset(chunk.mesh_asset),
      `${descriptor_source} mesh chunk ${chunk_index}`,
    );
    const materials = decode_material_chunk(
      read_asset(chunk.material_asset),
      `${descriptor_source} material chunk ${chunk_index}`,
    );
    if (chunk_meshes.length !== chunk.mesh_count) {
      throw new Error(
        `prepared scene ${
          JSON.stringify(descriptor_source)
        } mesh chunk ${chunk_index} contains ${chunk_meshes.length} meshes; descriptor declares ${chunk.mesh_count}`,
      );
    }
    if (materials.length !== chunk_meshes.length) {
      throw new Error(
        `prepared scene ${
          JSON.stringify(descriptor_source)
        } material chunk ${chunk_index} contains ${materials.length} materials for ${chunk_meshes.length} meshes`,
      );
    }
    for (const [mesh_index, mesh] of chunk_meshes.entries()) {
      const material = materials[mesh_index];
      if (material.id !== mesh.id) {
        throw new Error(
          `prepared scene ${
            JSON.stringify(descriptor_source)
          } chunk ${chunk_index} mesh ${mesh_index} has id ${
            JSON.stringify(mesh.id)
          } but its material has id ${JSON.stringify(material.id)}`,
        );
      }
      meshes.push(Object.freeze({ ...mesh, material: material.material }));
    }
  }
  const textures = descriptor.textures.map((texture) =>
    Object.freeze({
      bytes: read_asset(texture.asset).slice(),
      id: texture.id,
      mime_type: texture.mime_type,
    }) satisfies StaticGltfTexture
  );
  return Object.freeze({
    meshes: Object.freeze(meshes),
    source: descriptor.source,
    textures: Object.freeze(textures),
    texture_reference_count: descriptor.texture_reference_count,
  });
}

function group_meshes(
  meshes: readonly StaticGltfMesh[],
  maximum_bytes: number,
): readonly (readonly StaticGltfMesh[])[] {
  const groups: StaticGltfMesh[][] = [];
  let current: StaticGltfMesh[] = [];
  let current_bytes = mesh_chunk_magic.length + 4;
  for (const mesh of meshes) {
    const mesh_bytes = encoded_mesh_byte_size(mesh);
    const required_bytes = mesh_chunk_magic.length + 4 + mesh_bytes;
    if (required_bytes > maximum_bytes) {
      throw new Error(
        `prepared scene mesh ${
          JSON.stringify(mesh.id)
        } needs ${required_bytes} encoded bytes, exceeding chunk maximum ${maximum_bytes}`,
      );
    }
    if (current.length > 0 && current_bytes + mesh_bytes > maximum_bytes) {
      groups.push(current);
      current = [];
      current_bytes = mesh_chunk_magic.length + 4;
    }
    current.push(mesh);
    current_bytes += mesh_bytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function encoded_mesh_byte_size(mesh: StaticGltfMesh): number {
  return 12 + text_encoder.encode(mesh.id).length + mesh.vertices.byteLength +
    mesh.indices.byteLength;
}

function encode_mesh_chunk(meshes: readonly StaticGltfMesh[]): Uint8Array {
  const encoded_ids = meshes.map(({ id }) => text_encoder.encode(id));
  const byte_length = mesh_chunk_magic.length + 4 + meshes.reduce(
    (total, mesh, index) =>
      total + 12 + encoded_ids[index].length + mesh.vertices.byteLength +
      mesh.indices.byteLength,
    0,
  );
  const bytes = new Uint8Array(byte_length);
  bytes.set(mesh_chunk_magic);
  const view = new DataView(bytes.buffer);
  let offset = mesh_chunk_magic.length;
  view.setUint32(offset, meshes.length, true);
  offset += 4;
  for (const [mesh_index, mesh] of meshes.entries()) {
    const encoded_id = encoded_ids[mesh_index];
    view.setUint32(offset, encoded_id.length, true);
    offset += 4;
    bytes.set(encoded_id, offset);
    offset += encoded_id.length;
    view.setUint32(offset, mesh.vertices.length, true);
    offset += 4;
    view.setUint32(offset, mesh.indices.length, true);
    offset += 4;
    for (const value of mesh.vertices) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    for (const value of mesh.indices) {
      view.setUint32(offset, value, true);
      offset += 4;
    }
  }
  return bytes;
}

function decode_mesh_chunk(
  bytes: Uint8Array,
  source: string,
): readonly Omit<StaticGltfMesh, "material">[] {
  const input = bytes.slice();
  if (
    input.length < mesh_chunk_magic.length + 4 ||
    !mesh_chunk_magic.every((byte, index) => input[index] === byte)
  ) {
    throw new Error(
      `prepared mesh chunk ${JSON.stringify(source)} has an invalid header`,
    );
  }
  const view = new DataView(input.buffer);
  let offset = mesh_chunk_magic.length;
  const mesh_count = view.getUint32(offset, true);
  offset += 4;
  const meshes: Omit<StaticGltfMesh, "material">[] = [];
  for (let mesh_index = 0; mesh_index < mesh_count; mesh_index += 1) {
    const id_length = read_uint32(
      view,
      offset,
      source,
      `mesh ${mesh_index} id length`,
    );
    offset += 4;
    require_remaining(
      input,
      offset,
      id_length,
      source,
      `mesh ${mesh_index} id`,
    );
    const id = parse_nonempty(
      text_decoder.decode(input.subarray(offset, offset + id_length)),
      `prepared mesh chunk ${source} mesh ${mesh_index} id`,
    );
    offset += id_length;
    const vertex_count = read_uint32(
      view,
      offset,
      source,
      `mesh ${mesh_index} vertex float count`,
    );
    offset += 4;
    const index_count = read_uint32(
      view,
      offset,
      source,
      `mesh ${mesh_index} index count`,
    );
    offset += 4;
    if (vertex_count % 8 !== 0) {
      throw new Error(
        `prepared mesh chunk ${
          JSON.stringify(source)
        } mesh ${mesh_index} has ${vertex_count} vertex floats; expected a multiple of 8`,
      );
    }
    if (index_count % 3 !== 0) {
      throw new Error(
        `prepared mesh chunk ${
          JSON.stringify(source)
        } mesh ${mesh_index} has ${index_count} indices; expected a multiple of 3`,
      );
    }
    require_remaining(
      input,
      offset,
      vertex_count * 4 + index_count * 4,
      source,
      `mesh ${mesh_index} geometry`,
    );
    const vertices = new Float32Array(vertex_count);
    for (let index = 0; index < vertex_count; index += 1) {
      vertices[index] = view.getFloat32(offset, true);
      offset += 4;
    }
    const indices = new Uint32Array(index_count);
    for (let index = 0; index < index_count; index += 1) {
      indices[index] = view.getUint32(offset, true);
      offset += 4;
    }
    meshes.push(Object.freeze({ id, indices, vertices }));
  }
  if (offset !== input.length) {
    throw new Error(
      `prepared mesh chunk ${JSON.stringify(source)} has ${
        input.length - offset
      } trailing bytes`,
    );
  }
  return Object.freeze(meshes);
}

function encode_material_chunk(meshes: readonly StaticGltfMesh[]): Uint8Array {
  return text_encoder.encode(`${
    JSON.stringify({
      version: prepared_static_scene_version,
      materials: meshes.map(({ id, material }) => ({ id, material })),
    })
  }\n`);
}

function decode_material_chunk(
  bytes: Uint8Array,
  source: string,
): readonly PreparedMaterialRecord[] {
  const value = parse_json(bytes, source);
  const record = expect_record(value, "$", source);
  if (record.version !== prepared_static_scene_version) {
    throw new Error(
      `prepared material chunk ${JSON.stringify(source)} version ${
        JSON.stringify(record.version)
      } is unsupported; expected ${prepared_static_scene_version}`,
    );
  }
  const materials = expect_array(record.materials, "$.materials", source);
  return Object.freeze(materials.map((value, index) => {
    const field = `$.materials[${index}]`;
    const material_record = expect_record(value, field, source);
    return Object.freeze({
      id: expect_nonempty_string(material_record.id, `${field}.id`, source),
      material: parse_material(
        material_record.material,
        `${field}.material`,
        source,
      ),
    });
  }));
}

function parse_descriptor(
  bytes: Uint8Array,
  source: string,
): PreparedStaticSceneDescriptor {
  const value = parse_json(bytes, source);
  const record = expect_record(value, "$", source);
  if (record.version !== prepared_static_scene_version) {
    throw new Error(
      `prepared scene ${JSON.stringify(source)} version ${
        JSON.stringify(record.version)
      } is unsupported; expected ${prepared_static_scene_version}`,
    );
  }
  const mesh_chunks = expect_array(record.mesh_chunks, "$.mesh_chunks", source)
    .map((value, index) => {
      const field = `$.mesh_chunks[${index}]`;
      const chunk = expect_record(value, field, source);
      return Object.freeze({
        material_asset: asset_id<"prepared-material-chunk">(
          expect_nonempty_string(
            chunk.material_asset,
            `${field}.material_asset`,
            source,
          ),
        ),
        mesh_asset: asset_id<"prepared-mesh-chunk">(
          expect_nonempty_string(
            chunk.mesh_asset,
            `${field}.mesh_asset`,
            source,
          ),
        ),
        mesh_count: expect_nonnegative_integer(
          chunk.mesh_count,
          `${field}.mesh_count`,
          source,
        ),
      });
    });
  const textures = expect_array(record.textures, "$.textures", source).map(
    (value, index) => {
      const field = `$.textures[${index}]`;
      const texture = expect_record(value, field, source);
      if (texture.mip_level !== 0) {
        throw new Error(
          `prepared scene ${
            JSON.stringify(source)
          } field ${field}.mip_level is ${
            JSON.stringify(texture.mip_level)
          }; only mip level 0 is supported`,
        );
      }
      return Object.freeze({
        asset: asset_id<"prepared-texture-mip">(
          expect_nonempty_string(texture.asset, `${field}.asset`, source),
        ),
        id: expect_nonempty_string(texture.id, `${field}.id`, source),
        mime_type: expect_nonempty_string(
          texture.mime_type,
          `${field}.mime_type`,
          source,
        ),
        mip_level: 0 as const,
      });
    },
  );
  return Object.freeze({
    mesh_chunks: Object.freeze(mesh_chunks),
    source: expect_nonempty_string(record.source, "$.source", source),
    texture_reference_count: expect_nonnegative_integer(
      record.texture_reference_count,
      "$.texture_reference_count",
      source,
    ),
    textures: Object.freeze(textures),
    version: prepared_static_scene_version,
  });
}

function parse_material(
  value: unknown,
  field: string,
  source: string,
): StaticGltfMaterial {
  const record = expect_record(value, field, source);
  const base_color_texture = optional_nonempty_string(
    record.base_color_texture,
    `${field}.base_color_texture`,
    source,
  );
  const normal_texture = optional_nonempty_string(
    record.normal_texture,
    `${field}.normal_texture`,
    source,
  );
  return Object.freeze({
    albedo: vector3(record.albedo, `${field}.albedo`, source),
    ...(base_color_texture === undefined ? {} : { base_color_texture }),
    emissive: vector3(record.emissive, `${field}.emissive`, source),
    metallic: finite_number(record.metallic, `${field}.metallic`, source),
    ...(normal_texture === undefined ? {} : { normal_texture }),
    roughness: finite_number(record.roughness, `${field}.roughness`, source),
  });
}

function vector3(
  value: unknown,
  field: string,
  source: string,
): readonly [number, number, number] {
  const components = expect_array(value, field, source);
  if (components.length !== 3) {
    throw new Error(
      `prepared artifact ${
        JSON.stringify(source)
      } field ${field} must contain 3 numbers; found ${components.length}`,
    );
  }
  return Object.freeze([
    finite_number(components[0], `${field}[0]`, source),
    finite_number(components[1], `${field}[1]`, source),
    finite_number(components[2], `${field}[2]`, source),
  ]);
}

function parse_json(bytes: Uint8Array, source: string): unknown {
  try {
    return JSON.parse(text_decoder.decode(bytes));
  } catch (cause) {
    throw new Error(
      `prepared artifact ${JSON.stringify(source)} is not valid UTF-8 JSON`,
      { cause },
    );
  }
}

function expect_record(
  value: unknown,
  field: string,
  source: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `prepared artifact ${
        JSON.stringify(source)
      } field ${field} must be an object`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function expect_array(
  value: unknown,
  field: string,
  source: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `prepared artifact ${
        JSON.stringify(source)
      } field ${field} must be an array`,
    );
  }
  return value;
}

function expect_nonempty_string(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `prepared artifact ${
        JSON.stringify(source)
      } field ${field} must be a nonempty string; received ${
        JSON.stringify(value)
      }`,
    );
  }
  return value.trim();
}

function optional_nonempty_string(
  value: unknown,
  field: string,
  source: string,
): string | undefined {
  return value === undefined
    ? undefined
    : expect_nonempty_string(value, field, source);
}

function finite_number(value: unknown, field: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `prepared artifact ${
        JSON.stringify(source)
      } field ${field} must be finite; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function expect_nonnegative_integer(
  value: unknown,
  field: string,
  source: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `prepared artifact ${
        JSON.stringify(source)
      } field ${field} must be a nonnegative safe integer; received ${
        JSON.stringify(value)
      }`,
    );
  }
  return value as number;
}

function nonnegative_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value;
}

function parse_nonempty(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`${label} ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed;
}

function read_uint32(
  view: DataView,
  offset: number,
  source: string,
  field: string,
): number {
  if (offset + 4 > view.byteLength) {
    throw new Error(
      `prepared mesh chunk ${
        JSON.stringify(source)
      } ends before ${field} at byte ${offset}`,
    );
  }
  return view.getUint32(offset, true);
}

function require_remaining(
  bytes: Uint8Array,
  offset: number,
  required: number,
  source: string,
  field: string,
): void {
  if (required <= bytes.length - offset) return;
  throw new Error(
    `prepared mesh chunk ${
      JSON.stringify(source)
    } ${field} needs ${required} bytes at offset ${offset}; only ${
      bytes.length - offset
    } remain`,
  );
}

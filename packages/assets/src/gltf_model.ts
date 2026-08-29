import { decode_glb_container } from "./glb.ts";

export interface StaticGltfMaterial {
  readonly albedo: readonly [number, number, number];
  readonly base_color_texture?: string;
  readonly emissive: readonly [number, number, number];
  readonly metallic: number;
  readonly roughness: number;
}

export interface StaticGltfMesh {
  readonly id: string;
  readonly material: StaticGltfMaterial;
  readonly vertices: Float32Array;
}

export interface StaticGltfScene {
  readonly meshes: readonly StaticGltfMesh[];
  readonly source: string;
  readonly textures: readonly StaticGltfTexture[];
  readonly texture_reference_count: number;
}

export interface StaticGltfTexture {
  readonly bytes: Uint8Array;
  readonly id: string;
  readonly mime_type: string;
}

interface BufferView {
  readonly byte_length: number;
  readonly byte_offset: number;
  readonly byte_stride?: number;
}

interface Accessor {
  readonly buffer_view: number;
  readonly byte_offset: number;
  readonly component_type: number;
  readonly count: number;
  readonly shape: string;
}

interface Node {
  readonly children: readonly number[];
  readonly local_transform: readonly number[];
  readonly mesh?: number;
}

interface Primitive {
  readonly indices?: number;
  readonly material?: number;
  readonly normal: number;
  readonly position: number;
  readonly texture_coordinate?: number;
}

interface Mesh {
  readonly primitives: readonly Primitive[];
}

const float_component = 5126;
const unsigned_byte_component = 5121;
const unsigned_short_component = 5123;
const unsigned_int_component = 5125;

export function parse_static_glb_scene(
  bytes: Uint8Array,
  source: string,
): StaticGltfScene {
  const decoded = decode_glb_container(bytes, source);
  if (decoded.type === "invalid_gltf") {
    throw new Error(
      `GLB ${JSON.stringify(source)} ${decoded.field}: ${decoded.reason}`,
    );
  }
  const binary = decoded.container.binary_chunk;
  if (binary === undefined) {
    throw new Error(`GLB ${JSON.stringify(source)} has no binary chunk`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.container.json_source);
  } catch (cause) {
    throw new Error(`GLB ${JSON.stringify(source)} JSON is invalid`, { cause });
  }
  const root = record(parsed, "$", source);
  const asset = record(root.asset, "$.asset", source);
  if (asset.version !== "2.0") {
    throw field_error(
      source,
      "$.asset.version",
      `expected "2.0", found ${JSON.stringify(asset.version)}`,
    );
  }
  const buffers = array(root.buffers, "$.buffers", source);
  if (buffers.length !== 1) {
    throw field_error(
      source,
      "$.buffers",
      `static GLB scenes require one binary buffer; found ${buffers.length}`,
    );
  }
  const buffer = record(buffers[0], "$.buffers[0]", source);
  if (buffer.uri !== undefined) {
    throw field_error(
      source,
      "$.buffers[0].uri",
      "external buffers are unsupported",
    );
  }
  const declared_length = nonnegative_integer(
    buffer.byteLength,
    "$.buffers[0].byteLength",
    source,
  );
  if (declared_length > binary.byteLength) {
    throw field_error(
      source,
      "$.buffers[0].byteLength",
      `${declared_length} exceeds binary chunk length ${binary.byteLength}`,
    );
  }

  const buffer_views = parse_buffer_views(root.bufferViews, source);
  const accessors = parse_accessors(
    root.accessors,
    buffer_views.length,
    source,
  );
  const textures = parse_textures(
    root.images,
    root.textures,
    buffer_views,
    binary,
    source,
  );
  const materials = parse_materials(root.materials, textures.length, source);
  const meshes = parse_meshes(
    root.meshes,
    accessors.length,
    materials.length,
    source,
  );
  const nodes = parse_nodes(root.nodes, meshes.length, source);
  const scenes = array(root.scenes, "$.scenes", source);
  const scene_index = root.scene === undefined
    ? 0
    : index(root.scene, scenes.length, "$.scene", source);
  const scene = record(scenes[scene_index], `$.scenes[${scene_index}]`, source);
  const roots = index_array(
    scene.nodes,
    nodes.length,
    `$.scenes[${scene_index}].nodes`,
    source,
  );
  const output: StaticGltfMesh[] = [];
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (
    node_index: number,
    parent_transform: readonly number[],
  ): void => {
    if (visiting.has(node_index)) {
      throw field_error(
        source,
        `$.nodes[${node_index}]`,
        "node hierarchy contains a cycle",
      );
    }
    if (visited.has(node_index)) {
      throw field_error(
        source,
        `$.nodes[${node_index}]`,
        "node is referenced more than once",
      );
    }
    visiting.add(node_index);
    visited.add(node_index);
    const node = nodes[node_index];
    const world_transform = multiply_matrix(
      parent_transform,
      node.local_transform,
    );
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      for (const [primitive_index, primitive] of mesh.primitives.entries()) {
        output.push({
          id:
            `${source}#node/${node_index}/mesh/${node.mesh}/primitive/${primitive_index}`,
          material: primitive.material === undefined
            ? default_material()
            : materials[primitive.material],
          vertices: pack_primitive(
            primitive,
            accessors,
            buffer_views,
            binary,
            world_transform,
            source,
            `$.meshes[${node.mesh}].primitives[${primitive_index}]`,
          ),
        });
      }
    }
    for (const child of node.children) visit(child, world_transform);
    visiting.delete(node_index);
  };
  for (const root_node of roots) visit(root_node, identity_matrix());
  if (output.length === 0) {
    throw field_error(
      source,
      `$.scenes[${scene_index}]`,
      "scene contains no mesh primitives",
    );
  }
  return {
    source,
    meshes: output,
    textures,
    texture_reference_count: count_texture_references(root.materials, source),
  };
}

function parse_buffer_views(
  value: unknown,
  source: string,
): readonly BufferView[] {
  return array(value, "$.bufferViews", source).map((entry, view_index) => {
    const field = `$.bufferViews[${view_index}]`;
    const view = record(entry, field, source);
    const buffer = nonnegative_integer(view.buffer, `${field}.buffer`, source);
    if (buffer !== 0) {
      throw field_error(
        source,
        `${field}.buffer`,
        `expected buffer 0, found ${buffer}`,
      );
    }
    const byte_stride = view.byteStride === undefined
      ? undefined
      : positive_integer(view.byteStride, `${field}.byteStride`, source);
    return {
      byte_length: nonnegative_integer(
        view.byteLength,
        `${field}.byteLength`,
        source,
      ),
      byte_offset: view.byteOffset === undefined
        ? 0
        : nonnegative_integer(view.byteOffset, `${field}.byteOffset`, source),
      ...(byte_stride === undefined ? {} : { byte_stride }),
    };
  });
}

function parse_accessors(
  value: unknown,
  buffer_view_count: number,
  source: string,
): readonly Accessor[] {
  return array(value, "$.accessors", source).map((entry, accessor_index) => {
    const field = `$.accessors[${accessor_index}]`;
    const accessor = record(entry, field, source);
    if (accessor.sparse !== undefined) {
      throw field_error(
        source,
        `${field}.sparse`,
        "sparse accessors are unsupported",
      );
    }
    if (accessor.normalized === true) {
      throw field_error(
        source,
        `${field}.normalized`,
        "normalized accessors are unsupported",
      );
    }
    const shape = required_text(accessor.type, `${field}.type`, source);
    return {
      buffer_view: index(
        accessor.bufferView,
        buffer_view_count,
        `${field}.bufferView`,
        source,
      ),
      byte_offset: accessor.byteOffset === undefined ? 0 : nonnegative_integer(
        accessor.byteOffset,
        `${field}.byteOffset`,
        source,
      ),
      component_type: positive_integer(
        accessor.componentType,
        `${field}.componentType`,
        source,
      ),
      count: nonnegative_integer(accessor.count, `${field}.count`, source),
      shape,
    };
  });
}

function parse_textures(
  image_value: unknown,
  texture_value: unknown,
  buffer_views: readonly BufferView[],
  binary: Uint8Array,
  source: string,
): readonly StaticGltfTexture[] {
  if (texture_value === undefined) return [];
  const images = array(image_value, "$.images", source);
  return array(texture_value, "$.textures", source).map(
    (entry, texture_index) => {
      const texture_field = `$.textures[${texture_index}]`;
      const texture = record(entry, texture_field, source);
      const image_index = index(
        texture.source,
        images.length,
        `${texture_field}.source`,
        source,
      );
      const image_field = `$.images[${image_index}]`;
      const image = record(images[image_index], image_field, source);
      if (image.uri !== undefined) {
        throw field_error(
          source,
          `${image_field}.uri`,
          "external images are unsupported",
        );
      }
      const view_index = index(
        image.bufferView,
        buffer_views.length,
        `${image_field}.bufferView`,
        source,
      );
      const mime_type = required_text(
        image.mimeType,
        `${image_field}.mimeType`,
        source,
      );
      if (mime_type !== "image/png" && mime_type !== "image/jpeg") {
        throw field_error(
          source,
          `${image_field}.mimeType`,
          `expected image/png or image/jpeg, found ${
            JSON.stringify(mime_type)
          }`,
        );
      }
      const view = buffer_views[view_index];
      const end = view.byte_offset + view.byte_length;
      if (end > binary.byteLength) {
        throw field_error(
          source,
          image_field,
          `image ends at ${end}, beyond binary length ${binary.byteLength}`,
        );
      }
      return {
        bytes: binary.slice(view.byte_offset, end),
        id: texture_id(texture_index, source),
        mime_type,
      };
    },
  );
}

function texture_id(index: number, source: string): string {
  return `${source}#texture/${index}`;
}

function parse_materials(
  value: unknown,
  texture_count: number,
  source: string,
): readonly StaticGltfMaterial[] {
  if (value === undefined) return [];
  return array(value, "$.materials", source).map((entry, material_index) => {
    const field = `$.materials[${material_index}]`;
    const material = record(entry, field, source);
    const pbr = material.pbrMetallicRoughness === undefined
      ? undefined
      : record(
        material.pbrMetallicRoughness,
        `${field}.pbrMetallicRoughness`,
        source,
      );
    const base = pbr?.baseColorFactor === undefined
      ? [1, 1, 1, 1]
      : number_vector(
        pbr.baseColorFactor,
        4,
        `${field}.pbrMetallicRoughness.baseColorFactor`,
        source,
      );
    const emissive = material.emissiveFactor === undefined
      ? [0, 0, 0]
      : number_vector(
        material.emissiveFactor,
        3,
        `${field}.emissiveFactor`,
        source,
      );
    let base_color_texture: string | undefined;
    if (pbr?.baseColorTexture !== undefined) {
      const texture_field = `${field}.pbrMetallicRoughness.baseColorTexture`;
      const texture = record(pbr.baseColorTexture, texture_field, source);
      const texture_coordinate = texture.texCoord === undefined
        ? 0
        : nonnegative_integer(
          texture.texCoord,
          `${texture_field}.texCoord`,
          source,
        );
      if (texture_coordinate !== 0) {
        throw field_error(
          source,
          `${texture_field}.texCoord`,
          `only TEXCOORD_0 is supported; found ${texture_coordinate}`,
        );
      }
      base_color_texture = texture_id(
        index(
          texture.index,
          texture_count,
          `${texture_field}.index`,
          source,
        ),
        source,
      );
    }
    return {
      albedo: [base[0], base[1], base[2]],
      ...(base_color_texture === undefined ? {} : { base_color_texture }),
      emissive: [emissive[0], emissive[1], emissive[2]],
      metallic: unit_number(
        pbr?.metallicFactor ?? 1,
        `${field}.pbrMetallicRoughness.metallicFactor`,
        source,
      ),
      roughness: unit_number(
        pbr?.roughnessFactor ?? 1,
        `${field}.pbrMetallicRoughness.roughnessFactor`,
        source,
      ),
    };
  });
}

function parse_meshes(
  value: unknown,
  accessor_count: number,
  material_count: number,
  source: string,
): readonly Mesh[] {
  return array(value, "$.meshes", source).map((entry, mesh_index) => {
    const field = `$.meshes[${mesh_index}]`;
    const mesh = record(entry, field, source);
    const primitives = array(mesh.primitives, `${field}.primitives`, source)
      .map(
        (entry, primitive_index): Primitive => {
          const primitive_field = `${field}.primitives[${primitive_index}]`;
          const primitive = record(entry, primitive_field, source);
          const mode = primitive.mode === undefined ? 4 : nonnegative_integer(
            primitive.mode,
            `${primitive_field}.mode`,
            source,
          );
          if (mode !== 4) {
            throw field_error(
              source,
              `${primitive_field}.mode`,
              `triangle lists require mode 4; found ${mode}`,
            );
          }
          const attributes = record(
            primitive.attributes,
            `${primitive_field}.attributes`,
            source,
          );
          const indices = primitive.indices === undefined ? undefined : index(
            primitive.indices,
            accessor_count,
            `${primitive_field}.indices`,
            source,
          );
          const material = primitive.material === undefined ? undefined : index(
            primitive.material,
            material_count,
            `${primitive_field}.material`,
            source,
          );
          const texture_coordinate = attributes.TEXCOORD_0 === undefined
            ? undefined
            : index(
              attributes.TEXCOORD_0,
              accessor_count,
              `${primitive_field}.attributes.TEXCOORD_0`,
              source,
            );
          return {
            position: index(
              attributes.POSITION,
              accessor_count,
              `${primitive_field}.attributes.POSITION`,
              source,
            ),
            normal: index(
              attributes.NORMAL,
              accessor_count,
              `${primitive_field}.attributes.NORMAL`,
              source,
            ),
            ...(indices === undefined ? {} : { indices }),
            ...(material === undefined ? {} : { material }),
            ...(texture_coordinate === undefined ? {} : { texture_coordinate }),
          };
        },
      );
    if (primitives.length === 0) {
      throw field_error(
        source,
        `${field}.primitives`,
        "mesh must contain a primitive",
      );
    }
    return { primitives };
  });
}

function parse_nodes(
  value: unknown,
  mesh_count: number,
  source: string,
): readonly Node[] {
  const entries = array(value, "$.nodes", source);
  return entries.map((entry, node_index) => {
    const field = `$.nodes[${node_index}]`;
    const node = record(entry, field, source);
    const mesh = node.mesh === undefined
      ? undefined
      : index(node.mesh, mesh_count, `${field}.mesh`, source);
    return {
      children: node.children === undefined ? [] : index_array(
        node.children,
        entries.length,
        `${field}.children`,
        source,
      ),
      local_transform: parse_node_transform(node, field, source),
      ...(mesh === undefined ? {} : { mesh }),
    };
  });
}

function parse_node_transform(
  node: Record<string, unknown>,
  field: string,
  source: string,
): readonly number[] {
  if (node.matrix !== undefined) {
    if (
      node.translation !== undefined || node.rotation !== undefined ||
      node.scale !== undefined
    ) {
      throw field_error(
        source,
        field,
        "matrix cannot be combined with translation, rotation, or scale",
      );
    }
    return number_vector(node.matrix, 16, `${field}.matrix`, source);
  }
  const translation = node.translation === undefined
    ? [0, 0, 0]
    : number_vector(node.translation, 3, `${field}.translation`, source);
  const rotation = node.rotation === undefined
    ? [0, 0, 0, 1]
    : number_vector(node.rotation, 4, `${field}.rotation`, source);
  const scale = node.scale === undefined
    ? [1, 1, 1]
    : number_vector(node.scale, 3, `${field}.scale`, source);
  const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (Math.abs(length - 1) > 0.001) {
    throw field_error(
      source,
      `${field}.rotation`,
      `quaternion length ${length} is not normalized`,
    );
  }
  const [x, y, z, w] = rotation;
  const [scale_x, scale_y, scale_z] = scale;
  return [
    (1 - 2 * (y * y + z * z)) * scale_x,
    (2 * (x * y + z * w)) * scale_x,
    (2 * (x * z - y * w)) * scale_x,
    0,
    (2 * (x * y - z * w)) * scale_y,
    (1 - 2 * (x * x + z * z)) * scale_y,
    (2 * (y * z + x * w)) * scale_y,
    0,
    (2 * (x * z + y * w)) * scale_z,
    (2 * (y * z - x * w)) * scale_z,
    (1 - 2 * (x * x + y * y)) * scale_z,
    0,
    translation[0],
    translation[1],
    translation[2],
    1,
  ];
}

function pack_primitive(
  primitive: Primitive,
  accessors: readonly Accessor[],
  buffer_views: readonly BufferView[],
  binary: Uint8Array,
  transform: readonly number[],
  source: string,
  field: string,
): Float32Array {
  const positions = read_vec3(
    accessors[primitive.position],
    buffer_views,
    binary,
    `${field}.attributes.POSITION`,
    source,
  );
  const normals = read_vec3(
    accessors[primitive.normal],
    buffer_views,
    binary,
    `${field}.attributes.NORMAL`,
    source,
  );
  const texture_coordinates = primitive.texture_coordinate === undefined
    ? undefined
    : read_vec2(
      accessors[primitive.texture_coordinate],
      buffer_views,
      binary,
      `${field}.attributes.TEXCOORD_0`,
      source,
    );
  if (positions.length !== normals.length) {
    throw field_error(
      source,
      field,
      `position count ${positions.length} differs from normal count ${normals.length}`,
    );
  }
  if (
    texture_coordinates !== undefined &&
    texture_coordinates.length !== positions.length
  ) {
    throw field_error(
      source,
      field,
      `position count ${positions.length} differs from texture-coordinate count ${texture_coordinates.length}`,
    );
  }
  const indices = primitive.indices === undefined
    ? Array.from({ length: positions.length }, (_, vertex) => vertex)
    : read_indices(
      accessors[primitive.indices],
      buffer_views,
      binary,
      `${field}.indices`,
      source,
    );
  if (indices.length % 3 !== 0) {
    throw field_error(
      source,
      `${field}.indices`,
      `triangle index count ${indices.length} is not divisible by 3`,
    );
  }
  const normal_transform = inverse_transpose_3x3(transform, source, field);
  const packed = new Float32Array(indices.length * 8);
  for (const [output_index, vertex_index] of indices.entries()) {
    if (vertex_index < 0 || vertex_index >= positions.length) {
      throw field_error(
        source,
        `${field}.indices`,
        `index ${vertex_index} is outside 0..${positions.length - 1}`,
      );
    }
    const position = positions[vertex_index];
    const normal = normals[vertex_index];
    const output = output_index * 8;
    packed.set(transform_point(transform, position), output);
    packed.set(
      normalize(transform_direction(normal_transform, normal), source, field),
      output + 3,
    );
    packed.set(texture_coordinates?.[vertex_index] ?? [0, 0], output + 6);
  }
  return packed;
}

function read_vec2(
  accessor: Accessor,
  buffer_views: readonly BufferView[],
  binary: Uint8Array,
  field: string,
  source: string,
): readonly (readonly [number, number])[] {
  if (
    accessor.component_type !== float_component || accessor.shape !== "VEC2"
  ) {
    throw field_error(
      source,
      field,
      `expected float VEC2 accessor, found component ${accessor.component_type} ${accessor.shape}`,
    );
  }
  const view = buffer_views[accessor.buffer_view];
  const stride = view.byte_stride ?? 8;
  require_accessor_range(
    accessor,
    view,
    stride,
    8,
    binary.byteLength,
    field,
    source,
  );
  const values = new DataView(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  );
  const start = view.byte_offset + accessor.byte_offset;
  return Array.from({ length: accessor.count }, (_, element) => {
    const offset = start + element * stride;
    return [
      values.getFloat32(offset, true),
      values.getFloat32(offset + 4, true),
    ];
  });
}

function read_vec3(
  accessor: Accessor,
  buffer_views: readonly BufferView[],
  binary: Uint8Array,
  field: string,
  source: string,
): readonly (readonly [number, number, number])[] {
  if (
    accessor.component_type !== float_component || accessor.shape !== "VEC3"
  ) {
    throw field_error(
      source,
      field,
      `expected float VEC3 accessor, found component ${accessor.component_type} ${accessor.shape}`,
    );
  }
  const view = buffer_views[accessor.buffer_view];
  const stride = view.byte_stride ?? 12;
  require_accessor_range(
    accessor,
    view,
    stride,
    12,
    binary.byteLength,
    field,
    source,
  );
  const values = new DataView(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  );
  const start = view.byte_offset + accessor.byte_offset;
  return Array.from({ length: accessor.count }, (_, element) => {
    const offset = start + element * stride;
    return [
      values.getFloat32(offset, true),
      values.getFloat32(offset + 4, true),
      values.getFloat32(offset + 8, true),
    ];
  });
}

function read_indices(
  accessor: Accessor,
  buffer_views: readonly BufferView[],
  binary: Uint8Array,
  field: string,
  source: string,
): readonly number[] {
  if (accessor.shape !== "SCALAR") {
    throw field_error(
      source,
      field,
      `expected SCALAR accessor, found ${accessor.shape}`,
    );
  }
  const component_size = accessor.component_type === unsigned_byte_component
    ? 1
    : accessor.component_type === unsigned_short_component
    ? 2
    : accessor.component_type === unsigned_int_component
    ? 4
    : 0;
  if (component_size === 0) {
    throw field_error(
      source,
      field,
      `unsupported index component ${accessor.component_type}`,
    );
  }
  const view = buffer_views[accessor.buffer_view];
  const stride = view.byte_stride ?? component_size;
  require_accessor_range(
    accessor,
    view,
    stride,
    component_size,
    binary.byteLength,
    field,
    source,
  );
  const values = new DataView(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  );
  const start = view.byte_offset + accessor.byte_offset;
  return Array.from({ length: accessor.count }, (_, element) => {
    const offset = start + element * stride;
    if (component_size === 1) return values.getUint8(offset);
    if (component_size === 2) return values.getUint16(offset, true);
    return values.getUint32(offset, true);
  });
}

function require_accessor_range(
  accessor: Accessor,
  view: BufferView,
  stride: number,
  element_size: number,
  binary_length: number,
  field: string,
  source: string,
): void {
  if (stride < element_size) {
    throw field_error(
      source,
      field,
      `byte stride ${stride} is smaller than element size ${element_size}`,
    );
  }
  const relative_end = accessor.byte_offset +
    Math.max(0, accessor.count - 1) * stride +
    (accessor.count === 0 ? 0 : element_size);
  if (relative_end > view.byte_length) {
    throw field_error(
      source,
      field,
      `accessor ends at ${relative_end}, beyond buffer view length ${view.byte_length}`,
    );
  }
  const absolute_end = view.byte_offset + relative_end;
  if (absolute_end > binary_length) {
    throw field_error(
      source,
      field,
      `accessor ends at ${absolute_end}, beyond binary length ${binary_length}`,
    );
  }
}

function count_texture_references(value: unknown, source: string): number {
  if (value === undefined) return 0;
  let count = 0;
  for (
    const [material_index, entry] of array(value, "$.materials", source)
      .entries()
  ) {
    const field = `$.materials[${material_index}]`;
    const material = record(entry, field, source);
    const pbr = material.pbrMetallicRoughness === undefined
      ? undefined
      : record(
        material.pbrMetallicRoughness,
        `${field}.pbrMetallicRoughness`,
        source,
      );
    for (
      const texture of [
        pbr?.baseColorTexture,
        pbr?.metallicRoughnessTexture,
        material.normalTexture,
        material.occlusionTexture,
        material.emissiveTexture,
      ]
    ) {
      if (texture !== undefined) count += 1;
    }
  }
  return count;
}

function default_material(): StaticGltfMaterial {
  return { albedo: [1, 1, 1], emissive: [0, 0, 0], metallic: 1, roughness: 1 };
}

function identity_matrix(): readonly number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply_matrix(
  left: readonly number[],
  right: readonly number[],
): readonly number[] {
  const output = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let inner = 0; inner < 4; inner += 1) {
        output[column * 4 + row] += left[inner * 4 + row] *
          right[column * 4 + inner];
      }
    }
  }
  return output;
}

function transform_point(
  matrix: readonly number[],
  point: readonly [number, number, number],
): readonly [number, number, number] {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] +
    matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] +
    matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] +
    matrix[14],
  ];
}

function transform_direction(
  matrix: readonly number[],
  direction: readonly [number, number, number],
): readonly [number, number, number] {
  return [
    matrix[0] * direction[0] + matrix[3] * direction[1] +
    matrix[6] * direction[2],
    matrix[1] * direction[0] + matrix[4] * direction[1] +
    matrix[7] * direction[2],
    matrix[2] * direction[0] + matrix[5] * direction[1] +
    matrix[8] * direction[2],
  ];
}

function inverse_transpose_3x3(
  matrix: readonly number[],
  source: string,
  field: string,
): readonly number[] {
  const a = matrix[0];
  const b = matrix[4];
  const c = matrix[8];
  const d = matrix[1];
  const e = matrix[5];
  const f = matrix[9];
  const g = matrix[2];
  const h = matrix[6];
  const i = matrix[10];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) +
    c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-12) {
    throw field_error(source, field, "node transform has no normal inverse");
  }
  const inverse = 1 / determinant;
  return [
    (e * i - f * h) * inverse,
    (f * g - d * i) * inverse,
    (d * h - e * g) * inverse,
    (c * h - b * i) * inverse,
    (a * i - c * g) * inverse,
    (b * g - a * h) * inverse,
    (b * f - c * e) * inverse,
    (c * d - a * f) * inverse,
    (a * e - b * d) * inverse,
  ];
}

function normalize(
  vector: readonly [number, number, number],
  source: string,
  field: string,
): readonly [number, number, number] {
  const length = Math.hypot(...vector);
  if (length < 1e-12) {
    throw field_error(
      source,
      field,
      "normal has zero length after transformation",
    );
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function record(
  value: unknown,
  field: string,
  source: string,
): Record<string, unknown> {
  if (!is_record(value)) {
    throw field_error(
      source,
      field,
      `expected object, found ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(
  value: unknown,
  field: string,
  source: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw field_error(
      source,
      field,
      `expected array, found ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function index_array(
  value: unknown,
  length: number,
  field: string,
  source: string,
): readonly number[] {
  return array(value, field, source).map((entry, entry_index) =>
    index(entry, length, `${field}[${entry_index}]`, source)
  );
}

function index(
  value: unknown,
  length: number,
  field: string,
  source: string,
): number {
  const parsed = nonnegative_integer(value, field, source);
  if (parsed >= length) {
    throw field_error(source, field, `${parsed} is outside 0..${length - 1}`);
  }
  return parsed;
}

function nonnegative_integer(
  value: unknown,
  field: string,
  source: string,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw field_error(
      source,
      field,
      `expected nonnegative integer, found ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function positive_integer(
  value: unknown,
  field: string,
  source: string,
): number {
  const parsed = nonnegative_integer(value, field, source);
  if (parsed === 0) {
    throw field_error(source, field, "expected positive integer, found 0");
  }
  return parsed;
}

function required_text(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw field_error(
      source,
      field,
      `expected non-empty text, found ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function number_vector(
  value: unknown,
  length: number,
  field: string,
  source: string,
): readonly number[] {
  const values = array(value, field, source);
  if (
    values.length !== length ||
    values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw field_error(source, field, `expected ${length} finite numbers`);
  }
  return values.map((entry) => typeof entry === "number" ? entry : 0);
}

function unit_number(value: unknown, field: string, source: string): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    value > 1
  ) {
    throw field_error(
      source,
      field,
      `expected number in [0, 1], found ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function field_error(source: string, field: string, reason: string): Error {
  return new Error(`GLB ${JSON.stringify(source)} ${field}: ${reason}`);
}

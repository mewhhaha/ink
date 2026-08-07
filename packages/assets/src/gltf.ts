import { asset_id, type AssetId } from "./identity.ts";

export interface GltfPrimitive {
  readonly attributes: Readonly<Record<string, number>>;
  readonly indices?: number;
  readonly material?: number;
  readonly mode: number;
}

export interface GltfMesh {
  readonly id: AssetId<"gltf.mesh">;
  readonly name?: string;
  readonly primitives: readonly GltfPrimitive[];
}

export interface GltfMaterial {
  readonly id: AssetId<"gltf.material">;
  readonly name?: string;
}

export interface GltfNode {
  readonly id: AssetId<"gltf.node">;
  readonly name?: string;
  readonly children: readonly number[];
  readonly mesh?: number;
  readonly skin?: number;
}

export interface GltfSkin {
  readonly id: AssetId<"gltf.skin">;
  readonly name?: string;
  readonly joints: readonly number[];
  readonly skeleton?: number;
  readonly inverse_bind_matrices?: number;
}

export interface GltfAnimation {
  readonly id: AssetId<"gltf.animation">;
  readonly name?: string;
  readonly channel_count: number;
  readonly sampler_count: number;
}

export interface GltfScene {
  readonly id: AssetId<"gltf.scene">;
  readonly name?: string;
  readonly nodes: readonly number[];
}

export interface GltfDocument {
  readonly source: string;
  readonly buffers: readonly {
    readonly uri?: string;
    readonly byte_length: number;
  }[];
  readonly buffer_view_count: number;
  readonly accessor_count: number;
  readonly meshes: readonly GltfMesh[];
  readonly materials: readonly GltfMaterial[];
  readonly nodes: readonly GltfNode[];
  readonly skins: readonly GltfSkin[];
  readonly animations: readonly GltfAnimation[];
  readonly scenes: readonly GltfScene[];
  readonly default_scene?: number;
  readonly binary_chunk?: Uint8Array;
}

export interface GltfParseFailure {
  readonly type: "invalid_gltf";
  readonly source: string;
  readonly field: string;
  readonly offset?: number;
  readonly reason: string;
}

export type GltfParseResult =
  | { readonly type: "ready"; readonly document: GltfDocument }
  | GltfParseFailure;

interface ParseIssue {
  readonly field: string;
  readonly offset?: number;
  readonly reason: string;
}

const glb_magic = 0x46546c67;
const json_chunk_type = 0x4e4f534a;
const binary_chunk_type = 0x004e4942;

export function parse_gltf_json(
  source_text: string,
  source: string,
): GltfParseResult {
  let value: unknown;
  try {
    value = JSON.parse(source_text);
  } catch (error) {
    return failure(
      source,
      "$",
      error instanceof Error ? error.message : String(error),
    );
  }
  return parse_gltf_value(value, source);
}

export function parse_glb(bytes: Uint8Array, source: string): GltfParseResult {
  if (bytes.length < 12) {
    return failure(
      source,
      "$",
      `GLB has ${bytes.length} bytes; header needs 12`,
      0,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== glb_magic) {
    return failure(source, "$", "GLB magic is not 0x46546c67", 0);
  }
  const version = view.getUint32(4, true);
  if (version !== 2) {
    return failure(
      source,
      "$.asset.version",
      `GLB version ${version} is not supported`,
      4,
    );
  }
  const declared_length = view.getUint32(8, true);
  if (declared_length !== bytes.length) {
    return failure(
      source,
      "$",
      `GLB declares ${declared_length} bytes but contains ${bytes.length}`,
      8,
    );
  }

  let offset = 12;
  let chunk_index = 0;
  let json_bytes: Uint8Array | undefined;
  let binary_chunk: Uint8Array | undefined;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return failure(source, "$", "GLB chunk header is truncated", offset);
    }
    const chunk_length = view.getUint32(offset, true);
    const chunk_type = view.getUint32(offset + 4, true);
    if (chunk_length % 4 !== 0) {
      return failure(
        source,
        "$",
        `GLB chunk at offset ${offset} has unaligned length ${chunk_length}`,
        offset,
      );
    }
    if (chunk_index === 0 && chunk_type !== json_chunk_type) {
      return failure(source, "$", "GLB first chunk must contain JSON", offset);
    }
    const content_start = offset + 8;
    const content_end = content_start + chunk_length;
    if (content_end > bytes.length) {
      return failure(
        source,
        "$",
        `GLB chunk at offset ${offset} ends at ${content_end}, beyond ${bytes.length}`,
        offset,
      );
    }
    const content = bytes.slice(content_start, content_end);
    if (chunk_type === json_chunk_type) {
      if (json_bytes !== undefined) {
        return failure(
          source,
          "$",
          "GLB contains more than one JSON chunk",
          offset,
        );
      }
      json_bytes = content;
    } else if (chunk_type === binary_chunk_type) {
      if (binary_chunk !== undefined) {
        return failure(
          source,
          "$",
          "GLB contains more than one binary chunk",
          offset,
        );
      }
      binary_chunk = content;
    }
    offset = content_end;
    chunk_index += 1;
  }
  if (json_bytes === undefined) {
    return failure(source, "$", "GLB does not contain a JSON chunk", 12);
  }

  let source_text: string;
  try {
    source_text = new TextDecoder("utf-8", { fatal: true }).decode(json_bytes);
    while (source_text.endsWith("\0") || source_text.endsWith(" ")) {
      source_text = source_text.slice(0, -1);
    }
  } catch (error) {
    return failure(
      source,
      "$",
      `GLB JSON chunk is not UTF-8: ${
        error instanceof Error ? error.message : String(error)
      }`,
      20,
    );
  }
  const parsed = parse_gltf_json(source_text, source);
  if (parsed.type === "invalid_gltf" || binary_chunk === undefined) {
    return parsed;
  }
  return {
    type: "ready",
    document: { ...parsed.document, binary_chunk },
  };
}

function parse_gltf_value(value: unknown, source: string): GltfParseResult {
  try {
    const root = expect_record(value, "$", "glTF root must be an object");
    const asset = expect_record(
      root.asset,
      "$.asset",
      "glTF asset must be an object",
    );
    if (asset.version !== "2.0") {
      issue(
        "$.asset.version",
        `glTF asset version ${
          JSON.stringify(asset.version)
        } is not supported; expected "2.0"`,
      );
    }
    const buffers = parse_buffers(root.buffers);
    const buffer_views = optional_array(root.bufferViews, "$.bufferViews");
    const accessors = optional_array(root.accessors, "$.accessors");
    const materials = parse_named_records<"gltf.material">(
      root.materials,
      source,
      "material",
    );
    const meshes = parse_meshes(
      root.meshes,
      source,
      accessors.length,
      materials.length,
    );
    const raw_nodes = optional_array(root.nodes, "$.nodes");
    const raw_skins = optional_array(root.skins, "$.skins");
    const nodes = parse_nodes(
      raw_nodes,
      source,
      meshes.length,
      raw_skins.length,
    );
    validate_node_hierarchy(nodes);
    const skins = parse_skins(
      raw_skins,
      source,
      nodes.length,
      accessors.length,
    );
    const animations = parse_animations(root.animations, source);
    const scenes = parse_scenes(root.scenes, source, nodes.length);
    const default_scene = optional_index(root.scene, scenes.length, "$.scene");

    return {
      type: "ready",
      document: {
        source,
        buffers,
        buffer_view_count: buffer_views.length,
        accessor_count: accessors.length,
        meshes,
        materials,
        nodes,
        skins,
        animations,
        scenes,
        ...(default_scene === undefined ? {} : { default_scene }),
      },
    };
  } catch (error) {
    if (!is_parse_issue(error)) throw error;
    return failure(source, error.field, error.reason, error.offset);
  }
}

function parse_buffers(
  value: unknown,
): readonly { readonly uri?: string; readonly byte_length: number }[] {
  return optional_array(value, "$.buffers").map((buffer, index) => {
    const field = `$.buffers[${index}]`;
    const record = expect_record(buffer, field, `${field} must be an object`);
    const byte_length = nonnegative_integer(
      record.byteLength,
      `${field}.byteLength`,
    );
    if (record.uri !== undefined && typeof record.uri !== "string") {
      issue(`${field}.uri`, `${field}.uri must be a string`);
    }
    return {
      byte_length,
      ...(record.uri === undefined ? {} : { uri: record.uri as string }),
    };
  });
}

function parse_named_records<Kind extends string>(
  value: unknown,
  source: string,
  kind: string,
): readonly { readonly id: AssetId<Kind>; readonly name?: string }[] {
  return optional_array(value, `$.${kind}s`).map((entry, index) => {
    const field = `$.${kind}s[${index}]`;
    const record = expect_record(entry, field, `${field} must be an object`);
    const name = optional_name(record.name, `${field}.name`);
    return {
      id: asset_id<Kind>(`${source}#${kind}/${index}`),
      ...(name === undefined ? {} : { name }),
    };
  });
}

function parse_meshes(
  value: unknown,
  source: string,
  accessor_count: number,
  material_count: number,
): readonly GltfMesh[] {
  return optional_array(value, "$.meshes").map((mesh, mesh_index) => {
    const field = `$.meshes[${mesh_index}]`;
    const record = expect_record(mesh, field, `${field} must be an object`);
    const primitives = required_array(record.primitives, `${field}.primitives`)
      .map(
        (primitive, primitive_index): GltfPrimitive => {
          const primitive_field = `${field}.primitives[${primitive_index}]`;
          const primitive_record = expect_record(
            primitive,
            primitive_field,
            `${primitive_field} must be an object`,
          );
          const raw_attributes = expect_record(
            primitive_record.attributes,
            `${primitive_field}.attributes`,
            `${primitive_field}.attributes must be an object`,
          );
          const attribute_entries: [string, number][] = [];
          for (const semantic of Object.keys(raw_attributes).sort()) {
            const parsed_semantic = semantic.trim();
            if (parsed_semantic.length === 0) {
              issue(
                `${primitive_field}.attributes.${semantic}`,
                `${primitive_field} attribute semantic cannot be empty`,
              );
            }
            attribute_entries.push([
              parsed_semantic,
              index_value(
                raw_attributes[semantic],
                accessor_count,
                `${primitive_field}.attributes.${semantic}`,
              ),
            ]);
          }
          const attributes = Object.fromEntries(attribute_entries);
          const indices = optional_index(
            primitive_record.indices,
            accessor_count,
            `${primitive_field}.indices`,
          );
          const material = optional_index(
            primitive_record.material,
            material_count,
            `${primitive_field}.material`,
          );
          const mode = primitive_record.mode === undefined
            ? 4
            : integer_in_range(
              primitive_record.mode,
              0,
              6,
              `${primitive_field}.mode`,
            );
          return {
            attributes,
            ...(indices === undefined ? {} : { indices }),
            ...(material === undefined ? {} : { material }),
            mode,
          };
        },
      );
    const name = optional_name(record.name, `${field}.name`);
    return {
      id: asset_id<"gltf.mesh">(`${source}#mesh/${mesh_index}`),
      ...(name === undefined ? {} : { name }),
      primitives,
    };
  });
}

function parse_nodes(
  values: readonly unknown[],
  source: string,
  mesh_count: number,
  skin_count: number,
): readonly GltfNode[] {
  const node_count = values.length;
  return values.map((node, index) => {
    const field = `$.nodes[${index}]`;
    const record = expect_record(node, field, `${field} must be an object`);
    const children = optional_array(record.children, `${field}.children`).map(
      (child, child_index) =>
        index_value(child, node_count, `${field}.children[${child_index}]`),
    );
    if (new Set(children).size !== children.length) {
      issue(`${field}.children`, `${field}.children contains a duplicate node`);
    }
    const mesh = optional_index(record.mesh, mesh_count, `${field}.mesh`);
    const skin = optional_index(record.skin, skin_count, `${field}.skin`);
    const name = optional_name(record.name, `${field}.name`);
    return {
      id: asset_id<"gltf.node">(`${source}#node/${index}`),
      ...(name === undefined ? {} : { name }),
      children,
      ...(mesh === undefined ? {} : { mesh }),
      ...(skin === undefined ? {} : { skin }),
    };
  });
}

function parse_skins(
  values: readonly unknown[],
  source: string,
  node_count: number,
  accessor_count: number,
): readonly GltfSkin[] {
  return values.map((skin, index) => {
    const field = `$.skins[${index}]`;
    const record = expect_record(skin, field, `${field} must be an object`);
    const joints = required_array(record.joints, `${field}.joints`).map(
      (joint, joint_index) =>
        index_value(joint, node_count, `${field}.joints[${joint_index}]`),
    );
    if (joints.length === 0) {
      issue(`${field}.joints`, `${field}.joints cannot be empty`);
    }
    if (new Set(joints).size !== joints.length) {
      issue(`${field}.joints`, `${field}.joints contains a duplicate node`);
    }
    const skeleton = optional_index(
      record.skeleton,
      node_count,
      `${field}.skeleton`,
    );
    const inverse_bind_matrices = optional_index(
      record.inverseBindMatrices,
      accessor_count,
      `${field}.inverseBindMatrices`,
    );
    const name = optional_name(record.name, `${field}.name`);
    return {
      id: asset_id<"gltf.skin">(`${source}#skin/${index}`),
      ...(name === undefined ? {} : { name }),
      joints,
      ...(skeleton === undefined ? {} : { skeleton }),
      ...(inverse_bind_matrices === undefined ? {} : { inverse_bind_matrices }),
    };
  });
}

function parse_animations(
  value: unknown,
  source: string,
): readonly GltfAnimation[] {
  return optional_array(value, "$.animations").map((animation, index) => {
    const field = `$.animations[${index}]`;
    const record = expect_record(
      animation,
      field,
      `${field} must be an object`,
    );
    const channels = required_array(record.channels, `${field}.channels`);
    const samplers = required_array(record.samplers, `${field}.samplers`);
    const name = optional_name(record.name, `${field}.name`);
    return {
      id: asset_id<"gltf.animation">(`${source}#animation/${index}`),
      ...(name === undefined ? {} : { name }),
      channel_count: channels.length,
      sampler_count: samplers.length,
    };
  });
}

function parse_scenes(
  value: unknown,
  source: string,
  node_count: number,
): readonly GltfScene[] {
  return optional_array(value, "$.scenes").map((scene, index) => {
    const field = `$.scenes[${index}]`;
    const record = expect_record(scene, field, `${field} must be an object`);
    const nodes = optional_array(record.nodes, `${field}.nodes`).map(
      (node, node_index) =>
        index_value(node, node_count, `${field}.nodes[${node_index}]`),
    );
    if (new Set(nodes).size !== nodes.length) {
      issue(`${field}.nodes`, `${field}.nodes contains a duplicate node`);
    }
    const name = optional_name(record.name, `${field}.name`);
    return {
      id: asset_id<"gltf.scene">(`${source}#scene/${index}`),
      ...(name === undefined ? {} : { name }),
      nodes,
    };
  });
}

function validate_node_hierarchy(nodes: readonly GltfNode[]): void {
  const parents = new Map<number, number>();
  for (const [parent, node] of nodes.entries()) {
    for (const child of node.children) {
      const existing = parents.get(child);
      if (existing !== undefined) {
        issue(
          `$.nodes[${parent}].children`,
          `glTF node ${child} has parents ${existing} and ${parent}`,
        );
      }
      parents.set(child, parent);
    }
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visited.has(index)) return;
    if (visiting.has(index)) {
      issue(
        `$.nodes[${index}].children`,
        `glTF node hierarchy contains a cycle through node ${index}`,
      );
    }
    visiting.add(index);
    for (const child of nodes[index].children) visit(child);
    visiting.delete(index);
    visited.add(index);
  };
  for (let index = 0; index < nodes.length; index++) visit(index);
}

function optional_array(value: unknown, field: string): readonly unknown[] {
  if (value === undefined) return [];
  return required_array(value, field);
}

function required_array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) issue(field, `${field} must be an array`);
  return value;
}

function expect_record(
  value: unknown,
  field: string,
  reason: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issue(field, reason);
  }
  return value as Record<string, unknown>;
}

function optional_name(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(field, `${field} must be a nonempty string`);
  }
  return value.trim();
}

function optional_index(
  value: unknown,
  count: number,
  field: string,
): number | undefined {
  return value === undefined ? undefined : index_value(value, count, field);
}

function index_value(value: unknown, count: number, field: string): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < 0 ||
    (value as number) >= count
  ) {
    issue(
      field,
      `${field} ${JSON.stringify(value)} is outside 0..${count - 1}`,
    );
  }
  return value as number;
}

function nonnegative_integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    issue(
      field,
      `${field} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value as number;
}

function integer_in_range(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum
  ) {
    issue(
      field,
      `${field} ${JSON.stringify(value)} must be in ${minimum}..${maximum}`,
    );
  }
  return value as number;
}

function issue(field: string, reason: string, offset?: number): never {
  throw {
    field,
    reason,
    ...(offset === undefined ? {} : { offset }),
  } satisfies ParseIssue;
}

function is_parse_issue(value: unknown): value is ParseIssue {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.field === "string" && typeof record.reason === "string";
}

function failure(
  source: string,
  field: string,
  reason: string,
  offset?: number,
): GltfParseFailure {
  return {
    type: "invalid_gltf",
    source,
    field,
    ...(offset === undefined ? {} : { offset }),
    reason,
  };
}

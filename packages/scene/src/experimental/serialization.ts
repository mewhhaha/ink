import { asset_id, asset_ref, type AssetRef } from "@ink/assets/identity.ts";
import { aabb } from "@ink/geometry/shapes.ts";
import { quat } from "@ink/math/quaternion.ts";
import { transform } from "@ink/math/transform.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  attachment_key,
  type AttachmentKey,
  scene_id,
  scene_instance_id,
  scene_node_id,
  scene_node_key,
} from "../identity.ts";
import {
  resolve_scene_snapshot,
  type SceneInstanceNodeSource,
  type SceneNodeSource,
  type SceneOverrideProperty,
  type SceneSnapshot,
} from "./scene.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AttachmentCodec<Value = unknown> {
  readonly key: AttachmentKey<Value>;
  encode(value: Value): JsonValue;
  decode(value: JsonValue): Value;
}

export class AttachmentCodecRegistry {
  readonly #codecs = new Map<string, AttachmentCodec>();

  register<Value>(codec: AttachmentCodec<Value>): void {
    if (this.#codecs.has(codec.key)) {
      throw new Error(
        `attachment codec ${JSON.stringify(codec.key)} is already registered`,
      );
    }
    const encode = codec.encode.bind(codec);
    const decode = codec.decode.bind(codec);
    this.#codecs.set(
      codec.key,
      Object.freeze({
        key: codec.key,
        encode,
        decode,
      }) as AttachmentCodec,
    );
  }

  codec(key: string): AttachmentCodec | undefined {
    return this.#codecs.get(key);
  }
}

export interface SceneSerializationFailure {
  readonly type: "failed";
  readonly source: string;
  readonly field: string;
  readonly node?: string;
  readonly reason: string;
}

export type SceneSerializationResult =
  | { readonly type: "ready"; readonly source: string }
  | SceneSerializationFailure;

export type SceneDeserializationResult =
  | { readonly type: "ready"; readonly snapshot: SceneSnapshot }
  | SceneSerializationFailure;

export function serialize_scene(
  snapshot: SceneSnapshot,
  codecs: AttachmentCodecRegistry,
): SceneSerializationResult {
  try {
    const nodes = snapshot.nodes.map((node) => {
      const attachments: Record<string, JsonValue> = {};
      for (
        const [key, value] of [...node.attachments].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ) {
        const codec = codecs.codec(key);
        if (codec === undefined) {
          fail(
            "serialize",
            "attachments",
            scene_node_key(node.id),
            `attachment codec ${JSON.stringify(key)} is not registered`,
          );
        }
        try {
          attachments[key] = parse_json_value(
            codec.encode(value),
            `attachment ${JSON.stringify(key)}`,
          );
        } catch (error) {
          fail(
            "serialize",
            `attachments.${key}`,
            scene_node_key(node.id),
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return {
        id: [node.id.index, node.id.generation],
        ...(node.name === undefined ? {} : { name: node.name }),
        ...(node.parent === undefined
          ? {}
          : { parent: [node.parent.index, node.parent.generation] }),
        local_transform: {
          position: [
            node.local_transform.position.x,
            node.local_transform.position.y,
            node.local_transform.position.z,
          ],
          rotation: [
            node.local_transform.rotation.x,
            node.local_transform.rotation.y,
            node.local_transform.rotation.z,
            node.local_transform.rotation.w,
          ],
          scale: [
            node.local_transform.scale.x,
            node.local_transform.scale.y,
            node.local_transform.scale.z,
          ],
        },
        active: node.active,
        layers: node.layers,
        ...(node.local_bounds === undefined ? {} : {
          local_bounds: {
            minimum: [
              node.local_bounds.minimum.x,
              node.local_bounds.minimum.y,
              node.local_bounds.minimum.z,
            ],
            maximum: [
              node.local_bounds.maximum.x,
              node.local_bounds.maximum.y,
              node.local_bounds.maximum.z,
            ],
          },
        }),
        attachments,
        ...(node.instance === undefined ? {} : {
          instance: {
            id: node.instance.instance,
            source_scene: node.instance.source_scene,
            source_node: [
              node.instance.source_node.index,
              node.instance.source_node.generation,
            ],
            overrides: [...node.instance.overrides].sort(),
          },
        }),
      };
    });
    return {
      type: "ready",
      source: `${
        JSON.stringify(
          {
            version: 2,
            scene_id: snapshot.scene_id,
            revision: snapshot.revision,
            nodes,
          },
          null,
          2,
        )
      }\n`,
    };
  } catch (error) {
    if (is_failure(error)) return error;
    throw error;
  }
}

export function parse_scene(
  source_text: string,
  source: string,
  codecs: AttachmentCodecRegistry,
): SceneDeserializationResult {
  try {
    let value: unknown;
    try {
      value = JSON.parse(source_text);
    } catch (error) {
      fail(
        source,
        "$",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
    const root = record(value, "$", source);
    if (root.version !== 2) {
      fail(
        source,
        "$.version",
        undefined,
        `scene version ${
          JSON.stringify(root.version)
        } is not supported; expected 2`,
      );
    }
    const id = scene_id(string(root.scene_id, "$.scene_id", source));
    const revision = nonnegative_integer(root.revision, "$.revision", source);
    const nodes = array(root.nodes, "$.nodes", source).map((value, index) =>
      parse_node(value, `$.nodes[${index}]`, source, codecs)
    );
    const duplicate = duplicate_node(nodes);
    if (duplicate !== undefined) {
      fail(
        source,
        "$.nodes",
        duplicate,
        `scene node ${duplicate} appears more than once`,
      );
    }
    const instances = new Map<
      string,
      { readonly source_scene: string; readonly source_nodes: Set<string> }
    >();
    for (const node of nodes) {
      if (node.instance === undefined) continue;
      if (node.instance.source_scene === id) {
        fail(
          source,
          "$.nodes",
          scene_node_key(node.id),
          `scene ${id} contains an instance of itself`,
        );
      }
      const instance = instances.get(node.instance.instance);
      const source_node = scene_node_key(node.instance.source_node);
      if (instance === undefined) {
        instances.set(node.instance.instance, {
          source_scene: node.instance.source_scene,
          source_nodes: new Set([source_node]),
        });
        continue;
      }
      if (instance.source_scene !== node.instance.source_scene) {
        fail(
          source,
          "$.nodes",
          scene_node_key(node.id),
          `scene instance ${node.instance.instance} mixes source scenes ${instance.source_scene} and ${node.instance.source_scene}`,
        );
      }
      if (instance.source_nodes.has(source_node)) {
        fail(
          source,
          "$.nodes",
          scene_node_key(node.id),
          `scene instance ${node.instance.instance} repeats source node ${source_node}`,
        );
      }
      instance.source_nodes.add(source_node);
    }
    const resolved = resolve_scene_snapshot(id, revision, nodes);
    if (resolved.type === "invalid_hierarchy") {
      fail(
        source,
        "$.nodes",
        resolved.path[0] === undefined
          ? undefined
          : scene_node_key(resolved.path[0]),
        resolved.reason,
      );
    }
    return { type: "ready", snapshot: resolved.snapshot };
  } catch (error) {
    if (is_failure(error)) return error;
    return {
      type: "failed",
      source,
      field: "$",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function asset_reference_codec<Kind extends string>(
  key: AttachmentKey<AssetRef<Kind>>,
  kind: Kind,
): AttachmentCodec<AssetRef<Kind>> {
  return {
    key,
    encode(value) {
      if (value.kind !== kind) {
        throw new Error(
          `asset reference kind ${
            JSON.stringify(value.kind)
          } does not match codec kind ${JSON.stringify(kind)}`,
        );
      }
      return { id: value.id, kind: value.kind };
    },
    decode(value) {
      const parsed = record(value, "asset reference", "attachment");
      const parsed_kind = string(
        parsed.kind,
        "asset reference.kind",
        "attachment",
      );
      if (parsed_kind !== kind) {
        throw new Error(
          `asset reference kind ${
            JSON.stringify(parsed_kind)
          } does not match codec kind ${JSON.stringify(kind)}`,
        );
      }
      return asset_ref(
        asset_id<Kind>(string(parsed.id, "asset reference.id", "attachment")),
        kind,
      );
    },
  };
}

export function asset_attachment_key<Kind extends string>(
  name: string,
): AttachmentKey<AssetRef<Kind>> {
  return attachment_key<AssetRef<Kind>>("ink.asset", name);
}

function parse_node(
  value: unknown,
  field: string,
  source: string,
  codecs: AttachmentCodecRegistry,
): SceneNodeSource {
  const node = record(value, field, source);
  const id = parse_node_id(node.id, `${field}.id`, source);
  const transform_record = record(
    node.local_transform,
    `${field}.local_transform`,
    source,
  );
  const position = vector(
    transform_record.position,
    3,
    `${field}.local_transform.position`,
    source,
  );
  const rotation = vector(
    transform_record.rotation,
    4,
    `${field}.local_transform.rotation`,
    source,
  );
  const scale = vector(
    transform_record.scale,
    3,
    `${field}.local_transform.scale`,
    source,
  );
  if (typeof node.active !== "boolean") {
    fail(
      source,
      `${field}.active`,
      scene_node_key(id),
      `${field}.active must be a boolean`,
    );
  }
  const layers = nonnegative_integer(node.layers, `${field}.layers`, source);
  if (layers > 0xffff_ffff) {
    fail(
      source,
      `${field}.layers`,
      scene_node_key(id),
      `${field}.layers must be an unsigned 32-bit integer`,
    );
  }
  const attachments_record = record(
    node.attachments,
    `${field}.attachments`,
    source,
  );
  const attachments = new Map<string, unknown>();
  for (const key of Object.keys(attachments_record).sort()) {
    const codec = codecs.codec(key);
    if (codec === undefined) {
      fail(
        source,
        `${field}.attachments.${key}`,
        scene_node_key(id),
        `attachment codec ${JSON.stringify(key)} is not registered`,
      );
    }
    try {
      attachments.set(key, codec.decode(attachments_record[key] as JsonValue));
    } catch (error) {
      fail(
        source,
        `${field}.attachments.${key}`,
        scene_node_key(id),
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const local_bounds = node.local_bounds === undefined
    ? undefined
    : parse_bounds(node.local_bounds, `${field}.local_bounds`, source);
  const instance = node.instance === undefined
    ? undefined
    : parse_instance(node.instance, `${field}.instance`, source);
  return {
    id,
    ...(node.name === undefined
      ? {}
      : { name: string(node.name, `${field}.name`, source) }),
    ...(node.parent === undefined
      ? {}
      : { parent: parse_node_id(node.parent, `${field}.parent`, source) }),
    local_transform: transform(
      vec3(position[0], position[1], position[2]),
      quat(rotation[0], rotation[1], rotation[2], rotation[3]),
      vec3(scale[0], scale[1], scale[2]),
    ),
    active: node.active,
    layers,
    ...(local_bounds === undefined ? {} : { local_bounds }),
    attachments,
    ...(instance === undefined ? {} : { instance }),
  };
}

function parse_instance(
  value: unknown,
  field: string,
  source: string,
): SceneInstanceNodeSource {
  const instance = record(value, field, source);
  const overrides = array(instance.overrides, `${field}.overrides`, source).map(
    (value, index) =>
      parse_override(value, `${field}.overrides[${index}]`, source),
  );
  const unique = new Set(overrides);
  if (unique.size !== overrides.length) {
    fail(
      source,
      `${field}.overrides`,
      undefined,
      `${field}.overrides contains duplicates`,
    );
  }
  return {
    instance: scene_instance_id(string(instance.id, `${field}.id`, source)),
    source_scene: scene_id(
      string(instance.source_scene, `${field}.source_scene`, source),
    ),
    source_node: parse_node_id(
      instance.source_node,
      `${field}.source_node`,
      source,
    ),
    overrides: unique,
  };
}

function parse_override(
  value: unknown,
  field: string,
  source: string,
): SceneOverrideProperty {
  const parsed = string(value, field, source);
  if (
    parsed !== "name" && parsed !== "parent" &&
    parsed !== "local_transform" && parsed !== "active" &&
    parsed !== "layers" && parsed !== "local_bounds" &&
    !parsed.startsWith("attachment:")
  ) {
    fail(
      source,
      field,
      undefined,
      `${field} ${JSON.stringify(parsed)} is not a scene override`,
    );
  }
  if (parsed === "attachment:") {
    fail(source, field, undefined, `${field} attachment key cannot be empty`);
  }
  return parsed as SceneOverrideProperty;
}

function parse_bounds(value: unknown, field: string, source: string) {
  const bounds = record(value, field, source);
  const minimum = vector(bounds.minimum, 3, `${field}.minimum`, source);
  const maximum = vector(bounds.maximum, 3, `${field}.maximum`, source);
  return aabb(
    vec3(minimum[0], minimum[1], minimum[2]),
    vec3(maximum[0], maximum[1], maximum[2]),
  );
}

function parse_node_id(value: unknown, field: string, source: string) {
  const parts = array(value, field, source);
  if (parts.length !== 2) {
    fail(
      source,
      field,
      undefined,
      `${field} must contain index and generation`,
    );
  }
  return scene_node_id(
    nonnegative_integer(parts[0], `${field}[0]`, source),
    nonnegative_integer(parts[1], `${field}[1]`, source),
  );
}

function vector(
  value: unknown,
  length: number,
  field: string,
  source: string,
): readonly number[] {
  const values = array(value, field, source);
  if (values.length !== length) {
    fail(source, field, undefined, `${field} must contain ${length} numbers`);
  }
  return values.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      fail(
        source,
        `${field}[${index}]`,
        undefined,
        `${field}[${index}] must be finite`,
      );
    }
    return entry;
  });
}

function record(
  value: unknown,
  field: string,
  source: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(source, field, undefined, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(
  value: unknown,
  field: string,
  source: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(source, field, undefined, `${field} must be an array`);
  }
  return value;
}

function string(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(source, field, undefined, `${field} must be a nonempty string`);
  }
  return value.trim();
}

function nonnegative_integer(
  value: unknown,
  field: string,
  source: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(
      source,
      field,
      undefined,
      `${field} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value as number;
}

function parse_json_value(
  value: unknown,
  path: string,
  depth = 0,
): JsonValue {
  if (depth > 64) throw new Error(`${path} exceeds 64 nested levels`);
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} number ${String(value)} must be finite`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parse_json_value(entry, `${path}[${index}]`, depth + 1)
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`${path} contains unsupported ${typeof value} value`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      parse_json_value(entry, `${path}.${key}`, depth + 1),
    ]),
  );
}

function duplicate_node(nodes: readonly SceneNodeSource[]): string | undefined {
  const seen = new Set<string>();
  for (const node of nodes) {
    const key = scene_node_key(node.id);
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return undefined;
}

function fail(
  source: string,
  field: string,
  node: string | undefined,
  reason: string,
): never {
  throw {
    type: "failed",
    source,
    field,
    ...(node === undefined ? {} : { node }),
    reason,
  } satisfies SceneSerializationFailure;
}

function is_failure(value: unknown): value is SceneSerializationFailure {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "failed" && typeof record.source === "string" &&
    typeof record.field === "string" && typeof record.reason === "string";
}

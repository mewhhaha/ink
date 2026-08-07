declare const scene_id_brand: unique symbol;
declare const scene_instance_id_brand: unique symbol;
declare const scene_node_id_brand: unique symbol;
declare const attachment_key_brand: unique symbol;

export type SceneId = string & { readonly [scene_id_brand]: true };
export type SceneInstanceId = string & {
  readonly [scene_instance_id_brand]: true;
};

export interface SceneNodeId {
  readonly index: number;
  readonly generation: number;
  readonly [scene_node_id_brand]: true;
}

export type AttachmentKey<Value = unknown> = string & {
  readonly [attachment_key_brand]: Value;
};

export function scene_id(value: string): SceneId {
  const parsed = value.trim();
  if (parsed.length === 0) {
    throw new Error(`scene id ${JSON.stringify(value)} cannot be empty`);
  }
  return parsed as SceneId;
}

export function scene_instance_id(value: string): SceneInstanceId {
  const parsed = value.trim();
  if (parsed.length === 0 || !/^[a-zA-Z0-9_.:/-]+$/.test(parsed)) {
    throw new Error(
      `scene instance id ${JSON.stringify(value)} must be nonempty and stable`,
    );
  }
  return parsed as SceneInstanceId;
}

export function scene_node_id(index: number, generation: number): SceneNodeId {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(
      `scene node index ${
        JSON.stringify(index)
      } must be a nonnegative safe integer`,
    );
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(
      `scene node generation ${
        JSON.stringify(generation)
      } must be a nonnegative safe integer`,
    );
  }
  return Object.freeze({ index, generation }) as SceneNodeId;
}

export function scene_node_key(id: SceneNodeId): string {
  return `${id.index}:${id.generation}`;
}

export function scene_node_equal(
  left: SceneNodeId,
  right: SceneNodeId,
): boolean {
  return left.index === right.index && left.generation === right.generation;
}

export function attachment_key<Value>(
  namespace: string,
  name: string,
): AttachmentKey<Value> {
  const parsed_namespace = parse_segment(namespace, "attachment namespace");
  const parsed_name = parse_segment(name, "attachment name");
  return `${parsed_namespace}:${parsed_name}` as AttachmentKey<Value>;
}

function parse_segment(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0 || parsed.includes(":")) {
    throw new Error(
      `${label} ${
        JSON.stringify(value)
      } must be nonempty and cannot contain ':'`,
    );
  }
  return parsed;
}

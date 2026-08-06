export type SnapshotValue =
  | null
  | boolean
  | number
  | string
  | readonly SnapshotValue[]
  | { readonly [key: string]: SnapshotValue };

export type DecodeResult<value> =
  | { readonly type: "decoded"; readonly value: value }
  | { readonly type: "invalid"; readonly reason: string };

export interface SchemaCodec<value> {
  encode(value: value): SnapshotValue;
  decode(encoded_value: SnapshotValue): DecodeResult<value>;
}

export interface Component<value> {
  readonly type: "component";
  readonly id: string;
  readonly version: number;
  readonly codec: SchemaCodec<value>;
}

export interface Resource<value> {
  readonly type: "resource";
  readonly id: string;
  readonly version: number;
  readonly codec: SchemaCodec<value>;
}

export interface SchemaDefinition<value> {
  readonly id: string;
  readonly version: number;
  readonly codec: SchemaCodec<value>;
}

export type AnyComponent = Component<unknown>;
export type AnyResource = Resource<unknown>;
export type AnySchema = AnyComponent | AnyResource;

export function define_component<value>(
  definition: SchemaDefinition<value>,
): Component<value> {
  return Object.freeze({
    type: "component" as const,
    id: parse_schema_id(definition.id, "component"),
    version: parse_schema_version(definition.version, definition.id),
    codec: definition.codec,
  });
}

export function define_resource<value>(
  definition: SchemaDefinition<value>,
): Resource<value> {
  return Object.freeze({
    type: "resource" as const,
    id: parse_schema_id(definition.id, "resource"),
    version: parse_schema_version(definition.version, definition.id),
    codec: definition.codec,
  });
}

export function schema_digest(
  components: readonly AnyComponent[],
  resources: readonly AnyResource[],
): string {
  return schema_entry_digest(
    components.map((component) => ({
      type: "component",
      id: component.id,
      version: component.version,
    })),
    resources.map((resource) => ({
      type: "resource",
      id: resource.id,
      version: resource.version,
    })),
  );
}

export function schema_entry_digest(
  components: readonly { readonly id: string; readonly version: number }[],
  resources: readonly { readonly id: string; readonly version: number }[],
): string {
  const descriptors = [
    ...components.map((component) =>
      `component:${component.id}:${component.version}`
    ),
    ...resources.map((resource) =>
      `resource:${resource.id}:${resource.version}`
    ),
  ].sort();
  let digest = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(descriptors.join("\n"))) {
    digest ^= BigInt(byte);
    digest = BigInt.asUintN(64, digest * 0x100000001b3n);
  }
  return digest.toString(16).padStart(16, "0");
}

export function clone_schema_value<value>(
  schema: Component<value> | Resource<value>,
  value: value,
): value {
  const encoded_value = schema.codec.encode(value);
  const decoded = schema.codec.decode(encoded_value);
  if (decoded.type === "invalid") {
    throw new Error(
      `${schema.type} ${
        JSON.stringify(schema.id)
      } codec rejected its own encoding: ${decoded.reason}`,
    );
  }
  return decoded.value;
}

export function parse_schema_set(
  components: readonly AnyComponent[],
  resources: readonly AnyResource[],
): void {
  const identities = new Set<string>();
  for (const schema of [...components, ...resources]) {
    const identity = `${schema.type}:${schema.id}`;
    if (identities.has(identity)) {
      throw new Error(`ECS schema contains duplicate ${identity}`);
    }
    identities.add(identity);
  }
}

function parse_schema_id(value: string, kind: string): string {
  const id = value.trim();
  if (id.length === 0) throw new Error(`ECS ${kind} id cannot be empty`);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(id)) {
    throw new Error(
      `ECS ${kind} id ${
        JSON.stringify(value)
      } must start with a letter and contain only letters, digits, dot, underscore, or hyphen`,
    );
  }
  return id;
}

function parse_schema_version(value: number, id: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `ECS schema ${JSON.stringify(id)} version ${
        JSON.stringify(value)
      } must be a positive safe integer`,
    );
  }
  return value;
}

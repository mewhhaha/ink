export type CapabilityAvailability = "required" | "optional";

declare const guest_id_brand: unique symbol;
declare const artifact_digest_brand: unique symbol;
declare const schema_digest_brand: unique symbol;

export type GuestId = string & { readonly [guest_id_brand]: "GuestId" };
export type ArtifactDigest = string & {
  readonly [artifact_digest_brand]: "ArtifactDigest";
};
export type SchemaDigest = string & {
  readonly [schema_digest_brand]: "SchemaDigest";
};

export interface CapabilityDeclaration {
  readonly id: string;
  readonly availability: CapabilityAvailability;
}

export interface GameArtifact {
  readonly guest_id: GuestId;
  readonly artifact_digest: ArtifactDigest;
  readonly schema_digest: SchemaDigest;
  readonly wasm: Uint8Array;
  readonly capabilities: readonly CapabilityDeclaration[];
}

export function parse_game_artifact(input: unknown): GameArtifact {
  if (!is_record(input)) {
    throw new Error(`game artifact ${describe(input)} must be an object`);
  }
  const parsed_guest_id = guest_id(input.guest_id);
  const parsed_artifact_digest = artifact_digest(
    input.artifact_digest,
    `game artifact ${JSON.stringify(parsed_guest_id)} artifact digest`,
  );
  const parsed_schema_digest = schema_digest(
    input.schema_digest,
    `game artifact ${JSON.stringify(parsed_guest_id)} schema digest`,
  );
  if (!(input.wasm instanceof Uint8Array) || input.wasm.length === 0) {
    throw new Error(
      `game artifact ${
        JSON.stringify(parsed_guest_id)
      } Wasm must be a nonempty Uint8Array; received ${describe(input.wasm)}`,
    );
  }
  if (!Array.isArray(input.capabilities)) {
    throw new Error(
      `game artifact ${
        JSON.stringify(parsed_guest_id)
      } capabilities must be an array; received ${
        describe(input.capabilities)
      }`,
    );
  }
  const capability_ids = new Set<string>();
  const capabilities = input.capabilities.map((capability, index) => {
    if (!is_record(capability)) {
      throw new Error(
        `game artifact ${
          JSON.stringify(parsed_guest_id)
        } capability ${index} must be an object; received ${
          describe(capability)
        }`,
      );
    }
    const id = parse_identity(
      capability.id,
      `game artifact ${JSON.stringify(parsed_guest_id)} capability ${index} id`,
    );
    if (capability_ids.has(id)) {
      throw new Error(
        `game artifact ${JSON.stringify(parsed_guest_id)} declares capability ${
          JSON.stringify(id)
        } more than once`,
      );
    }
    if (
      capability.availability !== "required" &&
      capability.availability !== "optional"
    ) {
      throw new Error(
        `game artifact ${JSON.stringify(parsed_guest_id)} capability ${
          JSON.stringify(id)
        } availability ${
          describe(capability.availability)
        } must be "required" or "optional"`,
      );
    }
    capability_ids.add(id);
    return Object.freeze({ id, availability: capability.availability });
  });
  return Object.freeze({
    guest_id: parsed_guest_id,
    artifact_digest: parsed_artifact_digest,
    schema_digest: parsed_schema_digest,
    wasm: input.wasm.slice(),
    capabilities: Object.freeze(capabilities),
  });
}

export function guest_id(value: unknown): GuestId {
  return parse_identity(value, "game artifact guest id") as GuestId;
}

export function artifact_digest(
  value: unknown,
  label = "game artifact digest",
): ArtifactDigest {
  return parse_identity(value, label) as ArtifactDigest;
}

export function schema_digest(
  value: unknown,
  label = "game schema digest",
): SchemaDigest {
  return parse_identity(value, label) as SchemaDigest;
}

export function parse_identity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} ${describe(value)} must be a nonempty string`);
  }
  return value.trim();
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  return JSON.stringify(value) ?? String(value);
}

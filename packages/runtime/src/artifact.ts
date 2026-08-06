export type CapabilityAvailability = "required" | "optional";

export interface CapabilityDeclaration {
  readonly id: string;
  readonly availability: CapabilityAvailability;
}

export interface GameArtifact {
  readonly guest_id: string;
  readonly artifact_digest: string;
  readonly schema_digest: string;
  readonly wasm: Uint8Array;
  readonly capabilities: readonly CapabilityDeclaration[];
}

export function parse_game_artifact(input: unknown): GameArtifact {
  if (!is_record(input)) {
    throw new Error(`game artifact ${describe(input)} must be an object`);
  }
  const guest_id = parse_identity(input.guest_id, "game artifact guest id");
  const artifact_digest = parse_identity(
    input.artifact_digest,
    `game artifact ${JSON.stringify(guest_id)} artifact digest`,
  );
  const schema_digest = parse_identity(
    input.schema_digest,
    `game artifact ${JSON.stringify(guest_id)} schema digest`,
  );
  if (!(input.wasm instanceof Uint8Array) || input.wasm.length === 0) {
    throw new Error(
      `game artifact ${
        JSON.stringify(guest_id)
      } Wasm must be a nonempty Uint8Array; received ${describe(input.wasm)}`,
    );
  }
  if (!Array.isArray(input.capabilities)) {
    throw new Error(
      `game artifact ${
        JSON.stringify(guest_id)
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
          JSON.stringify(guest_id)
        } capability ${index} must be an object; received ${
          describe(capability)
        }`,
      );
    }
    const id = parse_identity(
      capability.id,
      `game artifact ${JSON.stringify(guest_id)} capability ${index} id`,
    );
    if (capability_ids.has(id)) {
      throw new Error(
        `game artifact ${JSON.stringify(guest_id)} declares capability ${
          JSON.stringify(id)
        } more than once`,
      );
    }
    if (
      capability.availability !== "required" &&
      capability.availability !== "optional"
    ) {
      throw new Error(
        `game artifact ${JSON.stringify(guest_id)} capability ${
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
    guest_id,
    artifact_digest,
    schema_digest,
    wasm: input.wasm.slice(),
    capabilities: Object.freeze(capabilities),
  });
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

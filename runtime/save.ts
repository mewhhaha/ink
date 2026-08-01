import { canonical_json, digest_text } from "./digest.ts";
import type { GameSave } from "./protocol.ts";

interface SaveContext {
  readonly artifact_digest: string;
  readonly schema_digest: string;
}

export async function create_game_save(
  state: bigint,
  random_state: bigint,
  context: SaveContext,
): Promise<GameSave> {
  const unsigned = {
    format: "ink-save" as const,
    version: 1 as const,
    game: "scene_explorer" as const,
    artifact_digest: context.artifact_digest,
    schema_digest: context.schema_digest,
    state: state.toString(),
    random_state: random_state.toString(),
  };
  return { ...unsigned, checksum: await digest_text(canonical_json(unsigned)) };
}

export async function parse_game_save(
  source: string,
  context: SaveContext,
): Promise<
  {
    readonly save: GameSave;
    readonly state: bigint;
    readonly random_state: bigint;
  }
> {
  const parsed: unknown = JSON.parse(source);
  if (!is_record(parsed)) throw new Error("save must be a JSON object");

  const expected_keys = [
    "artifact_digest",
    "checksum",
    "format",
    "game",
    "random_state",
    "schema_digest",
    "state",
    "version",
  ];
  const actual_keys = Object.keys(parsed).sort();
  if (actual_keys.join("\n") !== expected_keys.join("\n")) {
    throw new Error(`save fields are ${JSON.stringify(actual_keys)}`);
  }
  if (
    parsed.format !== "ink-save" || parsed.version !== 1 ||
    parsed.game !== "scene_explorer"
  ) {
    throw new Error(
      "save identity is not ink-save version 1 for scene_explorer",
    );
  }
  if (parsed.artifact_digest !== context.artifact_digest) {
    throw new Error(
      `save artifact digest ${
        JSON.stringify(parsed.artifact_digest)
      } does not match the loaded game`,
    );
  }
  if (parsed.schema_digest !== context.schema_digest) {
    throw new Error(
      `save schema digest ${
        JSON.stringify(parsed.schema_digest)
      } does not match the loaded game`,
    );
  }
  if (
    !is_decimal(parsed.state) || !is_decimal(parsed.random_state) ||
    typeof parsed.checksum !== "string"
  ) {
    throw new Error(
      "save state, random_state, and checksum have invalid representations",
    );
  }

  const { checksum: _checksum, ...unsigned } = parsed;
  const expected_checksum = await digest_text(canonical_json(unsigned));
  if (parsed.checksum !== expected_checksum) {
    throw new Error(
      `save checksum ${
        JSON.stringify(parsed.checksum)
      } does not match its contents`,
    );
  }

  return {
    save: parsed as unknown as GameSave,
    state: parse_i64(parsed.state, "state"),
    random_state: parse_i64(parsed.random_state, "random_state"),
  };
}

export function serialize_game_save(save: GameSave): string {
  return canonical_json(save);
}

function parse_i64(value: string, field: string): bigint {
  const integer = BigInt(value);
  if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) {
    throw new Error(`save ${field} ${value} is outside signed 64-bit range`);
  }
  return integer;
}

function is_decimal(value: unknown): value is string {
  return typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { canonical_json, digest_text } from "./digest.ts";
import type { GameState } from "./guest.ts";
import type { GameSave } from "./protocol.ts";

interface SaveContext {
  readonly game_id: string;
  readonly artifact_digest: string;
  readonly schema_digest: string;
}

export async function create_game_save(
  state: GameState,
  random_state: bigint,
  context: SaveContext,
): Promise<GameSave> {
  const unsigned = {
    format: "ink-save" as const,
    version: 1 as const,
    game: context.game_id,
    artifact_digest: context.artifact_digest,
    schema_digest: context.schema_digest,
    state: serialize_game_state(state),
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
    readonly state: GameState;
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
    parsed.game !== context.game_id
  ) {
    throw new Error(
      `save identity is not ink-save version 1 for ${context.game_id}`,
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
    typeof parsed.state !== "string" || !is_decimal(parsed.random_state) ||
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
    state: parse_game_state(parsed.state),
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

function serialize_game_state(state: GameState): string {
  return canonical_json({
    scalar: state.scalar.toString(),
    cells: state.cells.map((cell) => cell.toString()),
  });
}

function parse_game_state(source: string): GameState {
  const parsed: unknown = JSON.parse(source);
  if (!is_record(parsed)) throw new Error("save game state must be an object");
  const keys = Object.keys(parsed).sort();
  if (keys.join("\n") !== "cells\nscalar") {
    throw new Error(`save game state fields are ${JSON.stringify(keys)}`);
  }
  if (!is_decimal(parsed.scalar) || !Array.isArray(parsed.cells)) {
    throw new Error("save game state scalar and cells are invalid");
  }
  if (parsed.cells.length > 262_144 || !parsed.cells.every(is_decimal)) {
    throw new Error("save game state cells are invalid");
  }
  return {
    scalar: parse_i64(parsed.scalar, "state scalar"),
    cells: parsed.cells.map((cell, index) =>
      parse_i64(cell, `state cell ${index}`)
    ),
  };
}

function is_decimal(value: unknown): value is string {
  return typeof value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

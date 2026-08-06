import type { GameArtifact } from "./artifact.ts";
import { parse_identity } from "./artifact.ts";
import {
  type ChannelSnapshot,
  DeterministicChannels,
  DeterministicRandomStreams,
  type RandomStreamSnapshot,
} from "./determinism.ts";
import { canonical_json, digest_json, type JsonValue } from "./digest.ts";

const maximum_snapshot_source_bytes = 32 * 1024 * 1024;
const maximum_payload_bytes = 16 * 1024 * 1024;
const maximum_channels = 256;
const maximum_random_streams = 1024;

export interface RuntimeSnapshot {
  readonly format: "ink-runtime-snapshot";
  readonly version: 1;
  readonly guest: string;
  readonly artifact_digest: string;
  readonly schema_digest: string;
  readonly sequence: number;
  readonly guest_state: string;
  readonly random_streams: readonly RandomStreamSnapshot[];
  readonly channels: readonly EncodedChannelSnapshot[];
  readonly checksum: string;
}

export interface EncodedChannelSnapshot {
  readonly id: string;
  readonly payload: string;
}

export interface SnapshotGuest {
  snapshot(): Uint8Array | Promise<Uint8Array>;
  restore(payload: Uint8Array): void | Promise<void>;
}

export async function capture_runtime_snapshot(
  artifact: GameArtifact,
  sequence: number,
  guest: SnapshotGuest,
  random: DeterministicRandomStreams,
  channels: DeterministicChannels,
): Promise<RuntimeSnapshot> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(
      `runtime snapshot sequence ${
        JSON.stringify(sequence)
      } must be a nonnegative safe integer`,
    );
  }
  const [guest_state, channel_snapshots] = await Promise.all([
    guest.snapshot(),
    channels.snapshot(),
  ]);
  if (!(guest_state instanceof Uint8Array)) {
    throw new Error(
      `guest ${
        JSON.stringify(artifact.guest_id)
      } snapshot must be a Uint8Array`,
    );
  }
  assert_payload_size(guest_state, "guest state");
  const unsigned = {
    format: "ink-runtime-snapshot" as const,
    version: 1 as const,
    guest: artifact.guest_id,
    artifact_digest: artifact.artifact_digest,
    schema_digest: artifact.schema_digest,
    sequence,
    guest_state: encode_base64(guest_state),
    random_streams: random.snapshot(),
    channels: channel_snapshots.map(({ id, payload }) => {
      assert_payload_size(payload, `channel ${JSON.stringify(id)}`);
      return { id, payload: encode_base64(payload) };
    }),
  };
  return Object.freeze({
    ...unsigned,
    checksum: await digest_json(unsigned as unknown as JsonValue),
  });
}

export function serialize_runtime_snapshot(snapshot: RuntimeSnapshot): string {
  return canonical_json(snapshot as unknown as JsonValue);
}

export function runtime_snapshot_guest_state(
  snapshot: RuntimeSnapshot,
): Uint8Array {
  return parse_base64(snapshot.guest_state, "runtime snapshot guest state");
}

export function runtime_snapshot_channels(
  snapshot: RuntimeSnapshot,
): readonly ChannelSnapshot[] {
  return decode_channels(snapshot.channels);
}

export async function parse_runtime_snapshot(
  source: string,
  artifact: GameArtifact,
): Promise<RuntimeSnapshot> {
  if (new TextEncoder().encode(source).length > maximum_snapshot_source_bytes) {
    throw new Error(
      `runtime snapshot source exceeds ${maximum_snapshot_source_bytes} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error("runtime snapshot is not valid JSON", { cause });
  }
  if (!is_record(parsed)) throw new Error("runtime snapshot must be an object");
  expect_fields(parsed, [
    "artifact_digest",
    "channels",
    "checksum",
    "format",
    "guest",
    "guest_state",
    "random_streams",
    "schema_digest",
    "sequence",
    "version",
  ], "runtime snapshot");
  if (parsed.format !== "ink-runtime-snapshot" || parsed.version !== 1) {
    throw new Error(
      `runtime snapshot identity ${JSON.stringify(parsed.format)} version ${
        JSON.stringify(parsed.version)
      } is unsupported`,
    );
  }
  if (parsed.guest !== artifact.guest_id) {
    throw new Error(
      `runtime snapshot guest ${JSON.stringify(parsed.guest)} does not match ${
        JSON.stringify(artifact.guest_id)
      }`,
    );
  }
  if (parsed.artifact_digest !== artifact.artifact_digest) {
    throw new Error(
      `runtime snapshot artifact digest ${
        JSON.stringify(parsed.artifact_digest)
      } does not match ${JSON.stringify(artifact.artifact_digest)}`,
    );
  }
  if (parsed.schema_digest !== artifact.schema_digest) {
    throw new Error(
      `runtime snapshot schema digest ${
        JSON.stringify(parsed.schema_digest)
      } does not match ${JSON.stringify(artifact.schema_digest)}`,
    );
  }
  if (
    !Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 0
  ) {
    throw new Error(
      `runtime snapshot sequence ${
        JSON.stringify(parsed.sequence)
      } must be a nonnegative safe integer`,
    );
  }
  const guest_state = parse_base64(
    parsed.guest_state,
    "runtime snapshot guest state",
  );
  assert_payload_size(guest_state, "guest state");
  const random_streams = parse_random_streams(parsed.random_streams);
  const channels = parse_channels(parsed.channels);
  if (
    typeof parsed.checksum !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.checksum)
  ) {
    throw new Error(
      `runtime snapshot checksum ${
        JSON.stringify(parsed.checksum)
      } must be a lowercase SHA-256 digest`,
    );
  }
  const { checksum: _checksum, ...unsigned } = parsed;
  const expected_checksum = await digest_json(unsigned as JsonValue);
  if (parsed.checksum !== expected_checksum) {
    throw new Error(
      `runtime snapshot checksum ${
        JSON.stringify(parsed.checksum)
      } does not match ${JSON.stringify(expected_checksum)}`,
    );
  }
  return Object.freeze({
    format: "ink-runtime-snapshot",
    version: 1,
    guest: artifact.guest_id,
    artifact_digest: artifact.artifact_digest,
    schema_digest: artifact.schema_digest,
    sequence: parsed.sequence as number,
    guest_state: encode_base64(guest_state),
    random_streams,
    channels,
    checksum: parsed.checksum,
  });
}

export async function restore_runtime_snapshot(
  snapshot: RuntimeSnapshot,
  guest: SnapshotGuest,
  random: DeterministicRandomStreams,
  channels: DeterministicChannels,
): Promise<void> {
  const [previous_guest_state, previous_channels] = await Promise.all([
    guest.snapshot(),
    channels.snapshot(),
  ]);
  const previous_random = random.snapshot();
  try {
    await guest.restore(parse_base64(snapshot.guest_state, "guest state"));
    await channels.restore(decode_channels(snapshot.channels));
    random.restore(snapshot.random_streams);
  } catch (error) {
    const rollback_failures: unknown[] = [];
    try {
      await guest.restore(previous_guest_state);
    } catch (rollback_error) {
      rollback_failures.push(rollback_error);
    }
    try {
      await channels.restore(previous_channels);
    } catch (rollback_error) {
      rollback_failures.push(rollback_error);
    }
    try {
      random.restore(previous_random);
    } catch (rollback_error) {
      rollback_failures.push(rollback_error);
    }
    if (rollback_failures.length > 0) {
      throw new AggregateError(
        [error, ...rollback_failures],
        "runtime snapshot restore failed and rollback was incomplete",
      );
    }
    throw error;
  }
}

function parse_random_streams(value: unknown): readonly RandomStreamSnapshot[] {
  if (!Array.isArray(value) || value.length > maximum_random_streams) {
    throw new Error(
      `runtime snapshot random_streams must be an array of at most ${maximum_random_streams} entries`,
    );
  }
  const streams = value.map((entry, index) => {
    if (!is_record(entry)) {
      throw new Error(
        `runtime snapshot random stream ${index} must be an object`,
      );
    }
    expect_fields(
      entry,
      ["id", "state"],
      `runtime snapshot random stream ${index}`,
    );
    if (typeof entry.state !== "string") {
      throw new Error(
        `runtime snapshot random stream ${index} state ${
          JSON.stringify(entry.state)
        } must be a string`,
      );
    }
    return {
      id: parse_identity(
        entry.id,
        `runtime snapshot random stream ${index} id`,
      ),
      state: entry.state,
    };
  });
  const validator = new DeterministicRandomStreams(0n);
  validator.restore(streams);
  return Object.freeze(streams);
}

function parse_channels(value: unknown): readonly EncodedChannelSnapshot[] {
  if (!Array.isArray(value) || value.length > maximum_channels) {
    throw new Error(
      `runtime snapshot channels must be an array of at most ${maximum_channels} entries`,
    );
  }
  const identities = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    if (!is_record(entry)) {
      throw new Error(`runtime snapshot channel ${index} must be an object`);
    }
    expect_fields(
      entry,
      ["id", "payload"],
      `runtime snapshot channel ${index}`,
    );
    const id = parse_identity(entry.id, `runtime snapshot channel ${index} id`);
    if (identities.has(id)) {
      throw new Error(
        `runtime snapshot duplicates channel ${JSON.stringify(id)}`,
      );
    }
    identities.add(id);
    const payload = parse_base64(
      entry.payload,
      `runtime snapshot channel ${JSON.stringify(id)}`,
    );
    assert_payload_size(payload, `channel ${JSON.stringify(id)}`);
    return { id, payload: encode_base64(payload) };
  }));
}

function decode_channels(
  channels: readonly EncodedChannelSnapshot[],
): readonly ChannelSnapshot[] {
  return channels.map(({ id, payload }) => ({
    id,
    payload: parse_base64(payload, `channel ${JSON.stringify(id)}`),
  }));
}

function encode_base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function parse_base64(value: unknown, label: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be canonical base64`,
    );
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assert_payload_size(payload: Uint8Array, label: string): void {
  if (payload.length > maximum_payload_bytes) {
    throw new Error(
      `runtime snapshot ${label} has ${payload.length} bytes; maximum is ${maximum_payload_bytes}`,
    );
  }
}

function expect_fields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  if (actual.join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(`${label} fields are ${JSON.stringify(actual)}`);
  }
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

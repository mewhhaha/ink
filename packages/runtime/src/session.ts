import { Observer } from "@ink/observability/observer.ts";
import type { GameArtifact } from "./artifact.ts";
import {
  type DeterministicChannel,
  DeterministicChannels,
  DeterministicRandomStreams,
} from "./determinism.ts";
import { canonical_json, digest_json, type JsonValue } from "./digest.ts";
import {
  capture_runtime_snapshot,
  parse_runtime_snapshot,
  restore_runtime_snapshot,
  runtime_snapshot_channels,
  runtime_snapshot_guest_state,
  type RuntimeSnapshot,
  serialize_runtime_snapshot,
} from "./snapshot.ts";

export interface RuntimeExecutionContext {
  readonly sequence: number;
  readonly delta_seconds: number;
  readonly random: DeterministicRandomStreams;
}

export interface RuntimeGuest<input, observation> {
  readonly artifact: GameArtifact;
  reset(context: RuntimeExecutionContext): observation | Promise<observation>;
  step(
    input: input,
    context: RuntimeExecutionContext,
  ): observation | Promise<observation>;
  describe(): observation | Promise<observation>;
  snapshot(): Uint8Array | Promise<Uint8Array>;
  restore(payload: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface RuntimeCodec<input, observation> {
  encode_input(input: input): JsonValue;
  decode_input(value: JsonValue): input;
  encode_observation(observation: observation): JsonValue;
}

export interface RuntimeReplayStep {
  readonly sequence: number;
  readonly delta_seconds: number;
  readonly input: JsonValue;
  readonly snapshot_checksum: string;
  readonly observation_digest: string;
}

export interface RuntimeReplay {
  readonly format: "ink-runtime-replay";
  readonly version: 1;
  readonly guest: string;
  readonly artifact_digest: string;
  readonly initial_snapshot: RuntimeSnapshot;
  readonly steps: readonly RuntimeReplayStep[];
  readonly checksum: string;
}

export type RuntimeTraceEvent =
  | { readonly type: "initialized"; readonly sequence: 0 }
  | { readonly type: "reset"; readonly sequence: 0 }
  | { readonly type: "step"; readonly sequence: number }
  | {
    readonly type: "saved";
    readonly sequence: number;
    readonly checksum: string;
  }
  | { readonly type: "loaded"; readonly sequence: number }
  | {
    readonly type: "reloaded";
    readonly sequence: number;
    readonly preserved: boolean;
    readonly artifact_digest: string;
  }
  | { readonly type: "replay_diverged"; readonly sequence: number }
  | { readonly type: "closed"; readonly sequence: number };

export interface ReloadResult<observation> {
  readonly observation: observation;
  readonly preserved: boolean;
}

export interface RuntimeSession<input, observation> {
  describe(): Promise<observation>;
  reset(): Promise<observation>;
  step(input: input, delta_seconds: number): Promise<observation>;
  save(): Promise<string>;
  load(source: string): Promise<observation>;
  finish_replay(): Promise<RuntimeReplay>;
  replay(replay: unknown): Promise<observation>;
  reload(
    guest: RuntimeGuest<input, observation>,
  ): Promise<ReloadResult<observation>>;
  trace(): readonly RuntimeTraceEvent[];
  close(): Promise<void>;
}

export interface RuntimeSessionOptions<input, observation> {
  readonly guest: RuntimeGuest<input, observation>;
  readonly codec: RuntimeCodec<input, observation>;
  readonly observer: Observer;
  readonly random_seed?: bigint;
  readonly channels?: readonly DeterministicChannel[];
}

export async function create_runtime_session<input, observation>(
  options: RuntimeSessionOptions<input, observation>,
): Promise<RuntimeSession<input, observation>> {
  const session = new RuntimeSessionImplementation(options);
  await session.initialize();
  return session;
}

class RuntimeSessionImplementation<input, observation>
  implements RuntimeSession<input, observation> {
  #guest: RuntimeGuest<input, observation>;
  readonly #codec: RuntimeCodec<input, observation>;
  readonly #observer: Observer;
  readonly #channels: DeterministicChannels;
  readonly #random_seed: bigint;
  #random: DeterministicRandomStreams;
  #sequence = 0;
  #initial_snapshot: RuntimeSnapshot | undefined;
  #reset_channels: ReturnType<typeof runtime_snapshot_channels> | undefined;
  #replay_steps: RuntimeReplayStep[] = [];
  #trace_events: RuntimeTraceEvent[] = [];
  #operation_queue: Promise<void> = Promise.resolve();
  #closed = false;
  #close_operation: Promise<void> | undefined;

  constructor(options: RuntimeSessionOptions<input, observation>) {
    this.#guest = options.guest;
    this.#codec = options.codec;
    this.#observer = options.observer;
    this.#channels = new DeterministicChannels(options.channels ?? []);
    this.#random_seed = options.random_seed ?? 0n;
    this.#random = new DeterministicRandomStreams(this.#random_seed);
  }

  async initialize(): Promise<void> {
    try {
      await this.#guest.reset(this.#context(0, 0));
      this.#initial_snapshot = await this.#capture();
      this.#reset_channels = runtime_snapshot_channels(this.#initial_snapshot);
      this.#trace_events.push({ type: "initialized", sequence: 0 });
      this.#observer.event("runtime.session.initialized", this.#evidence());
    } catch (error) {
      try {
        await this.#guest.close();
      } catch (cleanup_error) {
        throw new AggregateError(
          [error, cleanup_error],
          `guest ${
            JSON.stringify(this.#guest.artifact.guest_id)
          } initialization failed and cleanup also failed`,
        );
      }
      throw error;
    }
  }

  describe(): Promise<observation> {
    return this.#serialized(async () => {
      this.#require_open("describe");
      return await this.#guest.describe();
    });
  }

  reset(): Promise<observation> {
    return this.#serialized(async () => {
      this.#require_open("reset");
      const previous = await this.#capture();
      const reset_random = new DeterministicRandomStreams(this.#random_seed);
      try {
        await this.#channels.restore(this.#reset_channels!);
        const observation = await this.#guest.reset({
          sequence: 0,
          delta_seconds: 0,
          random: reset_random,
        });
        const snapshot = await capture_runtime_snapshot(
          this.#guest.artifact,
          0,
          this.#guest,
          reset_random,
          this.#channels,
        );
        this.#random = reset_random;
        this.#sequence = 0;
        this.#initial_snapshot = snapshot;
        this.#replay_steps = [];
        this.#trace_events.push({ type: "reset", sequence: 0 });
        this.#observer.event("runtime.session.reset", this.#evidence());
        return observation;
      } catch (error) {
        try {
          await restore_runtime_snapshot(
            previous,
            this.#guest,
            this.#random,
            this.#channels,
          );
        } catch (rollback_error) {
          throw new AggregateError(
            [error, rollback_error],
            `guest ${
              JSON.stringify(this.#guest.artifact.guest_id)
            } reset failed and rollback was incomplete`,
          );
        }
        throw error;
      }
    });
  }

  step(input: input, delta_seconds: number): Promise<observation> {
    return this.#serialized(() => this.#step_now(input, delta_seconds));
  }

  save(): Promise<string> {
    return this.#serialized(async () => {
      this.#require_open("save");
      const snapshot = await this.#capture();
      this.#trace_events.push({
        type: "saved",
        sequence: this.#sequence,
        checksum: snapshot.checksum,
      });
      return serialize_runtime_snapshot(snapshot);
    });
  }

  load(source: string): Promise<observation> {
    return this.#serialized(async () => {
      this.#require_open("load");
      const snapshot = await parse_runtime_snapshot(
        source,
        this.#guest.artifact,
      );
      const observation = await this.#restore_and_describe(snapshot);
      this.#sequence = snapshot.sequence;
      this.#initial_snapshot = snapshot;
      this.#replay_steps = [];
      this.#trace_events.push({ type: "loaded", sequence: this.#sequence });
      this.#observer.event("runtime.session.loaded", this.#evidence());
      return observation;
    });
  }

  finish_replay(): Promise<RuntimeReplay> {
    return this.#serialized(async () => {
      this.#require_open("finish replay");
      const unsigned = {
        format: "ink-runtime-replay" as const,
        version: 1 as const,
        guest: this.#guest.artifact.guest_id,
        artifact_digest: this.#guest.artifact.artifact_digest,
        initial_snapshot: this.#initial_snapshot!,
        steps: this.#replay_steps.slice(),
      };
      return Object.freeze({
        ...unsigned,
        checksum: await digest_json(unsigned as unknown as JsonValue),
      });
    });
  }

  replay(replay: unknown): Promise<observation> {
    return this.#serialized(async () => {
      this.#require_open("replay");
      const parsed = await parse_runtime_replay(replay, this.#guest.artifact);
      const previous = await this.#capture();
      const previous_initial = this.#initial_snapshot!;
      const previous_steps = this.#replay_steps;
      const previous_trace_length = this.#trace_events.length;
      let divergence_sequence: number | undefined;
      try {
        let observation = await this.#restore_and_describe(
          parsed.initial_snapshot,
        );
        this.#sequence = parsed.initial_snapshot.sequence;
        this.#initial_snapshot = parsed.initial_snapshot;
        this.#replay_steps = [];
        for (const expected of parsed.steps) {
          observation = await this.#step_now(
            this.#codec.decode_input(expected.input),
            expected.delta_seconds,
          );
          const actual = this.#replay_steps.at(-1)!;
          if (
            actual.snapshot_checksum !== expected.snapshot_checksum ||
            actual.observation_digest !== expected.observation_digest
          ) {
            divergence_sequence = expected.sequence;
            this.#trace_events.push({
              type: "replay_diverged",
              sequence: expected.sequence,
            });
            this.#observer.diagnostic(
              "error",
              "runtime.session.replay",
              "runtime replay diverged",
              {
                ...this.#evidence(),
                replay_sequence: expected.sequence,
                expected_snapshot: expected.snapshot_checksum,
                actual_snapshot: actual.snapshot_checksum,
              },
            );
            throw new Error(
              `guest ${
                JSON.stringify(this.#guest.artifact.guest_id)
              } replay diverged at sequence ${expected.sequence}; expected snapshot ${expected.snapshot_checksum} and observation ${expected.observation_digest}, received ${actual.snapshot_checksum} and ${actual.observation_digest}`,
            );
          }
        }
        return observation;
      } catch (error) {
        try {
          await restore_runtime_snapshot(
            previous,
            this.#guest,
            this.#random,
            this.#channels,
          );
        } catch (rollback_error) {
          throw new AggregateError(
            [error, rollback_error],
            `guest ${
              JSON.stringify(this.#guest.artifact.guest_id)
            } replay failed and rollback was incomplete`,
          );
        }
        this.#sequence = previous.sequence;
        this.#initial_snapshot = previous_initial;
        this.#replay_steps = previous_steps;
        this.#trace_events.splice(previous_trace_length);
        if (divergence_sequence !== undefined) {
          this.#trace_events.push({
            type: "replay_diverged",
            sequence: divergence_sequence,
          });
        }
        throw error;
      }
    });
  }

  reload(
    replacement: RuntimeGuest<input, observation>,
  ): Promise<ReloadResult<observation>> {
    return this.#serialized(async () => {
      this.#require_open("reload");
      const previous = await this.#capture();
      const preserved = replacement.artifact.guest_id ===
          this.#guest.artifact.guest_id &&
        replacement.artifact.schema_digest ===
          this.#guest.artifact.schema_digest;
      const replacement_random = preserved
        ? this.#random
        : new DeterministicRandomStreams(this.#random_seed);
      let observation: observation;
      let replacement_snapshot: RuntimeSnapshot;
      try {
        if (preserved) {
          await replacement.restore(runtime_snapshot_guest_state(previous));
          observation = await replacement.describe();
        } else {
          observation = await replacement.reset({
            sequence: 0,
            delta_seconds: 0,
            random: replacement_random,
          });
          await this.#channels.restore(
            this.#reset_channels!,
          );
        }
        replacement_snapshot = await capture_runtime_snapshot(
          replacement.artifact,
          preserved ? previous.sequence : 0,
          replacement,
          replacement_random,
          this.#channels,
        );
      } catch (error) {
        const rollback_failures: unknown[] = [];
        if (!preserved) {
          try {
            await this.#channels.restore(runtime_snapshot_channels(previous));
          } catch (rollback_error) {
            rollback_failures.push(rollback_error);
          }
        }
        try {
          await replacement.close();
        } catch (cleanup_error) {
          rollback_failures.push(cleanup_error);
        }
        if (rollback_failures.length > 0) {
          throw new AggregateError(
            [error, ...rollback_failures],
            `replacement guest ${
              JSON.stringify(replacement.artifact.guest_id)
            } failed and rollback or cleanup was incomplete`,
          );
        }
        this.#observer.diagnostic(
          "error",
          "runtime.session.reload",
          "replacement guest failed before activation",
          {
            ...this.#evidence(),
            replacement_artifact: replacement.artifact.artifact_digest,
            reason: error_reason(error),
          },
        );
        throw error;
      }

      const previous_guest = this.#guest;
      this.#guest = replacement;
      this.#random = replacement_random;
      this.#sequence = preserved ? previous.sequence : 0;
      this.#initial_snapshot = replacement_snapshot;
      if (!preserved) {
        this.#reset_channels = runtime_snapshot_channels(replacement_snapshot);
      }
      this.#replay_steps = [];
      this.#trace_events.push({
        type: "reloaded",
        sequence: this.#sequence,
        preserved,
        artifact_digest: replacement.artifact.artifact_digest,
      });
      this.#observer.event("runtime.session.reloaded", {
        ...this.#evidence(),
        preserved,
      });
      try {
        await previous_guest.close();
      } catch (error) {
        this.#observer.diagnostic(
          "warning",
          "runtime.session.reload.cleanup",
          "previous guest failed to close after replacement activation",
          { ...this.#evidence(), reason: error_reason(error) },
        );
      }
      return { observation, preserved };
    });
  }

  trace(): readonly RuntimeTraceEvent[] {
    this.#require_open("read trace");
    return this.#trace_events.slice();
  }

  close(): Promise<void> {
    if (this.#close_operation !== undefined) return this.#close_operation;
    this.#close_operation = this.#serialized(async () => {
      if (this.#closed) return;
      this.#closed = true;
      await this.#guest.close();
      this.#trace_events.push({ type: "closed", sequence: this.#sequence });
      this.#observer.event("runtime.session.closed", this.#evidence());
    });
    return this.#close_operation;
  }

  async #step_now(input: input, delta_seconds: number): Promise<observation> {
    this.#require_open("step");
    if (!Number.isFinite(delta_seconds) || delta_seconds < 0) {
      throw new Error(
        `guest ${JSON.stringify(this.#guest.artifact.guest_id)} step delta ${
          String(delta_seconds)
        } must be finite nonnegative seconds`,
      );
    }
    const next_sequence = this.#sequence + 1;
    if (!Number.isSafeInteger(next_sequence)) {
      throw new Error(
        `guest ${
          JSON.stringify(this.#guest.artifact.guest_id)
        } cannot advance runtime sequence ${this.#sequence}`,
      );
    }
    const previous = await this.#capture();
    try {
      const observation = await this.#guest.step(
        input,
        this.#context(next_sequence, delta_seconds),
      );
      const snapshot = await capture_runtime_snapshot(
        this.#guest.artifact,
        next_sequence,
        this.#guest,
        this.#random,
        this.#channels,
      );
      const replay_step = {
        sequence: next_sequence,
        delta_seconds,
        input: parse_json_value(
          this.#codec.encode_input(input),
          "runtime encoded input",
        ),
        snapshot_checksum: snapshot.checksum,
        observation_digest: await digest_json(
          parse_json_value(
            this.#codec.encode_observation(observation),
            "runtime encoded observation",
          ),
        ),
      };
      this.#sequence = next_sequence;
      this.#replay_steps.push(replay_step);
      this.#trace_events.push({ type: "step", sequence: next_sequence });
      return observation;
    } catch (error) {
      try {
        await restore_runtime_snapshot(
          previous,
          this.#guest,
          this.#random,
          this.#channels,
        );
      } catch (rollback_error) {
        throw new AggregateError(
          [error, rollback_error],
          `guest ${
            JSON.stringify(this.#guest.artifact.guest_id)
          } step ${next_sequence} failed and rollback was incomplete`,
        );
      }
      throw error;
    }
  }

  async #restore_and_describe(snapshot: RuntimeSnapshot): Promise<observation> {
    const previous = await this.#capture();
    try {
      await restore_runtime_snapshot(
        snapshot,
        this.#guest,
        this.#random,
        this.#channels,
      );
      return await this.#guest.describe();
    } catch (error) {
      try {
        await restore_runtime_snapshot(
          previous,
          this.#guest,
          this.#random,
          this.#channels,
        );
      } catch (rollback_error) {
        throw new AggregateError(
          [error, rollback_error],
          `guest ${
            JSON.stringify(this.#guest.artifact.guest_id)
          } restore failed and rollback was incomplete`,
        );
      }
      throw error;
    }
  }

  #capture(): Promise<RuntimeSnapshot> {
    return capture_runtime_snapshot(
      this.#guest.artifact,
      this.#sequence,
      this.#guest,
      this.#random,
      this.#channels,
    );
  }

  #context(sequence: number, delta_seconds: number): RuntimeExecutionContext {
    return { sequence, delta_seconds, random: this.#random };
  }

  #serialized<result>(operation: () => Promise<result>): Promise<result> {
    const pending = this.#operation_queue.then(operation, operation);
    this.#operation_queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  #require_open(operation: string): void {
    if (this.#closed) {
      throw new Error(
        `guest ${
          JSON.stringify(this.#guest.artifact.guest_id)
        } cannot ${operation}; runtime session is closed`,
      );
    }
  }

  #evidence(): Readonly<Record<string, string | number | boolean>> {
    return {
      guest: this.#guest.artifact.guest_id,
      artifact_digest: this.#guest.artifact.artifact_digest,
      sequence: this.#sequence,
    };
  }
}

async function parse_runtime_replay(
  input: unknown,
  artifact: GameArtifact,
): Promise<RuntimeReplay> {
  if (!is_record(input)) throw new Error("runtime replay must be an object");
  expect_fields(input, [
    "artifact_digest",
    "checksum",
    "format",
    "guest",
    "initial_snapshot",
    "steps",
    "version",
  ], "runtime replay");
  if (input.format !== "ink-runtime-replay" || input.version !== 1) {
    throw new Error("runtime replay must use ink-runtime-replay version 1");
  }
  if (
    input.guest !== artifact.guest_id ||
    input.artifact_digest !== artifact.artifact_digest
  ) {
    throw new Error(
      `runtime replay guest ${JSON.stringify(input.guest)} artifact ${
        JSON.stringify(input.artifact_digest)
      } does not match guest ${JSON.stringify(artifact.guest_id)} artifact ${
        JSON.stringify(artifact.artifact_digest)
      }`,
    );
  }
  if (!is_record(input.initial_snapshot)) {
    throw new Error("runtime replay initial_snapshot must be an object");
  }
  const initial_snapshot = await parse_runtime_snapshot(
    canonical_json(input.initial_snapshot as JsonValue),
    artifact,
  );
  if (!Array.isArray(input.steps) || input.steps.length > 100_000) {
    throw new Error(
      "runtime replay steps must be an array of at most 100000 entries",
    );
  }
  const steps = input.steps.map((value, index) =>
    parse_replay_step(value, index, initial_snapshot.sequence)
  );
  if (typeof input.checksum !== "string") {
    throw new Error("runtime replay checksum must be a string");
  }
  const { checksum: _checksum, ...unsigned } = input;
  const expected = await digest_json(unsigned as JsonValue);
  if (input.checksum !== expected) {
    throw new Error(
      `runtime replay checksum ${
        JSON.stringify(input.checksum)
      } does not match ${JSON.stringify(expected)}`,
    );
  }
  return {
    format: "ink-runtime-replay",
    version: 1,
    guest: artifact.guest_id,
    artifact_digest: artifact.artifact_digest,
    initial_snapshot,
    steps,
    checksum: input.checksum,
  };
}

function parse_replay_step(
  value: unknown,
  index: number,
  initial_sequence: number,
): RuntimeReplayStep {
  if (!is_record(value)) {
    throw new Error(`runtime replay step ${index} must be an object`);
  }
  expect_fields(value, [
    "delta_seconds",
    "input",
    "observation_digest",
    "sequence",
    "snapshot_checksum",
  ], `runtime replay step ${index}`);
  const expected_sequence = initial_sequence + index + 1;
  if (value.sequence !== expected_sequence) {
    throw new Error(
      `runtime replay step ${index} sequence ${
        JSON.stringify(value.sequence)
      } must be ${expected_sequence}`,
    );
  }
  if (
    typeof value.delta_seconds !== "number" ||
    !Number.isFinite(value.delta_seconds) || value.delta_seconds < 0
  ) {
    throw new Error(
      `runtime replay step ${index} delta must be finite nonnegative seconds`,
    );
  }
  if (
    typeof value.snapshot_checksum !== "string" ||
    typeof value.observation_digest !== "string"
  ) {
    throw new Error(`runtime replay step ${index} digests must be strings`);
  }
  return {
    sequence: value.sequence,
    delta_seconds: value.delta_seconds,
    input: parse_json_value(value.input, `runtime replay step ${index} input`),
    snapshot_checksum: value.snapshot_checksum,
    observation_digest: value.observation_digest,
  };
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

function parse_json_value(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 64) throw new Error(`${path} exceeds 64 nested JSON levels`);
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parse_json_value(entry, `${path}[${index}]`, depth + 1)
    );
  }
  if (is_record(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        parse_json_value(entry, `${path}.${key}`, depth + 1),
      ]),
    );
  }
  throw new Error(`${path} contains non-JSON value ${String(value)}`);
}

function error_reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

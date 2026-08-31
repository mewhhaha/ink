import { Observer } from "@ink/observability/observer.ts";
import {
  artifact_digest,
  type ArtifactDigest,
  type GameArtifact,
  type GuestId,
} from "./artifact.ts";
import {
  DeterministicChannels,
  DeterministicRandomStreams,
} from "./determinism.ts";
import { canonical_json, digest_json, type JsonValue } from "./digest.ts";
import {
  type Microseconds,
  microseconds,
  runtime_sequence,
  type RuntimeSequence,
} from "./identity.ts";
import type { RuntimeGuestStructure } from "./graph.ts";
import { RuntimeLifecycle } from "./lifecycle.ts";
import { RuntimeStepScheduler } from "./scheduler.ts";
import {
  capture_runtime_snapshot,
  parse_runtime_snapshot,
  restore_runtime_snapshot,
  runtime_snapshot_channels,
  runtime_snapshot_guest_state,
  type RuntimeSnapshot,
  serialize_runtime_snapshot,
} from "./snapshot.ts";

export {
  type Microseconds,
  microseconds,
  runtime_sequence,
  type RuntimeSequence,
} from "./identity.ts";

export interface RuntimeStep<Input> {
  readonly elapsed_us: Microseconds;
  readonly inputs: readonly Input[];
}

export interface RuntimeExecutionContext {
  readonly sequence: RuntimeSequence;
}

export interface RuntimeGuest<Input, Query, Observation> {
  readonly artifact: GameArtifact;
  reset(context: RuntimeExecutionContext): void | Promise<void>;
  advance(
    step: RuntimeStep<Input>,
    context: RuntimeExecutionContext,
  ): void | Promise<void>;
  observe(query: Query): Observation | Promise<Observation>;
  snapshot(): Uint8Array | Promise<Uint8Array>;
  restore(payload: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface RuntimeCodec<Input> {
  encode_input(input: Input): JsonValue;
  decode_input(value: JsonValue): Input;
}

export interface RuntimeRevision {
  readonly sequence: RuntimeSequence;
  readonly snapshot_checksum: string;
  readonly artifact_digest: ArtifactDigest;
}

export interface RuntimeReplayStep {
  readonly sequence: RuntimeSequence;
  readonly elapsed_us: Microseconds;
  readonly inputs: readonly JsonValue[];
  readonly snapshot_checksum: string;
}

export interface RuntimeReplay {
  readonly format: "ink-runtime-replay";
  readonly version: 1;
  readonly guest: GuestId;
  readonly artifact_digest: ArtifactDigest;
  readonly initial_snapshot: JsonValue;
  readonly steps: readonly RuntimeReplayStep[];
  readonly checksum: string;
}

export type RuntimeTraceEvent =
  | { readonly type: "initialized"; readonly sequence: RuntimeSequence }
  | { readonly type: "reset"; readonly sequence: RuntimeSequence }
  | {
    readonly type: "advance";
    readonly sequence: RuntimeSequence;
    readonly elapsed_us: Microseconds;
    readonly input_count: number;
  }
  | {
    readonly type: "saved";
    readonly sequence: RuntimeSequence;
    readonly checksum: string;
  }
  | { readonly type: "loaded"; readonly sequence: RuntimeSequence }
  | {
    readonly type: "reloaded";
    readonly sequence: RuntimeSequence;
    readonly preserved: boolean;
    readonly artifact_digest: ArtifactDigest;
  }
  | { readonly type: "replay_diverged"; readonly sequence: RuntimeSequence }
  | { readonly type: "closed"; readonly sequence: RuntimeSequence };

export interface ReloadResult {
  readonly revision: RuntimeRevision;
  readonly preserved: boolean;
}

export interface RuntimeSession<Input, Query, Observation> {
  advance(step: RuntimeStep<Input>): Promise<RuntimeRevision>;
  observe(query: Query): Promise<Observation>;
  reset(): Promise<RuntimeRevision>;
  save(): Promise<string>;
  load(source: string): Promise<RuntimeRevision>;
  finish_replay(): Promise<RuntimeReplay>;
  replay(source: unknown): Promise<RuntimeRevision>;
  reload(
    guest: RuntimeGuest<Input, Query, Observation>,
  ): Promise<ReloadResult>;
  trace(): readonly RuntimeTraceEvent[];
  close(): Promise<void>;
}

export interface RuntimeSessionOptions<Input, Query, Observation> {
  readonly guest: RuntimeGuest<Input, Query, Observation>;
  readonly codec: RuntimeCodec<Input>;
  readonly observer: Observer;
}

export async function create_runtime_session<Input, Query, Observation>(
  options: RuntimeSessionOptions<Input, Query, Observation>,
): Promise<RuntimeSession<Input, Query, Observation>> {
  const session = new RuntimeSessionImplementation(options);
  await session.initialize();
  return session;
}

class RuntimeSessionImplementation<Input, Query, Observation>
  implements RuntimeSession<Input, Query, Observation> {
  #guest: RuntimeGuest<Input, Query, Observation>;
  readonly #codec: RuntimeCodec<Input>;
  readonly #observer: Observer;
  readonly #channels: DeterministicChannels;
  #random: DeterministicRandomStreams;
  #lifecycle: RuntimeLifecycle;
  #scheduler: RuntimeStepScheduler;
  #sequence = runtime_sequence(0);
  #initial_snapshot: RuntimeSnapshot | undefined;
  #reset_channels: ReturnType<typeof runtime_snapshot_channels> | undefined;
  #replay_steps: RuntimeReplayStep[] = [];
  #trace_events: RuntimeTraceEvent[] = [];
  #operation_queue: Promise<void> = Promise.resolve();
  #closed = false;
  #close_operation: Promise<void> | undefined;

  constructor(options: RuntimeSessionOptions<Input, Query, Observation>) {
    this.#guest = options.guest;
    this.#codec = options.codec;
    this.#observer = options.observer;
    this.#channels = new DeterministicChannels([]);
    this.#random = new DeterministicRandomStreams(0n);
    this.#lifecycle = this.#create_lifecycle(this.#guest);
    this.#scheduler = this.#create_scheduler(this.#lifecycle);
  }

  async initialize(): Promise<void> {
    try {
      await this.#lifecycle.initialize();
      await this.#lifecycle.start();
      await this.#guest.reset(this.#context(runtime_sequence(0)));
      const snapshot = await this.#capture();
      this.#initial_snapshot = snapshot;
      this.#reset_channels = runtime_snapshot_channels(snapshot);
      this.#trace_events.push({
        type: "initialized",
        sequence: runtime_sequence(0),
      });
      this.#observer.event("runtime.session.initialized", this.#evidence());
    } catch (error) {
      try {
        await close_runtime_guest(this.#lifecycle, this.#guest);
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

  advance(step: RuntimeStep<Input>): Promise<RuntimeRevision> {
    return this.#serialized(() => this.#advance_now(parse_runtime_step(step)));
  }

  observe(query: Query): Promise<Observation> {
    return this.#serialized(async () => {
      this.#require_open("observe");
      const previous = await this.#capture();
      try {
        const observation = await this.#guest.observe(query);
        const after = await this.#capture();
        if (after.checksum !== previous.checksum) {
          throw new Error(
            `guest ${
              JSON.stringify(this.#guest.artifact.guest_id)
            } observation mutated deterministic state from ${previous.checksum} to ${after.checksum}`,
          );
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
          this.#scheduler.restore(previous.schedule);
        } catch (rollback_error) {
          throw new AggregateError(
            [error, rollback_error],
            `guest ${
              JSON.stringify(this.#guest.artifact.guest_id)
            } observation failed and rollback was incomplete`,
          );
        }
        throw error;
      }
    });
  }

  reset(): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      this.#require_open("reset");
      const previous = await this.#capture();
      const reset_random = new DeterministicRandomStreams(0n);
      try {
        await this.#channels.restore(this.#initial_channels());
        await this.#guest.reset({
          sequence: runtime_sequence(0),
        });
        this.#scheduler.reset();
        const snapshot = await capture_runtime_snapshot(
          this.#guest.artifact,
          0,
          this.#guest,
          reset_random,
          this.#channels,
          this.#scheduler.snapshot(),
        );
        this.#random = reset_random;
        this.#sequence = runtime_sequence(0);
        this.#initial_snapshot = snapshot;
        this.#replay_steps = [];
        this.#trace_events.push({
          type: "reset",
          sequence: runtime_sequence(0),
        });
        this.#observer.event("runtime.session.reset", this.#evidence());
        return revision(snapshot);
      } catch (error) {
        try {
          await restore_runtime_snapshot(
            previous,
            this.#guest,
            this.#random,
            this.#channels,
          );
          this.#scheduler.restore(previous.schedule);
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

  load(source: string): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      this.#require_open("load");
      const snapshot = await parse_runtime_snapshot(
        source,
        this.#guest.artifact,
      );
      await this.#restore(snapshot);
      this.#sequence = runtime_sequence(snapshot.sequence);
      this.#initial_snapshot = snapshot;
      this.#replay_steps = [];
      this.#trace_events.push({ type: "loaded", sequence: this.#sequence });
      this.#observer.event("runtime.session.loaded", this.#evidence());
      return revision(snapshot);
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
        initial_snapshot: parse_json_value(
          this.#replay_origin(),
          "runtime replay snapshot",
        ),
        steps: this.#replay_steps.slice(),
      };
      return Object.freeze({
        ...unsigned,
        checksum: await digest_json(
          parse_json_value(unsigned, "runtime replay"),
        ),
      });
    });
  }

  replay(source: unknown): Promise<RuntimeRevision> {
    return this.#serialized(async () => {
      this.#require_open("replay");
      const parsed = await parse_runtime_replay(source, this.#guest.artifact);
      const previous = await this.#capture();
      const previous_initial = this.#replay_origin();
      const previous_steps = this.#replay_steps;
      const previous_trace_length = this.#trace_events.length;
      let divergence_sequence: RuntimeSequence | undefined;
      try {
        await this.#restore(parsed.initial_snapshot);
        this.#sequence = runtime_sequence(parsed.initial_snapshot.sequence);
        this.#initial_snapshot = parsed.initial_snapshot;
        this.#replay_steps = [];
        let replay_revision = revision(parsed.initial_snapshot);
        for (const expected of parsed.steps) {
          replay_revision = await this.#advance_now({
            elapsed_us: expected.elapsed_us,
            inputs: expected.inputs.map((input) =>
              this.#codec.decode_input(input)
            ),
          });
          if (
            replay_revision.snapshot_checksum !== expected.snapshot_checksum
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
                actual_snapshot: replay_revision.snapshot_checksum,
              },
            );
            throw new Error(
              `guest ${
                JSON.stringify(this.#guest.artifact.guest_id)
              } replay diverged at sequence ${expected.sequence}; expected snapshot ${expected.snapshot_checksum}, received ${replay_revision.snapshot_checksum}`,
            );
          }
        }
        return replay_revision;
      } catch (error) {
        try {
          await restore_runtime_snapshot(
            previous,
            this.#guest,
            this.#random,
            this.#channels,
          );
          this.#scheduler.restore(previous.schedule);
        } catch (rollback_error) {
          throw new AggregateError(
            [error, rollback_error],
            `guest ${
              JSON.stringify(this.#guest.artifact.guest_id)
            } replay failed and rollback was incomplete`,
          );
        }
        this.#sequence = runtime_sequence(previous.sequence);
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
    replacement: RuntimeGuest<Input, Query, Observation>,
  ): Promise<ReloadResult> {
    return this.#serialized(async () => {
      this.#require_open("reload");
      const previous = await this.#capture();
      const preserved = replacement.artifact.guest_id ===
          this.#guest.artifact.guest_id &&
        replacement.artifact.schema_digest ===
          this.#guest.artifact.schema_digest;
      const replacement_random = preserved
        ? this.#random
        : new DeterministicRandomStreams(0n);
      let replacement_lifecycle: RuntimeLifecycle;
      try {
        replacement_lifecycle = this.#create_lifecycle(replacement);
      } catch (error) {
        try {
          await replacement.close();
        } catch (cleanup_error) {
          throw new AggregateError(
            [error, cleanup_error],
            `replacement guest ${
              JSON.stringify(replacement.artifact.guest_id)
            } graph resolution failed and cleanup also failed`,
          );
        }
        throw error;
      }
      const replacement_scheduler = this.#create_scheduler(
        replacement_lifecycle,
      );
      let replacement_snapshot: RuntimeSnapshot;
      try {
        await replacement_lifecycle.initialize();
        await replacement_lifecycle.start();
        if (preserved) {
          await replacement.restore(runtime_snapshot_guest_state(previous));
          replacement_scheduler.restore(previous.schedule);
        } else {
          await replacement.reset({
            sequence: runtime_sequence(0),
          });
          await this.#channels.restore(this.#initial_channels());
        }
        replacement_snapshot = await capture_runtime_snapshot(
          replacement.artifact,
          preserved ? previous.sequence : 0,
          replacement,
          replacement_random,
          this.#channels,
          replacement_scheduler.snapshot(),
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
          await close_runtime_guest(replacement_lifecycle, replacement);
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
      const previous_lifecycle = this.#lifecycle;
      this.#guest = replacement;
      this.#lifecycle = replacement_lifecycle;
      this.#scheduler = replacement_scheduler;
      this.#random = replacement_random;
      this.#sequence = runtime_sequence(preserved ? previous.sequence : 0);
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
        await close_runtime_guest(previous_lifecycle, previous_guest);
      } catch (error) {
        this.#observer.diagnostic(
          "warning",
          "runtime.session.reload.cleanup",
          "previous guest failed to close after replacement activation",
          { ...this.#evidence(), reason: error_reason(error) },
        );
      }
      return { revision: revision(replacement_snapshot), preserved };
    });
  }

  trace(): readonly RuntimeTraceEvent[] {
    return this.#trace_events.slice();
  }

  close(): Promise<void> {
    if (this.#close_operation !== undefined) return this.#close_operation;
    this.#close_operation = this.#serialized(async () => {
      if (this.#closed) return;
      this.#closed = true;
      try {
        await close_runtime_guest(this.#lifecycle, this.#guest);
      } finally {
        this.#trace_events.push({ type: "closed", sequence: this.#sequence });
        this.#observer.event("runtime.session.closed", this.#evidence());
      }
    });
    return this.#close_operation;
  }

  async #advance_now(step: RuntimeStep<Input>): Promise<RuntimeRevision> {
    this.#require_open("advance");
    const next_sequence = runtime_sequence(this.#sequence + 1);
    const previous = await this.#capture();
    try {
      await this.#guest.advance(step, this.#context(next_sequence));
      await this.#scheduler.advance(step.elapsed_us);
      const snapshot = await capture_runtime_snapshot(
        this.#guest.artifact,
        next_sequence,
        this.#guest,
        this.#random,
        this.#channels,
        this.#scheduler.snapshot(),
      );
      const replay_step: RuntimeReplayStep = {
        sequence: next_sequence,
        elapsed_us: step.elapsed_us,
        inputs: step.inputs.map((input, index) =>
          parse_json_value(
            this.#codec.encode_input(input),
            `runtime encoded input ${index}`,
          )
        ),
        snapshot_checksum: snapshot.checksum,
      };
      this.#sequence = next_sequence;
      this.#replay_steps.push(replay_step);
      this.#trace_events.push({
        type: "advance",
        sequence: next_sequence,
        elapsed_us: step.elapsed_us,
        input_count: step.inputs.length,
      });
      return revision(snapshot);
    } catch (error) {
      try {
        await restore_runtime_snapshot(
          previous,
          this.#guest,
          this.#random,
          this.#channels,
        );
        this.#scheduler.restore(previous.schedule);
      } catch (rollback_error) {
        throw new AggregateError(
          [error, rollback_error],
          `guest ${
            JSON.stringify(this.#guest.artifact.guest_id)
          } advance ${next_sequence} failed and rollback was incomplete`,
        );
      }
      throw error;
    }
  }

  async #restore(snapshot: RuntimeSnapshot): Promise<void> {
    const previous = await this.#capture();
    try {
      await restore_runtime_snapshot(
        snapshot,
        this.#guest,
        this.#random,
        this.#channels,
      );
      this.#scheduler.restore(snapshot.schedule);
    } catch (error) {
      try {
        await restore_runtime_snapshot(
          previous,
          this.#guest,
          this.#random,
          this.#channels,
        );
        this.#scheduler.restore(previous.schedule);
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
      this.#scheduler.snapshot(),
    );
  }

  #context(sequence: RuntimeSequence): RuntimeExecutionContext {
    return { sequence };
  }

  #create_lifecycle(
    guest: RuntimeGuest<Input, Query, Observation>,
  ): RuntimeLifecycle {
    const structure: RuntimeGuestStructure = {
      artifact: guest.artifact,
      blocks: [],
    };
    return new RuntimeLifecycle({
      guest: structure,
      capabilities: [],
      observer: this.#observer,
    });
  }

  #create_scheduler(lifecycle: RuntimeLifecycle): RuntimeStepScheduler {
    return new RuntimeStepScheduler({ runtime: lifecycle });
  }

  #replay_origin(): RuntimeSnapshot {
    if (this.#initial_snapshot !== undefined) return this.#initial_snapshot;
    throw new Error(
      `guest ${
        JSON.stringify(this.#guest.artifact.guest_id)
      } has no initialized replay origin`,
    );
  }

  #initial_channels(): ReturnType<typeof runtime_snapshot_channels> {
    if (this.#reset_channels !== undefined) return this.#reset_channels;
    throw new Error(
      `guest ${
        JSON.stringify(this.#guest.artifact.guest_id)
      } has no initialized deterministic channels`,
    );
  }

  #serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
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

function parse_runtime_step<Input>(
  step: RuntimeStep<Input>,
): RuntimeStep<Input> {
  if (typeof step !== "object" || step === null) {
    throw new Error(`runtime step ${JSON.stringify(step)} must be an object`);
  }
  if (!Array.isArray(step.inputs)) {
    throw new Error("runtime step inputs must be an array");
  }
  return Object.freeze({
    elapsed_us: microseconds(step.elapsed_us),
    inputs: Object.freeze([...step.inputs]),
  });
}

function revision(snapshot: RuntimeSnapshot): RuntimeRevision {
  return Object.freeze({
    sequence: runtime_sequence(snapshot.sequence),
    snapshot_checksum: snapshot.checksum,
    artifact_digest: artifact_digest(snapshot.artifact_digest),
  });
}

async function parse_runtime_replay(
  input: unknown,
  artifact: GameArtifact,
): Promise<ParsedRuntimeReplay> {
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
    canonical_json(
      parse_json_value(input.initial_snapshot, "runtime replay snapshot"),
    ),
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
  const expected = await digest_json(
    parse_json_value(unsigned, "runtime replay checksum source"),
  );
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

interface ParsedRuntimeReplay {
  readonly format: "ink-runtime-replay";
  readonly version: 1;
  readonly guest: GuestId;
  readonly artifact_digest: ArtifactDigest;
  readonly initial_snapshot: RuntimeSnapshot;
  readonly steps: readonly RuntimeReplayStep[];
  readonly checksum: string;
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
    "elapsed_us",
    "inputs",
    "sequence",
    "snapshot_checksum",
  ], `runtime replay step ${index}`);
  const expected_sequence = runtime_sequence(initial_sequence + index + 1);
  if (value.sequence !== expected_sequence) {
    throw new Error(
      `runtime replay step ${index} sequence ${
        JSON.stringify(value.sequence)
      } must be ${expected_sequence}`,
    );
  }
  if (!Array.isArray(value.inputs)) {
    throw new Error(`runtime replay step ${index} inputs must be an array`);
  }
  if (typeof value.snapshot_checksum !== "string") {
    throw new Error(
      `runtime replay step ${index} snapshot checksum must be a string`,
    );
  }
  return {
    sequence: expected_sequence,
    elapsed_us: microseconds(
      typeof value.elapsed_us === "number" ? value.elapsed_us : Number.NaN,
    ),
    inputs: value.inputs.map((input, input_index) =>
      parse_json_value(
        input,
        `runtime replay step ${index} input ${input_index}`,
      )
    ),
    snapshot_checksum: value.snapshot_checksum,
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

async function close_runtime_guest<Input, Query, Observation>(
  lifecycle: RuntimeLifecycle,
  guest: RuntimeGuest<Input, Query, Observation>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await lifecycle.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await guest.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `guest ${JSON.stringify(guest.artifact.guest_id)} cleanup failed`,
    );
  }
}

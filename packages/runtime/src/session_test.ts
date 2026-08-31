import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import { digest_json, type JsonValue } from "./digest.ts";
import {
  create_runtime_session,
  microseconds,
  runtime_sequence,
  type RuntimeCodec,
  type RuntimeExecutionContext,
  type RuntimeGuest,
  type RuntimeReplay,
  type RuntimeStep,
} from "./session.ts";

type CounterQuery =
  | { readonly type: "value" }
  | {
    readonly type: "wait";
    readonly started: () => void;
    readonly release: Promise<void>;
  }
  | { readonly type: "mutate" };

interface CounterObservation {
  readonly value: number;
  readonly elapsed_us: number;
  readonly batches: number;
  readonly presentation: number;
}

const counter_codec: RuntimeCodec<number> = {
  encode_input: (input) => input,
  decode_input: (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(
        `counter input ${JSON.stringify(value)} must be a safe integer`,
      );
    }
    return value;
  },
};

class CounterGuest
  implements RuntimeGuest<number, CounterQuery, CounterObservation> {
  readonly artifact;
  readonly #fail_restore: boolean;
  #value = 0;
  #elapsed_us = 0;
  #batches = 0;
  #presentation = 0;
  close_count = 0;

  constructor(
    artifact_digest: string,
    schema_digest = "counter-schema",
    fail_restore = false,
  ) {
    this.artifact = parse_game_artifact({
      guest_id: "counter",
      artifact_digest,
      schema_digest,
      wasm: new Uint8Array([1]),
      capabilities: [],
    });
    this.#fail_restore = fail_restore;
  }

  reset(): void {
    this.#value = 0;
    this.#elapsed_us = 0;
    this.#batches = 0;
  }

  advance(
    step: RuntimeStep<number>,
    _context: RuntimeExecutionContext,
  ): void {
    this.#elapsed_us += step.elapsed_us;
    this.#batches += 1;
    for (const input of step.inputs) {
      this.#value += input;
      if (input === 999) throw new Error("counter rejected input 999");
    }
  }

  async observe(query: CounterQuery): Promise<CounterObservation> {
    this.#presentation += 1;
    if (query.type === "wait") {
      query.started();
      await query.release;
    }
    if (query.type === "mutate") this.#value += 1;
    return {
      value: this.#value,
      elapsed_us: this.#elapsed_us,
      batches: this.#batches,
      presentation: this.#presentation,
    };
  }

  snapshot(): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        value: this.#value,
        elapsed_us: this.#elapsed_us,
        batches: this.#batches,
      }),
    );
  }

  restore(payload: Uint8Array): void {
    if (this.#fail_restore) throw new Error("replacement rejected state");
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("counter state must be an object");
    }
    const value = Reflect.get(parsed, "value");
    const elapsed_us = Reflect.get(parsed, "elapsed_us");
    const batches = Reflect.get(parsed, "batches");
    if (
      !Number.isSafeInteger(value) || !Number.isSafeInteger(elapsed_us) ||
      !Number.isSafeInteger(batches)
    ) {
      throw new Error("counter state fields must be safe integers");
    }
    this.#value = value;
    this.#elapsed_us = elapsed_us;
    this.#batches = batches;
  }

  close(): void {
    this.close_count += 1;
  }
}

function runtime_observer(): Observer {
  return new Observer({
    source: { subsystem: "runtime" },
    sink: create_test_sink(),
    clock: { now_seconds: () => 1 },
  });
}

function deterministic_observation(
  observation: CounterObservation,
): Omit<CounterObservation, "presentation"> {
  return {
    value: observation.value,
    elapsed_us: observation.elapsed_us,
    batches: observation.batches,
  };
}

Deno.test("one advance applies every input while elapsed time advances once", async () => {
  const session = await create_runtime_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
  });
  const revision = await session.advance({
    elapsed_us: microseconds(20_000),
    inputs: [2, 3, 5],
  });
  assertEquals(revision.sequence, 1);
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    { value: 10, elapsed_us: 20_000, batches: 1 },
  );
  await session.close();
});

Deno.test("zero-elapsed input changes state without advancing guest time", async () => {
  const session = await create_runtime_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await session.advance({ elapsed_us: microseconds(0), inputs: [4] });
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    { value: 4, elapsed_us: 0, batches: 1 },
  );
  await session.close();
});

Deno.test("save load and serialized replay reproduce deterministic state without presentation checksums", async () => {
  const guest = new CounterGuest("artifact-1");
  const session = await create_runtime_session({
    guest,
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await session.advance({ elapsed_us: microseconds(10_000), inputs: [2] });
  await session.advance({ elapsed_us: microseconds(20_000), inputs: [3] });
  const expected = deterministic_observation(
    await session.observe({ type: "value" }),
  );
  const replay: unknown = JSON.parse(
    JSON.stringify(await session.finish_replay()),
  );
  const save = await session.save();
  await session.advance({ elapsed_us: microseconds(30_000), inputs: [100] });
  await session.load(save);
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    expected,
  );
  await session.advance({ elapsed_us: microseconds(40_000), inputs: [50] });
  await session.reset();
  await session.replay(replay);
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    expected,
  );
  await session.close();
  assertEquals(guest.close_count, 1);
});

Deno.test("invalid encoded input rolls back a completed guest advance", async () => {
  const session = await create_runtime_session({
    guest: new CounterGuest("artifact-1"),
    codec: { ...counter_codec, encode_input: () => Number.NaN as never },
    observer: runtime_observer(),
  });
  await assertRejects(
    () => session.advance({ elapsed_us: microseconds(1), inputs: [3] }),
    Error,
    "runtime encoded input 0 contains non-JSON value NaN",
  );
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    { value: 0, elapsed_us: 0, batches: 0 },
  );
  await session.close();
});

Deno.test("guest advance failure rolls deterministic state back", async () => {
  const session = await create_runtime_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await assertRejects(
    () => session.advance({ elapsed_us: microseconds(5), inputs: [2, 999] }),
    Error,
    "counter rejected input 999",
  );
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    { value: 0, elapsed_us: 0, batches: 0 },
  );
  await session.close();
});

Deno.test("replay divergence restores the state that preceded replay", async () => {
  const session = await create_runtime_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await session.advance({ elapsed_us: microseconds(10), inputs: [2] });
  const replay = await session.finish_replay();
  await session.advance({ elapsed_us: microseconds(20), inputs: [5] });
  const before = deterministic_observation(
    await session.observe({ type: "value" }),
  );
  const unsigned = {
    format: replay.format,
    version: replay.version,
    guest: replay.guest,
    artifact_digest: replay.artifact_digest,
    initial_snapshot: replay.initial_snapshot,
    steps: replay.steps.map((step, index) =>
      index === 0 ? { ...step, snapshot_checksum: "0".repeat(64) } : step
    ),
  };
  const corrupted: RuntimeReplay = {
    ...unsigned,
    checksum: await digest_json(unsigned as unknown as JsonValue),
  };
  await assertRejects(
    () => session.replay(corrupted),
    Error,
    "replay diverged at sequence 1",
  );
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    before,
  );
  assertEquals(session.trace().at(-1), {
    type: "replay_diverged",
    sequence: runtime_sequence(1),
  });
  await session.close();
});

Deno.test("failed reload retains the active guest and compatible reload preserves state", async () => {
  const active = new CounterGuest("artifact-1");
  const session = await create_runtime_session({
    guest: active,
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await session.advance({ elapsed_us: microseconds(10), inputs: [4] });
  const before = deterministic_observation(
    await session.observe({ type: "value" }),
  );
  const rejected = new CounterGuest("artifact-2", "counter-schema", true);
  await assertRejects(
    () => session.reload(rejected),
    Error,
    "replacement rejected state",
  );
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    before,
  );
  assertEquals(active.close_count, 0);
  assertEquals(rejected.close_count, 1);

  const replacement = new CounterGuest("artifact-3");
  const reloaded = await session.reload(replacement);
  assertEquals(reloaded.preserved, true);
  assertEquals(reloaded.revision.sequence, 1);
  assertEquals(active.close_count, 1);
  await session.close();
  assertEquals(replacement.close_count, 1);
});

Deno.test("incompatible reload resets state instead of preserving invalid bytes", async () => {
  const session = await create_runtime_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await session.advance({ elapsed_us: microseconds(10), inputs: [10] });
  const reloaded = await session.reload(
    new CounterGuest("artifact-2", "new-schema"),
  );
  assertEquals(reloaded.preserved, false);
  assertEquals(reloaded.revision.sequence, 0);
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    { value: 0, elapsed_us: 0, batches: 0 },
  );
  await session.close();
});

Deno.test("observe and advance share one actor and observation cannot mutate state", async () => {
  const session = await create_runtime_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
  });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observation = session.observe({
    type: "wait",
    started: started.resolve,
    release: release.promise,
  });
  await started.promise;
  let advanced = false;
  const pending_advance = session.advance({
    elapsed_us: microseconds(1),
    inputs: [7],
  }).then(() => {
    advanced = true;
  });
  await Promise.resolve();
  assertEquals(advanced, false);
  release.resolve();
  await observation;
  await pending_advance;
  assertEquals(advanced, true);

  await assertRejects(
    () => session.observe({ type: "mutate" }),
    Error,
    "observation mutated deterministic state",
  );
  assertEquals(
    deterministic_observation(await session.observe({ type: "value" })),
    { value: 7, elapsed_us: 1, batches: 1 },
  );
  await session.close();
});

Deno.test("close is idempotent and remains ordered after pending operations", async () => {
  const guest = new CounterGuest("artifact-1");
  const session = await create_runtime_session({
    guest,
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await Promise.all([session.close(), session.close(), session.close()]);
  assertEquals(guest.close_count, 1);
  assertEquals(session.trace().at(-1), {
    type: "closed",
    sequence: runtime_sequence(0),
  });
  await assertRejects(
    () => session.advance({ elapsed_us: microseconds(0), inputs: [] }),
    Error,
    "runtime session is closed",
  );
});

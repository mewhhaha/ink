import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import { digest_json, type JsonValue } from "./digest.ts";
import { create_browser_session, create_headless_session } from "./host.ts";
import type {
  RuntimeCodec,
  RuntimeExecutionContext,
  RuntimeGuest,
  RuntimeReplay,
} from "./session.ts";
import { create_runtime_session } from "./session.ts";

interface CounterObservation {
  readonly value: number;
}

const counter_codec: RuntimeCodec<number, CounterObservation> = {
  encode_input: (input) => input,
  decode_input: (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(
        `counter input ${JSON.stringify(value)} must be a safe integer`,
      );
    }
    return value;
  },
  encode_observation: ({ value }) => ({ value }),
};

class CounterGuest implements RuntimeGuest<number, CounterObservation> {
  readonly artifact;
  readonly #fail_restore: boolean;
  #value = 0;
  close_count = 0;
  describe_count = 0;

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

  reset(): CounterObservation {
    this.#value = 0;
    return { value: this.#value };
  }

  step(input: number, context: RuntimeExecutionContext): CounterObservation {
    const random = Number(context.random.stream("counter").next_u64() % 7n);
    this.#value += input + random;
    return { value: this.#value };
  }

  describe(): CounterObservation {
    this.describe_count += 1;
    return { value: this.#value };
  }

  snapshot(): Uint8Array {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setInt32(0, this.#value, true);
    return payload;
  }

  restore(payload: Uint8Array): void {
    if (this.#fail_restore) throw new Error("replacement rejected state");
    if (payload.length !== 4) {
      throw new Error(`counter state has ${payload.length} bytes; expected 4`);
    }
    this.#value = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).getInt32(0, true);
  }

  close(): void {
    this.close_count += 1;
  }
}

function runtime_observer() {
  return new Observer({
    source: { subsystem: "runtime" },
    sink: create_test_sink(),
    clock: { now_seconds: () => 1 },
  });
}

Deno.test("save load and replay reproduce deterministic guest state", async () => {
  const guest = new CounterGuest("artifact-1");
  const session = await create_runtime_session({
    guest,
    codec: counter_codec,
    observer: runtime_observer(),
    random_seed: 42n,
  });
  await session.step(2, 0.01);
  const expected = await session.step(3, 0.02);
  const replay = await session.finish_replay();
  const save = await session.save();
  await session.step(100, 0.03);
  assertEquals(await session.load(save), expected);
  await session.step(50, 0.04);
  assertEquals(await session.reset(), { value: 0 });
  assertEquals(await session.replay(replay), expected);
  await session.close();
  assertEquals(guest.close_count, 1);
});

Deno.test("empty replay describes restored state exactly once", async () => {
  const guest = new CounterGuest("artifact-1");
  const session = await create_runtime_session({
    guest,
    codec: counter_codec,
    observer: runtime_observer(),
  });
  const replay = await session.finish_replay();

  assertEquals(await session.replay(replay), { value: 0 });
  assertEquals(guest.describe_count, 1);
  await session.close();
});

Deno.test("invalid codec JSON rolls back a completed guest step", async () => {
  const guest = new CounterGuest("artifact-1");
  const session = await create_runtime_session({
    guest,
    codec: {
      ...counter_codec,
      encode_input: () => Number.NaN as never,
    },
    observer: runtime_observer(),
  });

  await assertRejects(
    () => session.step(3, 0.01),
    Error,
    "runtime encoded input contains non-JSON value NaN",
  );
  assertEquals(await session.describe(), { value: 0 });
  await session.close();
});

Deno.test("replay divergence restores the state that preceded replay", async () => {
  const session = await create_runtime_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
    random_seed: 9n,
  });
  await session.step(2, 0.01);
  const replay = await session.finish_replay();
  await session.step(5, 0.02);
  const before = await session.describe();
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
  assertEquals(await session.describe(), before);
  assertEquals(session.trace().at(-1), {
    type: "replay_diverged",
    sequence: 1,
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
  const before = await session.step(4, 0.01);
  const rejected = new CounterGuest("artifact-2", "counter-schema", true);
  await assertRejects(
    () => session.reload(rejected),
    Error,
    "replacement rejected state",
  );
  assertEquals(await session.describe(), before);
  assertEquals(active.close_count, 0);
  assertEquals(rejected.close_count, 1);

  const replacement = new CounterGuest("artifact-3");
  const reloaded = await session.reload(replacement);
  assertEquals(reloaded, { observation: before, preserved: true });
  assertEquals(active.close_count, 1);
  await session.close();
  assertEquals(replacement.close_count, 1);
});

Deno.test("incompatible reload resets state instead of preserving invalid bytes", async () => {
  const active = new CounterGuest("artifact-1");
  const session = await create_runtime_session({
    guest: active,
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await session.step(10, 0.01);
  const replacement = new CounterGuest("artifact-2", "new-schema");
  assertEquals(await session.reload(replacement), {
    observation: { value: 0 },
    preserved: false,
  });
  await session.close();
});

Deno.test("browser and headless hosts expose identical session behavior", async () => {
  const browser = await create_browser_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
    random_seed: 11n,
  });
  const headless = await create_headless_session({
    guest: new CounterGuest("artifact-1"),
    codec: counter_codec,
    observer: runtime_observer(),
    random_seed: 11n,
  });
  assertEquals(
    await browser.step(7, 0.016),
    await headless.step(7, 0.016),
  );
  assertEquals(await browser.save(), await headless.save());
  await Promise.all([browser.close(), headless.close()]);
});

import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { parse_game_artifact } from "@ink/runtime/artifact.ts";
import { microseconds, type RuntimeGuest } from "@ink/runtime/session.ts";
import { DevelopmentController } from "./controller.ts";

function counter_guest(
  artifact_digest: string,
  options: { readonly fail_restore?: boolean; readonly close?: () => void } =
    {},
): RuntimeGuest<number, "value", number> {
  let value = 0;
  return {
    artifact: parse_game_artifact({
      guest_id: "controller-counter",
      artifact_digest,
      schema_digest: "counter-schema",
      wasm: new Uint8Array([1]),
      capabilities: [],
    }),
    reset() {
      value = 0;
    },
    advance(step) {
      value += step.inputs.reduce((sum, input) => sum + input, 0);
    },
    observe() {
      return value;
    },
    snapshot() {
      return new Uint8Array([value]);
    },
    restore(payload) {
      if (options.fail_restore) throw new Error("replacement rejected state");
      value = payload[0] ?? 0;
    },
    close() {
      options.close?.();
    },
  };
}

Deno.test("controller publishes ready observations after serialized advances", async () => {
  const artifacts = ["artifact-1"];
  const controller = new DevelopmentController({
    load_source: () => Promise.resolve(artifacts.at(-1)!),
    create_guest: (artifact) => Promise.resolve(counter_guest(artifact)),
    codec: counter_codec,
    observer: runtime_observer(),
    initial_query: "value" as const,
  });
  const states: string[] = [];
  controller.subscribe(() => states.push(controller.snapshot().type));

  assertEquals(await controller.initialize(), 0);
  await controller.advance({ elapsed_us: microseconds(1), inputs: [2, 3] });
  assertEquals(controller.snapshot(), { type: "ready", observation: 5 });
  assertEquals(states, ["ready", "ready"]);
  await controller.close();
});

Deno.test("failed reload retains and reports the last good observation", async () => {
  let artifact = "artifact-1";
  let reject_restore = false;
  const controller = new DevelopmentController({
    load_source: () => Promise.resolve(artifact),
    create_guest: (source) =>
      Promise.resolve(counter_guest(source, { fail_restore: reject_restore })),
    codec: counter_codec,
    observer: runtime_observer(),
    initial_query: "value" as const,
  });
  await controller.initialize();
  await controller.advance({ elapsed_us: microseconds(0), inputs: [7] });
  artifact = "artifact-2";
  reject_restore = true;
  await assertRejects(() => controller.reload(), Error, "rejected state");
  assertEquals(controller.snapshot(), {
    type: "failed_with_last_good",
    last_good: 7,
    reason: "replacement rejected state",
  });
  assertEquals(await controller.observe("value"), 7);
  await controller.close();
});

Deno.test("controller close waits for earlier work and closes once", async () => {
  let close_count = 0;
  const controller = new DevelopmentController({
    load_source: () => Promise.resolve("artifact-1"),
    create_guest: (artifact) =>
      Promise.resolve(
        counter_guest(artifact, { close: () => close_count += 1 }),
      ),
    codec: counter_codec,
    observer: runtime_observer(),
  });
  await controller.initialize();
  await Promise.all([controller.close(), controller.close()]);
  assertEquals(controller.snapshot(), { type: "closed" });
  assertEquals(close_count, 1);
  await assertRejects(
    () => controller.observe("value"),
    Error,
    "while closed",
  );
});

const counter_codec = {
  encode_input: (input: number) => input,
  decode_input(value: unknown): number {
    if (typeof value !== "number") throw new Error("input must be a number");
    return value;
  },
};

function runtime_observer(): Observer {
  return new Observer({
    source: { subsystem: "development-controller" },
    sink: create_test_sink(),
    clock: { now_seconds: () => 1 },
  });
}

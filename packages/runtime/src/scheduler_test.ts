import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import type { Block } from "./graph.ts";
import { RuntimeLifecycle } from "./lifecycle.ts";
import {
  FixedStepScheduler,
  type FrameDriver,
  type FrameRequest,
} from "./scheduler.ts";

class ManualFrameDriver implements FrameDriver {
  readonly #requests: Array<{
    readonly run: () => Promise<void>;
    cancelled: boolean;
  }> = [];

  request_frame(run: () => Promise<void>): FrameRequest {
    const request = { run, cancelled: false };
    this.#requests.push(request);
    return { cancel: () => request.cancelled = true };
  }

  pending(): number {
    return this.#requests.filter(({ cancelled }) => !cancelled).length;
  }

  async run_next(): Promise<void> {
    const index = this.#requests.findIndex(({ cancelled }) => !cancelled);
    if (index === -1) throw new Error("no scheduled frame is available");
    const [request] = this.#requests.splice(index, 1);
    await request.run();
  }
}

function runtime_for(
  block: Block,
  runtime_observer: Observer,
): RuntimeLifecycle {
  const artifact = parse_game_artifact({
    guest_id: "scheduled-game",
    artifact_digest: "artifact-1",
    schema_digest: "schema-1",
    wasm: new Uint8Array([1]),
    capabilities: [],
  });
  return new RuntimeLifecycle({
    guest: { artifact, blocks: [block] },
    capabilities: [],
    observer: runtime_observer,
  });
}

Deno.test("scheduler bounds catch-up and reports retained interpolation", async () => {
  const sink = create_test_sink();
  const runtime_observer = new Observer({
    source: { subsystem: "runtime" },
    sink,
    clock: { now_seconds: () => 1 },
  });
  const fixed_sequences: number[] = [];
  const interpolations: number[] = [];
  const runtime = runtime_for({
    id: "game",
    dependencies: [],
    capabilities: [],
    acquire: () => ({
      fixed_step: ({ fixed_step_sequence }) => {
        fixed_sequences.push(fixed_step_sequence);
      },
      frame: ({ interpolation }) => {
        interpolations.push(interpolation);
      },
    }),
  }, runtime_observer);
  const times = [0, 0.35];
  const driver = new ManualFrameDriver();
  const failures: Error[] = [];
  const scheduler = new FixedStepScheduler({
    runtime,
    clock: { now_seconds: () => times.shift() ?? 0.35 },
    driver,
    observer: runtime_observer,
    fixed_step_seconds: 0.1,
    max_catch_up_steps: 2,
    report_failure: (failure) => failures.push(failure),
  });

  await scheduler.start();
  await driver.run_next();
  assertEquals(fixed_sequences, [0, 1]);
  assertAlmostEquals(interpolations[0], 0.5, 1e-12);
  assertEquals(failures, []);
  assertEquals(
    sink.observations().filter((entry) =>
      entry.type === "event" &&
      entry.name === "runtime.scheduler.catch_up_clamped"
    ).length,
    1,
  );
  await scheduler.stop();
});

Deno.test("pause excludes suspended time and resume schedules one frame", async () => {
  const runtime_observer = new Observer({
    source: { subsystem: "runtime" },
    sink: create_test_sink(),
    clock: { now_seconds: () => 1 },
  });
  const frame_deltas: number[] = [];
  const runtime = runtime_for({
    id: "game",
    dependencies: [],
    capabilities: [],
    acquire: () => ({
      frame: ({ delta_seconds }) => {
        frame_deltas.push(delta_seconds);
      },
    }),
  }, runtime_observer);
  const times = [1, 10, 10.05];
  const driver = new ManualFrameDriver();
  const scheduler = new FixedStepScheduler({
    runtime,
    clock: { now_seconds: () => times.shift() ?? 10.05 },
    driver,
    observer: runtime_observer,
    fixed_step_seconds: 1,
    max_catch_up_steps: 2,
    report_failure: () => {
      throw new Error("unexpected scheduler failure");
    },
  });

  await scheduler.start();
  assertEquals(driver.pending(), 1);
  scheduler.pause();
  assertEquals(driver.pending(), 0);
  await scheduler.resume();
  assertEquals(driver.pending(), 1);
  await driver.run_next();
  assertAlmostEquals(frame_deltas[0], 0.05, 1e-12);
  await scheduler.stop();
});

Deno.test("resume waits for an active frame before scheduling another", async () => {
  const runtime_observer = new Observer({
    source: { subsystem: "runtime" },
    sink: create_test_sink(),
    clock: { now_seconds: () => 1 },
  });
  let finish_frame: (() => void) | undefined;
  const frame_finished = new Promise<void>((resolve) => finish_frame = resolve);
  let frame_started = false;
  const runtime = runtime_for({
    id: "game",
    dependencies: [],
    capabilities: [],
    acquire: () => ({
      frame: async () => {
        frame_started = true;
        await frame_finished;
      },
    }),
  }, runtime_observer);
  const times = [0, 0.1, 10];
  const driver = new ManualFrameDriver();
  const scheduler = new FixedStepScheduler({
    runtime,
    clock: { now_seconds: () => times.shift() ?? 10 },
    driver,
    observer: runtime_observer,
    fixed_step_seconds: 1,
    max_catch_up_steps: 2,
    report_failure: () => {
      throw new Error("unexpected scheduler failure");
    },
  });

  await scheduler.start();
  const active_frame = driver.run_next();
  await Promise.resolve();
  assertEquals(frame_started, true);
  scheduler.pause();
  await scheduler.resume();
  assertEquals(driver.pending(), 0);
  finish_frame!();
  await active_frame;
  assertEquals(driver.pending(), 1);
  await scheduler.stop();
});

Deno.test("scheduled phase failure stops and closes the runtime exactly once", async () => {
  const runtime_observer = new Observer({
    source: { subsystem: "runtime" },
    sink: create_test_sink(),
    clock: { now_seconds: () => 1 },
  });
  let close_count = 0;
  const runtime = runtime_for({
    id: "simulation",
    dependencies: [],
    capabilities: [],
    acquire: () => ({
      fixed_step: () => {
        throw new Error("simulation diverged");
      },
      close: () => {
        close_count += 1;
      },
    }),
  }, runtime_observer);
  const times = [0, 0.2];
  const driver = new ManualFrameDriver();
  const failures: Error[] = [];
  const scheduler = new FixedStepScheduler({
    runtime,
    clock: { now_seconds: () => times.shift() ?? 0.2 },
    driver,
    observer: runtime_observer,
    fixed_step_seconds: 0.1,
    max_catch_up_steps: 2,
    report_failure: (failure) => failures.push(failure),
  });

  await scheduler.start();
  await driver.run_next();
  await scheduler.stop();
  assertEquals(scheduler.state, "stopped");
  assertEquals(close_count, 1);
  assertEquals(failures.length, 1);
  assertEquals(
    failures[0].message.includes(
      'artifact "artifact-1" block "simulation" failed during fixed_step: simulation diverged',
    ),
    true,
  );
});

import { Observer } from "@ink/observability/observer.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { parse_game_artifact } from "./artifact.ts";
import { frame_id } from "./frame.ts";
import type { Block } from "./graph.ts";
import { microseconds, runtime_sequence } from "./identity.ts";
import { RuntimeLifecycle } from "./lifecycle.ts";
import {
  type RuntimeScheduleSnapshot,
  RuntimeStepScheduler,
} from "./scheduler.ts";

async function scheduler_for(block: Block): Promise<{
  readonly lifecycle: RuntimeLifecycle;
  readonly scheduler: RuntimeStepScheduler;
}> {
  const lifecycle = new RuntimeLifecycle({
    guest: {
      artifact: parse_game_artifact({
        guest_id: "scheduled-game",
        artifact_digest: "artifact-1",
        schema_digest: "schema-1",
        wasm: new Uint8Array([1]),
        capabilities: [],
      }),
      blocks: [block],
    },
    capabilities: [],
    observer: new Observer({
      source: { subsystem: "runtime" },
      sink: create_test_sink(),
      clock: { now_seconds: () => 1 },
    }),
  });
  await lifecycle.initialize();
  await lifecycle.start();
  return {
    lifecycle,
    scheduler: new RuntimeStepScheduler({
      runtime: lifecycle,
      fixed_step_us: microseconds(10_000),
      maximum_catch_up_steps: 3,
    }),
  };
}

Deno.test("step scheduling bounds catch-up and retains one elapsed frame", async () => {
  const fixed_sequences: number[] = [];
  const frame_deltas: number[] = [];
  const { lifecycle, scheduler } = await scheduler_for({
    id: "game",
    dependencies: [],
    capabilities: [],
    acquire: () => ({
      fixed_step: ({ fixed_step_sequence }) => {
        fixed_sequences.push(fixed_step_sequence);
      },
      frame: ({ delta_seconds }) => {
        frame_deltas.push(delta_seconds);
      },
    }),
  });
  try {
    await scheduler.advance(microseconds(50_000));
    assertEquals(fixed_sequences, [0, 1, 2]);
    assertEquals(frame_deltas, [0.05]);
    assertEquals(scheduler.snapshot(), {
      elapsed_us: microseconds(50_000),
      accumulator_us: microseconds(0),
      next_frame_id: frame_id(1),
      fixed_step_sequence: runtime_sequence(3),
    });
  } finally {
    await lifecycle.close();
  }
});

Deno.test("zero elapsed still presents one frame without a fixed step", async () => {
  let fixed_steps = 0;
  let frames = 0;
  const { lifecycle, scheduler } = await scheduler_for({
    id: "game",
    dependencies: [],
    capabilities: [],
    acquire: () => ({
      fixed_step: () => {
        fixed_steps += 1;
      },
      frame: () => {
        frames += 1;
      },
    }),
  });
  try {
    await scheduler.advance(microseconds(0));
    assertEquals({ fixed_steps, frames }, { fixed_steps: 0, frames: 1 });
  } finally {
    await lifecycle.close();
  }
});

Deno.test("schedule snapshots restore exact counters", async () => {
  const { lifecycle, scheduler } = await scheduler_for({
    id: "game",
    dependencies: [],
    capabilities: [],
    acquire: () => ({}),
  });
  try {
    const restored: RuntimeScheduleSnapshot = {
      elapsed_us: microseconds(25_000),
      accumulator_us: microseconds(5_000),
      next_frame_id: frame_id(7),
      fixed_step_sequence: runtime_sequence(2),
    };
    scheduler.restore(restored);
    assertEquals(scheduler.snapshot(), restored);
    scheduler.reset();
    assertEquals(scheduler.snapshot().next_frame_id, frame_id(0));
  } finally {
    await lifecycle.close();
  }
});

Deno.test("scheduler construction rejects a zero fixed step", async () => {
  const { lifecycle } = await scheduler_for({
    id: "game",
    dependencies: [],
    capabilities: [],
    acquire: () => ({}),
  });
  try {
    assertThrows(
      () =>
        new RuntimeStepScheduler({
          runtime: lifecycle,
          fixed_step_us: microseconds(0),
        }),
      Error,
      "runtime fixed step must be positive",
    );
  } finally {
    await lifecycle.close();
  }
});

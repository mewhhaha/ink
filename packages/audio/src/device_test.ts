import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { AudioGraphSnapshot } from "./graph.ts";
import type { AudioPlan } from "./mixer.ts";
import type { AudioClip } from "./model.ts";
import { AudioDevice, type AudioOutput } from "./device.ts";

class FakeOutput implements AudioOutput {
  current_time_seconds = 2;
  readonly plans: AudioPlan[] = [];
  resume_error: Error | undefined;
  close_error: Error | undefined;
  installed_graph_revision: number | undefined;

  install_clip(_clip: AudioClip): void {}
  install_graph(graph: AudioGraphSnapshot): void {
    this.installed_graph_revision = graph.revision;
  }
  apply(plan: AudioPlan): void {
    this.plans.push(plan);
  }
  resume(): Promise<void> {
    return this.resume_error === undefined
      ? Promise.resolve()
      : Promise.reject(this.resume_error);
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return this.close_error === undefined
      ? Promise.resolve()
      : Promise.reject(this.close_error);
  }
}

const empty_plan: AudioPlan = {
  commands: [],
  stolen: [],
  dropped_sequences: [],
};

Deno.test("unavailable audio leaves gameplay-facing submission operational", () => {
  const device = new AudioDevice({ maximum_retained_commands: 2 });
  device.submit(empty_plan);
  assertEquals(device.state.type, "unavailable");
});

Deno.test("blocked audio retains a bounded tail and replays after activation", async () => {
  const output = new FakeOutput();
  const device = new AudioDevice({ output, maximum_retained_commands: 1 });
  const command = { type: "pause" as const, audio_time: 1 };
  device.submit({
    ...empty_plan,
    commands: [command, { ...command, audio_time: 2 }],
  });
  assertEquals(device.retained_commands, [{ ...command, audio_time: 2 }]);
  assertEquals((await device.activate()).type, "running");
  assertEquals(output.plans[0].commands, [{ ...command, audio_time: 2 }]);
});

Deno.test("activation failure remains an explicit blocked state", async () => {
  const output = new FakeOutput();
  output.resume_error = new Error("gesture missing");
  const device = new AudioDevice({ output, maximum_retained_commands: 1 });
  assertEquals(await device.activate(), {
    type: "blocked",
    reason: "audio output activation failed: gesture missing",
  });
});

Deno.test("interruption requires evidence and recovery is counted", async () => {
  const device = new AudioDevice({
    output: new FakeOutput(),
    maximum_retained_commands: 0,
  });
  assertThrows(() => device.interrupt(""), Error, "cannot be empty");
  device.interrupt("device changed");
  assertEquals(device.state, { type: "interrupted", reason: "device changed" });
  assertEquals((await device.recover(1)).type, "running");
});

Deno.test("native close failures include the failed operation", async () => {
  const output = new FakeOutput();
  output.close_error = new Error("driver stopped");
  const device = new AudioDevice({ output, maximum_retained_commands: 0 });
  await assertRejects(
    () => device.close(),
    Error,
    "audio output close failed: driver stopped",
  );
});

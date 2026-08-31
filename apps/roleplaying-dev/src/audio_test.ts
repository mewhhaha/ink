import type { AudioOutput } from "@ink/audio/device.ts";
import type { AudioGraphSnapshot } from "@ink/audio/graph.ts";
import type { AudioPlan } from "@ink/audio/mixer.ts";
import type { AudioClip } from "@ink/audio/model.ts";
import { asset_id } from "@ink/assets/identity.ts";
import { assertEquals } from "@std/assert";
import { RoleplayingAudio } from "./audio.ts";

Deno.test("role-playing audio bounds accepted and retained command state", async () => {
  const output = new RecordingAudioOutput();
  const audio = new RoleplayingAudio({
    output,
    now_seconds: () => 1,
  });
  assertEquals((await audio.activate()).type, "running");
  for (const cue of ["one", "two", "three", "four", "five", "six", "seven"]) {
    audio.play(asset_id<"audio">(`roleplaying.${cue}`));
  }

  assertEquals(audio.snapshot(), {
    accepted: [
      { cue: "roleplaying.two", sequence: 1 },
      { cue: "roleplaying.three", sequence: 2 },
      { cue: "roleplaying.four", sequence: 3 },
      { cue: "roleplaying.five", sequence: 4 },
      { cue: "roleplaying.six", sequence: 5 },
      { cue: "roleplaying.seven", sequence: 6 },
    ],
    command_capacity: 6,
    retained_commands: 0,
    state: "running",
  });
  assertEquals(output.applied_plans, 7);
  await audio.close();
});

class RecordingAudioOutput implements AudioOutput {
  readonly current_time_seconds = 0;
  applied_plans = 0;

  install_clip(_clip: AudioClip): void {}

  install_graph(_graph: AudioGraphSnapshot): void {}

  apply(_plan: AudioPlan): void {
    this.applied_plans += 1;
  }

  async resume(): Promise<void> {}

  async suspend(): Promise<void> {}

  async close(): Promise<void> {}
}

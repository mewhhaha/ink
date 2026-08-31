import type { AudioOutput } from "@ink/audio/device.ts";
import type { AudioGraphSnapshot } from "@ink/audio/graph.ts";
import type { AudioPlan } from "@ink/audio/mixer.ts";
import type { AudioClip } from "@ink/audio/model.ts";
import { asset_id } from "@ink/assets/identity.ts";
import { assertEquals } from "@std/assert";
import { ShooterAudio } from "./audio.ts";

Deno.test("authored shooter effects reach the canonical audio output", async () => {
  const output = new RecordingAudioOutput();
  const audio = new ShooterAudio(output);

  assertEquals((await audio.activate()).type, "running");
  audio.play(asset_id<"audio">("shooter.fire.sidearm"));
  audio.play(asset_id<"audio">("shooter.complete.clear-arena"));

  assertEquals(output.installed_graphs, 1);
  assertEquals(output.installed_clips, [
    "shooter.fire.sidearm",
    "shooter.complete.clear-arena",
  ]);
  assertEquals(output.plans.length, 2);
  assertEquals(audio.evidence(), { state: "running", submitted_cues: 2 });
  await audio.close();
  assertEquals(output.closed, true);
});

Deno.test("repeated fire effects reuse the installed clip", async () => {
  const output = new RecordingAudioOutput();
  const audio = new ShooterAudio(output);
  await audio.activate();
  const cue = asset_id<"audio">("shooter.fire.sidearm");

  audio.play(cue);
  audio.play(cue);

  assertEquals(output.installed_clips, ["shooter.fire.sidearm"]);
  assertEquals(output.plans.length, 2);
  await audio.close();
});

class RecordingAudioOutput implements AudioOutput {
  current_time_seconds = 0;
  installed_graphs = 0;
  installed_clips: string[] = [];
  plans: AudioPlan[] = [];
  closed = false;

  install_clip(clip: AudioClip): void {
    this.installed_clips.push(clip.id);
  }

  install_graph(_graph: AudioGraphSnapshot): void {
    this.installed_graphs += 1;
  }

  apply(plan: AudioPlan): void {
    this.plans.push(plan);
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

import type { AudioOutput } from "@ink/audio/device.ts";
import type { AudioGraphSnapshot } from "@ink/audio/graph.ts";
import type { AudioPlan } from "@ink/audio/mixer.ts";
import type { AudioClip } from "@ink/audio/model.ts";
import { asset_id } from "@ink/assets/identity.ts";
import { assertEquals } from "@std/assert";
import { NarrativeAudio } from "./audio.ts";

Deno.test("authored choice cues run through the canonical audio device", async () => {
  const output = new RecordingAudioOutput();
  const audio = new NarrativeAudio(output);

  assertEquals((await audio.activate()).type, "running");
  assertEquals(
    audio.play(asset_id<"audio">("narrative.choice.follow-signal")).type,
    "running",
  );
  assertEquals(output.installed_graphs, 1);
  assertEquals(output.installed_clips, ["narrative.choice.follow-signal"]);
  assertEquals(output.plans.length, 1);
  const command = output.plans[0].commands[0];
  assertEquals(command.type, "start");
  if (command.type === "start") {
    assertEquals(command.voice.source, {
      type: "clip",
      id: "narrative.choice.follow-signal",
    });
  }
  await audio.close();
  assertEquals(output.closed, true);
});

Deno.test("replaying one authored cue reuses its installed clip", async () => {
  const output = new RecordingAudioOutput();
  const audio = new NarrativeAudio(output);
  await audio.activate();
  const cue = asset_id<"audio">("narrative.choice.board-train");

  audio.play(cue);
  audio.play(cue);

  assertEquals(output.installed_clips, ["narrative.choice.board-train"]);
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

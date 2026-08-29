import { assertEquals } from "@std/assert";
import { AdventureAudio } from "./audio.ts";

Deno.test("adventure audio keeps gameplay cues safe when output is unavailable", async () => {
  const audio = new AdventureAudio();
  assertEquals(audio.state.type, "unavailable");
  audio.cue({ done: false, label: "Brass key acquired", value: "Unlock" });
  audio.cue({ done: false, label: "Oak gate unlocked", value: "Enter" });
  audio.cue({ done: true, label: "Adventure", value: "Complete" });
  assertEquals((await audio.activate()).type, "unavailable");
  await audio.close();
});

import { assertEquals } from "@std/assert";
import { create_choice_cue } from "./audio.ts";

Deno.test("choice audio reports browser unavailability with the device reason", async () => {
  const cue = create_choice_cue(() => {
    throw new Error("audio device missing");
  });
  assertEquals(await cue.play(), {
    type: "unavailable",
    reason: "audio device missing",
  });
  await cue.close();
});

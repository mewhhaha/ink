import { assertEquals } from "@std/assert";
import { apply_editor_action, initial_editor_state } from "./logic.ts";

Deno.test("play starts a stopped editor", () => {
  assertEquals(
    apply_editor_action(initial_editor_state, { type: "play" }),
    { playback: "playing", elapsedSeconds: 0, frame: 0 },
  );
});

Deno.test("advance moves the frame clock only while playing", () => {
  const playing = apply_editor_action(initial_editor_state, { type: "play" });
  const advanced = apply_editor_action(playing, {
    type: "advance",
    deltaSeconds: 1 / 30,
  });
  const paused = apply_editor_action(
    apply_editor_action(advanced, { type: "pause" }),
    { type: "advance", deltaSeconds: 1 },
  );

  assertEquals(advanced.frame, 1);
  assertEquals(advanced.elapsedSeconds, 1 / 30);
  assertEquals(paused, { ...advanced, playback: "paused" });
});

Deno.test("stop resets playback and the frame clock", () => {
  const playing = apply_editor_action(initial_editor_state, { type: "play" });
  const advanced = apply_editor_action(playing, {
    type: "advance",
    deltaSeconds: 2,
  });

  assertEquals(
    apply_editor_action(advanced, { type: "stop" }),
    initial_editor_state,
  );
});

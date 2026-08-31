import { assertEquals } from "@std/assert";
import {
  adventure_action_enabled,
  apply_editor_action,
  initial_editor_state,
} from "./logic.ts";

Deno.test("play starts a stopped editor", () => {
  assertEquals(
    apply_editor_action(initial_editor_state, { type: "play" }),
    { playback: "playing" },
  );
});

Deno.test("stop resets playback", () => {
  const playing = apply_editor_action(initial_editor_state, { type: "play" });

  assertEquals(
    apply_editor_action(playing, { type: "stop" }),
    initial_editor_state,
  );
});

Deno.test("gameplay actions require active playback", () => {
  const paint = { type: "custom", kind: 11, target: 8, value: 0 } as const;

  assertEquals(adventure_action_enabled("stopped", paint), false);
  assertEquals(adventure_action_enabled("paused", paint), false);
  assertEquals(adventure_action_enabled("playing", paint), true);
});

Deno.test("semantic activation remains disabled while playback is stopped", () => {
  assertEquals(
    adventure_action_enabled("stopped", { type: "activate", target: 3 }),
    false,
  );
});

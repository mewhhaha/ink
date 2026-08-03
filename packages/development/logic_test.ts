import { assertEquals } from "@std/assert";
import {
  apply_editor_action,
  game_action_enabled,
  initial_editor_state,
  wheel_zoom_action,
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

Deno.test("wheel movement becomes a directional camera zoom action", () => {
  assertEquals(wheel_zoom_action(-40), { type: "zoom", direction: "in" });
  assertEquals(wheel_zoom_action(40), { type: "zoom", direction: "out" });
  assertEquals(wheel_zoom_action(0), undefined);
  assertEquals(wheel_zoom_action(Number.NaN), undefined);
});

Deno.test("gameplay actions require active playback", () => {
  const paint = { type: "custom", kind: 11, target: 8, value: 0 } as const;

  assertEquals(game_action_enabled("stopped", paint), false);
  assertEquals(game_action_enabled("paused", paint), false);
  assertEquals(game_action_enabled("playing", paint), true);
});

Deno.test("camera zoom remains available while playback is stopped", () => {
  assertEquals(
    game_action_enabled("stopped", { type: "zoom", direction: "in" }),
    true,
  );
});

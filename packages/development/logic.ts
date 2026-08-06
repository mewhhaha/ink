import {
  Do,
  get,
  put,
  run_state_terminal,
  type StateValue,
} from "@mewhhaha/typeclasses";
import type { GameAction } from "@ink/blot/protocol.ts";

export type PlaybackStatus = "stopped" | "playing" | "paused";

export interface EditorState {
  readonly playback: PlaybackStatus;
}

export type EditorAction =
  | { readonly type: "play" }
  | { readonly type: "pause" }
  | { readonly type: "stop" };

export const initial_editor_state: EditorState = {
  playback: "stopped",
};

export function editor_transition(
  action: EditorAction,
): StateValue<EditorState, void> {
  return Do(function* () {
    const current = yield* get<EditorState>();
    return yield* put(next_editor_state(current, action));
  });
}

export function apply_editor_action(
  current: EditorState,
  action: EditorAction,
): EditorState {
  const [, next] = run_state_terminal(editor_transition(action), current);
  return next;
}

export function wheel_zoom_action(delta_y: number): GameAction | undefined {
  if (!Number.isFinite(delta_y) || delta_y === 0) return undefined;
  return { type: "zoom", direction: delta_y < 0 ? "in" : "out" };
}

export function game_action_enabled(
  playback: PlaybackStatus,
  action: GameAction,
): boolean {
  return action.type === "zoom" || playback === "playing";
}

function next_editor_state(
  current: EditorState,
  action: EditorAction,
): EditorState {
  switch (action.type) {
    case "play":
      return { ...current, playback: "playing" };
    case "pause":
      return current.playback === "playing"
        ? { ...current, playback: "paused" }
        : current;
    case "stop":
      return initial_editor_state;
  }
}

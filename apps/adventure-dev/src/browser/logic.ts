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

export function adventure_action_enabled(
  playback: PlaybackStatus,
  action: GameAction,
): boolean {
  if (!["stopped", "playing", "paused"].includes(playback)) {
    throw new Error(
      `editor playback ${JSON.stringify(playback)} is unsupported`,
    );
  }
  if (!["focus", "activate", "custom"].includes(action.type)) {
    throw new Error(
      `game action ${JSON.stringify(action.type)} is unsupported`,
    );
  }
  return playback === "playing";
}

function next_editor_state(
  current: EditorState,
  action: EditorAction,
): EditorState {
  if (!["stopped", "playing", "paused"].includes(current.playback)) {
    throw new Error(
      `editor playback ${JSON.stringify(current.playback)} is unsupported`,
    );
  }
  const type = action.type as string;
  if (!["play", "pause", "stop"].includes(type)) {
    throw new Error(`editor action ${JSON.stringify(type)} is unsupported`);
  }
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

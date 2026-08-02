import {
  Do,
  get,
  put,
  run_state_terminal,
  type StateValue,
} from "@mewhhaha/typeclasses";

export type PlaybackStatus = "stopped" | "playing" | "paused";

export interface EditorState {
  readonly playback: PlaybackStatus;
  readonly elapsedSeconds: number;
  readonly frame: number;
}

export type EditorAction =
  | { readonly type: "play" }
  | { readonly type: "pause" }
  | { readonly type: "stop" }
  | { readonly type: "advance"; readonly deltaSeconds: number };

export const initial_editor_state: EditorState = {
  playback: "stopped",
  elapsedSeconds: 0,
  frame: 0,
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
    case "advance":
      if (current.playback !== "playing") return current;

      return {
        ...current,
        elapsedSeconds: current.elapsedSeconds +
          Math.max(0, action.deltaSeconds),
        frame: current.frame + 1,
      };
  }
}

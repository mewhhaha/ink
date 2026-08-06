import type { GameAction, GameObservation } from "@ink/blot/protocol.ts";
import type { EditorAction, PlaybackStatus } from "./logic.ts";

export interface GameDevelopmentContext {
  readonly observation: GameObservation | undefined;
  readonly playback: PlaybackStatus;
  readonly can_interact: boolean;
  readonly dispatch_game_action: (action: GameAction) => Promise<void>;
  readonly dispatch_preview_update: (
    action: Extract<GameAction, { readonly type: "custom" }>,
  ) => Promise<void>;
  readonly dispatch_transport: (action: EditorAction) => Promise<void>;
}

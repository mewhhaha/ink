import type { GameAction, GameObservation } from "@ink/blot/protocol.ts";
import type { GizmoVisibility } from "@ink/development/debugger.ts";
import type { EditorAction, PlaybackStatus } from "./logic.ts";
import type { AdventureHostCameraOverride } from "./presentation.ts";

export interface GameDevelopmentContext {
  readonly observation: GameObservation | undefined;
  readonly playback: PlaybackStatus;
  readonly can_interact: boolean;
  readonly gizmo_visibility: GizmoVisibility;
  readonly dispatch_game_action: (action: GameAction) => Promise<void>;
  readonly dispatch_preview_update: (
    action: Extract<GameAction, { readonly type: "custom" }>,
  ) => Promise<void>;
  readonly set_host_camera: (camera: AdventureHostCameraOverride) => void;
  readonly dispatch_transport: (action: EditorAction) => Promise<void>;
}

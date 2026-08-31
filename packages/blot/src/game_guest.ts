import type {
  ActionDescription,
  BlotHostEffect,
  GameStatus,
  GameViewport,
  RenderSnapshot,
} from "./protocol.ts";
import type { UiSnapshot } from "@ink/ui/semantic.ts";

export interface GameStepResult {
  readonly state: GameState;
  readonly effects: readonly BlotHostEffect[];
}

export interface GameGuest {
  readonly state_schema: string;
  start(): GameState;
  step(
    state: GameState,
    event_kind: number,
    target: number,
    value: number,
    delta_us: number,
  ): GameStepResult;
  describe(
    state: GameState,
    viewport: GameViewport,
    revision: number,
  ): {
    readonly actions: readonly ActionDescription[];
    readonly ui: UiSnapshot;
    readonly status: GameStatus;
  };
  render(state: GameState, viewport: GameViewport): RenderSnapshot;
}

export interface GameState {
  readonly scalar: bigint;
  readonly cells: readonly bigint[];
}

import type {
  ActionDescription,
  GameStatus,
  GameViewport,
  RenderSnapshot,
  SemanticRegion,
} from "./protocol.ts";

export interface GameGuest {
  readonly state_schema: string;
  start(): GameState;
  step(
    state: GameState,
    event_kind: number,
    target: number,
    value: number,
    delta_us: number,
  ): GameState;
  describe(
    state: GameState,
    viewport: GameViewport,
  ): {
    readonly actions: readonly ActionDescription[];
    readonly regions: readonly SemanticRegion[];
    readonly status: GameStatus;
  };
  render(state: GameState, viewport: GameViewport): RenderSnapshot;
}

export interface GameState {
  readonly scalar: bigint;
  readonly cells: readonly bigint[];
}

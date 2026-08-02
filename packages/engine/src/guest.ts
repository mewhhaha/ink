import type {
  ActionDescription,
  GameStatus,
  GameViewport,
  RenderSnapshot,
  SemanticRegion,
} from "./protocol.ts";

export interface GameGuest {
  start(): bigint;
  step(
    state: bigint,
    event_kind: number,
    target: number,
    value: number,
    delta_us: number,
  ): bigint;
  describe(
    state: bigint,
    viewport: GameViewport,
  ): {
    readonly actions: readonly ActionDescription[];
    readonly regions: readonly SemanticRegion[];
    readonly status: GameStatus;
  };
  render(state: bigint, viewport: GameViewport): RenderSnapshot;
}

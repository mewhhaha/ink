import {
  Effect,
  type Effect as EffectValue,
  type Operation,
  Program,
} from "@mewhhaha/typeclasses";
import type { HeadlessSession } from "./headless_session.ts";
import type { GameGuest } from "./guest.ts";
import type { SessionContext } from "./headless_session.ts";
import type {
  GameAction,
  GameObservation,
  GameReplay,
  GameTraceEvent,
  GameViewport,
  RenderSnapshot,
} from "./protocol.ts";

type ResetGame = Operation<GameObservation> & readonly ["game.reset"];
type DescribeGame = Operation<GameObservation> & readonly ["game.describe"];
type StepGame =
  & Operation<GameObservation>
  & readonly [
    "game.step",
    { readonly action: GameAction; readonly delta_us: number },
  ];
type SaveGame = Operation<string> & readonly ["game.save"];
type LoadGame = Operation<GameObservation> & readonly ["game.load", string];
type FinishReplay = Operation<GameReplay> & readonly ["game.finish_replay"];
type ReplayGame =
  & Operation<GameObservation>
  & readonly ["game.replay", GameReplay];
type TraceGame =
  & Operation<readonly GameTraceEvent[]>
  & readonly ["game.trace"];
type RenderGame = Operation<RenderSnapshot> & readonly ["game.render"];
type SetGameViewport =
  & Operation<GameObservation>
  & readonly ["game.set_viewport", GameViewport];
type ReloadGame =
  & Operation<ReloadResult>
  & readonly [
    "game.reload",
    { readonly guest: GameGuest; readonly context: SessionContext },
  ];
type CloseGame = Operation<void> & readonly ["game.close"];

export interface ReloadResult {
  readonly observation: GameObservation;
  readonly preserved: boolean;
}

export interface GameFrame {
  readonly observation: GameObservation;
  readonly snapshot: RenderSnapshot;
}

export type GameOperation =
  | ResetGame
  | DescribeGame
  | StepGame
  | SaveGame
  | LoadGame
  | FinishReplay
  | ReplayGame
  | TraceGame
  | RenderGame
  | SetGameViewport
  | ReloadGame
  | CloseGame;

export function reset_game(): EffectValue<ResetGame, GameObservation> {
  return Effect.send(Effect.operation<GameObservation>()(["game.reset"]));
}

export function describe_game(): EffectValue<DescribeGame, GameObservation> {
  return Effect.send(Effect.operation<GameObservation>()(["game.describe"]));
}

export function step_game(
  action: GameAction,
  delta_us = 16_667,
): EffectValue<StepGame, GameObservation> {
  return Effect.send(
    Effect.operation<GameObservation>()(["game.step", { action, delta_us }]),
  );
}

export function save_game(): EffectValue<SaveGame, string> {
  return Effect.send(Effect.operation<string>()(["game.save"]));
}

export function load_game(
  source: string,
): EffectValue<LoadGame, GameObservation> {
  return Effect.send(
    Effect.operation<GameObservation>()(["game.load", source]),
  );
}

export function finish_game_replay(): EffectValue<FinishReplay, GameReplay> {
  return Effect.send(Effect.operation<GameReplay>()(["game.finish_replay"]));
}

export function replay_game(
  replay: GameReplay,
): EffectValue<ReplayGame, GameObservation> {
  return Effect.send(
    Effect.operation<GameObservation>()(["game.replay", replay]),
  );
}

export function trace_game(): EffectValue<
  TraceGame,
  readonly GameTraceEvent[]
> {
  return Effect.send(
    Effect.operation<readonly GameTraceEvent[]>()(["game.trace"]),
  );
}

export function render_game(): EffectValue<RenderGame, RenderSnapshot> {
  return Effect.send(Effect.operation<RenderSnapshot>()(["game.render"]));
}

export function set_game_viewport(
  viewport: GameViewport,
): EffectValue<SetGameViewport, GameObservation> {
  return Effect.send(
    Effect.operation<GameObservation>()(["game.set_viewport", viewport]),
  );
}

export function reload_game(
  guest: GameGuest,
  context: SessionContext,
): EffectValue<ReloadGame, ReloadResult> {
  return Effect.send(
    Effect.operation<ReloadResult>()(["game.reload", { guest, context }]),
  );
}

export function close_game(): EffectValue<CloseGame, void> {
  return Effect.send(Effect.operation<void>()(["game.close"]));
}

export function describe_game_frame(): EffectValue<
  GameOperation,
  GameFrame
> {
  return Program(function* () {
    const observation = yield* describe_game();
    const snapshot = yield* render_game();
    return { observation, snapshot };
  });
}

export function step_game_frame(
  action: GameAction,
  delta_us = 16_667,
): EffectValue<GameOperation, GameFrame> {
  return Program(function* () {
    const observation = yield* step_game(action, delta_us);
    const snapshot = yield* render_game();
    return { observation, snapshot };
  });
}

export function reset_game_frame(): EffectValue<GameOperation, GameFrame> {
  return Program(function* () {
    const observation = yield* reset_game();
    const snapshot = yield* render_game();
    return { observation, snapshot };
  });
}

export function resize_game_frame(
  viewport: GameViewport,
): EffectValue<GameOperation, GameFrame> {
  return Program(function* () {
    const observation = yield* set_game_viewport(viewport);
    const snapshot = yield* render_game();
    return { observation, snapshot };
  });
}

export function reload_game_frame(
  guest: GameGuest,
  context: SessionContext,
): EffectValue<
  GameOperation,
  ReloadResult & { readonly snapshot: RenderSnapshot }
> {
  return Program(function* () {
    const reloaded = yield* reload_game(guest, context);
    const snapshot = yield* render_game();
    return { ...reloaded, snapshot };
  });
}

export async function run_game_program<result>(
  effect: EffectValue<GameOperation, result>,
  session: HeadlessSession,
): Promise<result> {
  let current = effect as EffectValue<GameOperation, unknown>;
  while (current[0] === "impure") {
    const operation = current[1];
    const output = await run_game_operation(operation, session);
    current = current[2](output) as EffectValue<GameOperation, unknown>;
  }
  return current[1] as result;
}

async function run_game_operation(
  operation: GameOperation,
  session: HeadlessSession,
): Promise<unknown> {
  switch (operation[0]) {
    case "game.reset":
      return await session.reset();
    case "game.describe":
      return session.describe();
    case "game.step":
      return await session.step(operation[1].action, operation[1].delta_us);
    case "game.save":
      return await session.save();
    case "game.load":
      return await session.load(operation[1]);
    case "game.finish_replay":
      return session.finish_replay();
    case "game.replay":
      return await session.replay(operation[1]);
    case "game.trace":
      return session.trace();
    case "game.render":
      return session.render();
    case "game.set_viewport":
      return session.set_viewport(operation[1]);
    case "game.reload":
      return await session.reload(operation[1].guest, operation[1].context);
    case "game.close":
      return session.close();
  }
}

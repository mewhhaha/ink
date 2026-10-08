/**
 * A running game: a Blot guest exporting `step` (and optionally `start`) over
 * Ink's step packets. Browser- and Deno-safe; compiling lives in
 * `@ink/blot/compiler`.
 */
import { instantiateGuest } from "@mewhhaha/blot/guest";
import {
  decodeStepResult,
  encodeInput,
  type InputModel,
  type Schema,
  stepPacket,
  type StepResult,
} from "@ink/schema";

export interface Game {
  /** Advance one step from `state` with `input`. */
  step(state: Float32Array, input: InputModel): StepResult;
  /** Run the game's `start` entry when play begins, if it has one. */
  start(state: Float32Array, input: InputModel): StepResult;
  readonly hasStart: boolean;
  dispose(): void;
}

export class GameError extends Error {
  override name = "GameError";
}

export async function loadGame(
  bytes: Uint8Array,
  schema: Schema,
): Promise<Game> {
  const guest = await instantiateGuest(bytes);
  const exports = new Set(guest.abi.functions.map((f) => f.name));
  if (!exports.has("step")) {
    guest.dispose();
    throw new GameError(
      "the game must export `entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes`",
    );
  }
  const call = (name: string, state: Float32Array, input: InputModel) => {
    const lanes = guest.call(
      name,
      stepPacket(encodeInput(schema, input), state),
    ) as Float32Array;
    return decodeStepResult(schema, lanes);
  };
  const hasStart = exports.has("start");
  return {
    step: (state, input) => call("step", state, input),
    start: (state, input) =>
      hasStart ? call("start", state, input) : { state, events: [] },
    hasStart,
    dispose: () => guest.dispose(),
  };
}

/** Where Ink's Blot library lives; the compiler maps `ink/` here. */
export const libraryUrl: URL = new URL(
  /* @vite-ignore */ "./lib/",
  import.meta.url,
);

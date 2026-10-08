/**
 * Step a game without any UI: for tests, the CLI and agents checking logic.
 */
import {
  type EventModel,
  idleInput,
  type InputModel,
  type Schema,
} from "@ink/schema";
import type { GameInstance } from "./session.ts";

export interface HeadlessRun {
  state: Float32Array;
  events: { tick: number; events: EventModel[] }[];
}

/** Run `start` (when `start` is true) then one step per input. A number runs
 * that many idle steps. The host owns the tick, as in a session. */
export function runHeadless(
  game: GameInstance,
  schema: Schema,
  state: Float32Array,
  inputs: InputModel[] | number,
  options: { start?: boolean; dt?: number } = {},
): HeadlessRun {
  const dt = options.dt ?? 1 / 60;
  const events: HeadlessRun["events"] = [];
  let current = state;
  const first = current[1];
  if (options.start) {
    const result = game.start(current, idleInput(schema, first, 0));
    current = result.state;
    current[1] = first;
    if (result.events.length) {
      events.push({ tick: first, events: result.events });
    }
  }
  const count = typeof inputs === "number" ? inputs : inputs.length;
  for (let i = 0; i < count; i++) {
    const tick = current[1];
    const input = typeof inputs === "number"
      ? { ...idleInput(schema, tick, dt), time: (tick - first) * dt }
      : inputs[i];
    const result = game.step(current, input);
    current = result.state;
    current[1] = tick + 1;
    if (result.events.length) events.push({ tick, events: result.events });
  }
  return { state: current, events };
}

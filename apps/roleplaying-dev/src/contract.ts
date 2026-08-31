import type { GameAction } from "@ink/blot/protocol.ts";
import type { BlotRuntimeSession } from "@ink/blot/runtime.ts";
import { microseconds, type RuntimeRevision } from "@ink/runtime/session.ts";

export const roleplaying_timeline_step_us = 250_000;

export async function advance_roleplaying_timeline_action(
  session: BlotRuntimeSession,
  action: GameAction,
): Promise<RuntimeRevision> {
  await session.advance({
    elapsed_us: microseconds(roleplaying_timeline_step_us),
    inputs: [],
  });
  return await session.advance({
    elapsed_us: microseconds(0),
    inputs: [action],
  });
}

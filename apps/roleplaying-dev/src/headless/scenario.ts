import type { BlotRuntimeSession } from "@ink/blot/runtime.ts";
import { microseconds } from "@ink/runtime/session.ts";
import { create_roleplaying_session } from "../runtime.ts";

const viewport = { width: 960, height: 540 };
const action_ids = [
  "talk-keeper",
  "travel-ruins",
  "defeat-sentinel",
  "collect-loot",
  "reach-shrine",
] as const;

export async function run_headless_scenario(): Promise<void> {
  const result = await play_roleplaying_session(
    await open_roleplaying_session(),
  );
  await Deno.stdout.write(
    new TextEncoder().encode(`${JSON.stringify(result)}\n`),
  );
}

export async function open_roleplaying_session(): Promise<BlotRuntimeSession> {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(
      new URL("../../generated/roleplaying_development.wasm", import.meta.url),
    ),
    Deno.readTextFile(
      new URL(
        "../../generated/roleplaying_development.wasm.json",
        import.meta.url,
      ),
    ),
  ]);
  return await create_roleplaying_session(wasm_bytes, manifest_source);
}

export async function play_roleplaying_session(session: BlotRuntimeSession) {
  try {
    let presentation = await session.observe(viewport);
    let checksum = "";
    for (const action_id of action_ids) {
      const action = presentation.observation.actions.find(({ id }) =>
        id === action_id
      )?.action;
      if (action === undefined) {
        throw new Error(`role-playing action ${action_id} is missing`);
      }
      const revision = await session.advance({
        elapsed_us: microseconds(0),
        inputs: [action],
      });
      checksum = revision.snapshot_checksum;
      presentation = await session.observe(viewport);
    }
    if (!presentation.observation.status.done) {
      throw new Error(`role-playing playthrough did not reach the shrine`);
    }
    const replay = await session.finish_replay();
    await session.reset();
    const replayed = await session.replay(replay);
    return Object.freeze({
      ending: presentation.observation.status.label,
      outcome: presentation.observation.status.value,
      checksum,
      replay_checksum: replayed.snapshot_checksum,
    });
  } finally {
    await session.close();
  }
}

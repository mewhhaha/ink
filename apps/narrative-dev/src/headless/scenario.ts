import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import type { GameAction } from "@ink/blot/protocol.ts";
import { microseconds } from "@ink/runtime/session.ts";
import { create_narrative_session } from "../runtime.ts";

const viewport = { width: 960, height: 540 };

export interface NarrativeOutcome {
  readonly choice_id: string;
  readonly ending: string;
  readonly evidence: string;
  readonly snapshot_checksum: string;
  readonly replay_checksum: string;
}

export async function play_generated_narrative(
  directory = new URL("../../generated/", import.meta.url),
  artifact_name = "narrative_development",
): Promise<readonly NarrativeOutcome[]> {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(new URL(`${artifact_name}.wasm`, directory)),
    Deno.readTextFile(new URL(`${artifact_name}.wasm.json`, directory)),
  ]);
  const first = await play_choice(wasm_bytes, manifest_source, "follow-signal");
  const second = await play_choice(wasm_bytes, manifest_source, "board-train");
  return Object.freeze([first, second]);
}

async function play_choice(
  wasm_bytes: Uint8Array,
  manifest_source: string,
  choice_id: string,
): Promise<NarrativeOutcome> {
  const session = await create_narrative_session(wasm_bytes, manifest_source);
  try {
    const initial = await session.observe(viewport);
    const revision = await session.advance({
      elapsed_us: microseconds(0),
      inputs: [required_action(initial, choice_id)],
    });
    const ending = await session.observe(viewport);
    if (!ending.observation.status.done) {
      throw new Error(
        `narrative choice ${choice_id} did not reach an ending: ${ending.observation.status.value}`,
      );
    }
    const replay = await session.finish_replay();
    await session.reset();
    const replayed = await session.replay(replay);
    return Object.freeze({
      choice_id,
      ending: ending.observation.status.label,
      evidence: ending.observation.status.value,
      snapshot_checksum: revision.snapshot_checksum,
      replay_checksum: replayed.snapshot_checksum,
    });
  } finally {
    await session.close();
  }
}

export function required_action(
  presentation: BlotPresentation,
  id: string,
): GameAction {
  const description = presentation.observation.actions.find((action) =>
    action.id === id
  );
  if (description === undefined) {
    throw new Error(`narrative action ${JSON.stringify(id)} is missing`);
  }
  return description.action;
}

export async function open_narrative_session(
  directory = new URL("../../generated/", import.meta.url),
  artifact_name = "narrative_development",
): Promise<BlotRuntimeSession> {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(new URL(`${artifact_name}.wasm`, directory)),
    Deno.readTextFile(new URL(`${artifact_name}.wasm.json`, directory)),
  ]);
  return await create_narrative_session(wasm_bytes, manifest_source);
}

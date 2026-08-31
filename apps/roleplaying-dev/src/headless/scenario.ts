import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import type { GameAction, SceneObjectCommand } from "@ink/blot/protocol.ts";
import { microseconds } from "@ink/runtime/session.ts";
import {
  advance_roleplaying_timeline_action,
  roleplaying_timeline_step_us,
} from "../contract.ts";
import { create_roleplaying_runtime } from "../runtime.ts";

const viewport = Object.freeze({ width: 960, height: 540 });

export interface RoleplayingPlaythroughEvidence {
  readonly initial: BlotPresentation;
  readonly talked: BlotPresentation;
  readonly arrived_at_ruins: BlotPresentation;
  readonly first_strike: BlotPresentation;
  readonly sentinel_defeated: BlotPresentation;
  readonly loot_collected: BlotPresentation;
  readonly completed: BlotPresentation;
  readonly replayed: BlotPresentation;
  readonly snapshot_checksum: string;
  readonly replay_checksum: string;
}

export interface RoleplayingTimelineGuardEvidence {
  readonly out_of_order: BlotPresentation;
  readonly too_early: BlotPresentation;
  readonly on_time: BlotPresentation;
}

export async function play_roleplaying_to_shrine(
  session: BlotRuntimeSession,
): Promise<RoleplayingPlaythroughEvidence> {
  const initial = await session.observe(viewport);
  const talked = await activate_and_observe(
    session,
    initial,
    "activate:roleplaying.talk",
  );
  const arrived_at_ruins = await activate_and_observe(
    session,
    talked,
    "activate:roleplaying.travel-ruins",
  );
  const first_strike = await activate_and_observe(
    session,
    arrived_at_ruins,
    "activate:roleplaying.attack",
  );
  const sentinel_defeated = await activate_and_observe(
    session,
    first_strike,
    "activate:roleplaying.attack",
  );
  const loot_collected = await activate_and_observe(
    session,
    sentinel_defeated,
    "activate:roleplaying.collect-loot",
  );
  const completed_revision = await advance_roleplaying_timeline_action(
    session,
    required_roleplaying_action(
      loot_collected,
      "activate:roleplaying.travel-shrine",
    ),
  );
  const completed = await session.observe(viewport);
  const replay = await session.finish_replay();
  await session.reset();
  const replayed_revision = await session.replay(replay);
  const replayed = await session.observe(viewport);
  return Object.freeze({
    initial,
    talked,
    arrived_at_ruins,
    first_strike,
    sentinel_defeated,
    loot_collected,
    completed,
    replayed,
    snapshot_checksum: completed_revision.snapshot_checksum,
    replay_checksum: replayed_revision.snapshot_checksum,
  });
}

export async function probe_roleplaying_timeline_guards(
  session: BlotRuntimeSession,
): Promise<RoleplayingTimelineGuardEvidence> {
  await session.advance({
    elapsed_us: microseconds(roleplaying_timeline_step_us * 6),
    inputs: [],
  });
  await session.advance({
    elapsed_us: microseconds(0),
    inputs: [{ type: "activate", target: 20 }],
  });
  const out_of_order = await session.observe(viewport);

  await session.reset();
  await session.advance({
    elapsed_us: microseconds(roleplaying_timeline_step_us - 1),
    inputs: [],
  });
  await session.advance({
    elapsed_us: microseconds(0),
    inputs: [{ type: "activate", target: 10 }],
  });
  const too_early = await session.observe(viewport);
  await session.advance({
    elapsed_us: microseconds(1),
    inputs: [],
  });
  await session.advance({
    elapsed_us: microseconds(0),
    inputs: [{ type: "activate", target: 10 }],
  });
  const on_time = await session.observe(viewport);
  await session.reset();

  return Object.freeze({ out_of_order, too_early, on_time });
}

export async function play_generated_roleplaying(
  directory = new URL("../../generated/", import.meta.url),
  artifact_name = "roleplaying_development",
): Promise<RoleplayingPlaythroughEvidence> {
  const runtime = await create_roleplaying_runtime({
    wasm_bytes: await Deno.readFile(
      new URL(`${artifact_name}.wasm`, directory),
    ),
    manifest_source: await Deno.readTextFile(
      new URL(`${artifact_name}.wasm.json`, directory),
    ),
  });
  try {
    return await play_roleplaying_to_shrine(runtime.session);
  } finally {
    await runtime.session.close();
  }
}

export function rendered_roleplaying_object(
  presentation: BlotPresentation,
  object_id: number,
): SceneObjectCommand {
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  if (object === undefined) {
    throw new Error(
      `role-playing render snapshot is missing object ${object_id}`,
    );
  }
  return object;
}

function required_roleplaying_action(
  presentation: BlotPresentation,
  id: string,
): GameAction {
  const description = presentation.observation.actions.find((candidate) =>
    candidate.id === id
  );
  if (description === undefined) {
    throw new Error(`role-playing action ${JSON.stringify(id)} is missing`);
  }
  return description.action;
}

async function activate_and_observe(
  session: BlotRuntimeSession,
  presentation: BlotPresentation,
  action_id: string,
): Promise<BlotPresentation> {
  await advance_roleplaying_timeline_action(
    session,
    required_roleplaying_action(presentation, action_id),
  );
  return await session.observe(viewport);
}

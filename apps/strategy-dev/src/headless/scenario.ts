import type { GameAction, SceneObjectCommand } from "@ink/blot/protocol.ts";
import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import { microseconds } from "@ink/runtime/session.ts";
import { create_strategy_runtime } from "../runtime.ts";

const viewport = Object.freeze({ width: 960, height: 540 });

export interface StrategyPlaythroughEvidence {
  readonly initial: BlotPresentation;
  readonly early_attack: BlotPresentation;
  readonly trained: readonly BlotPresentation[];
  readonly route: readonly BlotPresentation[];
  readonly headquarters_hits: readonly BlotPresentation[];
  readonly completed: BlotPresentation;
  readonly replayed: BlotPresentation;
  readonly snapshot_checksum: string;
  readonly replay_checksum: string;
}

export async function play_strategy_to_victory(
  session: BlotRuntimeSession,
): Promise<StrategyPlaythroughEvidence> {
  const initial = await session.observe(viewport);
  const early_attack = await activate_and_observe(
    session,
    initial,
    "activate:strategy.attack-headquarters",
  );
  const trained: BlotPresentation[] = [];
  let presentation = early_attack;
  for (let scout = 0; scout < 3; scout += 1) {
    presentation = await activate_and_observe(
      session,
      presentation,
      "activate:strategy.train-scout",
    );
    trained.push(presentation);
  }
  const route: BlotPresentation[] = [];
  for (let point = 0; point < 4; point += 1) {
    presentation = await activate_and_observe(
      session,
      presentation,
      "activate:strategy.advance-route",
    );
    route.push(presentation);
  }
  const headquarters_hits: BlotPresentation[] = [];
  for (let hit = 0; hit < 2; hit += 1) {
    presentation = await activate_and_observe(
      session,
      presentation,
      "activate:strategy.attack-headquarters",
    );
    headquarters_hits.push(presentation);
  }
  const completed_revision = await session.advance({
    elapsed_us: microseconds(0),
    inputs: [required_action(
      presentation,
      "activate:strategy.attack-headquarters",
    )],
  });
  const completed = await session.observe(viewport);
  const replay = await session.finish_replay();
  await session.reset();
  const replayed_revision = await session.replay(replay);
  const replayed = await session.observe(viewport);
  return Object.freeze({
    initial,
    early_attack,
    trained: Object.freeze(trained),
    route: Object.freeze(route),
    headquarters_hits: Object.freeze(headquarters_hits),
    completed,
    replayed,
    snapshot_checksum: completed_revision.snapshot_checksum,
    replay_checksum: replayed_revision.snapshot_checksum,
  });
}

export async function play_generated_strategy(
  directory = new URL("../../generated/", import.meta.url),
  artifact_name = "strategy_development",
): Promise<StrategyPlaythroughEvidence> {
  const runtime = await create_strategy_runtime({
    wasm_bytes: await Deno.readFile(
      new URL(`${artifact_name}.wasm`, directory),
    ),
    manifest_source: await Deno.readTextFile(
      new URL(`${artifact_name}.wasm.json`, directory),
    ),
  });
  try {
    return await play_strategy_to_victory(runtime.session);
  } finally {
    await runtime.session.close();
  }
}

export function rendered_strategy_object(
  presentation: BlotPresentation,
  object_id: number,
): SceneObjectCommand {
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  if (object === undefined) {
    throw new Error(`strategy render snapshot is missing object ${object_id}`);
  }
  return object;
}

function required_action(
  presentation: BlotPresentation,
  action_id: string,
): GameAction {
  const description = presentation.observation.actions.find(({ id }) =>
    id === action_id
  );
  if (description === undefined) {
    throw new Error(
      `strategy presentation omitted required action ${
        JSON.stringify(action_id)
      }`,
    );
  }
  return description.action;
}

async function activate_and_observe(
  session: BlotRuntimeSession,
  presentation: BlotPresentation,
  action_id: string,
): Promise<BlotPresentation> {
  await session.advance({
    elapsed_us: microseconds(0),
    inputs: [required_action(presentation, action_id)],
  });
  return await session.observe(viewport);
}

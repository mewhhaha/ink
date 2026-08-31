import type { GameAction, SceneObjectCommand } from "@ink/blot/protocol.ts";
import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import { microseconds } from "@ink/runtime/session.ts";
import { create_shooter_runtime } from "../runtime.ts";

const viewport = Object.freeze({ width: 960, height: 540 });

export interface ShooterPlaythroughEvidence {
  readonly initial: BlotPresentation;
  readonly guard_hit: BlotPresentation;
  readonly reinforcement_arrived: BlotPresentation;
  readonly reinforcement_hit: BlotPresentation;
  readonly completed: BlotPresentation;
  readonly replayed: BlotPresentation;
  readonly snapshot_checksum: string;
  readonly replay_checksum: string;
}

export async function play_shooter_to_clear(
  session: BlotRuntimeSession,
): Promise<ShooterPlaythroughEvidence> {
  const initial = await session.observe(viewport);
  const guard_hit = await fire_and_observe(session, initial);
  const reinforcement_arrived = await fire_and_observe(session, guard_hit);
  const reinforcement_hit = await fire_and_observe(
    session,
    reinforcement_arrived,
  );
  const completed_revision = await session.advance({
    elapsed_us: microseconds(0),
    inputs: [required_fire_action(reinforcement_hit)],
  });
  const completed = await session.observe(viewport);
  const replay = await session.finish_replay();
  await session.reset();
  const replayed_revision = await session.replay(replay);
  const replayed = await session.observe(viewport);
  return Object.freeze({
    initial,
    guard_hit,
    reinforcement_arrived,
    reinforcement_hit,
    completed,
    replayed,
    snapshot_checksum: completed_revision.snapshot_checksum,
    replay_checksum: replayed_revision.snapshot_checksum,
  });
}

export async function play_generated_shooter(
  directory = new URL("../../generated/", import.meta.url),
  artifact_name = "shooter_development",
): Promise<ShooterPlaythroughEvidence> {
  const runtime = await create_shooter_runtime({
    wasm_bytes: await Deno.readFile(
      new URL(`${artifact_name}.wasm`, directory),
    ),
    manifest_source: await Deno.readTextFile(
      new URL(`${artifact_name}.wasm.json`, directory),
    ),
  });
  try {
    return await play_shooter_to_clear(runtime.session);
  } finally {
    await runtime.session.close();
  }
}

export function rendered_shooter_object(
  presentation: BlotPresentation,
  object_id: number,
): SceneObjectCommand {
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  if (object === undefined) {
    throw new Error(`shooter render snapshot is missing object ${object_id}`);
  }
  return object;
}

function required_fire_action(presentation: BlotPresentation): GameAction {
  const description = presentation.observation.actions.find(({ id }) =>
    id === "activate:shooter.fire"
  );
  if (description === undefined) {
    throw new Error("shooter presentation omitted the authored fire action");
  }
  return description.action;
}

async function fire_and_observe(
  session: BlotRuntimeSession,
  presentation: BlotPresentation,
): Promise<BlotPresentation> {
  await session.advance({
    elapsed_us: microseconds(0),
    inputs: [required_fire_action(presentation)],
  });
  return await session.observe(viewport);
}

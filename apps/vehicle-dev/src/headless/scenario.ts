import type { GameAction, SceneObjectCommand } from "@ink/blot/protocol.ts";
import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import { microseconds } from "@ink/runtime/session.ts";

const viewport = Object.freeze({ width: 960, height: 540 });

export interface VehiclePlaythroughEvidence {
  readonly initial: BlotPresentation;
  readonly early_finish: BlotPresentation;
  readonly start: BlotPresentation;
  readonly ridge: BlotPresentation;
  readonly tunnel: BlotPresentation;
  readonly completed: BlotPresentation;
  readonly replayed: BlotPresentation;
  readonly snapshot_checksum: string;
  readonly replay_checksum: string;
}

export async function play_vehicle_course(
  session: BlotRuntimeSession,
): Promise<VehiclePlaythroughEvidence> {
  const initial = await session.observe(viewport);
  const early_finish = await activate_and_observe(
    session,
    initial,
    "finish-line",
  );
  const start = await activate_and_observe(session, early_finish, "start");
  const ridge = await activate_and_observe(session, start, "ridge");
  const tunnel = await activate_and_observe(session, ridge, "tunnel");
  const completed_revision = await session.advance({
    elapsed_us: microseconds(0),
    inputs: [required_checkpoint_action(tunnel, "finish-line")],
  });
  const completed = await session.observe(viewport);
  const replay = await session.finish_replay();
  await session.reset();
  const replayed_revision = await session.replay(replay);
  const replayed = await session.observe(viewport);
  return Object.freeze({
    initial,
    early_finish,
    start,
    ridge,
    tunnel,
    completed,
    replayed,
    snapshot_checksum: completed_revision.snapshot_checksum,
    replay_checksum: replayed_revision.snapshot_checksum,
  });
}

export function rendered_vehicle_object(
  presentation: BlotPresentation,
  object_id: number,
): SceneObjectCommand {
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  if (object === undefined) {
    throw new Error(`vehicle render snapshot is missing object ${object_id}`);
  }
  return object;
}

function required_checkpoint_action(
  presentation: BlotPresentation,
  waypoint_id: string,
): GameAction {
  const action_id = `activate:vehicle.checkpoint.${waypoint_id}`;
  const description = presentation.observation.actions.find(({ id }) =>
    id === action_id
  );
  if (description === undefined) {
    throw new Error(
      `vehicle presentation omitted authored action ${action_id}`,
    );
  }
  return description.action;
}

async function activate_and_observe(
  session: BlotRuntimeSession,
  presentation: BlotPresentation,
  waypoint_id: string,
): Promise<BlotPresentation> {
  await session.advance({
    elapsed_us: microseconds(0),
    inputs: [required_checkpoint_action(presentation, waypoint_id)],
  });
  return await session.observe(viewport);
}

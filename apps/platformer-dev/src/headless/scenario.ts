import type {
  BlotPresentation,
  BlotRuntimeSession,
} from "@ink/blot/runtime.ts";
import type { SceneObjectCommand } from "@ink/blot/protocol.ts";
import { control_id, device_identity } from "@ink/input/model.ts";
import {
  recorded_frame_id,
  type RecordedDeviceFrame,
  RecordedInputAdapter,
} from "@ink/input/recording.ts";
import { SyntheticInputAdapter } from "@ink/input/synthetic.ts";
import { microseconds } from "@ink/runtime/identity.ts";
import { PlatformerInputController } from "../input.ts";

export const platformer_scenario_viewport = Object.freeze({
  width: 960,
  height: 540,
});
export const platformer_scenario_frame_us = 50_000;
export const platformer_scenario_run_frames = 73;

export interface PlatformerPlaythroughEvidence {
  readonly initial: BlotPresentation;
  readonly before_jump: BlotPresentation;
  readonly airborne: BlotPresentation;
  readonly completed: BlotPresentation;
  readonly replayed: BlotPresentation;
  readonly snapshot_checksum: string;
  readonly replay_checksum: string;
  readonly encoded_input_frames: readonly string[];
}

const keyboard = device_identity("keyboard", "default");
const recorded_input_frames: readonly RecordedDeviceFrame[] = Object.freeze([
  Object.freeze({
    frame_id: recorded_frame_id(0),
    events: Object.freeze([
      Object.freeze({ type: "connect" as const, device: keyboard }),
      Object.freeze({
        type: "button" as const,
        device: keyboard,
        control: control_id("key:ArrowRight"),
        pressed: true,
      }),
    ]),
  }),
  Object.freeze({
    frame_id: recorded_frame_id(1),
    events: Object.freeze([Object.freeze({
      type: "button" as const,
      device: keyboard,
      control: control_id("key:ArrowRight"),
      pressed: false,
    })]),
  }),
  Object.freeze({
    frame_id: recorded_frame_id(2),
    events: Object.freeze([Object.freeze({
      type: "button" as const,
      device: keyboard,
      control: control_id("key:Space"),
      pressed: true,
    })]),
  }),
  Object.freeze({
    frame_id: recorded_frame_id(3),
    events: Object.freeze([Object.freeze({
      type: "button" as const,
      device: keyboard,
      control: control_id("key:Space"),
      pressed: false,
    })]),
  }),
]);

export async function play_platformer_to_exit(
  session: BlotRuntimeSession,
): Promise<PlatformerPlaythroughEvidence> {
  const initial = await session.observe(platformer_scenario_viewport);
  const recorded_input = new PlatformerInputController(
    new RecordedInputAdapter(recorded_input_frames),
  );
  const synthetic_source = new SyntheticInputAdapter();
  const synthetic_input = new PlatformerInputController(synthetic_source);
  let next_input_frame = 0;
  const capture_matching_input_actions = () => {
    const recorded_frame = recorded_input_frames[next_input_frame];
    if (recorded_frame === undefined) {
      throw new Error(
        `platformer input sequence has no recorded frame ${next_input_frame}`,
      );
    }
    for (const event of recorded_frame.events) synthetic_source.enqueue(event);
    const recorded_actions = recorded_input.capture_actions(
      initial.observation.actions,
    );
    synthetic_input.capture_actions(initial.observation.actions);
    const recorded_source = recorded_input.encoded_frames().at(-1);
    const synthetic_frame_source = synthetic_input.encoded_frames().at(-1);
    if (recorded_source !== synthetic_frame_source) {
      throw new Error(
        `platformer input frame ${recorded_frame.frame_id} normalized differently: recorded ${recorded_source}, synthetic ${synthetic_frame_source}`,
      );
    }
    next_input_frame += 1;
    return recorded_actions;
  };
  await session.advance({
    elapsed_us: microseconds(0),
    inputs: capture_matching_input_actions(),
  });
  capture_matching_input_actions();
  for (let frame = 0; frame < platformer_scenario_run_frames; frame += 1) {
    await session.advance({
      elapsed_us: microseconds(platformer_scenario_frame_us),
      inputs: [],
    });
  }
  const before_jump = await session.observe(platformer_scenario_viewport);
  await session.advance({
    elapsed_us: microseconds(0),
    inputs: capture_matching_input_actions(),
  });
  capture_matching_input_actions();
  await session.advance({
    elapsed_us: microseconds(platformer_scenario_frame_us),
    inputs: [],
  });
  const airborne = await session.observe(platformer_scenario_viewport);
  const completed_revision = await session.advance({
    elapsed_us: microseconds(platformer_scenario_frame_us),
    inputs: [],
  });
  const completed = await session.observe(platformer_scenario_viewport);
  const replay = await session.finish_replay();
  await session.reset();
  const replayed_revision = await session.replay(replay);
  const replayed = await session.observe(platformer_scenario_viewport);
  return Object.freeze({
    initial,
    before_jump,
    airborne,
    completed,
    replayed,
    snapshot_checksum: completed_revision.snapshot_checksum,
    replay_checksum: replayed_revision.snapshot_checksum,
    encoded_input_frames: recorded_input.encoded_frames(),
  });
}

export function rendered_platformer_object(
  presentation: BlotPresentation,
  object_id: number,
): SceneObjectCommand {
  const object = presentation.snapshot.objects.find(({ id }) =>
    id === object_id
  );
  if (object === undefined) {
    throw new Error(
      `platformer render snapshot is missing object ${object_id}`,
    );
  }
  return object;
}

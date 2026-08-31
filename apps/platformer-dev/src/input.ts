import type { ActionDescription, GameAction } from "@ink/blot/protocol.ts";
import { ActionEvaluator, create_action_map } from "@ink/input/actions.ts";
import type { DeviceInputFrame } from "@ink/input/model.ts";
import { action_id, control_id } from "@ink/input/model.ts";
import { encode_input_frame } from "@ink/input/recording.ts";
import { frame_id, type FrameId } from "@ink/runtime/frame.ts";

interface PlatformerDeviceSource {
  capture(frame: FrameId): DeviceInputFrame;
}

const platformer_action_map_result = create_action_map({
  version: 1,
  contexts: [{
    id: "platformer",
    priority: 0,
    consume: true,
    actions: [
      {
        id: action_id("platformer.move_right"),
        type: "digital",
        bindings: [{
          id: "keyboard.move_right",
          type: "button",
          control: {
            device_kind: "keyboard",
            control: control_id("key:ArrowRight"),
          },
        }],
      },
      {
        id: action_id("platformer.jump"),
        type: "digital",
        bindings: [{
          id: "keyboard.jump",
          type: "button",
          control: {
            device_kind: "keyboard",
            control: control_id("key:Space"),
          },
        }],
      },
    ],
  }],
});

if (!platformer_action_map_result.ok) {
  const failure = platformer_action_map_result.failure;
  throw new Error(
    `platformer input binding ${failure.context}/${failure.action}/${failure.binding} is invalid: ${failure.reason}`,
  );
}

const platformer_action_map = platformer_action_map_result.value;
const decoder = new TextDecoder();
const guest_action_ids = Object.freeze(
  new Map([
    [action_id("platformer.move_right"), "right-start"],
    [action_id("platformer.jump"), "jump"],
  ]),
);

export class PlatformerInputController {
  readonly #source: PlatformerDeviceSource;
  readonly #evaluator = new ActionEvaluator(platformer_action_map);
  readonly #encoded_frames: string[] = [];
  #next_frame = 0;

  constructor(source: PlatformerDeviceSource) {
    this.#source = source;
  }

  capture_actions(
    descriptions: readonly ActionDescription[],
  ): readonly GameAction[] {
    const devices = this.#source.capture(frame_id(this.#next_frame));
    this.#next_frame += 1;
    const frame = this.#evaluator.evaluate(devices);
    this.#encoded_frames.push(decoder.decode(encode_input_frame(frame)));

    const actions: GameAction[] = [];
    for (const snapshot of frame.actions) {
      if (
        snapshot.value.type !== "digital" ||
        snapshot.value.phase !== "pressed"
      ) continue;
      const guest_action_id = guest_action_ids.get(snapshot.id);
      if (guest_action_id === undefined) {
        throw new Error(
          `platformer input action ${
            JSON.stringify(snapshot.id)
          } has no guest action mapping`,
        );
      }
      const description = descriptions.find(({ id }) => id === guest_action_id);
      if (description === undefined) {
        throw new Error(
          `platformer guest omitted action ${
            JSON.stringify(guest_action_id)
          } for input ${JSON.stringify(snapshot.id)}`,
        );
      }
      actions.push(description.action);
    }
    return Object.freeze(actions);
  }

  encoded_frames(): readonly string[] {
    return Object.freeze([...this.#encoded_frames]);
  }
}

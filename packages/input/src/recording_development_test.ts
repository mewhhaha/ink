import { assertEquals, assertThrows } from "@std/assert";
import { frame_id } from "@ink/runtime/frame.ts";
import { vec2 } from "@ink/math/vector.ts";
import { ActionEvaluator, create_action_map } from "./actions.ts";
import { action_id, control_id, device_identity } from "./model.ts";
import {
  decode_input_frame,
  encode_input_frame,
  InputFrameChannel,
  RecordedInputAdapter,
} from "./recording.ts";
import { SyntheticInputAdapter } from "./synthetic.ts";

const pointer = device_identity("pointer", "primary");
const recording_action_map = create_action_map({
  version: 1,
  contexts: [{
    id: "recording",
    priority: 0,
    consume: true,
    actions: [
      {
        id: action_id("pointer.position"),
        type: "axis2",
        bindings: [{
          id: "pointer.position",
          type: "axis2",
          control: { device_kind: "pointer", control: control_id("position") },
          range: "unbounded",
        }],
      },
      {
        id: action_id("pointer.primary"),
        type: "digital",
        bindings: [{
          id: "pointer.primary",
          type: "button",
          control: {
            device_kind: "pointer",
            control: control_id("button:0"),
          },
        }],
      },
      {
        id: action_id("pointer.wheel"),
        type: "axis2",
        bindings: [{
          id: "pointer.wheel",
          type: "axis2",
          control: { device_kind: "pointer", control: control_id("wheel") },
        }],
      },
    ],
  }],
});
const events = [
  {
    type: "axis2",
    device: pointer,
    control: control_id("position"),
    value: vec2(40, 50),
    mode: "absolute",
  },
  {
    type: "button",
    device: pointer,
    control: control_id("button:0"),
    pressed: true,
  },
  {
    type: "axis2",
    device: pointer,
    control: control_id("wheel"),
    value: vec2(0, -20),
    mode: "relative",
  },
] as const;

Deno.test("recorded and synthetic device sequences produce byte-equivalent action frames", () => {
  if (!recording_action_map.ok) {
    throw new Error(recording_action_map.failure.reason);
  }
  const synthetic = new SyntheticInputAdapter();
  for (const event of events) synthetic.enqueue(event);
  const recorded = new RecordedInputAdapter([{
    frame_id: frame_id(0),
    events,
  }]);
  const synthetic_frame = new ActionEvaluator(recording_action_map.value)
    .evaluate(
      synthetic.capture(frame_id(0)),
    );
  const recorded_frame = new ActionEvaluator(recording_action_map.value)
    .evaluate(
      recorded.capture(frame_id(0)),
    );
  assertEquals(
    encode_input_frame(recorded_frame),
    encode_input_frame(synthetic_frame),
  );
  assertEquals(
    decode_input_frame(encode_input_frame(synthetic_frame)),
    synthetic_frame,
  );
});

Deno.test("runtime deterministic channel snapshots and restores the current input frame", () => {
  if (!recording_action_map.ok) {
    throw new Error(recording_action_map.failure.reason);
  }
  const source = new SyntheticInputAdapter();
  for (const event of events) source.enqueue(event);
  const frame = new ActionEvaluator(recording_action_map.value).evaluate(
    source.capture(frame_id(0)),
  );
  const channel = new InputFrameChannel();
  channel.update(frame);
  const snapshot = channel.snapshot();
  channel.restore(new TextEncoder().encode('{"version":1,"frame":null}'));
  assertEquals(channel.current(), null);
  channel.restore(snapshot);
  assertEquals(channel.current(), frame);
});

Deno.test("recorded adapter rejects missing or out-of-order runtime frames", () => {
  const recorded = new RecordedInputAdapter([{
    frame_id: frame_id(2),
    events: [],
  }]);
  assertThrows(
    () => recorded.capture(frame_id(1)),
    Error,
    "recorded input expected frame 2 at sequence 0, received 1",
  );
  assertThrows(
    () =>
      decode_input_frame(
        new TextEncoder().encode('{"version":1,"frame":null}'),
      ),
    Error,
    "input frame must be an object",
  );
});

Deno.test("recorded input rejects invalid UTF-8 and malformed nested values", () => {
  assertThrows(
    () => decode_input_frame(new Uint8Array([0xff])),
    Error,
    "input frame recording is not valid UTF-8",
  );
  assertThrows(
    () =>
      decode_input_frame(
        new TextEncoder().encode(JSON.stringify({
          version: 1,
          frame: {
            frame_id: 0,
            actions: [{
              id: "jump",
              context: "game",
              value: { type: "digital", pressed: false, phase: "held" },
            }],
            devices: {
              frame_id: 0,
              focused: true,
              controls: [],
              contacts: [],
              lifecycle: [],
            },
          },
        })),
      ),
    Error,
    "input action 0 phase held does not match pressed false",
  );
});

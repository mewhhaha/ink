import { assertEquals, assertThrows } from "@std/assert";
import { vec2 } from "@ink/math/vector.ts";
import { frame_id } from "@ink/runtime/frame.ts";
import { create_test_sink } from "@ink/observability/sink.ts";
import { Observer } from "@ink/observability/observer.ts";
import {
  action_id,
  ActionEvaluator,
  create_action_map,
  parse_action_map,
  rebind_action,
  serialize_action_map,
} from "./actions.ts";
import { control_id, device_identity } from "./model.ts";
import { SyntheticInputAdapter } from "./synthetic.ts";

const keyboard = device_identity("keyboard", "default");
const pointer = device_identity("pointer", "primary");
const key_w = control_id("key:KeyW");
const key_s = control_id("key:KeyS");
const key_shift = control_id("key:ShiftLeft");

function action_map() {
  const result = create_action_map({
    version: 1,
    contexts: [{
      id: "gameplay",
      priority: 0,
      consume: true,
      actions: [
        {
          id: action_id("move.y"),
          type: "scalar",
          bindings: [{
            id: "move.keyboard",
            type: "button_axis",
            negative: { device_kind: "keyboard", control: key_s },
            positive: { device_kind: "keyboard", control: key_w },
          }],
        },
        {
          id: action_id("sprint"),
          type: "digital",
          bindings: [{
            id: "sprint.chord",
            type: "button",
            control: { device_kind: "keyboard", control: key_w },
            modifiers: [{ device_kind: "keyboard", control: key_shift }],
          }],
        },
        {
          id: action_id("interact"),
          type: "digital",
          bindings: [{
            id: "interact.keyboard",
            type: "button",
            control: { device_kind: "keyboard", control: key_w },
          }],
        },
      ],
    }],
  });
  if (!result.ok) throw new Error(result.failure.reason);
  return result.value;
}

Deno.test("synthetic controls produce press hold release and deterministic focus loss", () => {
  const source = new SyntheticInputAdapter();
  source.enqueue({ type: "connect", device: keyboard });
  source.enqueue({
    type: "button",
    device: keyboard,
    control: key_w,
    pressed: true,
  });
  assertEquals(source.capture(frame_id(0)).controls[0].type, "button");
  assertEquals(source.capture(frame_id(1)).controls[0], {
    type: "button",
    device: keyboard,
    control: key_w,
    pressed: true,
    phase: "held",
  });
  source.enqueue({ type: "focus", focused: false });
  const lost = source.capture(frame_id(2));
  assertEquals(lost.lifecycle, [{ type: "focus_lost" }]);
  assertEquals(lost.controls[0], {
    type: "button",
    device: keyboard,
    control: key_w,
    pressed: false,
    phase: "released",
  });
});

Deno.test("relative axes accumulate once and then return to neutral", () => {
  const source = new SyntheticInputAdapter();
  source.enqueue({
    type: "axis2",
    device: pointer,
    control: control_id("wheel"),
    value: vec2(0, 4),
    mode: "relative",
  });
  source.enqueue({
    type: "axis2",
    device: pointer,
    control: control_id("wheel"),
    value: vec2(0, -1),
    mode: "relative",
  });
  const accumulated = source.capture(frame_id(0)).controls[0];
  const neutral = source.capture(frame_id(1)).controls[0];
  if (accumulated.type !== "axis2" || neutral.type !== "axis2") {
    throw new Error("wheel control was not normalized as axis2");
  }
  assertEquals(accumulated.value, vec2(0, 3));
  assertEquals(neutral.value, vec2(0, 0));
});

Deno.test("touch cancellation and device hot-plug emit lifecycle without stale controls", () => {
  const source = new SyntheticInputAdapter();
  const touch = device_identity("touch", "screen");
  source.enqueue({ type: "connect", device: touch });
  source.enqueue({
    type: "touch",
    device: touch,
    contact: { id: 7, position: vec2(2, 3), pressure: 0.5 },
  });
  assertEquals(source.capture(frame_id(0)).contacts.length, 1);
  source.enqueue({
    type: "touch_end",
    device: touch,
    contact: 7,
    cancelled: true,
  });
  source.enqueue({ type: "disconnect", device: touch });
  const captured = source.capture(frame_id(1));
  assertEquals(captured.contacts, []);
  assertEquals(captured.lifecycle, [
    { type: "touch_cancelled", device: touch, contact: 7 },
    { type: "disconnected", device: touch },
  ]);
});

Deno.test("action evaluation resolves opposing axes and chord phases", () => {
  const source = new SyntheticInputAdapter();
  const evaluator = new ActionEvaluator(action_map());
  source.enqueue({
    type: "button",
    device: keyboard,
    control: key_w,
    pressed: true,
  });
  source.enqueue({
    type: "button",
    device: keyboard,
    control: key_s,
    pressed: true,
  });
  source.enqueue({
    type: "button",
    device: keyboard,
    control: key_shift,
    pressed: true,
  });
  const first = evaluator.evaluate(source.capture(frame_id(0)));
  assertEquals(first.actions.find((action) => action.id === "move.y")?.value, {
    type: "scalar",
    value: 0,
  });
  assertEquals(first.actions.find((action) => action.id === "sprint")?.value, {
    type: "digital",
    pressed: true,
    phase: "pressed",
  });
  const held = evaluator.evaluate(source.capture(frame_id(1)));
  assertEquals(held.actions.find((action) => action.id === "sprint")?.value, {
    type: "digital",
    pressed: true,
    phase: "held",
  });
});

Deno.test("priority consumption prevents lower contexts from reusing controls", () => {
  const result = create_action_map({
    version: 1,
    contexts: [
      {
        id: "menu",
        priority: 10,
        consume: true,
        actions: [{
          id: action_id("accept"),
          type: "digital",
          bindings: [{
            id: "menu.accept",
            type: "button",
            control: { device_kind: "keyboard", control: key_w },
          }],
        }],
      },
      {
        id: "game",
        priority: 0,
        consume: false,
        actions: [{
          id: action_id("jump"),
          type: "digital",
          bindings: [{
            id: "game.jump",
            type: "button",
            control: { device_kind: "keyboard", control: key_w },
          }],
        }],
      },
    ],
  });
  if (!result.ok) throw new Error(result.failure.reason);
  const source = new SyntheticInputAdapter();
  source.enqueue({
    type: "button",
    device: keyboard,
    control: key_w,
    pressed: true,
  });
  const frame = new ActionEvaluator(result.value).evaluate(
    source.capture(frame_id(0)),
  );
  assertEquals(frame.actions.find((action) => action.id === "accept")?.value, {
    type: "digital",
    pressed: true,
    phase: "pressed",
  });
  assertEquals(frame.actions.find((action) => action.id === "jump")?.value, {
    type: "digital",
    pressed: false,
    phase: "idle",
  });
});

Deno.test("rebindings report accessible conflicts and serialize stably", () => {
  const map = action_map();
  const rebound = rebind_action(map, {
    context: "gameplay",
    action: action_id("sprint"),
    binding: "sprint.chord",
    replacement: {
      id: "ignored",
      type: "button",
      control: { device_kind: "keyboard", control: key_w },
    },
  });
  if (!rebound.ok) throw new Error(rebound.failure.reason);
  assertEquals(rebound.conflicts, [{
    context: "gameplay",
    action: action_id("interact"),
    binding: "interact.keyboard",
    description: "interact in gameplay already uses keyboard/key:KeyW",
  }]);
  const serialized = serialize_action_map(rebound.map);
  const parsed = parse_action_map(serialized);
  if (!parsed.ok) throw new Error(parsed.failure.reason);
  assertEquals(serialize_action_map(parsed.value), serialized);
});

Deno.test("malformed bindings return identity-bearing failures", () => {
  const result = create_action_map({
    version: 1,
    contexts: [{
      id: "game",
      priority: 0,
      consume: false,
      actions: [{
        id: action_id("look"),
        type: "axis2",
        bindings: [{
          id: "look.stick",
          type: "axis2",
          control: { device_kind: "gamepad", control: control_id("axis:0") },
          dead_zone: 1,
        }],
      }],
    }],
  });
  assertEquals(result, {
    ok: false,
    failure: {
      type: "invalid_binding",
      context: "game",
      action: "look",
      binding: "look.stick",
      reason: "dead zone 1 must be in [0, 1)",
    },
  });
  assertEquals(parse_action_map("{").ok, false);
});

Deno.test("input lifecycle observations avoid text input", () => {
  const sink = create_test_sink();
  const observer = new Observer({
    source: { subsystem: "input" },
    sink,
    clock: { now_seconds: () => 0 },
  });
  const source = new SyntheticInputAdapter(observer);
  source.enqueue({ type: "connect", device: keyboard });
  source.capture(frame_id(0));
  assertEquals(
    sink.observations().map((entry) =>
      entry.type === "event" ? entry.name : entry.type
    ),
    ["input_device_connected"],
  );
  assertEquals(JSON.stringify(sink.observations()).includes("key:"), false);
});

Deno.test("invalid synthetic touch pressure fails with contact evidence", () => {
  const source = new SyntheticInputAdapter();
  source.enqueue({
    type: "touch",
    device: device_identity("touch", "screen"),
    contact: { id: 3, position: vec2(0, 0), pressure: 2 },
  });
  assertThrows(
    () => source.capture(frame_id(0)),
    Error,
    "touch contact 3 pressure 2 must be between 0 and 1",
  );
});

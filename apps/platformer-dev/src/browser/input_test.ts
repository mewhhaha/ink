import { control_id, device_identity } from "@ink/input/model.ts";
import { frame_id } from "@ink/runtime/frame.ts";
import { assertEquals } from "@std/assert";
import { PlatformerInputMap } from "./input.ts";

const observation = {
  sequence: 0,
  outcome: "running" as const,
  status: { done: false, label: "Platformer", value: "Run" },
  actions: [{
    id: "right-start",
    label: "Run right",
    action: { type: "custom" as const, kind: 10, target: 0, value: 0 },
  }, {
    id: "right-stop",
    label: "Stop right",
    action: { type: "custom" as const, kind: 11, target: 0, value: 0 },
  }],
  regions: [],
  projection: "orthographic" as const,
  camera_zoom: 0.7,
};

Deno.test("normalized keyboard phases map once into platformer actions", () => {
  const input = new PlatformerInputMap({
    ArrowRight: { pressed: "right-start", released: "right-stop" },
  });
  const keyboard = device_identity("keyboard", "default");
  const pressed = {
    frame_id: frame_id(1),
    focused: true,
    controls: [{
      type: "button" as const,
      device: keyboard,
      control: control_id("key:ArrowRight"),
      pressed: true,
      phase: "pressed" as const,
    }],
    contacts: [],
    lifecycle: [],
  };
  const released = {
    ...pressed,
    frame_id: frame_id(2),
    controls: [{
      ...pressed.controls[0],
      pressed: false,
      phase: "released" as const,
    }],
  };

  assertEquals(input.actions(pressed, observation), [
    observation.actions[0].action,
  ]);
  assertEquals(input.actions(released, observation), [
    observation.actions[1].action,
  ]);
});

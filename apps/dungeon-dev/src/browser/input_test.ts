import { control_id, device_identity } from "@ink/input/model.ts";
import { frame_id } from "@ink/runtime/frame.ts";
import { assertEquals } from "@std/assert";
import { AdventureInputMap } from "./input.ts";

const observation = {
  sequence: 0,
  outcome: "running" as const,
  status: { done: false, label: "Adventure", value: "Explore" },
  actions: [{
    id: "forward-start",
    label: "Forward",
    action: { type: "custom" as const, kind: 10, target: 0, value: 0 },
  }, {
    id: "forward-stop",
    label: "Stop",
    action: { type: "custom" as const, kind: 11, target: 0, value: 0 },
  }],
  regions: [],
  projection: "perspective" as const,
  camera_zoom: 1,
};

Deno.test("normalized keyboard phases map once into adventure actions", () => {
  const input = new AdventureInputMap({
    KeyW: { pressed: "forward-start", released: "forward-stop" },
  });
  const keyboard = device_identity("keyboard", "default");
  const pressed = {
    frame_id: frame_id(1),
    focused: true,
    controls: [{
      type: "button" as const,
      device: keyboard,
      control: control_id("key:KeyW"),
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

  assertEquals(input.actions(pressed, observation, "active"), [
    observation.actions[0].action,
  ]);
  assertEquals(input.actions(pressed, observation, "release_only"), []);
  assertEquals(input.actions(released, observation, "release_only"), [
    observation.actions[1].action,
  ]);
});

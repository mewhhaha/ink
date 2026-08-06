import { action_id, control_id, type InputFrame } from "./model.ts";
import { type ActionMapResult, create_action_map } from "./actions.ts";
import type { Vec2 } from "@ink/math/vector.ts";

export type DevelopmentInputGesture =
  | { readonly type: "zoom"; readonly direction: "in" | "out" }
  | {
    readonly type: "primary_pointer";
    readonly position: Vec2;
    readonly phase: "pressed" | "held";
  };

export function development_action_map(): ActionMapResult {
  return create_action_map({
    version: 1,
    contexts: [{
      id: "development.surface",
      priority: 0,
      consume: true,
      actions: [
        {
          id: action_id("camera.wheel"),
          type: "axis2",
          bindings: [{
            id: "camera.wheel.pointer",
            type: "axis2",
            control: { device_kind: "pointer", control: control_id("wheel") },
          }],
        },
        {
          id: action_id("surface.position"),
          type: "axis2",
          bindings: [{
            id: "surface.position.pointer",
            type: "axis2",
            control: {
              device_kind: "pointer",
              control: control_id("position"),
            },
            range: "unbounded",
          }],
        },
        {
          id: action_id("surface.primary"),
          type: "digital",
          bindings: [{
            id: "surface.primary.pointer",
            type: "button",
            control: {
              device_kind: "pointer",
              control: control_id("button:0"),
            },
          }],
        },
      ],
    }],
  });
}

export function development_input_gestures(
  frame: InputFrame,
): readonly DevelopmentInputGesture[] {
  const gestures: DevelopmentInputGesture[] = [];
  const wheel = frame.actions.find((action) => action.id === "camera.wheel")
    ?.value;
  if (wheel?.type === "axis2" && wheel.value.y !== 0) {
    gestures.push(
      Object.freeze({
        type: "zoom",
        direction: wheel.value.y < 0 ? "in" : "out",
      }),
    );
  }
  const pointer = frame.actions.find((action) =>
    action.id === "surface.position"
  )?.value;
  const primary = frame.actions.find((action) =>
    action.id === "surface.primary"
  )?.value;
  if (
    pointer?.type === "axis2" && primary?.type === "digital" &&
    primary.pressed &&
    (primary.phase === "pressed" || primary.phase === "held")
  ) {
    gestures.push(
      Object.freeze({
        type: "primary_pointer",
        position: pointer.value,
        phase: primary.phase,
      }),
    );
  }
  return Object.freeze(gestures);
}

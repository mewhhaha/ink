import { BrowserInputAdapter } from "@ink/input/browser.ts";
import {
  ActionEvaluator,
  type ControlReference,
  create_action_map,
} from "@ink/input/actions.ts";
import {
  action_id,
  type ActionId,
  control_id,
  type InputFrame,
} from "@ink/input/model.ts";
import type { RenderCamera, RenderVector } from "@ink/rendering/renderer.ts";
import { perspective_render_camera } from "@ink/rendering/renderer.ts";
import { frame_id } from "@ink/runtime/frame.ts";

export class DebugCamera {
  readonly #canvas: HTMLCanvasElement;
  readonly #actions = new ActionEvaluator(debug_camera_action_map);
  readonly #input: BrowserInputAdapter;
  readonly #on_speed_change: (speed: number) => void;
  #frame_sequence = 0;
  #move_speed: number;
  #pitch = 0;
  #position: RenderVector = [0, 0, 0];
  #vertical_fov_radians = Math.PI / 3;
  #yaw = 0;

  constructor(
    canvas: HTMLCanvasElement,
    camera: RenderCamera,
    target: RenderVector,
    move_speed: number,
    on_speed_change: (speed: number) => void,
  ) {
    this.#canvas = canvas;
    this.#on_speed_change = on_speed_change;
    this.#move_speed = move_speed;
    this.#input = new BrowserInputAdapter({
      keyboard_target: globalThis,
      pointer_target: canvas,
      focus_target: globalThis,
      pointer_lock_target: document,
      pointer_locked: () => document.pointerLockElement === canvas,
      accept_keyboard: (event, pressed) =>
        !pressed || !is_text_entry(event.target),
    });
    this.reset(camera, target, move_speed);
  }

  get move_speed(): number {
    return this.#move_speed;
  }

  get pointer_locked(): boolean {
    return document.pointerLockElement === this.#canvas;
  }

  capture_pointer(): Promise<void> {
    return this.#canvas.requestPointerLock();
  }

  reset(camera: RenderCamera, target: RenderVector, move_speed: number): void {
    if (camera.projection.type !== "perspective") {
      throw new Error(
        `debug camera ${camera.id} projection ${camera.projection.type} must be perspective`,
      );
    }
    const position: RenderVector = [
      camera.pose.position.x,
      camera.pose.position.y,
      camera.pose.position.z,
    ];
    const direction: RenderVector = [
      target[0] - position[0],
      target[1] - position[1],
      target[2] - position[2],
    ];
    const length = Math.hypot(...direction);
    if (length < 0.000001) {
      throw new Error("debug camera position and target must differ");
    }
    this.#position = position;
    this.#yaw = Math.atan2(direction[0], -direction[2]);
    this.#pitch = Math.asin(direction[1] / length);
    this.#vertical_fov_radians = camera.projection.vertical_fov_radians;
    this.set_move_speed(move_speed);
  }

  set_move_speed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 150) {
      throw new Error(`debug camera speed ${speed} must be in [0.5, 150]`);
    }
    if (this.#move_speed === speed) return;
    this.#move_speed = speed;
    this.#on_speed_change(speed);
  }

  update(delta_seconds: number): RenderCamera {
    const devices = this.#input.capture(frame_id(this.#frame_sequence));
    this.#frame_sequence += 1;
    const actions = this.#actions.evaluate(devices);
    this.#apply_look(actions);
    this.#apply_wheel(actions);
    this.#apply_movement(actions, Math.min(0.05, Math.max(0, delta_seconds)));
    const forward = this.#forward();
    return perspective_render_camera("lighting.debug", {
      position: this.#position,
      target: [
        this.#position[0] + forward[0],
        this.#position[1] + forward[1],
        this.#position[2] + forward[2],
      ],
      vertical_fov_radians: this.#vertical_fov_radians,
      clear_color: [0, 0, 0],
    });
  }

  dispose(): void {
    this.#input.dispose();
  }

  #apply_look(input: InputFrame): void {
    if (!this.pointer_locked) return;
    const look = input.actions.find(({ id }) => id === look_action)?.value;
    if (look?.type !== "axis2") return;
    this.#yaw += look.value.x * 0.002;
    this.#pitch = Math.max(
      -Math.PI * 0.49,
      Math.min(Math.PI * 0.49, this.#pitch - look.value.y * 0.002),
    );
  }

  #apply_wheel(input: InputFrame): void {
    const wheel = input.actions.find(({ id }) => id === wheel_action)?.value;
    if (wheel?.type !== "axis2" || wheel.value.y === 0) return;
    const next = this.#move_speed * Math.exp(-wheel.value.y * 0.0015);
    this.set_move_speed(Math.max(0.5, Math.min(150, next)));
  }

  #apply_movement(input: InputFrame, delta_seconds: number): void {
    const movement = input.actions.find(({ id }) => id === move_action)?.value;
    const forward_amount = movement?.type === "axis2" ? movement.value.y : 0;
    const right_amount = movement?.type === "axis2" ? movement.value.x : 0;
    const up_amount = Number(digital_action(input, rise_action)) -
      Number(digital_action(input, fall_action));
    const length = Math.hypot(forward_amount, right_amount, up_amount);
    if (length === 0) return;
    const speed_multiplier = digital_action(input, sprint_action) ? 3 : 1;
    const distance = this.#move_speed * speed_multiplier * delta_seconds /
      length;
    const forward = this.#forward();
    const right: RenderVector = [
      Math.cos(this.#yaw),
      0,
      Math.sin(this.#yaw),
    ];
    this.#position = [
      this.#position[0] +
      (forward[0] * forward_amount + right[0] * right_amount) * distance,
      this.#position[1] +
      (forward[1] * forward_amount + up_amount) * distance,
      this.#position[2] +
      (forward[2] * forward_amount + right[2] * right_amount) * distance,
    ];
  }

  #forward(): RenderVector {
    const horizontal = Math.cos(this.#pitch);
    return [
      Math.sin(this.#yaw) * horizontal,
      Math.sin(this.#pitch),
      -Math.cos(this.#yaw) * horizontal,
    ];
  }
}

const move_action = action_id("lighting.debug.move");
const rise_action = action_id("lighting.debug.rise");
const fall_action = action_id("lighting.debug.fall");
const sprint_action = action_id("lighting.debug.sprint");
const look_action = action_id("lighting.debug.look");
const wheel_action = action_id("lighting.debug.wheel");

const parsed_debug_camera_action_map = create_action_map({
  version: 1,
  contexts: [{
    id: "lighting.debug-camera",
    priority: 0,
    consume: true,
    actions: [{
      id: move_action,
      type: "axis2",
      bindings: [{
        id: "lighting.debug.move.keys",
        type: "button_axis2",
        left: keyboard_control("KeyA"),
        right: keyboard_control("KeyD"),
        down: keyboard_control("KeyS"),
        up: keyboard_control("KeyW"),
      }],
    }, {
      id: rise_action,
      type: "digital",
      bindings: ["KeyE", "Space"].map((code) => ({
        id: `lighting.debug.rise.${code}`,
        type: "button" as const,
        control: keyboard_control(code),
      })),
    }, {
      id: fall_action,
      type: "digital",
      bindings: [{
        id: "lighting.debug.fall.KeyQ",
        type: "button",
        control: keyboard_control("KeyQ"),
      }],
    }, {
      id: sprint_action,
      type: "digital",
      bindings: ["ShiftLeft", "ShiftRight"].map((code) => ({
        id: `lighting.debug.sprint.${code}`,
        type: "button" as const,
        control: keyboard_control(code),
      })),
    }, {
      id: look_action,
      type: "axis2",
      bindings: [{
        id: "lighting.debug.look.pointer",
        type: "axis2",
        control: pointer_control("delta"),
        range: "unbounded",
      }],
    }, {
      id: wheel_action,
      type: "axis2",
      bindings: [{
        id: "lighting.debug.wheel.pointer",
        type: "axis2",
        control: pointer_control("wheel"),
        range: "unbounded",
      }],
    }],
  }],
});
if (!parsed_debug_camera_action_map.ok) {
  throw new Error(
    `lighting debug camera action map is invalid: ${parsed_debug_camera_action_map.failure.reason}`,
  );
}
const debug_camera_action_map = parsed_debug_camera_action_map.value;

function keyboard_control(code: string): ControlReference {
  return {
    device_kind: "keyboard",
    control: control_id(`key:${code}`),
  };
}

function pointer_control(name: string): ControlReference {
  return { device_kind: "pointer", control: control_id(name) };
}

function digital_action(input: InputFrame, id: ActionId): boolean {
  const value = input.actions.find((action) => action.id === id)?.value;
  return value?.type === "digital" && value.pressed;
}

function is_text_entry(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}

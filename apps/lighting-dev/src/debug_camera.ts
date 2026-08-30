import { BrowserInputAdapter } from "@ink/input/browser.ts";
import type { DeviceInputFrame } from "@ink/input/model.ts";
import type {
  Simple3dCamera,
  Simple3dVector,
} from "@ink/rendering/simple3d.ts";
import { frame_id } from "@ink/runtime/frame.ts";

export class DebugCamera {
  readonly #canvas: HTMLCanvasElement;
  readonly #input: BrowserInputAdapter;
  readonly #on_speed_change: (speed: number) => void;
  #frame_sequence = 0;
  #move_speed: number;
  #pitch = 0;
  #position: Simple3dVector = [0, 0, 0];
  #vertical_fov_radians = Math.PI / 3;
  #yaw = 0;

  constructor(
    canvas: HTMLCanvasElement,
    camera: Simple3dCamera,
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
    this.reset(camera, move_speed);
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

  reset(camera: Simple3dCamera, move_speed: number): void {
    const direction: Simple3dVector = [
      camera.target[0] - camera.position[0],
      camera.target[1] - camera.position[1],
      camera.target[2] - camera.position[2],
    ];
    const length = Math.hypot(...direction);
    if (length < 0.000001) {
      throw new Error("debug camera position and target must differ");
    }
    this.#position = camera.position;
    this.#yaw = Math.atan2(direction[0], -direction[2]);
    this.#pitch = Math.asin(direction[1] / length);
    this.#vertical_fov_radians = camera.vertical_fov_radians;
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

  update(delta_seconds: number): Simple3dCamera {
    const input = this.#input.capture(frame_id(this.#frame_sequence));
    this.#frame_sequence += 1;
    this.#apply_look(input);
    this.#apply_wheel(input);
    this.#apply_movement(input, Math.min(0.05, Math.max(0, delta_seconds)));
    const forward = this.#forward();
    return {
      position: this.#position,
      target: [
        this.#position[0] + forward[0],
        this.#position[1] + forward[1],
        this.#position[2] + forward[2],
      ],
      vertical_fov_radians: this.#vertical_fov_radians,
    };
  }

  dispose(): void {
    this.#input.dispose();
  }

  #apply_look(input: DeviceInputFrame): void {
    if (!this.pointer_locked) return;
    const look = input.controls.find((control) =>
      control.type === "axis2" && control.device.kind === "pointer" &&
      control.control === "delta"
    );
    if (look?.type !== "axis2") return;
    this.#yaw += look.value.x * 0.002;
    this.#pitch = Math.max(
      -Math.PI * 0.49,
      Math.min(Math.PI * 0.49, this.#pitch - look.value.y * 0.002),
    );
  }

  #apply_wheel(input: DeviceInputFrame): void {
    const wheel = input.controls.find((control) =>
      control.type === "axis2" && control.device.kind === "pointer" &&
      control.control === "wheel"
    );
    if (wheel?.type !== "axis2" || wheel.value.y === 0) return;
    const next = this.#move_speed * Math.exp(-wheel.value.y * 0.0015);
    this.set_move_speed(Math.max(0.5, Math.min(150, next)));
  }

  #apply_movement(input: DeviceInputFrame, delta_seconds: number): void {
    const forward_amount = pressed(input, "KeyW") - pressed(input, "KeyS");
    const right_amount = pressed(input, "KeyD") - pressed(input, "KeyA");
    const up_amount = pressed(input, "KeyE") + pressed(input, "Space") -
      pressed(input, "KeyQ");
    const length = Math.hypot(forward_amount, right_amount, up_amount);
    if (length === 0) return;
    const speed_multiplier = pressed(input, "ShiftLeft") ||
        pressed(input, "ShiftRight")
      ? 3
      : 1;
    const distance = this.#move_speed * speed_multiplier * delta_seconds /
      length;
    const forward = this.#forward();
    const right: Simple3dVector = [
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

  #forward(): Simple3dVector {
    const horizontal = Math.cos(this.#pitch);
    return [
      Math.sin(this.#yaw) * horizontal,
      Math.sin(this.#pitch),
      -Math.cos(this.#yaw) * horizontal,
    ];
  }
}

function pressed(input: DeviceInputFrame, code: string): number {
  const control = input.controls.find((candidate) =>
    candidate.type === "button" && candidate.device.kind === "keyboard" &&
    candidate.control === `key:${code}`
  );
  return control?.type === "button" && control.pressed ? 1 : 0;
}

function is_text_entry(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}

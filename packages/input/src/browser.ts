import { vec2 } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type { FrameId } from "@ink/runtime/frame.ts";
import {
  control_id,
  device_id,
  device_identity,
  type DeviceAvailability,
  type DeviceInputFrame,
} from "./model.ts";
import { SyntheticInputAdapter } from "./synthetic.ts";

export interface XrControlSnapshot {
  readonly id: string;
  readonly buttons: readonly number[];
  readonly axes: readonly number[];
}

export interface XrInputReader {
  snapshots(): readonly XrControlSnapshot[];
}

export interface BrowserInputFeatures {
  readonly keyboard: DeviceAvailability;
  readonly pointer: DeviceAvailability;
  readonly touch: DeviceAvailability;
  readonly gamepad: DeviceAvailability;
  readonly xr: DeviceAvailability;
}

export interface BrowserInputOptions {
  readonly keyboard_target: EventTarget;
  readonly pointer_target: EventTarget;
  readonly lifecycle_target: EventTarget;
  readonly observer?: Observer;
  readonly get_gamepads?: () => readonly (Gamepad | null)[];
  readonly xr?: XrInputReader;
  readonly pointer_locked?: () => boolean;
}

export class BrowserInputAdapter {
  readonly features: BrowserInputFeatures;
  readonly #source: SyntheticInputAdapter;
  readonly #options: BrowserInputOptions;
  readonly #connected = new Set<string>();
  readonly #listeners: readonly {
    target: EventTarget;
    type: string;
    listener: EventListener;
  }[];
  #pointer_locked = false;

  constructor(options: BrowserInputOptions) {
    this.#options = options;
    this.#source = new SyntheticInputAdapter(options.observer);
    this.features = Object.freeze({
      keyboard: "available",
      pointer: "available",
      touch: "available",
      gamepad: options.get_gamepads === undefined ? "unavailable" : "available",
      xr: options.xr === undefined ? "unavailable" : "available",
    });
    if (this.features.gamepad === "unavailable") {
      options.observer?.event("input_adapter_unavailable", {
        device: "gamepad",
      });
    }
    if (this.features.xr === "unavailable") {
      options.observer?.event("input_adapter_unavailable", { device: "xr" });
    }
    this.#listeners = [
      this.#listen(
        options.keyboard_target,
        "keydown",
        (event) => this.#keyboard(event as KeyboardEvent, true),
      ),
      this.#listen(
        options.keyboard_target,
        "keyup",
        (event) => this.#keyboard(event as KeyboardEvent, false),
      ),
      this.#listen(
        options.pointer_target,
        "pointerdown",
        (event) => this.#pointer_button(event as PointerEvent, true),
      ),
      this.#listen(
        options.pointer_target,
        "pointerup",
        (event) => this.#pointer_button(event as PointerEvent, false),
      ),
      this.#listen(
        options.pointer_target,
        "pointermove",
        (event) => this.#pointer_move(event as PointerEvent),
      ),
      this.#listen(
        options.pointer_target,
        "pointercancel",
        (event) => this.#pointer_cancel(event as PointerEvent),
      ),
      this.#listen(
        options.pointer_target,
        "wheel",
        (event) => this.#wheel(event as WheelEvent),
      ),
      this.#listen(
        options.pointer_target,
        "touchstart",
        (event) => this.#touch(event as TouchEvent, "update"),
      ),
      this.#listen(
        options.pointer_target,
        "touchmove",
        (event) => this.#touch(event as TouchEvent, "update"),
      ),
      this.#listen(
        options.pointer_target,
        "touchend",
        (event) => this.#touch(event as TouchEvent, "end"),
      ),
      this.#listen(
        options.pointer_target,
        "touchcancel",
        (event) => this.#touch(event as TouchEvent, "cancel"),
      ),
      this.#listen(
        options.lifecycle_target,
        "blur",
        () => this.#source.enqueue({ type: "focus", focused: false }),
      ),
      this.#listen(
        options.lifecycle_target,
        "focus",
        () => this.#source.enqueue({ type: "focus", focused: true }),
      ),
      this.#listen(
        options.lifecycle_target,
        "pointerlockchange",
        () => this.#pointer_lock(),
      ),
    ];
  }

  capture(frame_id: FrameId): DeviceInputFrame {
    this.#poll_gamepads();
    this.#poll_xr();
    return this.#source.capture(frame_id);
  }

  dispose(): void {
    for (const { target, type, listener } of this.#listeners) {
      target.removeEventListener(type, listener);
    }
  }

  #listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
  ): { target: EventTarget; type: string; listener: EventListener } {
    target.addEventListener(type, listener);
    return { target, type, listener };
  }

  #connect(kind: "keyboard" | "pointer" | "touch", id: string) {
    const device = device_identity(kind, id);
    if (!this.#connected.has(device.id)) {
      this.#connected.add(device.id);
      this.#source.enqueue({ type: "connect", device });
    }
    return device;
  }

  #keyboard(event: KeyboardEvent, pressed: boolean): void {
    if (event.code.trim().length === 0 || event.repeat && pressed) return;
    this.#source.enqueue({
      type: "button",
      device: this.#connect("keyboard", "default"),
      control: control_id(`key:${event.code}`),
      pressed,
    });
  }

  #pointer_button(event: PointerEvent, pressed: boolean): void {
    if (!Number.isSafeInteger(event.button) || event.button < 0) {
      return this.#reject("pointer_button", event.button);
    }
    this.#source.enqueue({
      type: "button",
      device: this.#connect("pointer", String(event.pointerId)),
      control: control_id(`button:${event.button}`),
      pressed,
    });
  }

  #pointer_move(event: PointerEvent): void {
    if (
      ![event.clientX, event.clientY, event.movementX, event.movementY].every(
        Number.isFinite,
      )
    ) {
      return this.#reject(
        "pointer_move",
        `${event.clientX},${event.clientY},${event.movementX},${event.movementY}`,
      );
    }
    const device = this.#connect("pointer", String(event.pointerId));
    this.#source.enqueue({
      type: "axis2",
      device,
      control: control_id("position"),
      value: vec2(event.clientX, event.clientY),
      mode: "absolute",
    });
    this.#source.enqueue({
      type: "axis2",
      device,
      control: control_id("delta"),
      value: vec2(event.movementX, event.movementY),
      mode: "relative",
    });
  }

  #pointer_cancel(event: PointerEvent): void {
    const device = this.#connect("pointer", String(event.pointerId));
    for (let button = 0; button < 5; button++) {
      this.#source.enqueue({
        type: "button",
        device,
        control: control_id(`button:${button}`),
        pressed: false,
      });
    }
  }

  #wheel(event: WheelEvent): void {
    if (![event.deltaX, event.deltaY].every(Number.isFinite)) {
      return this.#reject("wheel", `${event.deltaX},${event.deltaY}`);
    }
    const device = this.#connect("pointer", "wheel");
    this.#source.enqueue({
      type: "axis2",
      device,
      control: control_id("wheel"),
      value: vec2(event.deltaX, event.deltaY),
      mode: "relative",
    });
  }

  #touch(event: TouchEvent, phase: "update" | "end" | "cancel"): void {
    const device = this.#connect("touch", "screen");
    for (const contact of Array.from(event.changedTouches)) {
      if (phase === "update") {
        const pressure = contact.force === 0 ? 1 : contact.force;
        this.#source.enqueue({
          type: "touch",
          device,
          contact: Object.freeze({
            id: contact.identifier,
            position: vec2(contact.clientX, contact.clientY),
            pressure,
          }),
        });
        this.#source.enqueue({
          type: "axis2",
          device,
          control: control_id("position"),
          value: vec2(contact.clientX, contact.clientY),
          mode: "absolute",
        });
        this.#source.enqueue({
          type: "button",
          device,
          control: control_id("primary"),
          pressed: true,
        });
      } else {
        this.#source.enqueue({
          type: "touch_end",
          device,
          contact: contact.identifier,
          cancelled: phase === "cancel",
        });
      }
    }
    if (phase !== "update" && event.touches.length === 0) {
      this.#source.enqueue({
        type: "button",
        device,
        control: control_id("primary"),
        pressed: false,
      });
    }
  }

  #pointer_lock(): void {
    const locked = this.#options.pointer_locked?.() ?? false;
    if (locked === this.#pointer_locked) return;
    this.#pointer_locked = locked;
    this.#source.enqueue({
      type: "pointer_lock",
      device: this.#connect("pointer", "locked"),
      locked,
    });
  }

  #poll_gamepads(): void {
    if (this.#options.get_gamepads === undefined) return;
    const observed = new Set<string>();
    for (const gamepad of this.#options.get_gamepads()) {
      if (gamepad === null || !gamepad.connected) continue;
      const device = device_identity(
        "gamepad",
        `${gamepad.index}:${gamepad.id.replaceAll(/[^a-zA-Z0-9_.:-]/g, "_")}`,
      );
      observed.add(device.id);
      if (!this.#connected.has(device.id)) {
        this.#connected.add(device.id);
        this.#source.enqueue({ type: "connect", device });
      }
      gamepad.buttons.forEach((button, index) => {
        this.#source.enqueue({
          type: "button",
          device,
          control: control_id(`button:${index}`),
          pressed: button.pressed,
        });
        this.#source.enqueue({
          type: "axis",
          device,
          control: control_id(`button_value:${index}`),
          value: button.value,
          mode: "absolute",
        });
      });
      gamepad.axes.forEach((value, index) => {
        this.#source.enqueue({
          type: "axis",
          device,
          control: control_id(`axis:${index}`),
          value,
          mode: "absolute",
        });
      });
    }
    for (const id of this.#connected) {
      if (!id.startsWith("gamepad:") || observed.has(id)) continue;
      this.#connected.delete(id);
      this.#source.enqueue({
        type: "disconnect",
        device: Object.freeze({ id: device_id(id), kind: "gamepad" }),
      });
    }
  }

  #poll_xr(): void {
    if (this.#options.xr === undefined) return;
    const observed = new Set<string>();
    for (const snapshot of this.#options.xr.snapshots()) {
      const device = device_identity("xr", snapshot.id);
      observed.add(device.id);
      if (!this.#connected.has(device.id)) {
        this.#connected.add(device.id);
        this.#source.enqueue({ type: "connect", device });
      }
      snapshot.buttons.forEach((value, index) => {
        this.#source.enqueue({
          type: "button",
          device,
          control: control_id(`button:${index}`),
          pressed: value >= 0.5,
        });
        this.#source.enqueue({
          type: "axis",
          device,
          control: control_id(`button_value:${index}`),
          value,
          mode: "absolute",
        });
      });
      snapshot.axes.forEach((value, index) => {
        this.#source.enqueue({
          type: "axis",
          device,
          control: control_id(`axis:${index}`),
          value,
          mode: "absolute",
        });
      });
    }
    for (const id of this.#connected) {
      if (!id.startsWith("xr:") || observed.has(id)) continue;
      this.#connected.delete(id);
      this.#source.enqueue({
        type: "disconnect",
        device: Object.freeze({ id: device_id(id), kind: "xr" }),
      });
    }
  }

  #reject(operation: string, evidence: unknown): void {
    this.#options.observer?.diagnostic(
      "warning",
      operation,
      "malformed browser input event rejected",
      { evidence: String(evidence) },
    );
  }
}

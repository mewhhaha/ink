import { finite_number } from "@ink/math/scalar.ts";
import { type Vec2, vec2 } from "@ink/math/vector.ts";
import type { FrameId } from "@ink/runtime/frame.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  control_key,
  type ControlId,
  type ControlSnapshot,
  type DeviceIdentity,
  type DeviceInputFrame,
  type DeviceLifecycleEvent,
  type TouchContact,
} from "./model.ts";

export type NormalizedDeviceEvent =
  | { readonly type: "connect"; readonly device: DeviceIdentity }
  | { readonly type: "disconnect"; readonly device: DeviceIdentity }
  | { readonly type: "focus"; readonly focused: boolean }
  | {
    readonly type: "pointer_lock";
    readonly device: DeviceIdentity;
    readonly locked: boolean;
  }
  | {
    readonly type: "button";
    readonly device: DeviceIdentity;
    readonly control: ControlId;
    readonly pressed: boolean;
  }
  | {
    readonly type: "axis";
    readonly device: DeviceIdentity;
    readonly control: ControlId;
    readonly value: number;
    readonly mode: "absolute" | "relative";
  }
  | {
    readonly type: "axis2";
    readonly device: DeviceIdentity;
    readonly control: ControlId;
    readonly value: Vec2;
    readonly mode: "absolute" | "relative";
  }
  | {
    readonly type: "touch";
    readonly device: DeviceIdentity;
    readonly contact: TouchContact;
  }
  | {
    readonly type: "touch_end";
    readonly device: DeviceIdentity;
    readonly contact: number;
    readonly cancelled: boolean;
  };

interface ButtonState {
  readonly device: DeviceIdentity;
  readonly control: ControlId;
  pressed: boolean;
  previous: boolean;
}

interface AxisState {
  readonly device: DeviceIdentity;
  readonly control: ControlId;
  readonly type: "axis" | "axis2";
  value: number | Vec2;
  readonly relative: boolean;
}

export class SyntheticInputAdapter {
  readonly #observer: Observer | undefined;
  readonly #pending: NormalizedDeviceEvent[] = [];
  readonly #buttons = new Map<string, ButtonState>();
  readonly #axes = new Map<string, AxisState>();
  readonly #contacts = new Map<number, TouchContact>();
  readonly #connected = new Map<string, DeviceIdentity>();
  #focused = true;

  constructor(observer?: Observer) {
    this.#observer = observer;
  }

  enqueue(event: NormalizedDeviceEvent): void {
    this.#pending.push(event);
  }

  capture(frame_id: FrameId): DeviceInputFrame {
    const lifecycle: DeviceLifecycleEvent[] = [];
    for (const event of this.#pending.splice(0)) {
      try {
        this.#apply(event, lifecycle);
      } catch (error) {
        this.#observer?.diagnostic(
          "warning",
          "capture_input",
          "normalized input event was rejected",
          {
            event: event.type,
            reason: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
    }
    const controls: ControlSnapshot[] = [];
    for (const state of this.#buttons.values()) {
      const phase = state.pressed
        ? state.previous ? "held" : "pressed"
        : state.previous
        ? "released"
        : "idle";
      controls.push(Object.freeze({
        type: "button",
        device: state.device,
        control: state.control,
        pressed: state.pressed,
        phase,
      }));
      state.previous = state.pressed;
    }
    for (const state of this.#axes.values()) {
      controls.push(
        state.type === "axis"
          ? Object.freeze({
            type: "axis",
            device: state.device,
            control: state.control,
            value: state.value as number,
          })
          : Object.freeze({
            type: "axis2",
            device: state.device,
            control: state.control,
            value: state.value as Vec2,
          }),
      );
      if (state.relative) state.value = state.type === "axis" ? 0 : vec2(0, 0);
    }
    controls.sort((left, right) =>
      left.device.id.localeCompare(right.device.id) ||
      left.control.localeCompare(right.control)
    );
    return Object.freeze({
      frame_id,
      focused: this.#focused,
      controls: Object.freeze(controls),
      contacts: Object.freeze(
        [...this.#contacts.values()].sort((left, right) => left.id - right.id),
      ),
      lifecycle: Object.freeze(lifecycle),
    });
  }

  #apply(
    event: NormalizedDeviceEvent,
    lifecycle: DeviceLifecycleEvent[],
  ): void {
    switch (event.type) {
      case "connect":
        if (!this.#connected.has(event.device.id)) {
          this.#connected.set(event.device.id, event.device);
          lifecycle.push(
            Object.freeze({ type: "connected", device: event.device }),
          );
          this.#observer?.event("input_device_connected", {
            device: event.device.id,
            kind: event.device.kind,
          });
        }
        return;
      case "disconnect":
        this.#connected.delete(event.device.id);
        this.#neutralize_device(event.device);
        lifecycle.push(
          Object.freeze({ type: "disconnected", device: event.device }),
        );
        this.#observer?.event("input_device_disconnected", {
          device: event.device.id,
          kind: event.device.kind,
        });
        return;
      case "focus":
        if (event.focused === this.#focused) return;
        this.#focused = event.focused;
        if (!event.focused) this.#neutralize_all();
        lifecycle.push(
          Object.freeze({
            type: event.focused ? "focus_gained" : "focus_lost",
          }),
        );
        this.#observer?.event(
          event.focused ? "input_focus_gained" : "input_focus_lost",
        );
        return;
      case "pointer_lock":
        lifecycle.push(Object.freeze({
          type: event.locked ? "pointer_lock_gained" : "pointer_lock_lost",
          device: event.device,
        }));
        return;
      case "button": {
        const key = control_key(event.device, event.control);
        const state = this.#buttons.get(key);
        if (state === undefined) {
          this.#buttons.set(key, {
            device: event.device,
            control: event.control,
            pressed: event.pressed,
            previous: false,
          });
        } else state.pressed = event.pressed;
        return;
      }
      case "axis":
        finite_number(event.value, `${event.device.id}/${event.control} axis`);
        this.#axis(
          event.device,
          event.control,
          "axis",
          event.value,
          event.mode,
        );
        return;
      case "axis2":
        this.#axis(
          event.device,
          event.control,
          "axis2",
          event.value,
          event.mode,
        );
        return;
      case "touch":
        if (!Number.isSafeInteger(event.contact.id) || event.contact.id < 0) {
          throw new Error(
            `touch contact id ${event.contact.id} must be a nonnegative safe integer`,
          );
        }
        finite_number(
          event.contact.pressure,
          `touch contact ${event.contact.id} pressure`,
        );
        if (event.contact.pressure < 0 || event.contact.pressure > 1) {
          throw new Error(
            `touch contact ${event.contact.id} pressure ${event.contact.pressure} must be between 0 and 1`,
          );
        }
        this.#contacts.set(event.contact.id, Object.freeze(event.contact));
        return;
      case "touch_end":
        this.#contacts.delete(event.contact);
        if (event.cancelled) {
          lifecycle.push(
            Object.freeze({
              type: "touch_cancelled",
              device: event.device,
              contact: event.contact,
            }),
          );
        }
        return;
    }
  }

  #axis(
    device: DeviceIdentity,
    control: ControlId,
    type: "axis" | "axis2",
    value: number | Vec2,
    mode: "absolute" | "relative",
  ): void {
    const key = control_key(device, control);
    const current = this.#axes.get(key);
    if (current !== undefined && current.type !== type) {
      throw new Error(`control ${key} changed from ${current.type} to ${type}`);
    }
    if (mode === "absolute" || current === undefined) {
      this.#axes.set(key, {
        device,
        control,
        type,
        value,
        relative: mode === "relative",
      });
      return;
    }
    current.value = type === "axis"
      ? current.value as number + (value as number)
      : vec2(
        (current.value as Vec2).x + (value as Vec2).x,
        (current.value as Vec2).y + (value as Vec2).y,
      );
  }

  #neutralize_device(device: DeviceIdentity): void {
    for (const state of this.#buttons.values()) {
      if (state.device.id === device.id) state.pressed = false;
    }
    for (const [key, state] of this.#axes) {
      if (state.device.id === device.id) this.#axes.delete(key);
    }
    if (device.kind === "touch") this.#contacts.clear();
  }

  #neutralize_all(): void {
    for (const state of this.#buttons.values()) state.pressed = false;
    this.#axes.clear();
    this.#contacts.clear();
  }
}

import { finite_number } from "@ink/math/scalar.ts";
import { type Vec2, vec2 } from "@ink/math/vector.ts";
import type { FrameId } from "@ink/runtime/frame.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  control_id,
  control_key,
  type ControlId,
  type ControlSnapshot,
  device_id,
  type DeviceIdentity,
  type DeviceInputFrame,
  type DeviceKind,
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
    this.#pending.push(parse_normalized_device_event(event));
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
        this.#contacts.set(event.contact.id, event.contact);
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
      ? finite_number(
        current.value as number + (value as number),
        `${device.id}/${control} accumulated axis`,
      )
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

export function parse_normalized_device_event(
  value: unknown,
): NormalizedDeviceEvent {
  const event = parse_event_record(value, "normalized input event");
  if (event.type === "focus") {
    expect_event_fields(event, ["focused", "type"]);
    if (typeof event.focused !== "boolean") {
      throw new Error("normalized focus event focused must be boolean");
    }
    return Object.freeze({ type: "focus", focused: event.focused });
  }
  if (event.type === "connect" || event.type === "disconnect") {
    expect_event_fields(event, ["device", "type"]);
    return Object.freeze({
      type: event.type,
      device: parse_event_device(event.device, event.type),
    });
  }
  if (event.type === "pointer_lock") {
    expect_event_fields(event, ["device", "locked", "type"]);
    const device = parse_event_device(event.device, "pointer lock");
    if (device.kind !== "pointer") {
      throw new Error(
        `pointer lock event uses ${device.kind} device ${device.id}`,
      );
    }
    if (typeof event.locked !== "boolean") {
      throw new Error("pointer lock event locked must be boolean");
    }
    return Object.freeze({
      type: "pointer_lock",
      device,
      locked: event.locked,
    });
  }
  if (event.type === "button") {
    expect_event_fields(event, ["control", "device", "pressed", "type"]);
    if (typeof event.control !== "string") {
      throw new Error("normalized button control must be a string");
    }
    if (typeof event.pressed !== "boolean") {
      throw new Error("normalized button pressed must be boolean");
    }
    return Object.freeze({
      type: "button",
      device: parse_event_device(event.device, "button"),
      control: control_id(event.control),
      pressed: event.pressed,
    });
  }
  if (event.type === "axis") {
    expect_event_fields(event, ["control", "device", "mode", "type", "value"]);
    if (typeof event.control !== "string") {
      throw new Error("normalized axis control must be a string");
    }
    return Object.freeze({
      type: "axis",
      device: parse_event_device(event.device, "axis"),
      control: control_id(event.control),
      value: parse_event_number(event.value, "normalized axis value"),
      mode: parse_axis_mode(event.mode),
    });
  }
  if (event.type === "axis2") {
    expect_event_fields(event, ["control", "device", "mode", "type", "value"]);
    if (typeof event.control !== "string") {
      throw new Error("normalized axis2 control must be a string");
    }
    const vector = parse_event_record(event.value, "normalized axis2 value");
    expect_event_fields(vector, ["x", "y"]);
    return Object.freeze({
      type: "axis2",
      device: parse_event_device(event.device, "axis2"),
      control: control_id(event.control),
      value: vec2(
        parse_event_number(vector.x, "normalized axis2 value.x"),
        parse_event_number(vector.y, "normalized axis2 value.y"),
      ),
      mode: parse_axis_mode(event.mode),
    });
  }
  if (event.type === "touch") {
    expect_event_fields(event, ["contact", "device", "type"]);
    const device = parse_event_device(event.device, "touch");
    if (device.kind !== "touch") {
      throw new Error(`touch event uses ${device.kind} device ${device.id}`);
    }
    const contact = parse_event_record(event.contact, "touch contact");
    expect_event_fields(contact, ["id", "position", "pressure"]);
    const id = parse_event_index(contact.id, "touch contact id");
    const pressure = parse_event_number(
      contact.pressure,
      `touch contact ${id} pressure`,
    );
    if (pressure < 0 || pressure > 1) {
      throw new Error(
        `touch contact ${id} pressure ${pressure} must be between 0 and 1`,
      );
    }
    const position = parse_event_record(
      contact.position,
      `touch contact ${id} position`,
    );
    expect_event_fields(position, ["x", "y"]);
    return Object.freeze({
      type: "touch",
      device,
      contact: Object.freeze({
        id,
        position: vec2(
          parse_event_number(position.x, `touch contact ${id} position.x`),
          parse_event_number(position.y, `touch contact ${id} position.y`),
        ),
        pressure,
      }),
    });
  }
  if (event.type === "touch_end") {
    expect_event_fields(event, ["cancelled", "contact", "device", "type"]);
    const device = parse_event_device(event.device, "touch end");
    if (device.kind !== "touch") {
      throw new Error(
        `touch end event uses ${device.kind} device ${device.id}`,
      );
    }
    if (typeof event.cancelled !== "boolean") {
      throw new Error("touch end event cancelled must be boolean");
    }
    return Object.freeze({
      type: "touch_end",
      device,
      contact: parse_event_index(event.contact, "touch end contact"),
      cancelled: event.cancelled,
    });
  }
  throw new Error(
    `normalized input event type ${JSON.stringify(event.type)} is unsupported`,
  );
}

function parse_event_device(value: unknown, label: string): DeviceIdentity {
  const device = parse_event_record(value, `${label} device`);
  expect_event_fields(device, ["id", "kind"]);
  if (!is_device_kind(device.kind)) {
    throw new Error(
      `${label} device kind ${JSON.stringify(device.kind)} is unsupported`,
    );
  }
  if (typeof device.id !== "string") {
    throw new Error(`${label} device id must be a string`);
  }
  const id = device_id(device.id);
  if (!id.startsWith(`${device.kind}:`)) {
    throw new Error(
      `${label} device ${JSON.stringify(id)} does not belong to ${device.kind}`,
    );
  }
  return Object.freeze({ id, kind: device.kind });
}

function is_device_kind(value: unknown): value is DeviceKind {
  return value === "keyboard" || value === "pointer" || value === "touch" ||
    value === "gamepad" || value === "xr";
}

function parse_axis_mode(value: unknown): "absolute" | "relative" {
  if (value !== "absolute" && value !== "relative") {
    throw new Error(
      `normalized axis mode ${JSON.stringify(value)} is unsupported`,
    );
  }
  return value;
}

function parse_event_number(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} ${JSON.stringify(value)} must be a number`);
  }
  return finite_number(value, label);
}

function parse_event_index(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value;
}

function parse_event_record(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expect_event_fields(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const fields = Object.keys(value).sort();
  if (fields.join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(
      `normalized input event fields are ${JSON.stringify(fields)}`,
    );
  }
}

import { finite_number } from "@ink/math/scalar.ts";
import { type Vec2, vec2 } from "@ink/math/vector.ts";
import { frame_id, type FrameId } from "@ink/runtime/frame.ts";

declare const device_id_brand: unique symbol;
declare const control_id_brand: unique symbol;
declare const action_id_brand: unique symbol;

export type DeviceKind = "keyboard" | "pointer" | "touch" | "gamepad" | "xr";
export type DeviceAvailability = "available" | "unavailable";
export type ButtonPhase = "idle" | "pressed" | "held" | "released";

export type DeviceId = string & { readonly [device_id_brand]: true };
export type ControlId = string & { readonly [control_id_brand]: true };
export type ActionId = string & { readonly [action_id_brand]: true };

export interface DeviceIdentity {
  readonly id: DeviceId;
  readonly kind: DeviceKind;
}

export type ControlSnapshot =
  | {
    readonly type: "button";
    readonly device: DeviceIdentity;
    readonly control: ControlId;
    readonly pressed: boolean;
    readonly phase: ButtonPhase;
  }
  | {
    readonly type: "axis";
    readonly device: DeviceIdentity;
    readonly control: ControlId;
    readonly value: number;
  }
  | {
    readonly type: "axis2";
    readonly device: DeviceIdentity;
    readonly control: ControlId;
    readonly value: Vec2;
  };

export interface TouchContact {
  readonly id: number;
  readonly position: Vec2;
  readonly pressure: number;
}

export type DeviceLifecycleEvent =
  | { readonly type: "connected"; readonly device: DeviceIdentity }
  | { readonly type: "disconnected"; readonly device: DeviceIdentity }
  | { readonly type: "focus_gained" }
  | { readonly type: "focus_lost" }
  | { readonly type: "pointer_lock_gained"; readonly device: DeviceIdentity }
  | { readonly type: "pointer_lock_lost"; readonly device: DeviceIdentity }
  | {
    readonly type: "touch_cancelled";
    readonly device: DeviceIdentity;
    readonly contact: number;
  };

export interface DeviceInputFrame {
  readonly frame_id: FrameId;
  readonly focused: boolean;
  readonly controls: readonly ControlSnapshot[];
  readonly contacts: readonly TouchContact[];
  readonly lifecycle: readonly DeviceLifecycleEvent[];
}

export type ActionValue =
  | {
    readonly type: "digital";
    readonly pressed: boolean;
    readonly phase: ButtonPhase;
  }
  | { readonly type: "scalar"; readonly value: number }
  | { readonly type: "axis2"; readonly value: Vec2 };

export interface ActionSnapshot {
  readonly id: ActionId;
  readonly value: ActionValue;
  readonly context: string;
}

export interface InputFrame {
  readonly frame_id: FrameId;
  readonly actions: readonly ActionSnapshot[];
  readonly devices: DeviceInputFrame;
}

function parsed_identity(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0) throw new Error(`${label} cannot be empty`);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(parsed)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} contains unsupported characters`,
    );
  }
  return parsed;
}

export function device_id(value: string): DeviceId {
  return parsed_identity(value, "device id") as DeviceId;
}

export function control_id(value: string): ControlId {
  return parsed_identity(value, "control id") as ControlId;
}

export function action_id(value: string): ActionId {
  return parsed_identity(value, "action id") as ActionId;
}

export function device_identity(kind: DeviceKind, id: string): DeviceIdentity {
  return Object.freeze({
    kind,
    id: device_id(`${kind}:${parsed_identity(id, `${kind} device identity`)}`),
  });
}

export function control_key(
  device: DeviceIdentity,
  control: ControlId,
): string {
  return `${device.id}/${control}`;
}

export function parse_input_frame(value: unknown): InputFrame {
  const root = parse_record(value, "input frame");
  expect_fields(root, ["actions", "devices", "frame_id"], "input frame");
  const parsed_frame_id = frame_id(
    parse_nonnegative_safe_integer(root.frame_id, "input frame id"),
  );
  if (!Array.isArray(root.actions)) {
    throw new Error("input frame actions must be an array");
  }
  const action_ids = new Set<string>();
  const actions = root.actions.map((entry, index) => {
    const action = parse_action_snapshot(entry, index);
    if (action_ids.has(action.id)) {
      throw new Error(
        `input frame repeats action ${JSON.stringify(action.id)}`,
      );
    }
    action_ids.add(action.id);
    return action;
  });
  actions.sort((left, right) => left.id.localeCompare(right.id));
  const devices = parse_device_frame(root.devices);
  if (devices.frame_id !== parsed_frame_id) {
    throw new Error(
      `input frame ${parsed_frame_id} devices belong to frame ${devices.frame_id}`,
    );
  }
  return Object.freeze({
    frame_id: parsed_frame_id,
    actions: Object.freeze(actions),
    devices,
  });
}

function parse_action_snapshot(value: unknown, index: number): ActionSnapshot {
  const action = parse_record(value, `input action ${index}`);
  expect_fields(action, ["context", "id", "value"], `input action ${index}`);
  if (typeof action.id !== "string") {
    throw new Error(`input action ${index} id must be a string`);
  }
  if (
    typeof action.context !== "string" || action.context.trim().length === 0
  ) {
    throw new Error(`input action ${index} context cannot be empty`);
  }
  return Object.freeze({
    id: action_id(action.id),
    value: parse_action_value(action.value, index),
    context: action.context,
  });
}

function parse_action_value(value: unknown, index: number): ActionValue {
  const action_value = parse_record(value, `input action ${index} value`);
  if (action_value.type === "digital") {
    expect_fields(
      action_value,
      ["phase", "pressed", "type"],
      `input action ${index} digital value`,
    );
    if (typeof action_value.pressed !== "boolean") {
      throw new Error(`input action ${index} pressed must be boolean`);
    }
    const phase = parse_button_phase(
      action_value.phase,
      `input action ${index}`,
    );
    expect_button_phase(
      action_value.pressed,
      phase,
      `input action ${index}`,
    );
    return Object.freeze({
      type: "digital",
      pressed: action_value.pressed,
      phase,
    });
  }
  if (action_value.type === "scalar") {
    expect_fields(
      action_value,
      ["type", "value"],
      `input action ${index} scalar value`,
    );
    return Object.freeze({
      type: "scalar",
      value: parse_finite(action_value.value, `input action ${index} scalar`),
    });
  }
  if (action_value.type === "axis2") {
    expect_fields(
      action_value,
      ["type", "value"],
      `input action ${index} axis2 value`,
    );
    return Object.freeze({
      type: "axis2",
      value: parse_vec2(action_value.value, `input action ${index} axis2`),
    });
  }
  throw new Error(
    `input action ${index} value type ${
      JSON.stringify(action_value.type)
    } is unsupported`,
  );
}

function parse_device_frame(value: unknown): DeviceInputFrame {
  const devices = parse_record(value, "input devices");
  expect_fields(
    devices,
    ["contacts", "controls", "focused", "frame_id", "lifecycle"],
    "input devices",
  );
  if (typeof devices.focused !== "boolean") {
    throw new Error("input devices focused must be boolean");
  }
  if (!Array.isArray(devices.controls)) {
    throw new Error("input device controls must be an array");
  }
  if (!Array.isArray(devices.contacts)) {
    throw new Error("input device contacts must be an array");
  }
  if (!Array.isArray(devices.lifecycle)) {
    throw new Error("input device lifecycle must be an array");
  }
  const control_keys = new Set<string>();
  const controls = devices.controls.map((entry, index) => {
    const control = parse_control_snapshot(entry, index);
    const key = control_key(control.device, control.control);
    if (control_keys.has(key)) {
      throw new Error(`input devices repeat control ${JSON.stringify(key)}`);
    }
    control_keys.add(key);
    return control;
  });
  const contact_ids = new Set<number>();
  const contacts = devices.contacts.map((entry, index) => {
    const contact = parse_touch_contact(entry, `input contact ${index}`);
    if (contact_ids.has(contact.id)) {
      throw new Error(`input devices repeat contact ${contact.id}`);
    }
    contact_ids.add(contact.id);
    return contact;
  });
  controls.sort((left, right) =>
    control_key(left.device, left.control).localeCompare(
      control_key(right.device, right.control),
    )
  );
  contacts.sort((left, right) => left.id - right.id);
  return Object.freeze({
    frame_id: frame_id(
      parse_nonnegative_safe_integer(
        devices.frame_id,
        "input devices frame id",
      ),
    ),
    focused: devices.focused,
    controls: Object.freeze(controls),
    contacts: Object.freeze(contacts),
    lifecycle: Object.freeze(
      devices.lifecycle.map((entry, index) =>
        parse_lifecycle_event(entry, index)
      ),
    ),
  });
}

function parse_control_snapshot(
  value: unknown,
  index: number,
): ControlSnapshot {
  const control = parse_record(value, `input control ${index}`);
  const device = parse_device_identity(
    control.device,
    `input control ${index}`,
  );
  if (typeof control.control !== "string") {
    throw new Error(`input control ${index} identity must be a string`);
  }
  const parsed_control = control_id(control.control);
  if (control.type === "button") {
    expect_fields(
      control,
      ["control", "device", "phase", "pressed", "type"],
      `input button control ${index}`,
    );
    if (typeof control.pressed !== "boolean") {
      throw new Error(`input button control ${index} pressed must be boolean`);
    }
    const phase = parse_button_phase(
      control.phase,
      `input button control ${index}`,
    );
    expect_button_phase(
      control.pressed,
      phase,
      `input button control ${index}`,
    );
    return Object.freeze({
      type: "button",
      device,
      control: parsed_control,
      pressed: control.pressed,
      phase,
    });
  }
  if (control.type === "axis") {
    expect_fields(
      control,
      ["control", "device", "type", "value"],
      `input axis control ${index}`,
    );
    return Object.freeze({
      type: "axis",
      device,
      control: parsed_control,
      value: parse_finite(control.value, `input axis control ${index}`),
    });
  }
  if (control.type === "axis2") {
    expect_fields(
      control,
      ["control", "device", "type", "value"],
      `input axis2 control ${index}`,
    );
    return Object.freeze({
      type: "axis2",
      device,
      control: parsed_control,
      value: parse_vec2(control.value, `input axis2 control ${index}`),
    });
  }
  throw new Error(
    `input control ${index} type ${
      JSON.stringify(control.type)
    } is unsupported`,
  );
}

function parse_lifecycle_event(
  value: unknown,
  index: number,
): DeviceLifecycleEvent {
  const event = parse_record(value, `input lifecycle event ${index}`);
  if (event.type === "focus_gained" || event.type === "focus_lost") {
    expect_fields(event, ["type"], `input lifecycle event ${index}`);
    return Object.freeze({ type: event.type });
  }
  if (event.type === "connected" || event.type === "disconnected") {
    expect_fields(event, ["device", "type"], `input lifecycle event ${index}`);
    return Object.freeze({
      type: event.type,
      device: parse_device_identity(
        event.device,
        `input lifecycle event ${index}`,
      ),
    });
  }
  if (
    event.type === "pointer_lock_gained" ||
    event.type === "pointer_lock_lost"
  ) {
    expect_fields(event, ["device", "type"], `input lifecycle event ${index}`);
    const device = parse_device_identity(
      event.device,
      `input lifecycle event ${index}`,
    );
    if (device.kind !== "pointer") {
      throw new Error(
        `input lifecycle event ${index} pointer lock uses ${device.kind} device ${device.id}`,
      );
    }
    return Object.freeze({ type: event.type, device });
  }
  if (event.type === "touch_cancelled") {
    expect_fields(
      event,
      ["contact", "device", "type"],
      `input lifecycle event ${index}`,
    );
    const device = parse_device_identity(
      event.device,
      `input lifecycle event ${index}`,
    );
    if (device.kind !== "touch") {
      throw new Error(
        `input lifecycle event ${index} touch cancellation uses ${device.kind} device ${device.id}`,
      );
    }
    return Object.freeze({
      type: "touch_cancelled",
      device,
      contact: parse_nonnegative_safe_integer(
        event.contact,
        `input lifecycle event ${index} contact`,
      ),
    });
  }
  throw new Error(
    `input lifecycle event ${index} type ${
      JSON.stringify(event.type)
    } is unsupported`,
  );
}

function parse_touch_contact(value: unknown, label: string): TouchContact {
  const contact = parse_record(value, label);
  expect_fields(contact, ["id", "position", "pressure"], label);
  const id = parse_nonnegative_safe_integer(contact.id, `${label} id`);
  const pressure = parse_finite(contact.pressure, `${label} pressure`);
  if (pressure < 0 || pressure > 1) {
    throw new Error(`${label} pressure ${pressure} must be in 0..1`);
  }
  return Object.freeze({
    id,
    position: parse_vec2(contact.position, `${label} position`),
    pressure,
  });
}

function parse_device_identity(value: unknown, label: string): DeviceIdentity {
  const device = parse_record(value, `${label} device`);
  expect_fields(device, ["id", "kind"], `${label} device`);
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

function parse_vec2(value: unknown, label: string): Vec2 {
  const vector = parse_record(value, label);
  expect_fields(vector, ["x", "y"], label);
  return vec2(
    parse_finite(vector.x, `${label}.x`),
    parse_finite(vector.y, `${label}.y`),
  );
}

function parse_button_phase(value: unknown, label: string): ButtonPhase {
  if (
    value !== "idle" && value !== "pressed" && value !== "held" &&
    value !== "released"
  ) {
    throw new Error(`${label} phase ${JSON.stringify(value)} is unsupported`);
  }
  return value;
}

function expect_button_phase(
  pressed: boolean,
  phase: ButtonPhase,
  label: string,
): void {
  const matches = pressed
    ? phase === "pressed" || phase === "held"
    : phase === "idle" || phase === "released";
  if (!matches) {
    throw new Error(
      `${label} phase ${phase} does not match pressed ${pressed}`,
    );
  }
}

function is_device_kind(value: unknown): value is DeviceKind {
  return value === "keyboard" || value === "pointer" || value === "touch" ||
    value === "gamepad" || value === "xr";
}

function parse_finite(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} ${JSON.stringify(value)} must be a number`);
  }
  return finite_number(value, label);
}

function parse_nonnegative_safe_integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must be a nonnegative safe integer`,
    );
  }
  return value;
}

function parse_record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expect_fields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const fields = Object.keys(value).sort();
  if (fields.join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(`${label} fields are ${JSON.stringify(fields)}`);
  }
}

import type { Vec2 } from "@ink/math/vector.ts";
import type { FrameId } from "@ink/runtime/frame.ts";

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

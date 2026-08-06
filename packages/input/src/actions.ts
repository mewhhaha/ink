import { finite_number } from "@ink/math/scalar.ts";
import { vec2, vec2_length, vec2_scale } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  action_id,
  type ActionId,
  type ActionSnapshot,
  control_id,
  type ControlId,
  type ControlSnapshot,
  device_id,
  type DeviceId,
  type DeviceInputFrame,
  type DeviceKind,
  type InputFrame,
} from "./model.ts";

export interface ControlReference {
  readonly device_kind: DeviceKind;
  readonly device?: DeviceId;
  readonly control: ControlId;
}

interface BindingBase {
  readonly id: string;
}

export interface ButtonBinding extends BindingBase {
  readonly type: "button";
  readonly control: ControlReference;
  readonly modifiers?: readonly ControlReference[];
}

export interface AxisBinding extends BindingBase {
  readonly type: "axis";
  readonly control: ControlReference;
  readonly scale?: number;
  readonly dead_zone?: number;
  readonly curve?: "linear" | "squared" | "cubed";
}

export interface ButtonAxisBinding extends BindingBase {
  readonly type: "button_axis";
  readonly negative: ControlReference;
  readonly positive: ControlReference;
  readonly scale?: number;
}

export interface Axis2Binding extends BindingBase {
  readonly type: "axis2";
  readonly control: ControlReference;
  readonly scale?: number;
  readonly dead_zone?: number;
  readonly curve?: "linear" | "squared" | "cubed";
  readonly range?: "normalized" | "unbounded";
}

export interface ButtonAxis2Binding extends BindingBase {
  readonly type: "button_axis2";
  readonly left: ControlReference;
  readonly right: ControlReference;
  readonly down: ControlReference;
  readonly up: ControlReference;
  readonly scale?: number;
}

export type ActionBinding =
  | ButtonBinding
  | AxisBinding
  | ButtonAxisBinding
  | Axis2Binding
  | ButtonAxis2Binding;

export type ActionDefinition =
  | {
    readonly id: ActionId;
    readonly type: "digital";
    readonly bindings: readonly ButtonBinding[];
  }
  | {
    readonly id: ActionId;
    readonly type: "scalar";
    readonly bindings: readonly (AxisBinding | ButtonAxisBinding)[];
  }
  | {
    readonly id: ActionId;
    readonly type: "axis2";
    readonly bindings: readonly (Axis2Binding | ButtonAxis2Binding)[];
  };

export interface InputContext {
  readonly id: string;
  readonly priority: number;
  readonly consume: boolean;
  readonly actions: readonly ActionDefinition[];
}

export interface ActionMapDefinition {
  readonly version: 1;
  readonly contexts: readonly InputContext[];
}

declare const action_map_brand: unique symbol;
export type ActionMap = ActionMapDefinition & {
  readonly [action_map_brand]: true;
};

export interface BindingFailure {
  readonly type: "invalid_binding";
  readonly context: string;
  readonly action: string;
  readonly binding: string;
  readonly reason: string;
}

export type ActionMapResult =
  | { readonly ok: true; readonly value: ActionMap }
  | { readonly ok: false; readonly failure: BindingFailure };

function binding_failure(
  context: string,
  action: string,
  binding: string,
  reason: string,
): ActionMapResult {
  return {
    ok: false,
    failure: { type: "invalid_binding", context, action, binding, reason },
  };
}

function control_reference_failure(reference: unknown): string | null {
  if (typeof reference !== "object" || reference === null) {
    return "control reference must be an object";
  }
  const candidate = reference as Record<string, unknown>;
  const kinds: readonly DeviceKind[] = [
    "keyboard",
    "pointer",
    "touch",
    "gamepad",
    "xr",
  ];
  if (!kinds.includes(candidate.device_kind as DeviceKind)) {
    return `device kind ${
      JSON.stringify(candidate.device_kind)
    } is unsupported`;
  }
  if (typeof candidate.control !== "string") {
    return "control identity must be a string";
  }
  try {
    control_id(candidate.control);
    if (candidate.device !== undefined) {
      if (typeof candidate.device !== "string") {
        return "device identity must be a string";
      }
      device_id(candidate.device);
      if (!candidate.device.startsWith(`${candidate.device_kind}:`)) {
        return `device ${
          JSON.stringify(candidate.device)
        } does not belong to ${candidate.device_kind}`;
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

function finite_scale(value: number | undefined, label: string): number {
  if (value === undefined) return 1;
  return finite_number(value, label);
}

function validate_response(
  binding: AxisBinding | Axis2Binding,
  context: string,
  action: string,
): ActionMapResult | null {
  try {
    finite_scale(binding.scale, `binding ${binding.id} scale`);
    if (binding.dead_zone !== undefined) {
      finite_number(binding.dead_zone, `binding ${binding.id} dead zone`);
      if (binding.dead_zone < 0 || binding.dead_zone >= 1) {
        return binding_failure(
          context,
          action,
          binding.id,
          `dead zone ${binding.dead_zone} must be in [0, 1)`,
        );
      }
    }
    if (
      binding.type === "axis2" && binding.range !== undefined &&
      binding.range !== "normalized" && binding.range !== "unbounded"
    ) {
      return binding_failure(
        context,
        action,
        binding.id,
        `axis2 range ${JSON.stringify(binding.range)} is unsupported`,
      );
    }
  } catch (error) {
    return binding_failure(
      context,
      action,
      binding.id,
      error instanceof Error ? error.message : String(error),
    );
  }
  return null;
}

export function create_action_map(
  definition: ActionMapDefinition,
): ActionMapResult {
  if (definition.version !== 1) {
    return binding_failure(
      "<map>",
      "<map>",
      "<map>",
      `version ${definition.version} is unsupported`,
    );
  }
  const context_ids = new Set<string>();
  for (const context of definition.contexts) {
    if (typeof context.id !== "string" || context.id.trim().length === 0) {
      return binding_failure(
        context.id,
        "<context>",
        "<context>",
        "context id cannot be empty",
      );
    }
    if (context_ids.has(context.id)) {
      return binding_failure(
        context.id,
        "<context>",
        "<context>",
        "context id is duplicated",
      );
    }
    context_ids.add(context.id);
    if (!Number.isSafeInteger(context.priority)) {
      return binding_failure(
        context.id,
        "<context>",
        "<context>",
        `priority ${context.priority} must be a safe integer`,
      );
    }
    const action_ids = new Set<string>();
    const binding_ids = new Set<string>();
    for (const action of context.actions) {
      if (typeof action.id !== "string") {
        return binding_failure(
          context.id,
          String(action.id),
          "<action>",
          "action id must be a string",
        );
      }
      if (action_ids.has(action.id)) {
        return binding_failure(
          context.id,
          action.id,
          "<action>",
          "action id is duplicated",
        );
      }
      action_ids.add(action.id);
      if (action.bindings.length === 0) {
        return binding_failure(
          context.id,
          action.id,
          "<action>",
          "action requires at least one binding",
        );
      }
      for (const binding of action.bindings) {
        if (typeof binding.id !== "string") {
          return binding_failure(
            context.id,
            action.id,
            String(binding.id),
            "binding id must be a string",
          );
        }
        const binding_matches_action = action.type === "digital"
          ? binding.type === "button"
          : action.type === "scalar"
          ? binding.type === "axis" || binding.type === "button_axis"
          : binding.type === "axis2" || binding.type === "button_axis2";
        if (!binding_matches_action) {
          return binding_failure(
            context.id,
            action.id,
            binding.id,
            `${binding.type} binding cannot drive a ${action.type} action`,
          );
        }
        for (const reference of binding_references(binding)) {
          const reason = control_reference_failure(reference);
          if (reason !== null) {
            return binding_failure(context.id, action.id, binding.id, reason);
          }
        }
        if (binding.id.trim().length === 0) {
          return binding_failure(
            context.id,
            action.id,
            binding.id,
            "binding id cannot be empty",
          );
        }
        if (binding_ids.has(binding.id)) {
          return binding_failure(
            context.id,
            action.id,
            binding.id,
            "binding id is duplicated in context",
          );
        }
        binding_ids.add(binding.id);
        if ((binding.type === "axis" || binding.type === "axis2")) {
          const failure = validate_response(binding, context.id, action.id);
          if (failure !== null) return failure;
        } else if (
          binding.type === "button_axis" || binding.type === "button_axis2"
        ) {
          try {
            finite_scale(binding.scale, `binding ${binding.id} scale`);
          } catch (error) {
            return binding_failure(
              context.id,
              action.id,
              binding.id,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }
    }
  }
  const contexts = [...definition.contexts]
    .map((context) =>
      Object.freeze({
        ...context,
        actions: Object.freeze(context.actions.map((action) =>
          Object.freeze({
            ...action,
            bindings: Object.freeze([...action.bindings]),
          })
        )),
      })
    )
    .sort((left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id)
    );
  return {
    ok: true,
    value: Object.freeze({
      version: 1,
      contexts: Object.freeze(contexts),
    }) as ActionMap,
  };
}

function matches(
  reference: ControlReference,
  snapshot: ControlSnapshot,
): boolean {
  return snapshot.device.kind === reference.device_kind &&
    (reference.device === undefined ||
      snapshot.device.id === reference.device) &&
    snapshot.control === reference.control;
}

function control_for(
  reference: ControlReference,
  controls: readonly ControlSnapshot[],
): ControlSnapshot | undefined {
  return controls.find((snapshot) => matches(reference, snapshot));
}

function reference_key(reference: ControlReference): string {
  return `${reference.device ?? reference.device_kind}/${reference.control}`;
}

function response(
  value: number,
  dead_zone = 0,
  curve: "linear" | "squared" | "cubed" = "linear",
): number {
  const magnitude = Math.abs(value);
  if (magnitude <= dead_zone) return 0;
  const normalized = Math.min(1, (magnitude - dead_zone) / (1 - dead_zone));
  const curved = curve === "linear"
    ? normalized
    : curve === "squared"
    ? normalized ** 2
    : normalized ** 3;
  return Math.sign(value) * curved;
}

function button_pressed(
  reference: ControlReference,
  controls: readonly ControlSnapshot[],
): boolean {
  const control = control_for(reference, controls);
  return control?.type === "button" && control.pressed;
}

function binding_references(
  binding: ActionBinding,
): readonly ControlReference[] {
  switch (binding.type) {
    case "button":
      return [binding.control, ...(binding.modifiers ?? [])];
    case "axis":
    case "axis2":
      return [binding.control];
    case "button_axis":
      return [binding.negative, binding.positive];
    case "button_axis2":
      return [binding.left, binding.right, binding.down, binding.up];
  }
}

export class ActionEvaluator {
  readonly #map: ActionMap;
  readonly #observer: Observer | undefined;
  readonly #previous_digital = new Map<string, boolean>();
  #enabled_contexts = new Set<string>();

  constructor(map: ActionMap, observer?: Observer) {
    this.#map = map;
    this.#observer = observer;
  }

  evaluate(
    devices: DeviceInputFrame,
    enabled_contexts?: readonly string[],
  ): InputFrame {
    const enabled = enabled_contexts === undefined
      ? null
      : new Set(enabled_contexts);
    const active_contexts = new Set(
      this.#map.contexts.filter((context) =>
        enabled === null || enabled.has(context.id)
      ).map((context) => context.id),
    );
    const context_changed =
      active_contexts.size !== this.#enabled_contexts.size ||
      [...active_contexts].some((context) =>
        !this.#enabled_contexts.has(context)
      );
    if (context_changed) {
      for (const context of this.#enabled_contexts) {
        if (!active_contexts.has(context)) {
          this.#observer?.event("input_context_disabled", { context });
        }
      }
      for (const context of active_contexts) {
        if (!this.#enabled_contexts.has(context)) {
          this.#observer?.event("input_context_enabled", { context });
        }
      }
      this.#previous_digital.clear();
      this.#enabled_contexts = active_contexts;
    }
    const consumed = new Set<string>();
    const resolved_actions = new Set<string>();
    const actions: ActionSnapshot[] = [];
    for (const context of this.#map.contexts) {
      if (enabled !== null && !enabled.has(context.id)) continue;
      for (const definition of context.actions) {
        if (resolved_actions.has(definition.id)) continue;
        const eligible = definition.bindings.filter((binding) =>
          binding_references(binding).every((reference) =>
            !consumed.has(reference_key(reference))
          )
        );
        let active = false;
        let value: ActionSnapshot["value"];
        if (definition.type === "digital") {
          const digital_bindings = eligible as readonly ButtonBinding[];
          const pressed = digital_bindings.some((binding) =>
            button_pressed(binding.control, devices.controls) &&
            (binding.modifiers ?? []).every((modifier) =>
              button_pressed(modifier, devices.controls)
            )
          );
          const previous = this.#previous_digital.get(definition.id) ?? false;
          const phase = pressed
            ? previous ? "held" : "pressed"
            : previous
            ? "released"
            : "idle";
          this.#previous_digital.set(definition.id, pressed);
          active = pressed || phase === "released";
          value = Object.freeze({ type: "digital", pressed, phase });
        } else if (definition.type === "scalar") {
          const scalar_bindings =
            eligible as readonly (AxisBinding | ButtonAxisBinding)[];
          let scalar = 0;
          for (const binding of scalar_bindings) {
            if (binding.type === "axis") {
              const control = control_for(binding.control, devices.controls);
              if (control?.type === "axis") {
                scalar +=
                  response(control.value, binding.dead_zone, binding.curve) *
                  finite_scale(binding.scale, binding.id);
              }
            } else {
              scalar +=
                ((button_pressed(binding.positive, devices.controls) ? 1 : 0) -
                  (button_pressed(binding.negative, devices.controls)
                    ? 1
                    : 0)) * finite_scale(binding.scale, binding.id);
            }
          }
          scalar = Math.max(-1, Math.min(1, scalar));
          active = scalar !== 0;
          value = Object.freeze({ type: "scalar", value: scalar });
        } else {
          const axis_bindings =
            eligible as readonly (Axis2Binding | ButtonAxis2Binding)[];
          let x = 0;
          let y = 0;
          let bounded = true;
          for (const binding of axis_bindings) {
            if (binding.type === "axis2") {
              const control = control_for(binding.control, devices.controls);
              if (control?.type === "axis2") {
                const magnitude = vec2_length(control.value);
                const unbounded = binding.range === "unbounded";
                bounded &&= !unbounded;
                const adjusted = unbounded || magnitude === 0
                  ? control.value
                  : vec2_scale(
                    control.value,
                    response(magnitude, binding.dead_zone, binding.curve) /
                      magnitude,
                  );
                const scale = finite_scale(binding.scale, binding.id);
                x += adjusted.x * scale;
                y += adjusted.y * scale;
              }
            } else {
              const scale = finite_scale(binding.scale, binding.id);
              x += ((button_pressed(binding.right, devices.controls) ? 1 : 0) -
                (button_pressed(binding.left, devices.controls) ? 1 : 0)) *
                scale;
              y += ((button_pressed(binding.up, devices.controls) ? 1 : 0) -
                (button_pressed(binding.down, devices.controls) ? 1 : 0)) *
                scale;
            }
          }
          const magnitude = Math.hypot(x, y);
          const axis = bounded && magnitude > 1
            ? vec2(x / magnitude, y / magnitude)
            : vec2(x, y);
          active = axis.x !== 0 || axis.y !== 0;
          value = Object.freeze({ type: "axis2", value: axis });
        }
        actions.push(
          Object.freeze({ id: definition.id, value, context: context.id }),
        );
        resolved_actions.add(definition.id);
        if (context.consume && active) {
          for (const binding of eligible) {
            for (const reference of binding_references(binding)) {
              consumed.add(reference_key(reference));
            }
          }
          this.#observer?.event("input_action_consumed", {
            action: definition.id,
            context: context.id,
          });
        }
      }
    }
    actions.sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze({
      frame_id: devices.frame_id,
      actions: Object.freeze(actions),
      devices,
    });
  }
}

export interface RebindConflict {
  readonly context: string;
  readonly action: ActionId;
  readonly binding: string;
  readonly description: string;
}

export interface RebindRequest {
  readonly context: string;
  readonly action: ActionId;
  readonly binding: string;
  readonly replacement: ActionBinding;
}

export type RebindResult =
  | {
    readonly ok: true;
    readonly map: ActionMap;
    readonly conflicts: readonly RebindConflict[];
  }
  | { readonly ok: false; readonly failure: BindingFailure };

export function rebind_action(
  map: ActionMap,
  request: RebindRequest,
  observer?: Observer,
): RebindResult {
  let found = false;
  const contexts = map.contexts.map((context) => ({
    ...context,
    actions: context.actions.map((definition) => ({
      ...definition,
      bindings: definition.bindings.map((binding) => {
        if (
          context.id !== request.context || definition.id !== request.action ||
          binding.id !== request.binding
        ) return binding;
        found = true;
        return { ...request.replacement, id: binding.id } as typeof binding;
      }),
    })) as readonly ActionDefinition[],
  }));
  if (!found) {
    return {
      ok: false,
      failure: {
        type: "invalid_binding",
        context: request.context,
        action: request.action,
        binding: request.binding,
        reason: "binding does not exist",
      },
    };
  }
  const candidate = create_action_map({ version: 1, contexts });
  if (!candidate.ok) return candidate;
  const replacement_keys = binding_references(request.replacement).map(
    reference_key,
  ).sort().join("+");
  const conflicts: RebindConflict[] = [];
  for (const context of candidate.value.contexts) {
    for (const definition of context.actions) {
      for (const binding of definition.bindings) {
        if (
          context.id === request.context && definition.id === request.action &&
          binding.id === request.binding
        ) continue;
        if (
          binding_references(binding).map(reference_key).sort().join("+") ===
            replacement_keys
        ) {
          conflicts.push(Object.freeze({
            context: context.id,
            action: definition.id,
            binding: binding.id,
            description:
              `${definition.id} in ${context.id} already uses ${replacement_keys}`,
          }));
        }
      }
    }
  }
  observer?.event(
    conflicts.length === 0 ? "input_rebound" : "input_rebind_conflict",
    {
      context: request.context,
      action: request.action,
      binding: request.binding,
      conflicts: conflicts.length,
    },
  );
  return {
    ok: true,
    map: candidate.value,
    conflicts: Object.freeze(conflicts),
  };
}

export function serialize_action_map(map: ActionMap): string {
  return JSON.stringify(map);
}

export function parse_action_map(serialized: string): ActionMapResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    return binding_failure(
      "<map>",
      "<map>",
      "<map>",
      `JSON is malformed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof parsed !== "object" || parsed === null || !("version" in parsed) ||
    !("contexts" in parsed) || !Array.isArray(parsed.contexts)
  ) {
    return binding_failure(
      "<map>",
      "<map>",
      "<map>",
      "serialized action map must contain version and contexts",
    );
  }
  try {
    return create_action_map(parsed as unknown as ActionMapDefinition);
  } catch (error) {
    return binding_failure(
      "<map>",
      "<map>",
      "<map>",
      `serialized action map is malformed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export { action_id };

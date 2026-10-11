export type Device = "keyboard" | "pointer" | "gamepad";
export type Binding =
  | { device: "keyboard"; code: string; scale?: number }
  | { device: "pointer"; button: number; scale?: number }
  | { device: "gamepad"; button: number; scale?: number }
  | { device: "gamepad"; axis: number; scale?: number; deadzone?: number };
export type ActionMap = Record<string, readonly Binding[]>;
export type Contexts = Record<string, ActionMap>;
export interface ActionState {
  value: number;
  down: boolean;
  pressed: boolean;
  released: boolean;
}
export interface PadState {
  connected: boolean;
  buttons: readonly { value: number }[];
  axes: readonly number[];
}
export interface Snapshot {
  context: string;
  device: Device;
  actions: Record<string, ActionState>;
}
export interface Input {
  setContext(name: string): void;
  rebind(context: string, action: string, bindings: readonly Binding[]): void;
  sample(gamepads?: readonly (PadState | null)[]): Snapshot;
  prompt(action: string): string;
  clear(): void;
  dispose(): void;
}

function validate(map: ActionMap) {
  for (const bindings of Object.values(map)) {
    for (const binding of bindings) {
      if (binding.scale !== undefined && !Number.isFinite(binding.scale)) {
        throw new RangeError("Invalid scale");
      }
      if (binding.device === "keyboard") {
        if (!binding.code) {
          throw new RangeError("A keyboard binding needs a code");
        }
      } else {
        let index = 0;
        if ("axis" in binding) index = binding.axis;
        else index = binding.button;
        if (!Number.isInteger(index) || index < 0) {
          throw new RangeError("Invalid control index");
        }
      }
      if (
        "deadzone" in binding && binding.deadzone !== undefined &&
        (!Number.isFinite(binding.deadzone) || binding.deadzone < 0 ||
          binding.deadzone >= 1)
      ) {
        throw new RangeError("deadzone must be in [0, 1)");
      }
    }
  }
}

/** No animation loop: the caller polls gamepads and consumes transitions in sample. */
export function input(
  target: HTMLElement,
  contexts: Contexts,
  initial: string,
): Input {
  const window = target.ownerDocument.defaultView;
  if (!window) throw new Error("Input target needs a window");
  for (const map of Object.values(contexts)) validate(map);
  const maps = structuredClone(contexts);
  if (!Object.hasOwn(maps, initial)) {
    throw new Error(`Unknown context: ${initial}`);
  }
  let context = initial;
  let device: Device = "keyboard";
  let disposed = false;
  let focused = target.ownerDocument.hasFocus();
  const keys = new Set<string>();
  const pointers = new Map<number, number>();
  let pads: readonly (PadState | null)[] = [];
  let previousPads: number[] = [];
  const values = new Map<string, number>();
  const pressed = new Set<string>();
  const released = new Set<string>();
  const events = new AbortController();
  const active = () =>
    !disposed && focused && target.ownerDocument.visibilityState !== "hidden";
  const update = () => {
    for (const [action, bindings] of Object.entries(maps[context])) {
      let value = 0;
      for (const binding of bindings) {
        let raw = 0;
        if (binding.device === "keyboard" && keys.has(binding.code)) raw = 1;
        if (
          binding.device === "pointer" &&
          [...pointers.values()].includes(binding.button)
        ) raw = 1;
        if (binding.device === "gamepad") {
          for (const pad of pads) {
            if (!pad?.connected) continue;
            let candidate = 0;
            if ("axis" in binding) {
              const axis = pad.axes[binding.axis] ?? 0;
              const deadzone = binding.deadzone ?? 0.15;
              if (Number.isFinite(axis) && Math.abs(axis) > deadzone) {
                candidate = Math.sign(axis) *
                  (Math.min(1, Math.abs(axis)) - deadzone) / (1 - deadzone);
              }
            } else candidate = pad.buttons[binding.button]?.value ?? 0;
            if (
              Number.isFinite(candidate) && Math.abs(candidate) > Math.abs(raw)
            ) raw = candidate;
          }
        }
        value += raw * (binding.scale ?? 1);
      }
      value = Math.max(-1, Math.min(1, value));
      const before = Math.abs(values.get(action) ?? 0) > 0.001;
      const after = Math.abs(value) > 0.001;
      if (!before && after) pressed.add(action);
      if (before && !after) released.add(action);
      values.set(action, value);
    }
  };
  const clear = () => {
    keys.clear();
    for (const id of pointers.keys()) {
      if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
    }
    pointers.clear();
    pads = [];
    previousPads = [];
    update();
  };
  const editable = (event: KeyboardEvent) =>
    event.target instanceof Element &&
    !!event.target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable=false])",
    );
  const keyBinding = (code: string) =>
    Object.values(maps[context]).some((bindings) =>
      bindings.some((binding) =>
        binding.device === "keyboard" && binding.code === code
      )
    );
  target.addEventListener("keydown", (event) => {
    if (!active() || editable(event) || !keyBinding(event.code)) return;
    event.preventDefault();
    device = "keyboard";
    keys.add(event.code);
    update();
  }, { signal: events.signal });
  window.addEventListener("keyup", (event) => {
    keys.delete(event.code);
    update();
  }, { signal: events.signal });
  target.addEventListener("pointerdown", (event) => {
    if (!active()) return;
    const bound = Object.values(maps[context]).some((bindings) =>
      bindings.some((binding) =>
        binding.device === "pointer" && binding.button === event.button
      )
    );
    if (!bound) return;
    device = "pointer";
    pointers.set(event.pointerId, event.button);
    if (event.isTrusted) target.setPointerCapture(event.pointerId);
    update();
  }, { signal: events.signal });
  const pointerEnd = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    update();
  };
  window.addEventListener("pointerup", pointerEnd, { signal: events.signal });
  window.addEventListener("pointercancel", pointerEnd, {
    signal: events.signal,
  });
  target.addEventListener("lostpointercapture", pointerEnd, {
    signal: events.signal,
  });
  target.addEventListener("focusout", (event) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !target.contains(event.relatedTarget)
    ) clear();
  }, { signal: events.signal });
  window.addEventListener("blur", () => {
    focused = false;
    clear();
  }, { signal: events.signal });
  window.addEventListener("focus", () => {
    focused = true;
  }, { signal: events.signal });
  target.ownerDocument.addEventListener("visibilitychange", () => {
    if (!active()) clear();
  }, { signal: events.signal });
  return {
    setContext(name: string) {
      if (!Object.hasOwn(maps, name)) {
        throw new Error(`Unknown context: ${name}`);
      }
      clear();
      values.clear();
      pressed.clear();
      released.clear();
      context = name;
    },
    rebind(name: string, action: string, bindings: readonly Binding[]) {
      if (!Object.hasOwn(maps, name)) {
        throw new Error(`Unknown context: ${name}`);
      }
      validate({ [action]: bindings });
      maps[name][action] = structuredClone(bindings);
      clear();
    },
    sample(gamepads: readonly (PadState | null)[] = []) {
      let controls: number[] = [];
      if (active() && target.contains(target.ownerDocument.activeElement)) {
        pads = gamepads;
        controls = gamepads.flatMap((pad) => {
          if (!pad?.connected) return [];
          return [...pad.axes, ...pad.buttons.map((button) => button.value)];
        });
        if (
          controls.some((value, index) =>
            Math.abs(value) > 0.15 &&
            Math.abs(value - (previousPads[index] ?? 0)) > 0.01
          )
        ) device = "gamepad";
      } else pads = [];
      previousPads = controls;
      update();
      const actions: Record<string, ActionState> = {};
      for (const action of Object.keys(maps[context])) {
        const value = values.get(action) ?? 0;
        actions[action] = {
          value,
          down: Math.abs(value) > 0.001,
          pressed: pressed.has(action),
          released: released.has(action),
        };
      }
      pressed.clear();
      released.clear();
      return { context, device, actions };
    },
    prompt(action: string) {
      const bindings = maps[context][action] ?? [];
      let binding = bindings.find((binding) => binding.device === device);
      binding ??= bindings[0];
      if (!binding) return "";
      if (binding.device === "keyboard") {
        return binding.code.replace(/^Key|^Digit/, "");
      }
      if (binding.device === "pointer") return `Pointer ${binding.button + 1}`;
      if ("axis" in binding) return `Axis ${binding.axis + 1}`;
      const standard = [
        "A / Cross",
        "B / Circle",
        "X / Square",
        "Y / Triangle",
        "Left bumper",
        "Right bumper",
        "Left trigger",
        "Right trigger",
        "Back",
        "Start",
        "Left stick",
        "Right stick",
        "D-pad up",
        "D-pad down",
        "D-pad left",
        "D-pad right",
        "Home",
      ];
      return standard[binding.button] ?? `Button ${binding.button + 1}`;
    },
    clear,
    dispose() {
      clear();
      disposed = true;
      events.abort();
    },
  };
}

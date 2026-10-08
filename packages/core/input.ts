/**
 * Turns device input into the schema's actions, one sample per step. Devices
 * (a viewport, a gamepad poller, an automation script) call `keyDown`,
 * `keyUp`, `pointer...`; UI buttons call `press(action)` so their clicks go
 * through the same recorded, replayable path as keys.
 */
import type {
  Action,
  ActionValue,
  ButtonState,
  InputModel,
  PointerModel,
  Schema,
  Vec2,
} from "@ink/schema";

export interface PointerSample {
  /** Normalized device coordinates in the game viewport, y up. */
  position: Vec2;
  inside: boolean;
  locked: boolean;
  ray: PointerModel["ray"];
  hovered: number;
  point: PointerModel["point"];
}

export class InputState {
  readonly #down = new Set<string>();
  readonly #pressed = new Set<string>();
  readonly #released = new Set<string>();
  /** Actions pressed by UI for exactly one step. */
  readonly #tapped = new Set<string>();
  /** Actions held by UI until released. */
  readonly #held = new Set<string>();
  readonly #heldPressed = new Set<string>();
  readonly #heldReleased = new Set<string>();
  readonly #devices = new Map<
    string,
    Record<string, number | Vec2 | boolean>
  >();
  readonly #lastButtons = new Map<string, boolean>();
  bindings: Record<string, Action> = {};
  #delta: Vec2 = [0, 0];
  #wheel = 0;
  #pointer: PointerSample = {
    position: [0, 0],
    inside: false,
    locked: false,
    ray: { origin: [0, 0, 0], direction: [0, 0, -1] },
    hovered: 0,
    point: [0, 0, 0],
  };
  viewport: Vec2 = [1280, 720];
  /** Disable while a text field or editor tool owns the keyboard. */
  enabled = true;

  constructor(public schema: Schema) {}

  binding(name: string): Action {
    const action = this.schema.actions.find((a) => a.name === name)?.action;
    if (!action) throw new Error(`unknown action: ${name}`);
    const override = this.bindings[name];
    return override?.kind === action.kind ? override : action;
  }

  /** Replace one physical binding without mutating the game's schema. */
  bind(name: string, slot: string, keys: string[]) {
    const action = this.binding(name);
    const slots = action.kind === "button"
      ? ["keys"]
      : action.kind === "axis"
      ? ["negative", "positive"]
      : ["left", "right", "up", "down"];
    if (!slots.includes(slot) || keys.some((key) => !key || key.length > 80)) {
      throw new Error("invalid action binding");
    }
    this.bindings = {
      ...this.bindings,
      [name]: { ...action, [slot]: [...keys] },
    };
    this.releaseAll();
  }

  /** A device replaces its complete contribution each poll; sources combine. */
  device(
    source: string,
    actions: Record<string, number | Vec2 | boolean> | null,
  ) {
    if (actions) this.#devices.set(source, structuredClone(actions));
    else this.#devices.delete(source);
  }

  keyDown(code: string) {
    if (!this.enabled || this.#down.has(code)) return;
    this.#down.add(code);
    this.#pressed.add(code);
  }

  keyUp(code: string) {
    if (!this.#down.has(code)) return;
    this.#down.delete(code);
    this.#released.add(code);
  }

  /** Release everything, e.g. when the window loses focus. */
  releaseAll() {
    for (const code of this.#down) this.#released.add(code);
    this.#down.clear();
    for (const action of this.#held) this.#heldReleased.add(action);
    this.#held.clear();
    this.#devices.clear();
    this.#delta = [0, 0];
  }

  /** Start a new run without carrying edges from the previous run. */
  reset() {
    this.releaseAll();
    this.#pressed.clear();
    this.#released.clear();
    this.#tapped.clear();
    this.#heldPressed.clear();
    this.#heldReleased.clear();
    this.#lastButtons.clear();
    this.#wheel = 0;
  }

  pointerMove(dx: number, dy: number) {
    this.#delta = [this.#delta[0] + dx, this.#delta[1] + dy];
  }

  wheel(amount: number) {
    this.#wheel += amount;
  }

  pointer(sample: Partial<PointerSample>) {
    this.#pointer = { ...this.#pointer, ...sample };
  }

  /** Press an action for one step, as a UI button does. */
  press(action: string) {
    this.#tapped.add(action);
  }

  hold(action: string, down: boolean) {
    if (down && !this.#held.has(action)) {
      this.#held.add(action);
      this.#heldPressed.add(action);
    } else if (!down && this.#held.delete(action)) {
      this.#heldReleased.add(action);
    }
  }

  isDown(code: string) {
    return this.#down.has(code);
  }

  /** The input for the next step; clears per-step edges and deltas. */
  sample(tick: number, dt: number, time: number): InputModel {
    const any = (keys: string[], set: Set<string>) =>
      keys.some((k) => set.has(k));
    const actions: Record<string, ActionValue> = {};
    for (const { name } of this.schema.actions) {
      const action = this.binding(name);
      const devices = this.enabled
        ? [...this.#devices.values()].map((d) => d[name])
        : [];
      if (action.kind === "button") {
        const tapped = this.#tapped.has(name);
        const held = this.#held.has(name);
        const down = tapped || held || any(action.keys, this.#down) ||
          devices.some((v) => v === true);
        const prior = this.#lastButtons.get(name) ?? false;
        const button: ButtonState = {
          down,
          pressed: tapped ||
            (!prior &&
              (down || this.#heldPressed.has(name) ||
                any(action.keys, this.#pressed))),
          released: !down &&
            (prior || this.#heldReleased.has(name) ||
              any(action.keys, this.#released)),
        };
        this.#lastButtons.set(name, down);
        actions[name] = button;
      } else if (action.kind === "axis") {
        const analog = devices.reduce<number>(
          (sum, v) =>
            sum + (typeof v === "number" && Number.isFinite(v) ? v : 0),
          0,
        );
        actions[name] = Math.max(
          -1,
          Math.min(
            1,
            analog + (any(action.positive, this.#down) ? 1 : 0) -
              (any(action.negative, this.#down) ? 1 : 0),
          ),
        );
      } else {
        let x = (any(action.right, this.#down) ? 1 : 0) -
          (any(action.left, this.#down) ? 1 : 0);
        let y = (any(action.up, this.#down) ? 1 : 0) -
          (any(action.down, this.#down) ? 1 : 0);
        for (const value of devices) {
          if (
            Array.isArray(value) && value.length === 2 &&
            value.every(Number.isFinite)
          ) {
            x += value[0];
            y += value[1];
          }
        }
        const length = Math.hypot(x, y);
        if (length > 1) {
          x /= length;
          y /= length;
        }
        actions[name] = [x, y];
      }
    }
    const input: InputModel = {
      tick,
      dt,
      time,
      viewport: this.viewport,
      pointer: {
        position: this.#pointer.position,
        delta: this.#delta,
        wheel: this.#wheel,
        ray: this.#pointer.ray,
        hovered: this.#pointer.hovered,
        point: this.#pointer.point,
        inside: this.#pointer.inside,
        locked: this.#pointer.locked,
      },
      actions,
    };
    this.#pressed.clear();
    this.#released.clear();
    this.#tapped.clear();
    this.#heldPressed.clear();
    this.#heldReleased.clear();
    this.#delta = [0, 0];
    this.#wheel = 0;
    return input;
  }
}

/** Human-readable binding, e.g. "Space" or "A / D". */
export function describeAction(
  action: Schema["actions"][number]["action"],
): string {
  const keys = (codes: string[]) => codes.map(keyLabel).join("/");
  switch (action.kind) {
    case "button":
      return keys(action.keys);
    case "axis":
      return `${keys(action.negative)} ↔ ${keys(action.positive)}`;
    case "axis2":
      return [action.up, action.left, action.down, action.right].map(keys).join(
        " ",
      );
  }
}

export function keyLabel(code: string): string {
  const padButton = /^PadButton(\d+)$/.exec(code);
  if (padButton) {
    return `Gamepad ${
      [
        "A",
        "B",
        "X",
        "Y",
        "LB",
        "RB",
        "LT",
        "RT",
        "Back",
        "Start",
        "L3",
        "R3",
        "↑",
        "↓",
        "←",
        "→",
      ][Number(padButton[1])] ?? padButton[1]
    }`;
  }
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) {
    return { Up: "↑", Down: "↓", Left: "←", Right: "→" }[code.slice(5)] ?? code;
  }
  if (code === "MouseLeft") return "LMB";
  if (code === "MouseRight") return "RMB";
  if (code === "MouseMiddle") return "MMB";
  return code;
}

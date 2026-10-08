/**
 * Turns device input into the schema's actions, one sample per step. Devices
 * (a viewport, a gamepad poller, an automation script) call `keyDown`,
 * `keyUp`, `pointer...`; UI buttons call `press(action)` so their clicks go
 * through the same recorded, replayable path as keys.
 */
import type {
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
    this.#held.clear();
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
    if (down) this.#held.add(action);
    else this.#held.delete(action);
  }

  isDown(code: string) {
    return this.#down.has(code);
  }

  /** The input for the next step; clears per-step edges and deltas. */
  sample(tick: number, dt: number, time: number): InputModel {
    const any = (keys: string[], set: Set<string>) =>
      keys.some((k) => set.has(k));
    const actions: Record<string, ActionValue> = {};
    for (const { name, action } of this.schema.actions) {
      if (action.kind === "button") {
        const tapped = this.#tapped.has(name);
        const held = this.#held.has(name);
        const button: ButtonState = {
          down: tapped || held || any(action.keys, this.#down),
          pressed: tapped || any(action.keys, this.#pressed),
          released: any(action.keys, this.#released),
        };
        actions[name] = button;
      } else if (action.kind === "axis") {
        actions[name] = (any(action.positive, this.#down) ? 1 : 0) -
          (any(action.negative, this.#down) ? 1 : 0);
      } else {
        let x = (any(action.right, this.#down) ? 1 : 0) -
          (any(action.left, this.#down) ? 1 : 0);
        let y = (any(action.up, this.#down) ? 1 : 0) -
          (any(action.down, this.#down) ? 1 : 0);
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

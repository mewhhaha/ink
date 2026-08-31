import type { GameAction, GameObservation } from "@ink/blot/protocol.ts";
import type { DeviceInputFrame } from "@ink/input/model.ts";

export interface ContinuousKeyboardActionBinding {
  readonly pressed: string;
  readonly released: string;
}

export type KeyboardActionBinding =
  | string
  | ContinuousKeyboardActionBinding;

export class AdventureInputMap {
  readonly #bindings: ReadonlyMap<string, KeyboardActionBinding>;

  constructor(bindings: Readonly<Record<string, KeyboardActionBinding>>) {
    const parsed = new Map<string, KeyboardActionBinding>();
    for (const [code, binding] of Object.entries(bindings)) {
      if (!/^[a-zA-Z0-9_.:-]+$/.test(code)) {
        throw new Error(
          `adventure keyboard code ${JSON.stringify(code)} is unsupported`,
        );
      }
      parsed.set(
        code,
        typeof binding === "string"
          ? required_action(binding, code)
          : Object.freeze({
            pressed: required_action(binding.pressed, `${code} pressed`),
            released: required_action(binding.released, `${code} released`),
          }),
      );
    }
    this.#bindings = parsed;
  }

  includes(code: string): boolean {
    return this.#bindings.has(code);
  }

  actions(
    frame: DeviceInputFrame,
    observation: GameObservation | undefined,
    mode: "active" | "release_only",
  ): readonly GameAction[] {
    if (observation === undefined) return [];
    const available = new Map(
      observation.actions.map(({ id, action }) => [id, action]),
    );
    const actions: GameAction[] = [];
    for (const control of frame.controls) {
      if (
        control.type !== "button" || control.device.kind !== "keyboard" ||
        (control.phase !== "pressed" && control.phase !== "released")
      ) {
        continue;
      }
      const name = String(control.control);
      if (!name.startsWith("key:")) continue;
      const binding = this.#bindings.get(name.slice("key:".length));
      if (binding === undefined) continue;
      const action_id = typeof binding === "string"
        ? control.phase === "pressed" && mode === "active" ? binding : undefined
        : control.phase === "pressed"
        ? mode === "active" ? binding.pressed : undefined
        : binding.released;
      if (action_id === undefined) continue;
      const action = available.get(action_id);
      if (action !== undefined) actions.push(action);
    }
    return Object.freeze(actions);
  }
}

export function game_surface_owns_pointer_lock(
  surface: { readonly canvas: object } | null,
  pointer_lock_element: object | null,
): boolean {
  if (surface === null) return false;
  return pointer_lock_element === surface ||
    pointer_lock_element === surface.canvas;
}

function required_action(value: string, label: string): string {
  const parsed = value.trim();
  if (parsed.length === 0 || parsed.includes("\u0000")) {
    throw new Error(
      `adventure keyboard action ${
        JSON.stringify(label)
      } must be nonempty without nulls`,
    );
  }
  return parsed;
}

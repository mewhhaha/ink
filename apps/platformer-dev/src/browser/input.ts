import type { GameAction, GameObservation } from "@ink/blot/protocol.ts";
import type { DeviceInputFrame } from "@ink/input/model.ts";

export interface ContinuousPlatformerBinding {
  readonly pressed: string;
  readonly released: string;
}

export type PlatformerKeyboardBinding = string | ContinuousPlatformerBinding;

export class PlatformerInputMap {
  readonly #bindings: ReadonlyMap<string, PlatformerKeyboardBinding>;

  constructor(bindings: Readonly<Record<string, PlatformerKeyboardBinding>>) {
    const parsed = new Map<string, PlatformerKeyboardBinding>();
    for (const [code, binding] of Object.entries(bindings)) {
      if (!/^[a-zA-Z0-9_.:-]+$/.test(code)) {
        throw new Error(
          `platformer keyboard code ${JSON.stringify(code)} is unsupported`,
        );
      }
      parsed.set(
        code,
        typeof binding === "string"
          ? required_action_id(binding, code)
          : Object.freeze({
            pressed: required_action_id(binding.pressed, `${code} pressed`),
            released: required_action_id(
              binding.released,
              `${code} released`,
            ),
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
      const control_name = String(control.control);
      if (!control_name.startsWith("key:")) continue;
      const binding = this.#bindings.get(control_name.slice(4));
      if (binding === undefined) continue;
      const action_id = typeof binding === "string"
        ? control.phase === "pressed" ? binding : undefined
        : control.phase === "pressed"
        ? binding.pressed
        : binding.released;
      if (action_id === undefined) continue;
      const action = available.get(action_id);
      if (action !== undefined) actions.push(action);
    }
    return Object.freeze(actions);
  }
}

function required_action_id(value: string, control: string): string {
  const parsed = value.trim();
  if (parsed.length === 0 || parsed.includes("\u0000")) {
    throw new Error(
      `platformer keyboard action ${
        JSON.stringify(control)
      } must be nonempty without nulls`,
    );
  }
  return parsed;
}

import type { InputState } from "@ink/core/input";

export interface GamepadSample {
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
  connected: boolean;
}

const deadzone = (v: number) =>
  Math.abs(v) <= 0.15
    ? 0
    : Math.sign(v) * Math.min(1, (Math.abs(v) - 0.15) / 0.85);

/** Stable physical codes support rebinding; analog defaults keep stick precision. */
export function pollGamepad(
  input: InputState,
  pad: GamepadSample | null,
  prior = new Set<string>(),
): Set<string> {
  const down = new Set<string>();
  const actions: Record<string, number | [number, number] | boolean> = {};
  if (pad?.connected) {
    pad.buttons.forEach((b, i) => {
      if (b.pressed || b.value > 0.5) down.add(`PadButton${i}`);
    });
    pad.axes.forEach((v, i) => {
      if (Math.abs(v) > 0.5) down.add(`PadAxis${i}${v > 0 ? "+" : "-"}`);
    });
    let button = 0;
    const defaults: Record<string, number> = {
      jump: 0,
      fire: 7,
      press: 2,
      interact: 2,
      restart: 9,
    };
    for (const { name, action } of input.schema.actions) {
      const explicit = input.bindings[name];
      const codes = explicit
        ? Object.values(explicit).filter(Array.isArray).flat() as string[]
        : null;
      // Keyboard rebinding preserves analog defaults; explicit pad bindings replace them.
      if (
        codes && (!codes.length || codes.some((code) => code.startsWith("Pad")))
      ) continue;
      if (action.kind === "button") {
        actions[name] = down.has(`PadButton${defaults[name] ?? button++}`);
      } else {
        const offset = name === "turn" || name === "look" ? 2 : 0;
        const x = deadzone(pad.axes[offset] ?? 0),
          y = -deadzone(pad.axes[offset + 1] ?? 0);
        actions[name] = action.kind === "axis" ? x : [x, y];
      }
    }
  }
  for (const code of down) if (!prior.has(code)) input.keyDown(code);
  for (const code of prior) if (!down.has(code)) input.keyUp(code);
  input.device("gamepad", pad?.connected ? actions : null);
  return down;
}

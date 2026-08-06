export interface ContinuousKeyboardActionBinding {
  readonly pressed: string;
  readonly released: string;
}

export type KeyboardActionBinding = string | ContinuousKeyboardActionBinding;

export interface KeyboardInputController {
  readonly press: (key: string, code: string, repeat: boolean) => boolean;
  readonly release: (code: string) => boolean;
  readonly release_all: () => void;
}

export interface PointerLockSurface {
  readonly canvas: object;
}

export function game_surface_owns_pointer_lock(
  surface: PointerLockSurface | null,
  pointer_lock_element: object | null,
): boolean {
  if (!surface) return false;
  return pointer_lock_element === surface ||
    pointer_lock_element === surface.canvas;
}

export function create_keyboard_input_controller(
  bindings: Readonly<Record<string, KeyboardActionBinding>>,
  dispatch_action_id: (action_id: string) => void,
): KeyboardInputController {
  const held_bindings = new Map<string, ContinuousKeyboardActionBinding>();
  const held_binding_counts = new Map<string, number>();

  const release = (code: string): boolean => {
    const binding = held_bindings.get(code);
    if (!binding) return false;
    held_bindings.delete(code);

    const binding_key = continuous_binding_key(binding);
    const remaining = (held_binding_counts.get(binding_key) ?? 1) - 1;
    if (remaining > 0) {
      held_binding_counts.set(binding_key, remaining);
      return true;
    }

    held_binding_counts.delete(binding_key);
    dispatch_action_id(binding.released);
    return true;
  };

  return {
    press(key, code, repeat) {
      const binding = bindings[key.toLowerCase()];
      if (!binding) return false;
      if (repeat || held_bindings.has(code)) return true;

      if (typeof binding === "string") {
        dispatch_action_id(binding);
        return true;
      }

      held_bindings.set(code, binding);
      const binding_key = continuous_binding_key(binding);
      const held_count = held_binding_counts.get(binding_key) ?? 0;
      held_binding_counts.set(binding_key, held_count + 1);
      if (held_count === 0) dispatch_action_id(binding.pressed);
      return true;
    },
    release,
    release_all() {
      const codes = [...held_bindings.keys()];
      for (const code of codes) release(code);
    },
  };
}

function continuous_binding_key(
  binding: ContinuousKeyboardActionBinding,
): string {
  return `${binding.pressed}\u0000${binding.released}`;
}

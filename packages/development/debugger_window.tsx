import { ArrowsPointingOutIcon } from "@heroicons/react/24/outline";
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  apply_debugger_action,
  type DebuggerCommandRegistry,
  type DebuggerEntry,
  initial_debugger_state,
  maximum_debugger_history_entries,
} from "./debugger.ts";

export interface DebuggerWindowProps {
  readonly commands: DebuggerCommandRegistry;
  readonly on_close: () => void;
  readonly on_clear: () => void;
  readonly runtime_entries: readonly DebuggerEntry[];
  readonly runtime_message: string;
}

export const DebuggerWindow = function debugger_window({
  commands,
  on_close,
  on_clear,
  runtime_entries,
  runtime_message,
}: DebuggerWindowProps) {
  "use memo";

  const [debugger_state, set_debugger_state] = useState(() => {
    let state = initial_debugger_state;
    for (const entry of runtime_entries) {
      state = apply_debugger_action(state, {
        type: "record",
        kind: entry.kind,
        message: entry.message,
      });
    }
    return state;
  });
  const latest_runtime_entry_id_reference = useRef(
    runtime_entries.at(-1)?.id,
  );
  const command_input_id = useId();
  const completion_list_id = useId();
  const drag_reference = useRef<
    {
      readonly pointer_id: number;
      readonly offset_x: number;
      readonly offset_y: number;
    } | undefined
  >(undefined);
  const resize_reference = useRef<
    {
      readonly pointer_id: number;
      readonly start_x: number;
      readonly start_y: number;
      readonly width: number;
      readonly height: number;
    } | undefined
  >(undefined);
  const history_reference = useRef<HTMLOListElement>(null);
  const command_history_reference = useRef<string[]>([]);
  const command_position_reference = useRef(0);
  const draft_reference = useRef("");
  const completions = commands.completions(debugger_state.input);

  useEffect(() => {
    set_debugger_state((current) =>
      apply_debugger_action(current, {
        type: "record",
        kind: "runtime",
        message: runtime_message,
      })
    );
  }, [runtime_message]);

  useEffect(() => {
    const latest_entry_id = latest_runtime_entry_id_reference.current;
    const pending_entries = latest_entry_id === undefined
      ? runtime_entries
      : runtime_entries.filter(({ id }) => id > latest_entry_id);
    if (pending_entries.length === 0) return;
    set_debugger_state((current) => {
      let state = current;
      for (const entry of pending_entries) {
        state = apply_debugger_action(state, {
          type: "record",
          kind: entry.kind,
          message: entry.message,
        });
      }
      return state;
    });
    latest_runtime_entry_id_reference.current = pending_entries.at(-1)!.id;
  }, [runtime_entries]);

  useEffect(() => {
    const history = history_reference.current;
    if (history) history.scrollTop = history.scrollHeight;
  }, [debugger_state.history]);

  const begin_drag = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag_reference.current = {
      pointer_id: event.pointerId,
      offset_x: event.clientX - debugger_state.position.x,
      offset_y: event.clientY - debugger_state.position.y,
    };
  };

  const continue_drag = (event: PointerEvent<HTMLElement>) => {
    const drag = drag_reference.current;
    if (!drag || drag.pointer_id !== event.pointerId) return;
    set_debugger_state((current) =>
      apply_debugger_action(current, {
        type: "move",
        position: {
          x: event.clientX - drag.offset_x,
          y: event.clientY - drag.offset_y,
        },
      })
    );
  };

  const finish_drag = (event: PointerEvent<HTMLElement>) => {
    if (drag_reference.current?.pointer_id !== event.pointerId) return;
    drag_reference.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resize = (width: number, height: number) => {
    set_debugger_state((current) =>
      apply_debugger_action(current, {
        type: "resize",
        size: {
          width: Math.min(width, innerWidth - current.position.x - 16),
          height: Math.min(height, innerHeight - current.position.y - 16),
        },
      })
    );
  };

  const begin_resize = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const window = event.currentTarget.closest<HTMLElement>("aside");
    if (!window) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = window.getBoundingClientRect();
    resize_reference.current = {
      pointer_id: event.pointerId,
      start_x: event.clientX,
      start_y: event.clientY,
      width: bounds.width,
      height: bounds.height,
    };
  };

  const continue_resize = (event: PointerEvent<HTMLButtonElement>) => {
    const resizing = resize_reference.current;
    if (!resizing || resizing.pointer_id !== event.pointerId) return;
    resize(
      resizing.width + event.clientX - resizing.start_x,
      resizing.height + event.clientY - resizing.start_y,
    );
  };

  const finish_resize = (event: PointerEvent<HTMLButtonElement>) => {
    if (resize_reference.current?.pointer_id !== event.pointerId) return;
    resize_reference.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resize_with_keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    let width = debugger_state.size.width;
    let height = debugger_state.size.height;
    const distance = event.shiftKey ? 48 : 16;
    switch (event.key) {
      case "ArrowLeft":
        width -= distance;
        break;
      case "ArrowRight":
        width += distance;
        break;
      case "ArrowUp":
        height -= distance;
        break;
      case "ArrowDown":
        height += distance;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    resize(width, height);
  };

  const submit_command = async () => {
    const source = debugger_state.input.trim();
    if (!source) return;
    if (command_history_reference.current.at(-1) !== source) {
      command_history_reference.current.push(source);
      if (
        command_history_reference.current.length >
          maximum_debugger_history_entries
      ) {
        command_history_reference.current.shift();
      }
    }
    command_position_reference.current =
      command_history_reference.current.length;
    draft_reference.current = "";
    set_debugger_state((current) => {
      const recorded = apply_debugger_action(current, {
        type: "record",
        kind: "command",
        message: `> ${source}`,
      });
      return apply_debugger_action(recorded, { type: "set_input", input: "" });
    });
    try {
      const result = await commands.execute(source);
      if (typeof result !== "string") {
        on_clear();
        set_debugger_state((current) =>
          apply_debugger_action(current, { type: "clear" })
        );
        return;
      }
      if (result.length === 0) return;
      set_debugger_state((current) =>
        apply_debugger_action(current, {
          type: "record",
          kind: "result",
          message: result,
        })
      );
    } catch (error) {
      set_debugger_state((current) =>
        apply_debugger_action(current, {
          type: "record",
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
  };

  const set_input = (input: string) => {
    set_debugger_state((current) =>
      apply_debugger_action(current, { type: "set_input", input })
    );
  };

  const show_previous_command = () => {
    const history = command_history_reference.current;
    if (history.length === 0 || command_position_reference.current === 0) {
      return;
    }
    if (command_position_reference.current === history.length) {
      draft_reference.current = debugger_state.input;
    }
    command_position_reference.current -= 1;
    set_input(history[command_position_reference.current]);
  };

  const show_next_command = () => {
    const history = command_history_reference.current;
    if (command_position_reference.current >= history.length) return;
    command_position_reference.current += 1;
    set_input(
      command_position_reference.current === history.length
        ? draft_reference.current
        : history[command_position_reference.current],
    );
  };

  return (
    <aside
      className="fixed z-20 flex max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-white/15 bg-zinc-950/95 font-mono text-xs text-zinc-100 shadow-[0_28px_90px_rgba(0,0,0,0.82)] outline-none backdrop-blur focus-within:border-white/70 focus-within:ring-2 focus-within:ring-white focus:border-white/70 focus:ring-2 focus:ring-white"
      style={{
        width: debugger_state.size.width,
        height: debugger_state.size.height,
        transform:
          `translate(${debugger_state.position.x}px, ${debugger_state.position.y}px)`,
      }}
      aria-label="Game debugger"
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("button, input, select, textarea, a")
        ) return;
        event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        on_close();
      }}
    >
      <header
        className="flex cursor-move touch-none select-none items-center border-b border-white/10 bg-zinc-900 px-2 py-1.5 font-semibold"
        onPointerDown={begin_drag}
        onPointerMove={continue_drag}
        onPointerUp={finish_drag}
        onPointerCancel={finish_drag}
      >
        <strong className="min-w-0 flex-1 px-1">Debugger</strong>
        <button
          type="button"
          className="relative z-10 grid size-6 cursor-nwse-resize touch-none place-items-center rounded-sm text-zinc-400 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
          aria-label="Resize debugger"
          title="Drag or use arrow keys to resize"
          onPointerDown={begin_resize}
          onPointerMove={continue_resize}
          onPointerUp={finish_resize}
          onPointerCancel={finish_resize}
          onKeyDown={resize_with_keyboard}
        >
          <ArrowsPointingOutIcon className="size-4" />
        </button>
      </header>
      <ol
        ref={history_reference}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2"
        aria-live="polite"
      >
        {debugger_state.history.map((entry) => (
          <li
            key={entry.id}
            className={entry.kind === "error"
              ? "text-red-300"
              : entry.kind === "command"
              ? "text-sky-300"
              : entry.kind === "runtime"
              ? "text-zinc-400"
              : "text-emerald-300"}
          >
            {entry.message}
          </li>
        ))}
      </ol>
      <form
        className="relative isolate flex border-t border-white/10"
        onSubmit={(event) => {
          event.preventDefault();
          void submit_command();
        }}
      >
        <label className="sr-only" htmlFor={command_input_id}>
          Debugger command
        </label>
        <input
          id={command_input_id}
          className="relative z-0 min-w-0 flex-1 bg-black/50 px-3 py-2 outline-none placeholder:text-zinc-600 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
          value={debugger_state.input}
          onChange={(event) => set_input(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              show_previous_command();
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              show_next_command();
              return;
            }
            if (event.key === "Tab" && completions.length > 0) {
              event.preventDefault();
              set_input(
                commands.complete(debugger_state.input, completions[0]),
              );
            }
          }}
          placeholder="help"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-controls={completion_list_id}
          aria-autocomplete="list"
          aria-expanded={completions.length > 0 &&
            debugger_state.input.length > 0}
        />
        {completions.length > 0 && debugger_state.input.length > 0 && (
          <div
            id={completion_list_id}
            className="absolute right-0 bottom-full left-0 z-20 max-h-32 overflow-y-auto border border-white/10 bg-zinc-950 py-1 shadow-xl"
            role="listbox"
          >
            {completions.map((completion) => (
              <button
                key={completion}
                type="button"
                className="block w-full px-3 py-1 text-left text-zinc-300 hover:bg-white/10 hover:text-white"
                role="option"
                aria-selected={false}
                onClick={() =>
                  set_input(
                    commands.complete(debugger_state.input, completion),
                  )}
              >
                {completion}
              </button>
            ))}
          </div>
        )}
        <button
          type="submit"
          className="relative z-0 border-l border-white/10 px-3 py-2 text-zinc-300 outline-none hover:bg-white/10 hover:text-white focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
        >
          Run
        </button>
      </form>
    </aside>
  );
};

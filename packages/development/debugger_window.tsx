import { type PointerEvent, useEffect, useRef, useState } from "react";
import {
  apply_debugger_action,
  type DebuggerCommand,
  initial_debugger_state,
  parse_debugger_command,
} from "./debugger.ts";

export interface DebuggerWindowProps {
  readonly execute_command: (command: DebuggerCommand) => Promise<string>;
  readonly runtime_message: string;
}

export const DebuggerWindow = function debugger_window({
  execute_command,
  runtime_message,
}: DebuggerWindowProps) {
  "use memo";

  const [debugger_state, set_debugger_state] = useState(
    initial_debugger_state,
  );
  const drag_reference = useRef<
    {
      readonly pointer_id: number;
      readonly offset_x: number;
      readonly offset_y: number;
    } | undefined
  >(undefined);
  const history_reference = useRef<HTMLOListElement>(null);

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

  const submit_command = async () => {
    const source = debugger_state.input.trim();
    if (!source) return;
    set_debugger_state((current) => {
      const recorded = apply_debugger_action(current, {
        type: "record",
        kind: "command",
        message: `> ${source}`,
      });
      return apply_debugger_action(recorded, { type: "set_input", input: "" });
    });
    try {
      const command = parse_debugger_command(source);
      if (command.type === "clear") {
        set_debugger_state((current) =>
          apply_debugger_action(current, { type: "clear" })
        );
        return;
      }
      const result = await execute_command(command);
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

  return (
    <aside
      className="fixed z-20 flex h-[min(18rem,40vh)] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-md border border-white/15 bg-zinc-950/95 font-mono text-xs text-zinc-100 shadow-2xl backdrop-blur"
      style={{
        transform:
          `translate(${debugger_state.position.x}px, ${debugger_state.position.y}px)`,
      }}
      aria-label="Game debugger"
    >
      <header
        className="cursor-move touch-none select-none border-b border-white/10 bg-zinc-900 px-3 py-2 font-semibold"
        onPointerDown={begin_drag}
        onPointerMove={continue_drag}
        onPointerUp={finish_drag}
        onPointerCancel={finish_drag}
      >
        Debugger
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
        className="flex border-t border-white/10"
        onSubmit={(event) => {
          event.preventDefault();
          void submit_command();
        }}
      >
        <label className="sr-only" htmlFor="ink-debugger-command">
          Debugger command
        </label>
        <input
          id="ink-debugger-command"
          className="min-w-0 flex-1 bg-black/50 px-3 py-2 outline-none placeholder:text-zinc-600 focus:ring-1 focus:ring-inset focus:ring-sky-500"
          value={debugger_state.input}
          onChange={(event) =>
            set_debugger_state((current) =>
              apply_debugger_action(current, {
                type: "set_input",
                input: event.target.value,
              })
            )}
          placeholder="help"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          className="border-l border-white/10 px-3 py-2 text-zinc-300 hover:bg-white/10 hover:text-white"
        >
          Run
        </button>
      </form>
    </aside>
  );
};

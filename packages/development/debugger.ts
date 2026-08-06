import {
  Do,
  get,
  put,
  run_state_terminal,
  type StateValue,
} from "@mewhhaha/typeclasses";
import type { GameAction } from "@ink/blot/protocol.ts";
import type { Observation } from "@ink/observability/model.ts";
import type { ObservationSink } from "@ink/observability/sink.ts";
import type { EditorAction } from "./logic.ts";

export type DebuggerEntryKind = "command" | "result" | "runtime" | "error";

export interface DebuggerEntry {
  readonly id: number;
  readonly kind: DebuggerEntryKind;
  readonly message: string;
}

export interface DebuggerState {
  readonly input: string;
  readonly history: readonly DebuggerEntry[];
  readonly next_entry_id: number;
  readonly position: { readonly x: number; readonly y: number };
}

export type DebuggerAction =
  | { readonly type: "set_input"; readonly input: string }
  | {
    readonly type: "move";
    readonly position: { readonly x: number; readonly y: number };
  }
  | {
    readonly type: "record";
    readonly kind: DebuggerEntryKind;
    readonly message: string;
  }
  | { readonly type: "clear" };

export type DebuggerCommand =
  | { readonly type: "help" }
  | { readonly type: "status" }
  | { readonly type: "clear" }
  | { readonly type: "transport"; readonly action: EditorAction }
  | { readonly type: "game_action"; readonly action: GameAction };

export const initial_debugger_state: DebuggerState = {
  input: "",
  history: [],
  next_entry_id: 0,
  position: { x: 16, y: 16 },
};

export function debugger_transition(
  action: DebuggerAction,
): StateValue<DebuggerState, void> {
  return Do(function* () {
    const current = yield* get<DebuggerState>();
    return yield* put(next_debugger_state(current, action));
  });
}

export function apply_debugger_action(
  current: DebuggerState,
  action: DebuggerAction,
): DebuggerState {
  const [, next] = run_state_terminal(debugger_transition(action), current);
  return next;
}

export function parse_debugger_command(source: string): DebuggerCommand {
  const words = source.trim().split(/\s+/);
  const command = words[0];
  if (!command) throw new Error("enter a debugger command");

  switch (command) {
    case "help":
      require_word_count(words, 1);
      return { type: "help" };
    case "status":
      require_word_count(words, 1);
      return { type: "status" };
    case "clear":
      require_word_count(words, 1);
      return { type: "clear" };
    case "play":
    case "pause":
    case "stop":
      require_word_count(words, 1);
      return { type: "transport", action: { type: command } };
    case "frame":
      require_word_count(words, 1);
      return { type: "game_action", action: { type: "frame" } };
    case "activate":
    case "focus":
      require_word_count(words, 2);
      return {
        type: "game_action",
        action: {
          type: command,
          target: parse_nonnegative_integer(words[1], "target"),
        },
      };
    case "custom":
      require_word_count(words, 4);
      return {
        type: "game_action",
        action: {
          type: "custom",
          kind: parse_nonnegative_integer(words[1], "kind"),
          target: parse_nonnegative_integer(words[2], "target"),
          value: parse_nonnegative_integer(words[3], "value"),
        },
      };
    default:
      throw new Error(`debugger command ${JSON.stringify(command)} is unknown`);
  }
}

export const debugger_help =
  "help | status | clear | play | pause | stop | frame | activate <target> | focus <target> | custom <kind> <target> <value>";

export function create_debugger_observation_sink(
  record: (action: Extract<DebuggerAction, { type: "record" }>) => void,
): ObservationSink {
  return {
    record(observation) {
      record({
        type: "record",
        kind:
          observation.type === "diagnostic" && observation.severity === "error"
            ? "error"
            : "runtime",
        message: format_observation(observation),
      });
    },
  };
}

function format_observation(observation: Observation): string {
  const source = observation.source.instance === undefined
    ? observation.source.subsystem
    : `${observation.source.subsystem}/${observation.source.instance}`;
  switch (observation.type) {
    case "diagnostic":
      return `[${source}] ${observation.operation}: ${observation.message}`;
    case "event":
      return `[${source}] ${observation.name}`;
    case "span":
      return `[${source}] ${observation.name} ${
        format_milliseconds(observation.duration_seconds)
      }`;
    case "metric":
      return observation.kind === "histogram"
        ? `[${source}] ${observation.name} ${observation.count} samples (${observation.unit})`
        : `[${source}] ${observation.name} ${observation.value} ${observation.unit}`;
    case "frame_profile":
      return `[${source}] frame ${observation.frame_id}: ${observation.cpu_spans.length} CPU, ${observation.gpu_spans.length} GPU spans`;
  }
}

function format_milliseconds(seconds: number): string {
  return `${(seconds * 1_000).toFixed(3)} ms`;
}

function next_debugger_state(
  current: DebuggerState,
  action: DebuggerAction,
): DebuggerState {
  switch (action.type) {
    case "set_input":
      return { ...current, input: action.input };
    case "move":
      return {
        ...current,
        position: {
          x: Math.max(0, Math.round(action.position.x)),
          y: Math.max(0, Math.round(action.position.y)),
        },
      };
    case "record": {
      const history = [...current.history, {
        id: current.next_entry_id,
        kind: action.kind,
        message: action.message,
      }].slice(-100);
      return {
        ...current,
        history,
        next_entry_id: current.next_entry_id + 1,
      };
    }
    case "clear":
      return { ...current, history: [] };
  }
}

function require_word_count(words: readonly string[], expected: number): void {
  if (words.length === expected) return;
  throw new Error(
    `debugger command ${JSON.stringify(words[0])} received ${
      words.length - 1
    } arguments; expected ${expected - 1}`,
  );
}

function parse_nonnegative_integer(source: string, name: string): number {
  const value = Number(source);
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(
    `${name} ${JSON.stringify(source)} must be a nonnegative integer`,
  );
}

import {
  Do,
  get,
  put,
  run_state_terminal,
  type StateValue,
} from "@mewhhaha/typeclasses";
import {
  type Observation,
  type ObservationValue,
} from "@ink/observability/observer.ts";
import { create_redacting_sink } from "@ink/observability/redaction.ts";
import {
  type BufferedObservationSink,
  create_fan_out_sink,
  create_ring_buffer_sink,
  type FanOutObservationSink,
} from "@ink/observability/sink.ts";

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
  readonly size: { readonly width: number; readonly height: number };
}

export type DebuggerAction =
  | { readonly type: "set_input"; readonly input: string }
  | {
    readonly type: "move";
    readonly position: { readonly x: number; readonly y: number };
  }
  | {
    readonly type: "resize";
    readonly size: { readonly width: number; readonly height: number };
  }
  | {
    readonly type: "record";
    readonly kind: DebuggerEntryKind;
    readonly message: string;
  }
  | { readonly type: "clear" };

export interface DebuggerCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly execute: (
    arguments_: readonly string[],
  ) => DebuggerCommandResult | Promise<DebuggerCommandResult>;
  readonly complete?: (arguments_: readonly string[]) => readonly string[];
}

export type DebuggerCommandResult =
  | string
  | { readonly type: "clear" };

export type GizmoVisibility = "all" | "none" | "collisions" | "areas";

export type DebuggerRecordAction = Extract<
  DebuggerAction,
  { readonly type: "record" }
>;

export interface DebuggerObservationLogOptions {
  readonly capacity: number;
  readonly record: (action: DebuggerRecordAction) => void;
}

export interface DebuggerObservationLog
  extends BufferedObservationSink, FanOutObservationSink {}

export const maximum_debugger_history_entries = 100;

export const initial_debugger_state: DebuggerState = {
  input: "",
  history: [],
  next_entry_id: 0,
  position: { x: 16, y: 16 },
  size: { width: 384, height: 288 },
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

export function parse_debugger_command(source: string): readonly string[] {
  if (typeof source !== "string") {
    throw new Error("debugger command must be a string");
  }
  const words = parse_debugger_words(source, false);
  if (words.length === 0) throw new Error("enter a debugger command");
  return Object.freeze(words);
}

export class DebuggerCommandRegistry {
  readonly #commands = new Map<string, DebuggerCommand>();

  constructor(commands: readonly DebuggerCommand[] = []) {
    for (const command of commands) this.register(command);
  }

  register(command: DebuggerCommand): () => void {
    const parsed = debugger_command(command);
    if (this.#commands.has(parsed.name)) {
      throw new Error(
        `debugger command ${JSON.stringify(parsed.name)} is already registered`,
      );
    }
    this.#commands.set(parsed.name, parsed);
    return () => {
      if (this.#commands.get(parsed.name) === parsed) {
        this.#commands.delete(parsed.name);
      }
    };
  }

  async execute(source: string): Promise<DebuggerCommandResult> {
    const [name, ...arguments_] = parse_debugger_command(source);
    const command = this.#commands.get(name);
    if (command === undefined) {
      throw new Error(`debugger command ${JSON.stringify(name)} is unknown`);
    }
    const result = await command.execute(Object.freeze(arguments_));
    if (
      typeof result !== "string" &&
      (typeof result !== "object" || result === null || result.type !== "clear")
    ) {
      throw new Error(
        `debugger command ${JSON.stringify(name)} returned unsupported result ${
          JSON.stringify(result)
        }`,
      );
    }
    return result;
  }

  completions(source: string): readonly string[] {
    if (typeof source !== "string") {
      throw new Error("debugger command must be a string");
    }
    const words = parse_debugger_words(source, true);
    const ends_with_space = /\s$/.test(source);
    if (words.length === 0) return this.#matching_command_names("");
    if (words.length === 1 && !ends_with_space) {
      return this.#matching_command_names(words[0]);
    }
    const command = this.#commands.get(words[0]);
    if (command?.complete === undefined) return Object.freeze([]);
    const arguments_ = words.slice(1);
    if (ends_with_space) arguments_.push("");
    const prefix = arguments_.at(-1) ?? "";
    const candidates = command.complete(Object.freeze(arguments_));
    if (!Array.isArray(candidates)) {
      throw new Error(
        `debugger command ${
          JSON.stringify(command.name)
        } completion must return an array`,
      );
    }
    return unique_sorted(
      candidates.filter((candidate) => candidate.startsWith(prefix)),
    );
  }

  complete(source: string, candidate: string): string {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error(
        `debugger completion ${JSON.stringify(candidate)} must be nonempty`,
      );
    }
    const prefix = source.match(/\S+$/);
    return prefix === null
      ? `${source}${candidate}`
      : `${source.slice(0, prefix.index)}${candidate}`;
  }

  help(): string {
    return [...this.#commands.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ usage, description }) => `${usage} — ${description}`)
      .join("\n");
  }

  #matching_command_names(prefix: string): readonly string[] {
    return Object.freeze(
      [...this.#commands.keys()].filter((name) => name.startsWith(prefix))
        .sort(),
    );
  }
}

export function create_debugger_observation_log(
  options: DebuggerObservationLogOptions,
): DebuggerObservationLog {
  if (typeof options.record !== "function") {
    throw new Error("debugger observation log must provide a record function");
  }
  const retained = create_ring_buffer_sink(options.capacity);
  const debugger_sink = {
    record(observation: Observation) {
      options.record({
        type: "record",
        kind:
          observation.type === "diagnostic" && observation.severity === "error"
            ? "error"
            : "runtime",
        message: format_observation(observation),
      });
    },
  };
  const fan_out = create_fan_out_sink(
    [retained, debugger_sink],
    options.capacity,
  );
  const redacting = create_redacting_sink(fan_out);
  return {
    capacity: retained.capacity,
    record(observation) {
      redacting.record(observation);
    },
    observations() {
      return retained.observations();
    },
    dropped() {
      return retained.dropped();
    },
    clear() {
      retained.clear();
    },
    failures() {
      return fan_out.failures();
    },
    dropped_failures() {
      return fan_out.dropped_failures();
    },
  };
}

function format_observation(observation: Observation): string {
  const source = observation.source.instance === undefined
    ? observation.source.subsystem
    : `${observation.source.subsystem}/${observation.source.instance}`;
  switch (observation.type) {
    case "diagnostic":
      return `[${source}] ${observation.operation}: ${observation.message}${
        format_evidence(observation.evidence)
      }`;
    case "event":
      return `[${source}] ${observation.name}${
        format_evidence(observation.evidence)
      }`;
    case "span":
      return `[${source}] ${observation.name} ${
        format_milliseconds(observation.duration_seconds)
      }${format_evidence(observation.evidence)}`;
    case "metric":
      return observation.kind === "histogram"
        ? `[${source}] ${observation.name} ${observation.count} samples (${observation.unit})`
        : `[${source}] ${observation.name} ${observation.value} ${observation.unit}`;
    case "frame_profile":
      return `[${source}] frame ${observation.frame_id}: ${observation.cpu_spans.length} CPU, ${observation.gpu_spans.length} GPU spans`;
  }
}

function format_evidence(
  evidence: Readonly<Record<string, ObservationValue>>,
): string {
  const entries = Object.entries(evidence).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (entries.length === 0) return "";
  return ` ${
    entries.map(([key, value]) => `${key}=${format_observation_value(value)}`)
      .join(" ")
  }`;
}

function format_observation_value(value: ObservationValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(format_observation_value).join(",")}]`;
  }
  if (is_observation_record(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    const fields = entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${format_observation_value(entry)}`
    );
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

function is_observation_record(
  value: ObservationValue,
): value is Readonly<Record<string, ObservationValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function format_milliseconds(seconds: number): string {
  return `${(seconds * 1_000).toFixed(3)} ms`;
}

function next_debugger_state(
  current: DebuggerState,
  action: DebuggerAction,
): DebuggerState {
  const type = action.type as string;
  if (!["set_input", "move", "resize", "record", "clear"].includes(type)) {
    throw new Error(`debugger action ${JSON.stringify(type)} is unsupported`);
  }
  switch (action.type) {
    case "set_input":
      if (typeof action.input !== "string") {
        throw new Error("debugger input must be a string");
      }
      return { ...current, input: action.input };
    case "move":
      if (
        !Number.isFinite(action.position.x) ||
        !Number.isFinite(action.position.y)
      ) {
        throw new Error(
          `debugger position ${JSON.stringify(action.position.x)},${
            JSON.stringify(action.position.y)
          } must be finite`,
        );
      }
      return {
        ...current,
        position: {
          x: Math.max(0, Math.round(action.position.x)),
          y: Math.max(0, Math.round(action.position.y)),
        },
      };
    case "resize":
      if (
        !Number.isFinite(action.size.width) ||
        !Number.isFinite(action.size.height)
      ) {
        throw new Error(
          `debugger size ${JSON.stringify(action.size.width)}x${
            JSON.stringify(action.size.height)
          } must be finite`,
        );
      }
      return {
        ...current,
        size: {
          width: Math.max(280, Math.round(action.size.width)),
          height: Math.max(160, Math.round(action.size.height)),
        },
      };
    case "record": {
      if (!["command", "result", "runtime", "error"].includes(action.kind)) {
        throw new Error(
          `debugger entry kind ${JSON.stringify(action.kind)} is unsupported`,
        );
      }
      if (typeof action.message !== "string") {
        throw new Error("debugger entry message must be a string");
      }
      if (current.next_entry_id === Number.MAX_SAFE_INTEGER) {
        throw new Error("debugger entry identity exceeds safe integer range");
      }
      const history = [...current.history, {
        id: current.next_entry_id,
        kind: action.kind,
        message: action.message,
      }].slice(-maximum_debugger_history_entries);
      return {
        ...current,
        history: Object.freeze(history),
        next_entry_id: current.next_entry_id + 1,
      };
    }
    case "clear":
      return { ...current, history: [] };
  }
}

function debugger_command(command: DebuggerCommand): DebuggerCommand {
  if (!/^[a-z][a-z0-9_-]*$/.test(command.name)) {
    throw new Error(
      `debugger command name ${JSON.stringify(command.name)} is invalid`,
    );
  }
  if (
    typeof command.usage !== "string" ||
    command.usage.split(/\s/, 1)[0] !== command.name
  ) {
    throw new Error(
      `debugger command ${JSON.stringify(command.name)} usage ${
        JSON.stringify(command.usage)
      } must begin with its name`,
    );
  }
  if (
    typeof command.description !== "string" ||
    command.description.trim().length === 0
  ) {
    throw new Error(
      `debugger command ${
        JSON.stringify(command.name)
      } description must be nonempty`,
    );
  }
  if (typeof command.execute !== "function") {
    throw new Error(
      `debugger command ${JSON.stringify(command.name)} must provide execute`,
    );
  }
  if (
    command.complete !== undefined && typeof command.complete !== "function"
  ) {
    throw new Error(
      `debugger command ${
        JSON.stringify(command.name)
      } completion must be a function`,
    );
  }
  return Object.freeze({ ...command });
}

function parse_debugger_words(
  source: string,
  allow_incomplete: boolean,
): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let started = false;
  for (const character of source) {
    if (escaping) {
      word += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        word += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += character;
    started = true;
  }
  if (!allow_incomplete && escaping) {
    throw new Error("debugger command ends with an incomplete escape");
  }
  if (!allow_incomplete && quote !== null) {
    throw new Error(`debugger command has an unterminated ${quote} quote`);
  }
  if (started) words.push(word);
  return words;
}

function unique_sorted(values: readonly string[]): readonly string[] {
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
      throw new Error(
        `debugger completion ${
          JSON.stringify(value)
        } must be one nonempty word`,
      );
    }
  }
  return Object.freeze([...new Set(values)].sort());
}

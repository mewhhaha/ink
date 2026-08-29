import type { GameAction } from "@ink/blot/protocol.ts";
import {
  type DebuggerCommand,
  DebuggerCommandRegistry,
  type GizmoVisibility,
} from "@ink/development/debugger.ts";
import type { EditorAction } from "./logic.ts";

export interface GameDebuggerOptions {
  readonly additional_commands?: readonly DebuggerCommand[];
  readonly dispatch_game_action: (action: GameAction) => Promise<void>;
  readonly dispatch_transport: (action: EditorAction) => Promise<void>;
  readonly read_status: () => string;
  readonly set_gizmo_visibility: (visibility: GizmoVisibility) => void;
}

export function create_game_debugger_registry(
  options: GameDebuggerOptions,
): DebuggerCommandRegistry {
  const registry = new DebuggerCommandRegistry();
  registry.register({
    name: "status",
    usage: "status",
    description: "Show the current adventure status.",
    execute(arguments_) {
      require_argument_count("status", arguments_, 0);
      return options.read_status();
    },
  });
  registry.register({
    name: "clear",
    usage: "clear",
    description: "Clear debugger history.",
    execute(arguments_) {
      require_argument_count("clear", arguments_, 0);
      return { type: "clear" };
    },
  });
  for (const action of ["play", "pause", "stop"] as const) {
    registry.register({
      name: action,
      usage: action,
      description: `${capitalize(action)} game playback.`,
      async execute(arguments_) {
        require_argument_count(action, arguments_, 0);
        await options.dispatch_transport({ type: action });
        return `transport ${action}`;
      },
    });
  }
  registry.register({
    name: "frame",
    usage: "frame",
    description: "Advance the game by one frame.",
    async execute(arguments_) {
      require_argument_count("frame", arguments_, 0);
      await options.dispatch_game_action({ type: "frame" });
      return options.read_status();
    },
  });
  for (const action of ["activate", "focus"] as const) {
    registry.register({
      name: action,
      usage: `${action} <target>`,
      description: `${capitalize(action)} a semantic target.`,
      async execute(arguments_) {
        require_argument_count(action, arguments_, 1);
        await options.dispatch_game_action({
          type: action,
          target: parse_nonnegative_integer(arguments_[0], "target"),
        });
        return options.read_status();
      },
    });
  }
  registry.register({
    name: "custom",
    usage: "custom <kind> <target> <value>",
    description: "Send a custom game action.",
    async execute(arguments_) {
      require_argument_count("custom", arguments_, 3);
      await options.dispatch_game_action({
        type: "custom",
        kind: parse_nonnegative_integer(arguments_[0], "kind"),
        target: parse_nonnegative_integer(arguments_[1], "target"),
        value: parse_nonnegative_integer(arguments_[2], "value"),
      });
      return options.read_status();
    },
  });
  registry.register({
    name: "gizmos",
    usage: "gizmos <all|none|collisions|areas>",
    description: "Choose which development gizmos are visible.",
    complete: () => ["all", "none", "collisions", "areas"],
    execute(arguments_) {
      require_argument_count("gizmos", arguments_, 1);
      const visibility = gizmo_visibility(arguments_[0]);
      options.set_gizmo_visibility(visibility);
      return `gizmos ${visibility}`;
    },
  });
  registry.register({
    name: "help",
    usage: "help",
    description: "List registered debugger commands.",
    execute(arguments_) {
      require_argument_count("help", arguments_, 0);
      return registry.help();
    },
  });
  for (const command of options.additional_commands ?? []) {
    registry.register(command);
  }
  return registry;
}

function require_argument_count(
  command: string,
  arguments_: readonly string[],
  expected: number,
): void {
  if (arguments_.length === expected) return;
  throw new Error(
    `debugger command ${
      JSON.stringify(command)
    } received ${arguments_.length} arguments; expected ${expected}`,
  );
}

function parse_nonnegative_integer(source: string, name: string): number {
  const value = /^(0|[1-9][0-9]*)$/.test(source) ? Number(source) : NaN;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(
    `${name} ${JSON.stringify(source)} must be a nonnegative integer`,
  );
}

function gizmo_visibility(source: string): GizmoVisibility {
  if (
    source === "all" || source === "none" || source === "collisions" ||
    source === "areas"
  ) {
    return source;
  }
  throw new Error(
    `gizmo visibility ${
      JSON.stringify(source)
    } must be all, none, collisions, or areas`,
  );
}

function capitalize(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}

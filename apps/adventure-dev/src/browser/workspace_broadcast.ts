import type { GameAction } from "@ink/blot/protocol.ts";
import type { EditorAction } from "./logic.ts";

export type WorkspaceMessage =
  | { readonly type: "transport"; readonly action: EditorAction }
  | { readonly type: "game_action"; readonly action: GameAction }
  | {
    readonly type: "preview_update";
    readonly action: Extract<GameAction, { readonly type: "custom" }>;
  };

export function workspace_channel_name(workspace_id: string): string {
  if (workspace_id.trim().length === 0) {
    throw new Error(
      `workspace id ${JSON.stringify(workspace_id)} must not be empty`,
    );
  }
  return `ink-adventure-development:${workspace_id}`;
}

export function parse_workspace_message(value: unknown): WorkspaceMessage {
  const message = require_record(value, "workspace message");
  switch (message.type) {
    case "transport":
      return { type: "transport", action: parse_editor_action(message.action) };
    case "game_action":
      return { type: "game_action", action: parse_game_action(message.action) };
    case "preview_update": {
      const action = parse_game_action(message.action);
      if (action.type !== "custom") {
        throw new Error(
          `workspace preview action ${
            JSON.stringify(action.type)
          } must be "custom"`,
        );
      }
      return { type: "preview_update", action };
    }
    default:
      throw new Error(
        `workspace message type ${JSON.stringify(message.type)} is unsupported`,
      );
  }
}

function parse_editor_action(value: unknown): EditorAction {
  const action = require_record(value, "workspace transport action");
  if (
    action.type === "play" || action.type === "pause" || action.type === "stop"
  ) {
    return { type: action.type };
  }
  throw new Error(
    `workspace transport action type ${
      JSON.stringify(action.type)
    } is unsupported`,
  );
}

function parse_game_action(value: unknown): GameAction {
  const action = require_record(value, "workspace game action");
  switch (action.type) {
    case "focus":
    case "activate":
      return {
        type: action.type,
        target: require_integer(action.target, "target"),
      };
    case "custom":
      return {
        type: "custom",
        kind: require_integer(action.kind, "kind"),
        target: require_integer(action.target, "target"),
        value: require_integer(action.value, "value"),
      };
    default:
      throw new Error(
        `workspace game action type ${
          JSON.stringify(action.type)
        } is unsupported`,
      );
  }
}

function require_record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} ${describe(value)} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function require_integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `workspace game action ${field} ${
        describe(value)
      } must be a safe integer`,
    );
  }
  return value as number;
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

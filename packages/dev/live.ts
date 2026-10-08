/** Browser-session commands, shared by HTTP, MCP and the Vite connection. */
export interface LiveSessionInfo {
  id: string;
  title: string;
  url: string;
}

export interface LiveCommand {
  id: string;
  method: string;
  params: Record<string, unknown>;
  deadline: number;
}

export interface LiveResult {
  id: string;
  result?: unknown;
  error?: string;
}

const string = { type: "string" };
const integer = { type: "integer", minimum: 0 };
const object = { type: "object" };
const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties: { session: string, ...properties },
  required,
  additionalProperties: false,
});
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  name: `ink_${name}`,
  description,
  inputSchema: schema(properties, required),
});

export const liveTools = [
  tool(
    "sessions",
    "List connected browser editors. Supply a session id when several are open.",
    {},
  ),
  tool(
    "world",
    "Read the exact live world, selection, game revision, diagnostics and mounted views.",
    {},
  ),
  tool(
    "edit",
    "Apply one undoable edit to an entity component or resource. Values are scene-style partial fields; unknown fields fail. Optionally require the current tick.",
    {
      entity: integer,
      component: string,
      resource: string,
      values: object,
      label: string,
      tick: integer,
    },
    ["values"],
  ),
  tool(
    "play",
    "Control the existing editor's play session or undo/redo an edit.",
    {
      action: {
        enum: ["play", "pause", "stop", "restart", "undo", "redo", "seek"],
      },
      tick: integer,
    },
    ["action"],
  ),
  tool(
    "step",
    "Pause and advance fixed ticks, optionally using recorded inputs. Returns the resulting world.",
    {
      ticks: { ...integer, maximum: 36000 },
      inputs: { type: "array", items: object, maxItems: 36000 },
    },
  ),
  tool(
    "capture",
    "Capture a mounted view exactly as seen in the editor, or render a named game/iso/top/front/side view. Saves PNG and state under .ink/captures.",
    { view: string },
  ),
  tool(
    "comments",
    "Read the comment queue including threads, assignees, replay links and capture evidence.",
    {
      status: { enum: ["open", "in_progress", "blocked", "resolved", "all"] },
      assignee: string,
    },
  ),
  tool(
    "comment",
    "Add, assign, update, reply to or resolve a comment. Attach before/after captures to replies; save a handoff when reporting a replayable issue.",
    {
      action: { enum: ["add", "update", "reply"] },
      id: string,
      text: string,
      author: string,
      assignee: string,
      status: { enum: ["open", "in_progress", "blocked", "resolved"] },
      anchor: object,
      handoff: string,
      captures: { type: "array", items: object },
    },
    ["action"],
  ),
  tool(
    "handoff",
    "Create a handoff from the live session, open its saved state, or reproduce its recorded inputs in this editor.",
    {
      action: { enum: ["create", "open", "replay"] },
      id: string,
      note: string,
    },
    ["action"],
  ),
  tool(
    "source",
    "Read or replace a project source file. Writing requires the SHA-256 hash returned by reading, preventing stale edits. Vite compiles and updates the open editor.",
    {
      path: string,
      text: string,
      expectedHash: string,
    },
    ["path"],
  ),
];

export const liveMethods = new Set(liveTools.map((t) => t.name.slice(4)));

export function liveObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

export function liveString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a nonempty string`);
  }
  return value;
}

export function liveInteger(
  value: unknown,
  name: string,
  max = 16777215,
): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 0 ||
    value > max
  ) {
    throw new Error(`${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

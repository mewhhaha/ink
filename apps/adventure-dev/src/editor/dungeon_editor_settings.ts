export type DungeonTool =
  | "select"
  | "floor"
  | "wall"
  | "door"
  | "stairs"
  | "player_start";

export interface DungeonEditorSettings {
  readonly tool: DungeonTool;
  readonly selected_slot: number | null;
  readonly viewport_offset: { readonly x: number; readonly y: number };
  readonly zoom: number;
}

export const default_dungeon_editor_settings: DungeonEditorSettings = {
  tool: "select",
  selected_slot: null,
  viewport_offset: { x: 0, y: 0 },
  zoom: 1,
};

export function parse_dungeon_editor_settings(
  parameters: URLSearchParams,
): DungeonEditorSettings {
  const tool = parameters.get("tool");
  const selected_slot = parameter_integer(parameters, "brush", 0, 47);
  return {
    tool: is_dungeon_tool(tool) ? tool : default_dungeon_editor_settings.tool,
    selected_slot,
    viewport_offset: {
      x: parameter_integer(parameters, "view_x", -10_000, 10_000) ?? 0,
      y: parameter_integer(parameters, "view_y", -10_000, 10_000) ?? 0,
    },
    zoom: (parameter_integer(parameters, "zoom", 50, 200) ?? 100) / 100,
  };
}

export function write_dungeon_editor_settings(
  parameters: URLSearchParams,
  settings: DungeonEditorSettings,
): URLSearchParams {
  const next = new URLSearchParams(parameters);
  next.set("tool", settings.tool);
  next.set("view_x", String(Math.round(settings.viewport_offset.x)));
  next.set("view_y", String(Math.round(settings.viewport_offset.y)));
  next.set("zoom", String(Math.round(settings.zoom * 100)));
  if (settings.selected_slot === null) next.delete("brush");
  else next.set("brush", String(settings.selected_slot));
  return next;
}

function is_dungeon_tool(value: string | null): value is DungeonTool {
  return value === "select" || value === "floor" || value === "wall" ||
    value === "door" || value === "stairs" || value === "player_start";
}

function parameter_integer(
  parameters: URLSearchParams,
  name: string,
  minimum: number,
  maximum: number,
): number | null {
  const source = parameters.get(name);
  if (source === null || !/^-?\d+$/.test(source)) return null;
  const value = Number(source);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

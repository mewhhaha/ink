import type { LevelLayer } from "./level.ts";

export type PlatformerTool =
  | "pan"
  | "pencil"
  | "eraser"
  | "player_start"
  | "collision_shape"
  | "area_shape";

export interface PlatformerEditorSettings {
  readonly tool: PlatformerTool;
  readonly layer: LevelLayer;
  readonly selected_tile: number;
  readonly selected_geometry: string | null;
  readonly palette_position: { readonly x: number; readonly y: number };
  readonly palette_size: { readonly width: number; readonly height: number };
  readonly level_offset: { readonly x: number; readonly y: number };
}

export const default_platformer_editor_settings: PlatformerEditorSettings = {
  tool: "pencil",
  layer: "terrain",
  selected_tile: 0,
  selected_geometry: null,
  palette_position: { x: 20, y: 82 },
  palette_size: { width: 280, height: 480 },
  level_offset: { x: 0, y: 0 },
};

export function parse_platformer_editor_settings(
  parameters: URLSearchParams,
): PlatformerEditorSettings {
  const defaults = default_platformer_editor_settings;
  const tool = parameters.get("tool");
  const layer = parameters.get("layer");
  const selected_geometry = parameters.get("shape");
  return {
    tool: is_platformer_tool(tool) ? tool : defaults.tool,
    layer: layer === "terrain" || layer === "decoration"
      ? layer
      : defaults.layer,
    selected_tile: parameter_integer(
      parameters,
      "tile",
      0,
      255,
      defaults.selected_tile,
    ),
    selected_geometry: selected_geometry?.trim() || null,
    palette_position: {
      x: parameter_integer(
        parameters,
        "palette_x",
        0,
        10_000,
        defaults.palette_position.x,
      ),
      y: parameter_integer(
        parameters,
        "palette_y",
        0,
        10_000,
        defaults.palette_position.y,
      ),
    },
    palette_size: {
      width: parameter_integer(
        parameters,
        "palette_width",
        220,
        800,
        defaults.palette_size.width,
      ),
      height: parameter_integer(
        parameters,
        "palette_height",
        160,
        900,
        defaults.palette_size.height,
      ),
    },
    level_offset: {
      x: parameter_integer(
        parameters,
        "level_x",
        -10_000,
        10_000,
        defaults.level_offset.x,
      ),
      y: parameter_integer(
        parameters,
        "level_y",
        -10_000,
        10_000,
        defaults.level_offset.y,
      ),
    },
  };
}

export function write_platformer_editor_settings(
  parameters: URLSearchParams,
  settings: PlatformerEditorSettings,
): URLSearchParams {
  const next = new URLSearchParams(parameters);
  next.set("tool", settings.tool);
  next.set("layer", settings.layer);
  next.set("tile", String(settings.selected_tile));
  next.set("palette_x", String(Math.round(settings.palette_position.x)));
  next.set("palette_y", String(Math.round(settings.palette_position.y)));
  next.set("palette_width", String(Math.round(settings.palette_size.width)));
  next.set("palette_height", String(Math.round(settings.palette_size.height)));
  next.set("level_x", String(Math.round(settings.level_offset.x)));
  next.set("level_y", String(Math.round(settings.level_offset.y)));
  if (settings.selected_geometry === null) {
    next.delete("shape");
  } else {
    next.set("shape", settings.selected_geometry);
  }
  return next;
}

function is_platformer_tool(value: string | null): value is PlatformerTool {
  return value === "pan" || value === "pencil" || value === "eraser" ||
    value === "player_start" || value === "collision_shape" ||
    value === "area_shape";
}

function parameter_integer(
  parameters: URLSearchParams,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const source = parameters.get(name);
  if (source === null || !/^-?\d+$/.test(source)) return fallback;
  const value = Number(source);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

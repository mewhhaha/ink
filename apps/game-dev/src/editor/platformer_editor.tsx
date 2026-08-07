import type { GameDevelopmentContext } from "@ink/development/game_development_context.ts";
import { Button, ToggleButton, Toolbar } from "@comp0/react";
import {
  ArrowsPointingInIcon,
  BackspaceIcon,
  CheckIcon,
  CloudArrowUpIcon,
  CubeTransparentIcon,
  ExclamationTriangleIcon,
  HandRaisedIcon,
  MapPinIcon,
  PencilIcon,
  PhotoIcon,
  PlayIcon,
  RectangleGroupIcon,
  Squares2X2Icon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  default_platformer_editor_settings,
  parse_platformer_editor_settings,
  type PlatformerTool,
  write_platformer_editor_settings,
} from "./editor_settings.ts";
import {
  expand_platformer_level,
  level_asset_url,
  level_save_url,
  type LevelExpansion,
  type LevelGeometry,
  type LevelGeometryCategory,
  type LevelLayer,
  type LevelPoint,
  move_player_start,
  paint_level_tile,
  parse_platformer_level,
  type PlatformerLevel,
  serialize_platformer_level,
  tile_atlas_columns,
  tile_edit_event,
} from "./level.ts";
import "./platformer_editor.css";

const editable_margin = 4;
const displayed_tile_size = 32;

const available_tiles = [
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
  40,
  41,
  42,
  43,
  48,
  49,
  50,
  53,
  54,
  55,
  56,
  57,
  64,
  65,
  66,
  67,
  68,
  69,
  70,
  71,
  72,
  73,
  80,
  81,
  82,
  83,
  84,
  85,
  86,
  87,
  88,
  97,
  98,
  99,
  100,
  101,
  102,
  103,
  104,
  112,
  113,
  115,
  117,
  118,
  119,
  120,
  128,
  129,
  130,
  131,
  132,
  133,
  134,
  135,
  136,
  144,
  145,
  146,
  147,
  148,
  149,
  150,
  151,
  160,
  161,
  162,
  163,
  164,
  166,
  176,
  177,
  178,
  179,
  180,
  181,
  192,
  193,
  194,
  195,
  196,
  208,
  209,
  210,
  211,
  212,
  213,
  224,
  225,
  226,
  227,
  228,
  240,
  241,
  242,
  243,
] as const;

interface Point {
  readonly x: number;
  readonly y: number;
}

type SaveState =
  | { readonly type: "clean" }
  | { readonly type: "dirty" }
  | { readonly type: "saving" }
  | { readonly type: "saved" }
  | { readonly type: "error"; readonly message: string };

type GeometryContext =
  | {
    readonly type: "actions";
    readonly geometry_id: string;
    readonly position: Point;
  }
  | {
    readonly type: "rename";
    readonly geometry_id: string;
    readonly position: Point;
    readonly name: string;
  };

export function render_platformer_editor(context: GameDevelopmentContext) {
  return <PlatformerEditor context={context} />;
}

function PlatformerEditor(
  { context }: { readonly context: GameDevelopmentContext },
) {
  const [initial_settings] = useState(() =>
    typeof location === "undefined"
      ? default_platformer_editor_settings
      : parse_platformer_editor_settings(new URLSearchParams(location.search))
  );
  const [level, set_level] = useState<PlatformerLevel>();
  const [load_error, set_load_error] = useState<string>();
  const [layer, set_layer] = useState<LevelLayer>(initial_settings.layer);
  const [tool, set_tool] = useState<PlatformerTool>(initial_settings.tool);
  const [selected_tile, set_selected_tile] = useState(
    initial_settings.selected_tile,
  );
  const [selected_geometry, set_selected_geometry] = useState<string | null>(
    initial_settings.selected_geometry,
  );
  const [geometry_preview, set_geometry_preview] = useState<LevelGeometry>();
  const [geometry_context, set_geometry_context] = useState<GeometryContext>();
  const [save_state, set_save_state] = useState<SaveState>({ type: "clean" });
  const [palette_position, set_palette_position] = useState<Point>(
    initial_settings.palette_position,
  );
  const [palette_size, set_palette_size] = useState(
    initial_settings.palette_size,
  );
  const [level_offset, set_level_offset] = useState<Point>(
    initial_settings.level_offset,
  );
  const palette_element_reference = useRef<HTMLElement>(null);
  const geometry_context_reference = useRef<HTMLDivElement>(null);
  const palette_drag_reference = useRef<
    {
      readonly pointer_id: number;
      readonly start: Point;
      readonly position: Point;
      readonly maximum: Point;
    } | undefined
  >(undefined);
  const level_drag_reference = useRef<
    {
      readonly pointer_id: number;
      readonly start: Point;
      readonly offset: Point;
    } | undefined
  >(undefined);
  const geometry_draw_reference = useRef<
    {
      readonly pointer_id: number;
      readonly category: LevelGeometryCategory;
      readonly start: LevelPoint;
    } | undefined
  >(undefined);
  const geometry_vertex_drag_reference = useRef<
    {
      readonly pointer_id: number;
      readonly geometry_id: string;
      readonly point_index: number;
    } | undefined
  >(undefined);

  useEffect(() => {
    if (typeof history === "undefined" || typeof location === "undefined") {
      return;
    }
    const parameters = write_platformer_editor_settings(
      new URLSearchParams(location.search),
      {
        tool,
        layer,
        selected_tile,
        selected_geometry,
        palette_position,
        palette_size,
        level_offset,
      },
    );
    const search = parameters.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
    );
  }, [
    layer,
    level_offset,
    palette_position,
    palette_size,
    selected_geometry,
    selected_tile,
    tool,
  ]);

  useEffect(() => {
    const keep_palette_visible = () => {
      const palette = palette_element_reference.current;
      if (!palette) return;
      const workspace = palette.closest<HTMLElement>(".platformer-workspace");
      if (!workspace) return;
      const maximum = palette_position_limits(palette, workspace);
      set_palette_position((current) => ({
        x: clamp(current.x, 8, maximum.x),
        y: clamp(current.y, 8, maximum.y),
      }));
    };
    globalThis.addEventListener("resize", keep_palette_visible);
    return () => globalThis.removeEventListener("resize", keep_palette_visible);
  }, []);

  useEffect(() => {
    if (!geometry_context) return;
    const context = geometry_context_reference.current;
    context?.querySelector<HTMLElement>("input, button")?.focus();
    const close_context = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && context?.contains(target)) return;
      set_geometry_context(undefined);
    };
    document.addEventListener("pointerdown", close_context);
    return () => document.removeEventListener("pointerdown", close_context);
  }, [geometry_context?.geometry_id, geometry_context?.type]);

  useEffect(() => {
    const palette = palette_element_reference.current;
    if (!palette || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = Math.round(palette.offsetWidth);
      const height = Math.round(palette.offsetHeight);
      set_palette_size((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height }
      );
      const workspace = palette.closest<HTMLElement>(".platformer-workspace");
      if (!workspace) return;
      const maximum = palette_position_limits(palette, workspace);
      set_palette_position((current) => ({
        x: clamp(current.x, 8, maximum.x),
        y: clamp(current.y, 8, maximum.y),
      }));
    });
    observer.observe(palette);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(level_asset_url, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`level asset returned ${response.status}`);
      }
      const loaded_level = parse_platformer_level(await response.text());
      set_level(loaded_level);
      set_selected_geometry((current) =>
        current !== null &&
          loaded_level.geometry.some(({ id }) => id === current)
          ? current
          : null
      );
    }).catch((error) => {
      if (controller.signal.aborted) return;
      set_load_error(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, []);

  const persist_level = async (): Promise<boolean> => {
    if (!level) return false;
    set_save_state({ type: "saving" });
    try {
      const response = await fetch(level_save_url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: serialize_platformer_level(level),
      });
      if (!response.ok) {
        throw new Error(`level save returned ${response.status}`);
      }
      set_save_state({ type: "saved" });
      return true;
    } catch (error) {
      set_save_state({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const show_game = async () => {
    if (save_state.type === "dirty" || save_state.type === "error") {
      if (!await persist_level()) return;
    }
    await context.dispatch_transport({ type: "play" });
  };

  const expand_level = (
    current: PlatformerLevel,
    expansion: LevelExpansion,
  ) => {
    const expanded = expand_platformer_level(current, expansion);
    if (expanded === current) return current;
    set_level_offset((offset) => ({
      x: offset.x +
        (expansion.right - expansion.left) * displayed_tile_size / 2,
      y: offset.y +
        (expansion.bottom - expansion.top) * displayed_tile_size / 2,
    }));
    return expanded;
  };

  const paint = (column: number, row: number) => {
    if (!level) return;
    const outside = column < 0 || column >= level.columns || row < 0 ||
      row >= level.rows;
    if (outside && tool === "eraser") return;
    let expanded: PlatformerLevel;
    try {
      expanded = expand_level(level, {
        left: Math.max(0, -column),
        right: Math.max(0, column - level.columns + 1),
        top: Math.max(0, -row),
        bottom: Math.max(0, row - level.rows + 1),
      });
    } catch (error) {
      set_save_state({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const destination_column = column + Math.max(0, -column);
    const destination_row = row + Math.max(0, -row);
    const index = destination_row * expanded.columns + destination_column;
    const tile_count = expanded.columns * expanded.rows;
    if (tool === "player_start") {
      const next = move_player_start(expanded, index);
      if (next === level) return;
      set_level(next);
      set_save_state({ type: "dirty" });
      if (expanded === level) {
        void context.dispatch_preview_update({
          type: "custom",
          kind: tile_edit_event,
          target: tile_count * 2,
          value: index,
        });
      }
      return;
    }
    const tile = tool === "eraser" ? -1 : selected_tile;
    const next = paint_level_tile(expanded, layer, index, tile);
    if (next === level) return;
    set_level(next);
    set_save_state({ type: "dirty" });
    if (expanded === level) {
      void context.dispatch_preview_update({
        type: "custom",
        kind: tile_edit_event,
        target: layer === "terrain" ? index : tile_count + index,
        value: tile,
      });
    }
  };

  const begin_palette_drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const panel = event.currentTarget.closest<HTMLElement>(
      ".platformer-floating-palette",
    );
    const workspace = event.currentTarget.closest<HTMLElement>(
      ".platformer-workspace",
    );
    if (!panel || !workspace) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    palette_drag_reference.current = {
      pointer_id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      position: palette_position,
      maximum: palette_position_limits(panel, workspace),
    };
  };

  const move_palette = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = palette_drag_reference.current;
    if (!drag || drag.pointer_id !== event.pointerId) return;
    set_palette_position({
      x: clamp(
        drag.position.x + event.clientX - drag.start.x,
        8,
        drag.maximum.x,
      ),
      y: clamp(
        drag.position.y + event.clientY - drag.start.y,
        8,
        drag.maximum.y,
      ),
    });
  };

  const finish_palette_drag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (palette_drag_reference.current?.pointer_id !== event.pointerId) return;
    palette_drag_reference.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const move_palette_with_keyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    let direction: Point | undefined;
    switch (event.key) {
      case "ArrowLeft":
        direction = { x: -1, y: 0 };
        break;
      case "ArrowRight":
        direction = { x: 1, y: 0 };
        break;
      case "ArrowUp":
        direction = { x: 0, y: -1 };
        break;
      case "ArrowDown":
        direction = { x: 0, y: 1 };
        break;
    }
    if (!direction) return;
    const palette = palette_element_reference.current;
    const workspace = palette?.closest<HTMLElement>(".platformer-workspace");
    if (!palette || !workspace) return;
    event.preventDefault();
    const maximum = palette_position_limits(palette, workspace);
    set_palette_position((current) => ({
      x: clamp(
        current.x + direction.x * 12,
        8,
        maximum.x,
      ),
      y: clamp(
        current.y + direction.y * 12,
        8,
        maximum.y,
      ),
    }));
  };

  const begin_level_drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pans_with_pointer = event.button === 1 ||
      (event.button === 0 && tool === "pan");
    if (!pans_with_pointer) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    level_drag_reference.current = {
      pointer_id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      offset: level_offset,
    };
  };

  const move_level = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = level_drag_reference.current;
    if (!drag || drag.pointer_id !== event.pointerId) return;
    set_level_offset({
      x: drag.offset.x + event.clientX - drag.start.x,
      y: drag.offset.y + event.clientY - drag.start.y,
    });
  };

  const finish_level_drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (level_drag_reference.current?.pointer_id !== event.pointerId) return;
    level_drag_reference.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const begin_geometry = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!level || event.button !== 0 || event.target !== event.currentTarget) {
      return;
    }
    const category = tool === "collision_shape"
      ? "collision"
      : tool === "area_shape"
      ? "area"
      : undefined;
    if (!category) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = geometry_point_at(
      event.clientX,
      event.clientY,
      event.currentTarget,
      level,
    );
    geometry_draw_reference.current = {
      pointer_id: event.pointerId,
      category,
      start,
    };
    set_geometry_preview(rectangle_geometry("preview", category, start, start));
  };

  const move_geometry = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drawing = geometry_draw_reference.current;
    if (!level || !drawing || drawing.pointer_id !== event.pointerId) return;
    const end = geometry_point_at(
      event.clientX,
      event.clientY,
      event.currentTarget,
      level,
    );
    set_geometry_preview(
      rectangle_geometry("preview", drawing.category, drawing.start, end),
    );
  };

  const finish_geometry = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drawing = geometry_draw_reference.current;
    if (!level || !drawing || drawing.pointer_id !== event.pointerId) return;
    geometry_draw_reference.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const end = geometry_point_at(
      event.clientX,
      event.clientY,
      event.currentTarget,
      level,
    );
    set_geometry_preview(undefined);
    if (drawing.start.x === end.x || drawing.start.y === end.y) return;
    const expansion = level_expansion_for_points(level, [drawing.start, end]);
    let expanded: PlatformerLevel;
    try {
      expanded = expand_level(level, expansion);
    } catch (error) {
      set_save_state({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const id = next_geometry_id(expanded.geometry, drawing.category);
    const geometry = rectangle_geometry(
      id,
      drawing.category,
      {
        x: drawing.start.x + expansion.left,
        y: drawing.start.y + expansion.top,
      },
      { x: end.x + expansion.left, y: end.y + expansion.top },
    );
    set_level({ ...expanded, geometry: [...expanded.geometry, geometry] });
    set_selected_geometry(id);
    set_save_state({ type: "dirty" });
  };

  const move_geometry_vertex = (
    event: ReactPointerEvent<SVGCircleElement>,
  ) => {
    const drag = geometry_vertex_drag_reference.current;
    const svg = event.currentTarget.ownerSVGElement;
    if (!level || !svg || !drag || drag.pointer_id !== event.pointerId) return;
    const point = geometry_point_at(
      event.clientX,
      event.clientY,
      svg,
      level,
    );
    set_level((current) => {
      if (!current) return current;
      return {
        ...current,
        geometry: current.geometry.map((geometry) =>
          geometry.id === drag.geometry_id
            ? move_geometry_point(geometry, drag.point_index, point)
            : geometry
        ),
      };
    });
    set_save_state({ type: "dirty" });
  };

  const finish_geometry_vertex = (
    event: ReactPointerEvent<SVGCircleElement>,
  ) => {
    if (
      geometry_vertex_drag_reference.current?.pointer_id !== event.pointerId
    ) {
      return;
    }
    geometry_vertex_drag_reference.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!level) return;
    const expansion = level_expansion_for_points(
      level,
      level.geometry.flatMap(({ points }) => points),
    );
    try {
      set_level(expand_level(level, expansion));
    } catch (error) {
      set_save_state({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const insert_geometry_vertex = (
    geometry_id: string,
    point_index: number,
    point: LevelPoint,
  ) => {
    set_level((current) => {
      if (!current) return current;
      return {
        ...current,
        geometry: current.geometry.map((geometry) =>
          geometry.id === geometry_id && geometry.points.length < 64
            ? {
              ...geometry,
              points: [
                ...geometry.points.slice(0, point_index + 1),
                point,
                ...geometry.points.slice(point_index + 1),
              ],
            }
            : geometry
        ),
      };
    });
    set_selected_geometry(geometry_id);
    set_save_state({ type: "dirty" });
  };

  const delete_geometry = (geometry_id: string) => {
    if (!level) return;
    const geometry = level.geometry.filter(({ id }) => id !== geometry_id);
    if (geometry.length === level.geometry.length) return;
    set_level({ ...level, geometry });
    set_selected_geometry((current) =>
      current === geometry_id ? null : current
    );
    set_geometry_context(undefined);
    set_save_state({ type: "dirty" });
  };

  const delete_selected_geometry = () => {
    if (selected_geometry !== null) delete_geometry(selected_geometry);
  };

  const open_geometry_context = (
    geometry_id: string,
    event: ReactMouseEvent<SVGElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    set_selected_geometry(geometry_id);
    set_geometry_context({
      type: "actions",
      geometry_id,
      position: {
        x: clamp(event.clientX, 8, innerWidth - 208),
        y: clamp(event.clientY, 8, innerHeight - 128),
      },
    });
  };

  const rename_area = (geometry_id: string, name: string) => {
    const normalized_name = name.trim();
    if (!level || normalized_name === "" || normalized_name.length > 80) {
      return;
    }
    const geometry = level.geometry.map((candidate) =>
      candidate.id === geometry_id && candidate.category === "area"
        ? { ...candidate, name: normalized_name }
        : candidate
    );
    set_level({ ...level, geometry });
    set_geometry_context(undefined);
    set_save_state({ type: "dirty" });
  };

  const contextual_geometry = geometry_context === undefined
    ? undefined
    : level?.geometry.find(({ id }) => id === geometry_context.geometry_id);

  return (
    <section
      className="platformer-workspace"
      aria-label={`${level?.name ?? "Platformer"} level editor`}
    >
      <div
        className="platformer-canvas"
        data-panning={tool === "pan" ? "true" : undefined}
        onPointerDown={begin_level_drag}
        onPointerMove={move_level}
        onPointerUp={finish_level_drag}
        onPointerCancel={finish_level_drag}
      >
        {level
          ? (
            <div
              className="platformer-grid"
              aria-label={`${level.name} grid`}
              style={{
                gridTemplateColumns: `repeat(${
                  level.columns + editable_margin * 2
                }, ${displayed_tile_size}px)`,
                transform:
                  `translate3d(${level_offset.x}px, ${level_offset.y}px, 0)`,
              }}
            >
              {Array.from({
                length: (level.columns + editable_margin * 2) *
                  (level.rows + editable_margin * 2),
              }, (_, displayed_index) => {
                const displayed_columns = level.columns + editable_margin * 2;
                const column = displayed_index % displayed_columns -
                  editable_margin;
                const row = Math.floor(displayed_index / displayed_columns) -
                  editable_margin;
                const outside = column < 0 || column >= level.columns ||
                  row < 0 || row >= level.rows;
                const level_index = outside ? -1 : row * level.columns + column;
                return (
                  <GridCell
                    key={`${column}:${row}`}
                    column={column}
                    row={row}
                    terrain={outside ? -1 : level.terrain[level_index]}
                    decoration={outside ? -1 : level.decoration[level_index]}
                    player_start={!outside &&
                      level.player_start === level_index}
                    outside={outside}
                    selected_layer={layer}
                    painting_enabled={tool === "pencil" ||
                      tool === "eraser" || tool === "player_start"}
                    onPaint={paint}
                  />
                );
              })}
              <svg
                className="platformer-geometry-layer"
                data-authoring={tool === "collision_shape" ||
                    tool === "area_shape"
                  ? "true"
                  : undefined}
                viewBox={`0 0 ${level.columns + editable_margin * 2} ${
                  level.rows + editable_margin * 2
                }`}
                aria-label="Level collision and area geometry"
                onPointerDown={begin_geometry}
                onPointerMove={move_geometry}
                onPointerUp={finish_geometry}
                onPointerCancel={(event) => {
                  if (
                    geometry_draw_reference.current?.pointer_id !==
                      event.pointerId
                  ) return;
                  geometry_draw_reference.current = undefined;
                  set_geometry_preview(undefined);
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
              >
                <rect
                  className="platformer-level-boundary"
                  x={editable_margin}
                  y={editable_margin}
                  width={level.columns}
                  height={level.rows}
                />
                {[
                  ...level.geometry,
                  ...(geometry_preview ? [geometry_preview] : []),
                ].map((geometry) => {
                  const left = Math.min(...geometry.points.map(({ x }) => x));
                  const right = Math.max(...geometry.points.map(({ x }) => x));
                  const top = Math.min(...geometry.points.map(({ y }) => y));
                  const polygon_points = geometry.points.map(({ x, y }) =>
                    `${x + editable_margin},${y + editable_margin}`
                  ).join(" ");
                  return (
                    <g
                      key={geometry.id}
                      data-category={geometry.category}
                      data-selected={geometry.id === selected_geometry
                        ? "true"
                        : undefined}
                      data-preview={geometry.id === "preview"
                        ? "true"
                        : undefined}
                    >
                      {geometry.category === "area" &&
                        geometry.id !== "preview" && (
                        <polygon
                          className="platformer-geometry-hit-target"
                          points={polygon_points}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            event.preventDefault();
                            event.stopPropagation();
                            set_selected_geometry(geometry.id);
                          }}
                          onContextMenu={(event) =>
                            open_geometry_context(geometry.id, event)}
                        />
                      )}
                      <polygon
                        className="platformer-geometry-shape"
                        points={polygon_points}
                        onPointerDown={(event) => {
                          if (geometry.id === "preview" || event.button !== 0) {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          set_selected_geometry(geometry.id);
                        }}
                        onContextMenu={(event) => {
                          if (geometry.id !== "preview") {
                            open_geometry_context(geometry.id, event);
                          }
                        }}
                      />
                      {geometry.category === "area" &&
                        geometry.id !== "preview" && (
                        <text
                          className="platformer-geometry-name"
                          x={(left + right) / 2 + editable_margin}
                          y={top + editable_margin + 0.5}
                          textAnchor="middle"
                          aria-label={`${geometry.name} area`}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            event.preventDefault();
                            event.stopPropagation();
                            set_selected_geometry(geometry.id);
                          }}
                          onContextMenu={(event) =>
                            open_geometry_context(geometry.id, event)}
                        >
                          {geometry.name}
                        </text>
                      )}
                      {geometry.id === selected_geometry &&
                        geometry.points.map((point, point_index) => {
                          const next = geometry.points[
                            (point_index + 1) % geometry.points.length
                          ];
                          const midpoint = {
                            x: (point.x + next.x) / 2,
                            y: (point.y + next.y) / 2,
                          };
                          return (
                            <g key={point_index}>
                              <circle
                                className="platformer-geometry-edge-handle"
                                cx={midpoint.x + editable_margin}
                                cy={midpoint.y + editable_margin}
                                r={0.12}
                                onContextMenu={(event) =>
                                  open_geometry_context(geometry.id, event)}
                                onPointerDown={(event) => {
                                  if (event.button !== 0) return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  insert_geometry_vertex(
                                    geometry.id,
                                    point_index,
                                    midpoint,
                                  );
                                }}
                              />
                              <circle
                                className="platformer-geometry-vertex"
                                cx={point.x + editable_margin}
                                cy={point.y + editable_margin}
                                r={0.17}
                                onContextMenu={(event) =>
                                  open_geometry_context(geometry.id, event)}
                                onPointerDown={(event) => {
                                  if (event.button !== 0) return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  event.currentTarget.setPointerCapture(
                                    event.pointerId,
                                  );
                                  geometry_vertex_drag_reference.current = {
                                    pointer_id: event.pointerId,
                                    geometry_id: geometry.id,
                                    point_index,
                                  };
                                }}
                                onPointerMove={move_geometry_vertex}
                                onPointerUp={finish_geometry_vertex}
                                onPointerCancel={finish_geometry_vertex}
                              />
                            </g>
                          );
                        })}
                    </g>
                  );
                })}
              </svg>
            </div>
          )
          : (
            <p className="platformer-load-state">
              {load_error ?? "Loading level…"}
            </p>
          )}
      </div>

      <Toolbar
        className="platformer-tool-dock"
        aria-label="Level tools"
      >
        <ToggleButton
          className="platformer-icon-button"
          selected={tool === "pan"}
          aria-label="Pan level"
          title="Pan level"
          onClick={() => set_tool("pan")}
        >
          <HandRaisedIcon />
        </ToggleButton>
        <ToggleButton
          className="platformer-icon-button"
          selected={tool === "pencil"}
          aria-label="Paint tiles"
          title="Paint tiles"
          onClick={() => set_tool("pencil")}
        >
          <PencilIcon />
        </ToggleButton>
        <ToggleButton
          className="platformer-icon-button"
          selected={tool === "eraser"}
          aria-label="Erase tiles"
          title="Erase tiles"
          onClick={() => set_tool("eraser")}
        >
          <BackspaceIcon />
        </ToggleButton>
        <ToggleButton
          className="platformer-icon-button"
          selected={tool === "player_start"}
          aria-label="Move player start"
          title="Move player start"
          onClick={() => set_tool("player_start")}
        >
          <MapPinIcon />
        </ToggleButton>

        <span className="platformer-tool-divider" aria-hidden="true" />

        <ToggleButton
          className="platformer-icon-button"
          selected={tool === "collision_shape"}
          aria-label="Draw collision box"
          title="Draw collision box"
          data-geometry-category="collision"
          onClick={() => set_tool("collision_shape")}
        >
          <CubeTransparentIcon />
        </ToggleButton>
        <ToggleButton
          className="platformer-icon-button"
          selected={tool === "area_shape"}
          aria-label="Draw area box"
          title="Draw area box"
          data-geometry-category="area"
          onClick={() => set_tool("area_shape")}
        >
          <RectangleGroupIcon />
        </ToggleButton>
        <Button
          className="platformer-icon-button"
          aria-label="Delete selected geometry"
          title="Delete selected geometry"
          disabled={selected_geometry === null}
          onClick={delete_selected_geometry}
        >
          <TrashIcon />
        </Button>

        <span className="platformer-tool-divider" aria-hidden="true" />

        <ToggleButton
          className="platformer-icon-button"
          selected={layer === "terrain"}
          aria-label="Terrain layer"
          title="Terrain layer"
          onClick={() => {
            set_layer("terrain");
            set_tool("pencil");
          }}
        >
          <Squares2X2Icon />
        </ToggleButton>
        <ToggleButton
          className="platformer-icon-button"
          selected={layer === "decoration"}
          aria-label="Decoration layer"
          title="Decoration layer"
          onClick={() => {
            set_layer("decoration");
            set_tool("pencil");
          }}
        >
          <PhotoIcon />
        </ToggleButton>

        <span className="platformer-tool-divider" aria-hidden="true" />

        <Button
          className="platformer-icon-button"
          aria-label="Center level"
          title="Center level"
          onClick={() => set_level_offset({ x: 0, y: 0 })}
        >
          <ArrowsPointingInIcon />
        </Button>
        <Button
          className="platformer-icon-button"
          aria-label={save_label(save_state)}
          title={save_label(save_state)}
          disabled={!level || save_state.type === "saving"}
          data-save-state={save_state.type}
          onClick={() => void persist_level()}
        >
          {save_state.type === "saved"
            ? <CheckIcon />
            : save_state.type === "error"
            ? <ExclamationTriangleIcon />
            : <CloudArrowUpIcon />}
        </Button>
        <Button
          as="a"
          className="platformer-icon-button platformer-play-button"
          href="/game"
          target="ink-game-preview"
          aria-label="Play game"
          title="Play game"
          onClick={() => void show_game()}
        >
          <PlayIcon />
        </Button>
      </Toolbar>

      {geometry_context && contextual_geometry && (
        <div
          ref={geometry_context_reference}
          className="platformer-geometry-context"
          style={{
            left: geometry_context.position.x,
            top: geometry_context.position.y,
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              set_geometry_context(undefined);
              return;
            }
            if (
              geometry_context.type !== "actions" ||
              (event.key !== "ArrowDown" && event.key !== "ArrowUp")
            ) return;
            const actions = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="menuitem"]',
              ),
            ];
            const focused = actions.indexOf(
              document.activeElement as HTMLElement,
            );
            const direction = event.key === "ArrowDown" ? 1 : -1;
            const next = (focused + direction + actions.length) %
              actions.length;
            event.preventDefault();
            actions[next]?.focus();
          }}
        >
          {geometry_context.type === "actions"
            ? (
              <div
                role="menu"
                aria-label={`${
                  contextual_geometry.category === "area"
                    ? contextual_geometry.name
                    : contextual_geometry.id
                } actions`}
              >
                <p className="platformer-geometry-context-title">
                  {contextual_geometry.category === "area"
                    ? contextual_geometry.name
                    : contextual_geometry.id}
                </p>
                {contextual_geometry.category === "area" && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                      set_geometry_context({
                        ...geometry_context,
                        type: "rename",
                        name: contextual_geometry.name,
                      })}
                  >
                    Rename
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  data-destructive="true"
                  onClick={() => delete_geometry(contextual_geometry.id)}
                >
                  Delete
                </button>
              </div>
            )
            : (
              <form
                aria-label="Rename area"
                onSubmit={(event) => {
                  event.preventDefault();
                  rename_area(
                    geometry_context.geometry_id,
                    geometry_context.name,
                  );
                }}
              >
                <label htmlFor="platformer-area-name">Area name</label>
                <input
                  id="platformer-area-name"
                  value={geometry_context.name}
                  maxLength={80}
                  onChange={(event) =>
                    set_geometry_context({
                      ...geometry_context,
                      name: event.currentTarget.value,
                    })}
                />
                <div className="platformer-geometry-context-actions">
                  <button
                    type="button"
                    onClick={() =>
                      set_geometry_context({
                        type: "actions",
                        geometry_id: geometry_context.geometry_id,
                        position: geometry_context.position,
                      })}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={geometry_context.name.trim() === ""}
                  >
                    Save
                  </button>
                </div>
              </form>
            )}
        </div>
      )}

      <aside
        ref={palette_element_reference}
        className="platformer-floating-palette"
        aria-label="Tile palette"
        style={{
          left: palette_position.x,
          top: palette_position.y,
          width: palette_size.width,
          height: palette_size.height,
        }}
      >
        <Button
          className="platformer-palette-handle"
          aria-label="Drag tile palette"
          title="Drag tile palette"
          onKeyDown={move_palette_with_keyboard}
          onPointerDown={begin_palette_drag}
          onPointerMove={move_palette}
          onPointerUp={finish_palette_drag}
          onPointerCancel={finish_palette_drag}
        >
          <strong>Palette</strong>
        </Button>
        <div className="platformer-palette" aria-label="Brackeys tiles">
          {available_tiles.map((tile) => (
            <ToggleButton
              key={tile}
              className="platformer-palette-tile"
              aria-label={`Tile ${tile}`}
              title={`Tile ${tile}`}
              selected={tool === "pencil" && selected_tile === tile}
              onClick={() => {
                set_selected_tile(tile);
                set_tool("pencil");
              }}
            >
              <span style={tile_style(tile, 32)} />
            </ToggleButton>
          ))}
        </div>
      </aside>
    </section>
  );
}

function GridCell({
  column,
  row,
  terrain,
  decoration,
  player_start,
  outside,
  selected_layer,
  painting_enabled,
  onPaint,
}: {
  readonly column: number;
  readonly row: number;
  readonly terrain: number;
  readonly decoration: number;
  readonly player_start: boolean;
  readonly outside: boolean;
  readonly selected_layer: LevelLayer;
  readonly painting_enabled: boolean;
  readonly onPaint: (column: number, row: number) => void;
}) {
  const paint_dragged_cell = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (painting_enabled && (event.buttons & 1) !== 0) onPaint(column, row);
  };
  return (
    <button
      type="button"
      className="platformer-grid-cell"
      data-outside={outside ? "true" : undefined}
      aria-label={`Column ${column + 1}, row ${row + 1}${
        outside ? ", outside level" : player_start ? ", player start" : ""
      }`}
      onPointerDown={(event) => {
        if (!painting_enabled || event.button !== 0) return;
        event.preventDefault();
        onPaint(column, row);
      }}
      onPointerEnter={paint_dragged_cell}
    >
      {terrain >= 0 && (
        <span
          data-muted={selected_layer !== "terrain"}
          style={tile_style(terrain, 32)}
        />
      )}
      {decoration >= 0 && (
        <span
          data-muted={selected_layer !== "decoration"}
          style={tile_style(decoration, 32)}
        />
      )}
      {player_start && (
        <span className="platformer-player-start" aria-hidden="true" />
      )}
    </button>
  );
}

function tile_style(tile: number, displayed_size: number): CSSProperties {
  return {
    backgroundImage: "url('/assets/brackeys/world_tileset.png')",
    backgroundPosition: `${-(tile % tile_atlas_columns) * displayed_size}px ${
      -Math.floor(tile / tile_atlas_columns) * displayed_size
    }px`,
    backgroundSize: `${tile_atlas_columns * displayed_size}px ${
      tile_atlas_columns * displayed_size
    }px`,
  };
}

function save_label(state: SaveState): string {
  switch (state.type) {
    case "clean":
      return "Loaded";
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved to assets/levels/starter.json";
    case "error":
      return `Save failed: ${state.message}`;
  }
}

function geometry_point_at(
  client_x: number,
  client_y: number,
  svg: SVGSVGElement,
  level: PlatformerLevel,
): LevelPoint {
  const bounds = svg.getBoundingClientRect();
  const displayed_columns = level.columns + editable_margin * 2;
  const displayed_rows = level.rows + editable_margin * 2;
  const x = (client_x - bounds.left) / bounds.width * displayed_columns -
    editable_margin;
  const y = (client_y - bounds.top) / bounds.height * displayed_rows -
    editable_margin;
  return {
    x: snap_geometry_coordinate(
      x,
      -editable_margin,
      level.columns + editable_margin,
    ),
    y: snap_geometry_coordinate(
      y,
      -editable_margin,
      level.rows + editable_margin,
    ),
  };
}

function snap_geometry_coordinate(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return clamp(Math.round(value * 4) / 4, minimum, maximum);
}

function level_expansion_for_points(
  level: PlatformerLevel,
  points: readonly LevelPoint[],
): LevelExpansion {
  if (points.length === 0) {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }
  const x_coordinates = points.map(({ x }) => x);
  const y_coordinates = points.map(({ y }) => y);
  return {
    left: Math.max(0, Math.ceil(-Math.min(...x_coordinates))),
    right: Math.max(0, Math.ceil(Math.max(...x_coordinates) - level.columns)),
    top: Math.max(0, Math.ceil(-Math.min(...y_coordinates))),
    bottom: Math.max(0, Math.ceil(Math.max(...y_coordinates) - level.rows)),
  };
}

function rectangle_geometry(
  id: string,
  category: LevelGeometryCategory,
  start: LevelPoint,
  end: LevelPoint,
): LevelGeometry {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const points = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  if (category === "area") {
    const sequence = id.match(/\d+$/)?.[0];
    return {
      id,
      category,
      name: sequence === undefined ? "Area" : `Area ${sequence}`,
      points,
    };
  }
  return {
    id,
    category,
    points,
  };
}

function next_geometry_id(
  geometry: readonly LevelGeometry[],
  category: LevelGeometryCategory,
): string {
  const identities = new Set(geometry.map(({ id }) => id));
  let sequence = 1;
  while (identities.has(`${category}-${sequence}`)) sequence += 1;
  return `${category}-${sequence}`;
}

function move_geometry_point(
  geometry: LevelGeometry,
  point_index: number,
  point: LevelPoint,
): LevelGeometry {
  const points = geometry.points.map((candidate, index) =>
    index === point_index ? point : candidate
  );
  let twice_area = 0;
  for (const [index, candidate] of points.entries()) {
    const next = points[(index + 1) % points.length];
    twice_area += candidate.x * next.y - next.x * candidate.y;
  }
  return twice_area === 0 ? geometry : { ...geometry, points };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function palette_position_limits(
  palette: HTMLElement,
  workspace: HTMLElement,
): Point {
  const workspace_bounds = workspace.getBoundingClientRect();
  const palette_bounds = palette.getBoundingClientRect();
  return {
    x: Math.max(8, workspace_bounds.width - palette_bounds.width - 8),
    y: Math.max(8, workspace_bounds.height - palette_bounds.height - 8),
  };
}

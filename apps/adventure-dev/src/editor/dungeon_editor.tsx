import type { GameDevelopmentContext } from "../browser/game_development_context.ts";
import {
  EditorButton,
  IconButton,
  NumberField,
  SelectField,
  TextField,
  ToggleButton,
} from "@ink/editor-ui/controls.tsx";
import {
  InspectorSection,
  StatusBar,
  Toolbar,
} from "@ink/editor-ui/layout.tsx";
import {
  ArrowPathIcon,
  ArrowsPointingInIcon,
  BugAntIcon,
  BuildingLibraryIcon,
  CheckIcon,
  CloudArrowUpIcon,
  CubeIcon,
  CursorArrowRaysIcon,
  ExclamationTriangleIcon,
  FlagIcon,
  MinusIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  RectangleStackIcon,
  Squares2X2Icon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  default_dungeon_editor_settings,
  type DungeonTool,
  parse_dungeon_editor_settings,
  write_dungeon_editor_settings,
} from "./dungeon_editor_settings.ts";
import {
  adventure_project_save_url,
  adventure_project_url,
  brush_preview_updates,
  player_start_preview_updates,
  remove_brush_preview_update,
} from "./level.ts";
import {
  type AdventureDocument,
  parse_adventure_document,
  serialize_adventure_document,
} from "@ink/adventure-editor/document.ts";
import {
  type AdventureBrush,
  type AdventureLayout,
  apply_adventure_layout_command,
} from "@ink/adventure-editor/layout.ts";
import { AdventureWorkspace } from "@ink/adventure-editor/workspace.tsx";
import "@ink/editor-ui/styles.css";
import "./dungeon_editor.css";

const grid = { minimum_x: -9, minimum_z: -7, columns: 18, rows: 14 };
const base_cell_size = 38;

type SaveState =
  | { readonly type: "clean" | "dirty" | "saving" | "saved" }
  | { readonly type: "error"; readonly message: string };

interface GridPoint {
  readonly x: number;
  readonly z: number;
}

interface BrushDraft {
  readonly tool: "floor" | "wall";
  readonly start: GridPoint;
  readonly end: GridPoint;
}

const tool_presets: readonly {
  readonly tool: DungeonTool;
  readonly label: string;
  readonly description: string;
  readonly icon: typeof CubeIcon;
}[] = [
  {
    tool: "select",
    label: "Select",
    description: "Inspect and nudge existing brushes",
    icon: CursorArrowRaysIcon,
  },
  {
    tool: "floor",
    label: "Floor",
    description: "Drag a flagstone room footprint",
    icon: Squares2X2Icon,
  },
  {
    tool: "wall",
    label: "Wall",
    description: "Drag a one-cell-thick wall run",
    icon: RectangleStackIcon,
  },
  {
    tool: "door",
    label: "Oak gate",
    description: "Place a two-metre Kenney gate",
    icon: BuildingLibraryIcon,
  },
  {
    tool: "stairs",
    label: "Stairs",
    description: "Place modular dungeon stairs",
    icon: CubeIcon,
  },
  {
    tool: "player_start",
    label: "Entry point",
    description: "Move the dungeon entrance",
    icon: FlagIcon,
  },
] as const;

export function render_dungeon_editor(context: GameDevelopmentContext) {
  return <DungeonEditor context={context} />;
}

export { render_dungeon_debug_view } from "./dungeon_debug_view.tsx";

function DungeonEditor(
  { context }: { readonly context: GameDevelopmentContext },
) {
  const [initial_settings] = useState(() =>
    typeof location === "undefined"
      ? default_dungeon_editor_settings
      : parse_dungeon_editor_settings(new URLSearchParams(location.search))
  );
  const [document, set_document] = useState<AdventureDocument>();
  const level = document?.layout;
  const [load_error, set_load_error] = useState<string>();
  const [tool, set_tool] = useState<DungeonTool>(initial_settings.tool);
  const [selected_slot, set_selected_slot] = useState<number | null>(
    initial_settings.selected_slot,
  );
  const [viewport_offset, set_viewport_offset] = useState(
    initial_settings.viewport_offset,
  );
  const [zoom, set_zoom] = useState(initial_settings.zoom);
  const [draft, set_draft] = useState<BrushDraft>();
  const [save_state, set_save_state] = useState<SaveState>({ type: "clean" });
  const draft_reference = useRef<
    { readonly pointer_id: number; readonly draft: BrushDraft } | undefined
  >(undefined);
  const pan_reference = useRef<
    {
      readonly pointer_id: number;
      readonly start: { readonly x: number; readonly y: number };
      readonly offset: { readonly x: number; readonly y: number };
    } | undefined
  >(undefined);

  useEffect(() => {
    if (typeof history === "undefined" || typeof location === "undefined") {
      return;
    }
    const parameters = write_dungeon_editor_settings(
      new URLSearchParams(location.search),
      { tool, selected_slot, viewport_offset, zoom },
    );
    const search = parameters.toString();
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
    );
  }, [selected_slot, tool, viewport_offset, zoom]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(adventure_project_url, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`level asset returned ${response.status}`);
      }
      const loaded = parse_adventure_document(await response.text());
      set_document(loaded);
      set_selected_slot((current) =>
        current !== null &&
          loaded.layout.brushes.some(({ slot }) => slot === current)
          ? current
          : null
      );
    }).catch((error) => {
      if (controller.signal.aborted) return;
      set_load_error(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const choose_tool = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      ) return;
      const index = Number(event.key) - 1;
      const preset = tool_presets[index];
      if (!preset) return;
      event.preventDefault();
      set_tool(preset.tool);
    };
    globalThis.addEventListener("keydown", choose_tool);
    return () => globalThis.removeEventListener("keydown", choose_tool);
  }, []);

  const replace_layout = (layout: AdventureLayout) => {
    set_document((current) =>
      current === undefined ? current : { ...current, layout }
    );
  };

  const dispatch_brush_preview = async (brush: AdventureBrush) => {
    for (const update of brush_preview_updates(brush)) {
      await context.dispatch_preview_update(update);
    }
  };

  const persist_project = async (): Promise<boolean> => {
    if (!document) return false;
    set_save_state({ type: "saving" });
    try {
      const response = await fetch(adventure_project_save_url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: serialize_adventure_document(document),
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

  const open_runtime_view = async (path: "/debug" | "/game") => {
    const target = path === "/debug" ? "ink-debug-preview" : "ink-game-preview";
    const runtime_window = globalThis.open("", target);
    if (
      (save_state.type === "dirty" || save_state.type === "error") &&
      !await persist_project()
    ) {
      return;
    }
    if (!runtime_window) {
      location.href = path;
      return;
    }
    runtime_window.location.href = path;
    runtime_window.focus();
  };

  const place_brush = (point: GridPoint, placement_tool: DungeonTool) => {
    if (
      !level || placement_tool === "select" || placement_tool === "player_start"
    ) {
      return;
    }
    const prefix = placement_tool === "door" ? "oak-gate" : placement_tool;
    const dimensions = placement_tool === "stairs"
      ? { width: 3, height: 2, depth: 4 }
      : { width: 2, height: 3, depth: 1 };
    const kind = placement_tool === "stairs" ? "stairs" : "door";
    const material = placement_tool === "door"
      ? "dungeon.gate.oak"
      : "dungeon.wall.limestone";
    const id = next_brush_id(level, prefix);
    const next = apply_adventure_layout_command(level, {
      type: "add_brush",
      brush: {
        id,
        kind,
        center_x2: point.x * 2 + 1,
        elevation: 0,
        center_z2: point.z * 2 + 1,
        ...dimensions,
        yaw_quarters: 0,
        material,
      },
    });
    const added = next.brushes.find((brush) => brush.id === id)!;
    replace_layout(next);
    set_selected_slot(added.slot);
    set_tool("select");
    set_save_state({ type: "dirty" });
    void dispatch_brush_preview(added);
  };

  const begin_plan_action = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pan_reference.current = {
        pointer_id: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        offset: viewport_offset,
      };
      return;
    }
    if (!level || event.button !== 0 || event.target !== event.currentTarget) {
      return;
    }
    const point = grid_point_at(event, zoom);
    if (!point) return;
    if (tool === "select") {
      set_selected_slot(null);
      return;
    }
    if (tool === "player_start") {
      const player_start = { x2: point.x * 2 + 1, z2: point.z * 2 + 1 };
      replace_layout(apply_adventure_layout_command(level, {
        type: "move_player_start",
        position: player_start,
      }));
      set_save_state({ type: "dirty" });
      for (
        const update of player_start_preview_updates(player_start)
      ) void context.dispatch_preview_update(update);
      return;
    }
    if (tool === "door" || tool === "stairs") {
      place_brush(point, tool);
      return;
    }
    const next_draft = { tool, start: point, end: point } as BrushDraft;
    event.currentTarget.setPointerCapture(event.pointerId);
    draft_reference.current = {
      pointer_id: event.pointerId,
      draft: next_draft,
    };
    set_draft(next_draft);
  };

  const move_plan_action = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panning = pan_reference.current;
    if (panning?.pointer_id === event.pointerId) {
      set_viewport_offset({
        x: panning.offset.x + event.clientX - panning.start.x,
        y: panning.offset.y + event.clientY - panning.start.y,
      });
      return;
    }
    const drawing = draft_reference.current;
    if (!drawing || drawing.pointer_id !== event.pointerId) return;
    const point = grid_point_at(event, zoom);
    if (!point) return;
    const next = { ...drawing.draft, end: point };
    draft_reference.current = { ...drawing, draft: next };
    set_draft(next);
  };

  const finish_plan_action = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pan_reference.current?.pointer_id === event.pointerId) {
      pan_reference.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    const drawing = draft_reference.current;
    if (!level || !drawing || drawing.pointer_id !== event.pointerId) return;
    draft_reference.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    set_draft(undefined);
    const brush = brush_from_draft(level, drawing.draft);
    try {
      const next = apply_adventure_layout_command(level, {
        type: "add_brush",
        brush,
      });
      const added = next.brushes.find(({ id }) => id === brush.id)!;
      replace_layout(next);
      set_selected_slot(added.slot);
      set_tool("select");
      set_save_state({ type: "dirty" });
      void dispatch_brush_preview(added);
    } catch (error) {
      set_save_state({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const update_selected = (changes: Partial<AdventureBrush>) => {
    if (!level || selected_slot === null) return;
    const current = level.brushes.find(({ slot }) => slot === selected_slot);
    if (!current) return;
    const brush = { ...current, ...changes };
    try {
      replace_layout(apply_adventure_layout_command(level, {
        type: "replace_brush",
        brush,
      }));
      set_save_state({ type: "dirty" });
      void dispatch_brush_preview(brush);
    } catch (error) {
      set_save_state({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const delete_selected = () => {
    if (!level || selected_slot === null) return;
    replace_layout(apply_adventure_layout_command(level, {
      type: "remove_brush",
      slot: selected_slot,
    }));
    void context.dispatch_preview_update(
      remove_brush_preview_update(selected_slot),
    );
    set_selected_slot(null);
    set_save_state({ type: "dirty" });
  };

  const selected = selected_slot === null
    ? undefined
    : level?.brushes.find(({ slot }) => slot === selected_slot);
  const preview_brush = level && draft
    ? brush_from_draft(level, draft)
    : undefined;
  const cell_size = base_cell_size * zoom;
  const plan_style = {
    "--dungeon-cell": `${cell_size}px`,
    width: grid.columns * cell_size,
    height: grid.rows * cell_size,
    transform: `translate(${viewport_offset.x}px, ${viewport_offset.y}px)`,
  } as CSSProperties;
  const active_tool = tool_presets.find((preset) => preset.tool === tool)!;

  return (
    <section
      className="dungeon-workspace ink-editor-surface"
      data-theme="dark"
      data-density="compact"
      aria-label="Dungeon Workshop editor"
    >
      <header className="dungeon-command-bar">
        <div className="dungeon-brand">
          <CubeIcon />
          <span>
            <small>INK / WORLDS</small>
            <strong>{level?.name ?? "Dungeon Workshop"}</strong>
          </span>
        </div>
        <div className="dungeon-authoring-mode">
          <PencilSquareIcon />
          <span>
            <strong>Authoring</strong>
            <small>Top-down construction</small>
          </span>
        </div>
        <div className="dungeon-command-actions">
          <EditorButton
            className="dungeon-save-button"
            interaction={!level || save_state.type === "saving"
              ? "disabled"
              : "enabled"}
            onPress={() => void persist_project()}
          >
            {save_state.type === "saved"
              ? <CheckIcon />
              : save_state.type === "error"
              ? <ExclamationTriangleIcon />
              : <CloudArrowUpIcon />}
            {save_state.type === "dirty"
              ? "Save changes"
              : save_state.type === "clean"
              ? "Saved"
              : save_state.type}
          </EditorButton>
          <EditorButton
            className="dungeon-runtime-button"
            onPress={() => void open_runtime_view("/debug")}
          >
            <BugAntIcon /> Debug
          </EditorButton>
          <EditorButton
            className="dungeon-runtime-button"
            tone="primary"
            onPress={() => void open_runtime_view("/game")}
          >
            <PlayIcon /> Play
          </EditorButton>
        </div>
      </header>

      <div className="dungeon-editor-body">
        <aside className="dungeon-scene-panel" aria-label="Scene hierarchy">
          <div className="dungeon-panel-heading">
            <span>Scene</span>
            <output>{level?.brushes.length ?? 0}</output>
          </div>
          <div className="dungeon-scene-tree">
            {document && (
              <AdventureWorkspace
                document={document}
                selected_brush_slot={selected_slot}
                onSelectBrush={(slot) => {
                  set_selected_slot(slot);
                  set_tool("select");
                }}
              />
            )}
          </div>
          <div className="dungeon-scene-footer">
            <FlagIcon /> Entry at{" "}
            {level?.player_start.x2 ?? 0}/2,{level?.player_start.z2 ?? 0}/2
          </div>
        </aside>

        <main className="dungeon-plan-stage" aria-label="Top construction view">
          <Toolbar label="Plan view controls">
            <div className="dungeon-view-identity">
              <strong>TOP</strong>
              <span>Construction plane</span>
            </div>
            <div className="dungeon-view-controls">
              <IconButton
                label="Zoom out"
                icon={<MinusIcon />}
                onPress={() =>
                  set_zoom((current) => Math.max(0.5, current - 0.1))}
              />
              <output aria-label="Plan zoom">{Math.round(zoom * 100)}%</output>
              <IconButton
                label="Zoom in"
                icon={<PlusIcon />}
                onPress={() =>
                  set_zoom((current) => Math.min(2, current + 0.1))}
              />
              <IconButton
                label="Center plan"
                icon={<ArrowsPointingInIcon />}
                onPress={() => set_viewport_offset({ x: 0, y: 0 })}
              />
            </div>
          </Toolbar>

          <div className="dungeon-plan-viewport">
            {level
              ? (
                <div
                  className="dungeon-plan"
                  data-authoring={tool === "select" ? undefined : "true"}
                  style={plan_style}
                  onPointerDown={begin_plan_action}
                  onPointerMove={move_plan_action}
                  onPointerUp={finish_plan_action}
                  onPointerCancel={finish_plan_action}
                >
                  {level.brushes.map((brush) => (
                    <BrushRectangle
                      key={brush.slot}
                      brush={brush}
                      cell_size={cell_size}
                      selected={brush.slot === selected_slot}
                      on_select={() => {
                        set_selected_slot(brush.slot);
                        set_tool("select");
                      }}
                      on_nudge={(x, z) =>
                        update_selected({
                          center_x2: brush.center_x2 + x * 2,
                          center_z2: brush.center_z2 + z * 2,
                        })}
                    />
                  ))}
                  {preview_brush && (
                    <BrushRectangle
                      brush={{ ...preview_brush, slot: -1 }}
                      cell_size={cell_size}
                      selected={false}
                      preview
                      on_select={() => {}}
                      on_nudge={() => {}}
                    />
                  )}
                  <span
                    className="dungeon-player-start"
                    title="Entry point"
                    style={point_style(
                      level.player_start.x2,
                      level.player_start.z2,
                      cell_size,
                    )}
                  >
                    <FlagIcon />
                  </span>
                </div>
              )
              : (
                <p className="dungeon-load-state">
                  {load_error ?? "Loading level…"}
                </p>
              )}
          </div>

          <div className="dungeon-tool-dock">
            <Toolbar label="Construction tools">
              {tool_presets.map((preset, index) => {
                const Icon = preset.icon;
                return (
                  <ToggleButton
                    key={preset.tool}
                    className="dungeon-tool-button"
                    label={`${preset.label}: ${preset.description}`}
                    selected={tool === preset.tool}
                    onPress={() => set_tool(preset.tool)}
                  >
                    <Icon />
                    <span>
                      <strong>{preset.label}</strong>
                      <small>{preset.description}</small>
                    </span>
                    <kbd>{index + 1}</kbd>
                  </ToggleButton>
                );
              })}
            </Toolbar>
          </div>
        </main>

        <aside className="dungeon-properties-panel" aria-label="Properties">
          <div className="dungeon-panel-heading">
            <span>Properties</span>
            {selected && <code>#{selected.slot}</code>}
          </div>
          {selected
            ? (
              <div className="dungeon-properties-scroll">
                <InspectorSection title="Identity">
                  <TextField
                    label="Brush name"
                    value={selected.id}
                    onValueChange={(id) => update_selected({ id })}
                  />
                </InspectorSection>
                <InspectorSection title="Transform">
                  <div className="dungeon-field-row">
                    <NumberField
                      label="X"
                      value={selected.center_x2 / 2}
                      step={0.5}
                      suffix="m"
                      onValueChange={(value) =>
                        update_half_coordinate(
                          value,
                          (center_x2) => update_selected({ center_x2 }),
                        )}
                    />
                    <NumberField
                      label="Y"
                      value={selected.elevation}
                      minimum={-16}
                      maximum={16}
                      step={1}
                      suffix="m"
                      onValueChange={(value) =>
                        update_integer(
                          value,
                          (elevation) => update_selected({ elevation }),
                        )}
                    />
                    <NumberField
                      label="Z"
                      value={selected.center_z2 / 2}
                      step={0.5}
                      suffix="m"
                      onValueChange={(value) =>
                        update_half_coordinate(
                          value,
                          (center_z2) => update_selected({ center_z2 }),
                        )}
                    />
                  </div>
                </InspectorSection>
                <InspectorSection title="Dimensions">
                  <div className="dungeon-field-row">
                    <NumberField
                      label="Width"
                      value={selected.width}
                      minimum={1}
                      maximum={32}
                      step={1}
                      suffix="m"
                      onValueChange={(value) =>
                        update_integer(
                          value,
                          (width) => update_selected({ width }),
                        )}
                    />
                    <NumberField
                      label="Height"
                      value={selected.height}
                      minimum={1}
                      maximum={16}
                      step={1}
                      suffix="m"
                      onValueChange={(value) =>
                        update_integer(
                          value,
                          (height) => update_selected({ height }),
                        )}
                    />
                    <NumberField
                      label="Depth"
                      value={selected.depth}
                      minimum={1}
                      maximum={32}
                      step={1}
                      suffix="m"
                      onValueChange={(value) =>
                        update_integer(
                          value,
                          (depth) => update_selected({ depth }),
                        )}
                    />
                  </div>
                </InspectorSection>
                <InspectorSection title="Surface">
                  <SelectField
                    label="Material"
                    value={selected.material}
                    options={[
                      {
                        value: "dungeon.floor.flagstone",
                        label: "Flagstone floor",
                      },
                      {
                        value: "dungeon.wall.limestone",
                        label: "Limestone wall",
                      },
                      {
                        value: "dungeon.gate.oak",
                        label: "Iron-strapped oak",
                      },
                    ]}
                    onValueChange={(material) =>
                      update_selected({
                        material: material as AdventureBrush["material"],
                      })}
                  />
                  <div
                    className="dungeon-material-preview"
                    data-material={selected.material}
                  >
                    <span>{selected.material}</span>
                  </div>
                </InspectorSection>
                <div className="dungeon-property-actions">
                  <EditorButton
                    onPress={() =>
                      update_selected({
                        yaw_quarters: (selected.yaw_quarters + 1) % 4,
                      })}
                  >
                    <ArrowPathIcon /> Rotate 90°
                  </EditorButton>
                  <EditorButton tone="danger" onPress={delete_selected}>
                    <TrashIcon /> Delete
                  </EditorButton>
                </div>
                <p className="dungeon-property-tip">
                  Arrow keys nudge the focused brush by one metre.
                </p>
              </div>
            )
            : (
              <div className="dungeon-empty-properties">
                <CursorArrowRaysIcon />
                <strong>Nothing selected</strong>
                <p>Choose geometry in the scene or directly on the plan.</p>
              </div>
            )}
        </aside>
      </div>

      <StatusBar
        label="Authoring status"
        entries={[
          { id: "tool", label: "Tool", value: active_tool.label },
          {
            id: "brushes",
            label: "Brushes",
            value: `${level?.brushes.length ?? 0} brushes`,
          },
          { id: "snap", label: "Snap", value: "1 m snap" },
          {
            id: "save",
            label: "Save state",
            value: save_state.type === "error"
              ? save_state.message
              : save_state.type,
          },
        ]}
      />
    </section>
  );
}

function BrushRectangle(
  { brush, cell_size, selected, preview = false, on_select, on_nudge }: {
    readonly brush: AdventureBrush;
    readonly cell_size: number;
    readonly selected: boolean;
    readonly preview?: boolean;
    readonly on_select: () => void;
    readonly on_nudge: (x: number, z: number) => void;
  },
) {
  return (
    <button
      type="button"
      className="dungeon-brush"
      data-kind={brush.kind}
      data-material={brush.material}
      data-selected={selected ? "true" : undefined}
      data-preview={preview ? "true" : undefined}
      aria-label={preview ? `Preview ${brush.id}` : brush.id}
      tabIndex={preview ? -1 : 0}
      style={brush_style(brush, cell_size)}
      onPointerDown={(event) => {
        if (preview || event.button !== 0) return;
        event.stopPropagation();
        on_select();
      }}
      onKeyDown={(event) => {
        const movement = event.key === "ArrowLeft"
          ? [-1, 0]
          : event.key === "ArrowRight"
          ? [1, 0]
          : event.key === "ArrowUp"
          ? [0, -1]
          : event.key === "ArrowDown"
          ? [0, 1]
          : undefined;
        if (!movement) return;
        event.preventDefault();
        on_nudge(movement[0], movement[1]);
      }}
    >
      <span>{brush_icon(brush)}</span>
      {brush.width * brush.depth >= 6 && <small>{brush.id}</small>}
    </button>
  );
}

function brush_from_draft(
  level: AdventureLayout,
  draft: BrushDraft,
): Omit<AdventureBrush, "slot"> {
  const minimum_x = Math.min(draft.start.x, draft.end.x);
  const maximum_x = Math.max(draft.start.x, draft.end.x);
  const minimum_z = Math.min(draft.start.z, draft.end.z);
  const maximum_z = Math.max(draft.start.z, draft.end.z);
  if (draft.tool === "floor") {
    return {
      id: next_brush_id(level, "floor"),
      kind: "block",
      center_x2: minimum_x + maximum_x + 1,
      elevation: -1,
      center_z2: minimum_z + maximum_z + 1,
      width: maximum_x - minimum_x + 1,
      height: 1,
      depth: maximum_z - minimum_z + 1,
      yaw_quarters: 0,
      material: "dungeon.floor.flagstone",
    };
  }
  const horizontal = maximum_x - minimum_x >= maximum_z - minimum_z;
  return {
    id: next_brush_id(level, "wall"),
    kind: "block",
    center_x2: horizontal ? minimum_x + maximum_x + 1 : draft.start.x * 2 + 1,
    elevation: 0,
    center_z2: horizontal ? draft.start.z * 2 + 1 : minimum_z + maximum_z + 1,
    width: horizontal ? maximum_x - minimum_x + 1 : 1,
    height: 3,
    depth: horizontal ? 1 : maximum_z - minimum_z + 1,
    yaw_quarters: 0,
    material: "dungeon.wall.limestone",
  };
}

function brush_style(brush: AdventureBrush, cell_size: number): CSSProperties {
  return {
    left: (brush.center_x2 / 2 - brush.width / 2 - grid.minimum_x) * cell_size,
    top: (brush.center_z2 / 2 - brush.depth / 2 - grid.minimum_z) * cell_size,
    width: brush.width * cell_size,
    height: brush.depth * cell_size,
    "--brush-height": `${Math.min(14, brush.height * 3)}px`,
  } as CSSProperties;
}

function point_style(x2: number, z2: number, cell_size: number): CSSProperties {
  return {
    left: (x2 / 2 - grid.minimum_x) * cell_size,
    top: (z2 / 2 - grid.minimum_z) * cell_size,
  };
}

function grid_point_at(
  event: ReactPointerEvent<HTMLDivElement>,
  zoom: number,
): GridPoint | undefined {
  const bounds = event.currentTarget.getBoundingClientRect();
  const cell_size = base_cell_size * zoom;
  const x = Math.floor((event.clientX - bounds.left) / cell_size) +
    grid.minimum_x;
  const z = Math.floor((event.clientY - bounds.top) / cell_size) +
    grid.minimum_z;
  if (
    x < grid.minimum_x || x >= grid.minimum_x + grid.columns ||
    z < grid.minimum_z || z >= grid.minimum_z + grid.rows
  ) return undefined;
  return { x, z };
}

function next_brush_id(level: AdventureLayout, prefix: string): string {
  const ids = new Set(level.brushes.map(({ id }) => id));
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const id = `${prefix}-${suffix}`;
    if (!ids.has(id)) return id;
  }
  throw new Error(
    `dungeon brush prefix ${JSON.stringify(prefix)} has no free id`,
  );
}

function brush_icon(brush: AdventureBrush): string {
  if (brush.kind === "door") return "▥";
  if (brush.kind === "stairs") return "▰";
  return brush.material === "dungeon.floor.flagstone" ? "▦" : "▤";
}

function update_integer(value: number, apply: (value: number) => void): void {
  if (Number.isSafeInteger(value)) apply(value);
}

function update_half_coordinate(
  source: number,
  apply: (value: number) => void,
): void {
  const value = source * 2;
  if (Number.isSafeInteger(value)) apply(value);
}

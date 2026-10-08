/**
 * A Valve Hammer-style editor: the classic four views (3D, top, front, side),
 * an object list, an entity palette, and Object Properties with the class
 * info, Outputs and Inputs of the selected entity. The 3D view becomes the
 * first-person game while playing.
 */
import { useEffect } from "react";
import {
  Brand,
  BuildStatus,
  Console,
  HistoryButtons,
  Icon,
  InkApp,
  Inspector,
  LanguageSelect,
  LayoutButton,
  Outliner,
  PaletteButton,
  Pane,
  Panel,
  PlayControls,
  SaveButton,
  ScenarioControls,
  SnapControls,
  Spacer,
  Split,
  Timeline,
  ToolPicker,
  TopBar,
  useInk,
  useMode,
  useSelection,
  useSession,
  useSessionValue,
  useUi,
  Viewport,
  Workspace,
} from "@ink/react";
import {
  brushAlignmentCommands,
  brushCommands,
  BrushHint,
  BrushToolbar,
  FaceInspector,
  faceSelection,
  TextureBrowser,
} from "@ink/brushes";
import { connectionsOf, describe, incoming } from "./io.ts";
import { InputsPanel, OutputsPanel } from "./outputs.tsx";
import { hammerOverlay } from "./overlay.ts";
import {
  entityPresets,
  placement,
  placeTool,
  tools,
  usePlacement,
} from "./tools.ts";
import { Hud } from "./hud.tsx";
import "./hammer.css";

/** Entity I/O that fires while playing goes to the console as it happens. */
function IoLog() {
  const session = useSession();
  useEffect(
    () =>
      session.onEvents((events) => {
        for (const event of events) {
          if (event.name !== "io") continue;
          session.info(
            describe((id) => session.nameOf(id), event.value as never),
            "game",
          );
        }
      }),
    [session],
  );
  return null;
}

function EntityPalette() {
  const ink = useInk();
  const tool = useUi((u) => u.tool);
  const active = usePlacement();
  return (
    <div className="hammer-palette">
      <button
        type="button"
        className="ink-button"
        aria-pressed={(tool as string) === "block"}
        title="Drag a box in the top, front or side view (B)"
        onClick={() => ink.ui.set({ tool: "block" as never })}
      >
        <Icon name="box" /> Block
      </button>
      {entityPresets.map((preset) => (
        <button
          type="button"
          key={preset.label}
          className="ink-button"
          aria-pressed={tool === placeTool.id && active === preset}
          title={`Click in a view to place a ${preset.label.toLowerCase()} (N)`}
          onClick={() => {
            placement.set(preset);
            ink.ui.set({ tool: placeTool.id as never });
          }}
        >
          <Icon name={preset.icon ?? "entity"} /> {preset.label}
        </button>
      ))}
    </div>
  );
}

function Count({ kind }: { kind: "out" | "in" }) {
  const id = useSelection()[0];
  const count = useSessionValue((s) => {
    if (id === undefined) return 0;
    return kind === "out"
      ? connectionsOf(s.world.entities.find((e) => e.id === id)).length
      : incoming(s.world, id).length;
  });
  return count > 0 ? <span className="ink-chip">{count}</span> : null;
}

/** The 3D camera while editing, the first-person game while playing. */
function PerspectiveView() {
  const { mode } = useMode();
  return (
    <Viewport
      id="persp"
      view={mode === "play" ? "game" : "perspective"}
      label={mode === "play" ? "Game" : "3D Camera"}
      tools={tools}
      selectedFaces={faceSelection}
      overlay={hammerOverlay}
      pointerLock
      diagnostics
    >
      <Hud />
    </Viewport>
  );
}

export function App() {
  return (
    <InkApp
      project="examples/hammer"
      title="Ink Hammer"
      presets={entityPresets}
      hud={<Hud />}
      tools={tools}
      pointerLock
      commands={[...brushCommands, ...brushAlignmentCommands]}
      ui={{ tool: "select", grid: 0.5 }}
    >
      <IoLog />
      <TopBar>
        <Brand subtitle="entity I/O" />
        <SaveButton />
        <HistoryButtons />
        <Spacer />
        <ToolPicker />
        <BrushToolbar tools={tools} />
        <BrushHint />
        <SnapControls />
        <PlayControls />
        <Spacer />
        <BuildStatus />
        <LanguageSelect />
        <ScenarioControls />
        <LayoutButton />
        <PaletteButton />
      </TopBar>
      <Workspace>
        <Split id="columns">
          <Pane size={230} min={170}>
            <Split id="left" direction="column">
              <Pane>
                <Panel title="Objects">
                  <Outliner presets={entityPresets} />
                </Panel>
              </Pane>
              <Pane size={260} min={120}>
                <Panel
                  id="palette"
                  tabs={[
                    {
                      id: "entities",
                      label: "Entities",
                      content: <EntityPalette />,
                    },
                    {
                      id: "textures",
                      label: "Textures",
                      content: <TextureBrowser />,
                    },
                  ]}
                />
              </Pane>
            </Split>
          </Pane>
          <Pane>
            <Split id="center" direction="column">
              <Pane>
                <Split id="rows" direction="column">
                  <Pane>
                    <Split id="top-row">
                      <Pane>
                        <PerspectiveView />
                      </Pane>
                      <Pane>
                        <Viewport
                          id="top"
                          view="top"
                          shading="wireframe"
                          label="Top (X/Z)"
                          tools={tools}
                          selectedFaces={faceSelection}
                          overlay={hammerOverlay}
                        />
                      </Pane>
                    </Split>
                  </Pane>
                  <Pane>
                    <Split id="bottom-row">
                      <Pane>
                        <Viewport
                          id="front"
                          view="front"
                          shading="wireframe"
                          label="Front (X/Y)"
                          tools={tools}
                          selectedFaces={faceSelection}
                          overlay={hammerOverlay}
                        />
                      </Pane>
                      <Pane>
                        <Viewport
                          id="side"
                          view="side"
                          shading="wireframe"
                          label="Side (Z/Y)"
                          tools={tools}
                          selectedFaces={faceSelection}
                          overlay={hammerOverlay}
                        />
                      </Pane>
                    </Split>
                  </Pane>
                </Split>
              </Pane>
              <Pane size={150} min={70}>
                <Panel title="Console">
                  <Timeline />
                  <Console />
                </Panel>
              </Pane>
            </Split>
          </Pane>
          <Pane size={360} min={280}>
            <Panel
              id="properties"
              tabs={[
                {
                  id: "class",
                  label: "Class info",
                  content: <Inspector hide={["outputs"]} />,
                },
                { id: "face", label: "Face", content: <FaceInspector /> },
                {
                  id: "outputs",
                  label: "Outputs",
                  badge: <Count kind="out" />,
                  content: <OutputsPanel />,
                },
                {
                  id: "inputs",
                  label: "Inputs",
                  badge: <Count kind="in" />,
                  content: <InputsPanel />,
                },
              ]}
            />
          </Pane>
        </Split>
      </Workspace>
    </InkApp>
  );
}

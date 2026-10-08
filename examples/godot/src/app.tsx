/**
 * A Godot-style scene editor: scene tree and files on the left, the 3D view
 * and a game view in the middle, the inspector on the right, output,
 * timeline and comments below. Every piece comes from @ink/react.
 */
import {
  AssetBrowser,
  Brand,
  BuildStatus,
  CollaborateButtons,
  CommentList,
  Console,
  HistoryButtons,
  InkApp,
  Inspector,
  LayoutButton,
  Outliner,
  PaletteButton,
  Pane,
  Panel,
  PlayControls,
  type Preset,
  SaveButton,
  SnapControls,
  Spacer,
  Split,
  Timeline,
  ToolPicker,
  TopBar,
  useResource,
  Viewport,
  Workspace,
} from "@ink/react";

const shape = (path: string, color: number[]) => ({
  shape: path,
  color: [...color, 1],
});

const presets: Preset[] = [
  {
    label: "Cube",
    icon: "cube",
    components: {
      transform: {},
      mesh: shape("builtin:cube", [0.85, 0.85, 0.88]),
    },
  },
  {
    label: "Sphere",
    icon: "cube",
    components: {
      transform: {},
      mesh: shape("builtin:sphere", [0.85, 0.85, 0.88]),
    },
  },
  {
    label: "Platform",
    icon: "box",
    components: {
      transform: { scale: [3, 0.5, 3] },
      mesh: shape("builtin:cube", [0.85, 0.78, 0.66]),
      platform: { size: [3, 0.5, 3] },
    },
  },
  {
    label: "Coin",
    icon: "sparkle",
    components: {
      transform: { position: [0, 1, 0] },
      coin: {},
      spinner: {},
      mesh: {
        shape: "builtin:cylinder",
        color: [1, 0.78, 0.25, 1],
        metallic: 1,
        roughness: 0.25,
      },
    },
  },
  {
    label: "Point light",
    icon: "sun",
    components: {
      transform: { position: [0, 3, 0] },
      light: { kind: "point", intensity: 5, range: 8 },
    },
  },
  {
    label: "Camera",
    icon: "camera",
    components: {
      transform: { position: [0, 2, 6] },
      camera: { active: false },
    },
  },
];

/** The game's HUD: plain React reading a world resource. */
function Hud() {
  const score = useResource("score") as
    | { value: number; total: number }
    | undefined;
  if (!score) return null;
  const done = score.total > 0 && score.value >= score.total;
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        padding: "6px 12px",
        borderRadius: 999,
        background: done
          ? "rgba(79, 209, 139, 0.85)"
          : "rgba(12, 13, 16, 0.65)",
        color: done ? "#06210f" : "#ffd75e",
        fontWeight: 700,
        fontSize: 14,
        letterSpacing: "0.02em",
      }}
    >
      {done ? "All coins!" : `● ${score.value} / ${score.total || "?"}`}
    </div>
  );
}

export function App() {
  return (
    <InkApp
      project="examples/godot"
      title="Ink Scene"
      presets={presets}
      hud={<Hud />}
    >
      <TopBar>
        <Brand subtitle="scene editor" />
        <SaveButton />
        <HistoryButtons />
        <Spacer />
        <ToolPicker />
        <SnapControls />
        <PlayControls />
        <Spacer />
        <BuildStatus />
        <CollaborateButtons />
        <LayoutButton />
        <PaletteButton />
      </TopBar>
      <Workspace>
        <Split id="columns">
          <Pane size={260} min={180}>
            <Split id="left" direction="column">
              <Pane>
                <Panel title="Scene">
                  <Outliner presets={presets} />
                </Panel>
              </Pane>
              <Pane size={230}>
                <Panel title="FileSystem">
                  <AssetBrowser />
                </Panel>
              </Pane>
            </Split>
          </Pane>
          <Pane>
            <Split id="center" direction="column">
              <Pane>
                <Split id="views">
                  <Pane>
                    <Viewport id="main" diagnostics />
                  </Pane>
                  <Pane size={440} min={200}>
                    <Viewport id="game" view="game" label="Game">
                      <Hud />
                    </Viewport>
                  </Pane>
                </Split>
              </Pane>
              <Pane size={210} min={80}>
                <Panel
                  id="bottom"
                  tabs={[
                    { id: "output", label: "Output", content: <Console /> },
                    {
                      id: "timeline",
                      label: "Timeline",
                      content: <Timeline />,
                    },
                    {
                      id: "comments",
                      label: "Comments",
                      content: <CommentList />,
                    },
                  ]}
                />
              </Pane>
            </Split>
          </Pane>
          <Pane size={320} min={240}>
            <Panel title="Inspector">
              <Inspector />
            </Panel>
          </Pane>
        </Split>
      </Workspace>
    </InkApp>
  );
}

/**
 * A terrain editor: the scene tree and files on the left, the 3D view and the
 * game view in the middle, the inspector on the right, output, timeline and
 * comments below. The terrain and scatter tools join the toolbar and the
 * viewport as they land; every piece here comes from @ink/react.
 */
import {
  AssetBrowser,
  Brand,
  BuildStatus,
  CollaborateButtons,
  CommentList,
  Console,
  FrameProfiler,
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
  ScenarioControls,
  SnapControls,
  Spacer,
  Split,
  Timeline,
  ToolPicker,
  TopBar,
  Viewport,
  Workspace,
} from "@ink/react";
import {
  createTerrainTools,
  NewScatterForm,
  NewTerrainForm,
  TerrainBrushPanel,
  terrainCommands,
  TerrainHint,
  TerrainToolbar,
} from "@ink/terrain";

const tools = createTerrainTools();

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
    label: "Walker",
    icon: "hand",
    components: {
      transform: { scale: [1.6, 1.8, 1.6] },
      mesh: shape("builtin:capsule", [0.36, 0.55, 0.95]),
      walker: {},
    },
  },
  {
    label: "Point light",
    icon: "sun",
    components: {
      transform: { position: [0, 3, 0] },
      light: { kind: "point", intensity: 5, range: 12 },
    },
  },
  {
    label: "Camera",
    icon: "camera",
    components: {
      transform: { position: [0, 2, 6] },
      camera: { active: false, far: 6000 },
    },
  },
];

export function App() {
  return (
    <InkApp
      project="examples/terrain"
      title="Terrain Lab"
      presets={presets}
      tools={tools}
      commands={terrainCommands}
    >
      <TopBar>
        <Brand subtitle="terrain editor" />
        <SaveButton />
        <HistoryButtons />
        <Spacer />
        <ToolPicker />
        <TerrainToolbar tools={tools} />
        <TerrainHint />
        <SnapControls />
        <PlayControls />
        <Spacer />
        <BuildStatus />
        <FrameProfiler />
        <ScenarioControls />
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
                    <Viewport
                      id="main"
                      grid={false}
                      diagnostics
                      tools={tools}
                      // Start near the meadow, not framing the whole 4 km².
                      frameOnOpen={() => ({
                        position: [40, 45, 70],
                        yaw: 0.52,
                        pitch: -0.36,
                        distance: 90,
                      })}
                    />
                  </Pane>
                  <Pane size={440} min={200}>
                    <Viewport id="game" view="game" label="Game" />
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
            <Split id="right" direction="column">
              <Pane>
                <Panel title="Inspector">
                  <Inspector />
                </Panel>
              </Pane>
              <Pane size={330} min={120}>
                <Panel title="Terrain">
                  <TerrainBrushPanel />
                  <NewTerrainForm />
                  <NewScatterForm />
                </Panel>
              </Pane>
            </Split>
          </Pane>
        </Split>
      </Workspace>
    </InkApp>
  );
}

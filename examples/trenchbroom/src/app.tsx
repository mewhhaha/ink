/**
 * A TrenchBroom-style level editor: a big 3D view with top and front views
 * beside it, the map and entity browsers and the texture browser on the left,
 * the entity and face inspectors on the right. The brush tools, face
 * inspector and texture browser come from @ink/brushes; everything else is
 * @ink/react. Playing switches the big view to the game camera.
 */
import { type ReactNode, useEffect, useState } from "react";
import { quat, type Vec3 } from "@ink/geometry";
import { defaultRecord } from "@ink/schema";
import {
  BrushHint,
  BrushToolbar,
  createBrushTools,
  FaceInspector,
  faceSelection,
  TextureBrowser,
} from "@ink/brushes";
import {
  Brand,
  BuildStatus,
  CollaborateButtons,
  CommentList,
  Console,
  HistoryButtons,
  Icon,
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
  ToolButton,
  ToolPicker,
  TopBar,
  useInk,
  useMode,
  useResource,
  useSession,
  type ViewName,
  Viewport,
  Workspace,
} from "@ink/react";

const tools = createBrushTools({ name: "Brush" });

const white = [1, 1, 1, 1];
const pickup = (kind: "health" | "ammo") => ({
  transform: {
    position: [0, 1, 0],
    scale: kind === "health" ? [0.45, 0.45, 0.45] : [0.35, 0.5, 0.35],
  },
  mesh: {
    shape: kind === "health" ? "builtin:cube" : "builtin:cylinder",
    color: kind === "health" ? [0.95, 0.2, 0.2, 1] : [0.95, 0.78, 0.2, 1],
    emissive: kind === "health" ? [0.45, 0.04, 0.04, 1] : [0.4, 0.3, 0.02, 1],
    cast_shadows: false,
  },
  pickup: { kind, amount: kind === "health" ? 25 : 10, radius: 1 },
});

/** Point entities the browser places in front of the 3D view. */
const pointEntities: (Preset & { name: string })[] = [
  {
    label: "Player start",
    name: "info_player_start",
    icon: "hand",
    components: {
      transform: { position: [0, 0.45, 0], scale: [0.6, 1, 0.6] },
      mesh: {
        shape: "builtin:cone",
        color: [0.3, 0.9, 0.45, 1],
        cast_shadows: false,
      },
      player: {},
    },
  },
  {
    label: "Light",
    name: "light",
    icon: "sun",
    components: {
      transform: { position: [0, 3, 0] },
      light: { kind: "point", color: white, intensity: 8, range: 12 },
    },
  },
  {
    label: "Health",
    name: "item_health",
    icon: "sparkle",
    components: pickup("health"),
  },
  {
    label: "Ammo",
    name: "item_ammo",
    icon: "sparkle",
    components: pickup("ammo"),
  },
  {
    label: "Camera",
    name: "fps_camera",
    icon: "camera",
    components: {
      transform: { position: [0, 1.65, 0] },
      camera: { fov: 78, near: 0.05 },
      first_person: {},
    },
  },
];

/** Components that turn the selected brushes into brush entities. */
const brushEntities = [
  { label: "Door", icon: "door", component: "door" },
  { label: "Acid", icon: "bolt", component: "hazard" },
  { label: "Crate", icon: "box", component: "breakable" },
];

/** Entity browser: click a point entity to place it in front of the camera; click a
 * brush entity to make the selected brushes one. */
function EntityBrowser() {
  const ink = useInk();
  const session = useSession();
  const place = (preset: Preset & { name: string }) => {
    let at: Vec3 = [0, 0, 0];
    const pose = ink.views.get("main")?.pose();
    if (pose && pose.view === "perspective") {
      const ahead = quat.rotate(pose.rotation as never, [0, 0, -1]) as Vec3;
      at = pose.position.map((v, i) =>
        Math.round((v + ahead[i] * 5) * 2) / 2
      ) as unknown as Vec3;
    }
    const transform = { ...preset.components.transform };
    const lift = (transform.position as number[] | undefined)?.[1] ?? 0;
    transform.position = [at[0], Math.max(0, at[1]) + lift, at[2]];
    session.createEntity({
      name: preset.name,
      components: { ...preset.components, transform },
    });
  };
  return (
    <div
      style={{ padding: 8, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <Section title="Point entities">
        {pointEntities.map((p) => (
          <button
            type="button"
            key={p.label}
            className="ink-button"
            onClick={() => place(p)}
            title={`Place ${p.name} in front of the 3D view`}
          >
            <Icon name={p.icon ?? "entity"} size={13} /> {p.label}
          </button>
        ))}
      </Section>
      <Section title="Brush entities (selected brushes)">
        {brushEntities.map((b) => (
          <button
            type="button"
            key={b.label}
            className="ink-button"
            onClick={() => {
              const brushes = session.selection.filter((id) =>
                session.world.entities.find((e) => e.id === id)?.components
                  .brush
              );
              if (brushes.length === 0) {
                return session.warn(
                  "Select a brush first.",
                );
              }
              session.edit(`Make ${b.label.toLowerCase()}`, (world) => {
                for (const id of brushes) {
                  const e = world.entities.find((x) => x.id === id);
                  const record = session.schema.component(b.component);
                  if (e && record && !e.components[b.component]) {
                    e.components[b.component] = defaultRecord(record);
                  }
                }
              });
            }}
            title={`Turn the selected brushes into ${b.label.toLowerCase()} entities`}
          >
            <Icon name={b.icon} size={13} /> {b.label}
          </button>
        ))}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div
        className="ink-field-group"
        style={{ marginTop: 0, marginBottom: 4 }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

interface Stats {
  health: number;
  ammo: number;
  found: number;
  total: number;
}

/** The game's HUD: plain React reading the `stats` resource. */
function Hud() {
  const stats = useResource("stats") as unknown as Stats | undefined;
  const { mode } = useMode();
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const update = () => setLocked(document.pointerLockElement !== null);
    document.addEventListener("pointerlockchange", update);
    return () => document.removeEventListener("pointerlockchange", update);
  }, []);
  if (!stats || mode !== "play") return null;
  const health = Math.max(0, Math.round(stats.health));
  const low = health <= 30;
  const chip = {
    padding: "6px 14px",
    borderRadius: 8,
    background: "rgba(10, 11, 14, 0.62)",
    color: "#f2f4f8",
    fontWeight: 700,
    fontSize: 22,
    letterSpacing: "0.02em",
    fontVariantNumeric: "tabular-nums",
    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
  } as const;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 18,
          height: 18,
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 8,
            top: 0,
            width: 2,
            height: 18,
            background: "rgba(255,255,255,0.8)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 8,
            width: 18,
            height: 2,
            background: "rgba(255,255,255,0.8)",
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 14,
          bottom: 14,
          ...chip,
          color: low ? "#ff6b5e" : "#7dff9a",
        }}
      >
        ✚ {health}
      </div>
      <div
        style={{
          position: "absolute",
          right: 14,
          bottom: 14,
          ...chip,
          color: stats.ammo === 0 ? "#ff6b5e" : "#ffd75e",
        }}
      >
        ▮ {stats.ammo}
      </div>
      <div
        style={{
          position: "absolute",
          left: 96,
          top: 14,
          ...chip,
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        Items {stats.found} / {stats.total}
      </div>
      {!locked && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 70,
            transform: "translateX(-50%)",
            ...chip,
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Click to look around · WASD move · Space jump · Click fires · Esc
          releases the mouse
        </div>
      )}
    </>
  );
}

/** The big view: the perspective editor camera, or the game while playing. */
function MainView() {
  const { mode } = useMode();
  const [view, setView] = useState<ViewName>("perspective");
  useEffect(() => setView(mode === "play" ? "game" : "perspective"), [mode]);
  return (
    <Viewport
      id="main"
      view={view}
      tools={tools}
      selectedFaces={faceSelection}
      pointerLock
      diagnostics
      actions={
        <ToolButton
          icon={view === "game" ? "cube" : "camera"}
          label={view === "game" ? "Editor camera" : "Game camera"}
          onClick={() => setView(view === "game" ? "perspective" : "game")}
        />
      }
    >
      <Hud />
    </Viewport>
  );
}

export function App() {
  return (
    <InkApp
      project="examples/trenchbroom"
      title="Ink Brush Editor"
      tools={tools}
      presets={pointEntities}
      hud={<Hud />}
      pointerLock
      ui={{ tool: "brush-edit" as never, grid: 0.5 }}
    >
      <TopBar>
        <Brand subtitle="brush editor" />
        <SaveButton />
        <HistoryButtons />
        <Spacer />
        <ToolPicker />
        <BrushToolbar tools={tools} />
        <SnapControls />
        <Spacer />
        <PlayControls />
        <Spacer />
        <BuildStatus />
        <CollaborateButtons />
        <LayoutButton />
        <PaletteButton />
      </TopBar>
      <Workspace>
        <Split id="columns">
          <Pane size={270} min={200}>
            <Split id="left" direction="column">
              <Pane>
                <Panel
                  id="left-top"
                  tabs={[
                    {
                      id: "map",
                      label: "Map",
                      content: <Outliner presets={pointEntities} />,
                    },
                    {
                      id: "entities",
                      label: "Entities",
                      content: <EntityBrowser />,
                    },
                  ]}
                />
              </Pane>
              <Pane size={250} min={120}>
                <Panel title="Textures">
                  <TextureBrowser />
                </Panel>
              </Pane>
            </Split>
          </Pane>
          <Pane>
            <Split id="center" direction="column">
              <Pane>
                <Split id="views">
                  <Pane>
                    <MainView />
                  </Pane>
                  <Pane size={440} min={240}>
                    <Split id="plans" direction="column">
                      <Pane>
                        <Viewport
                          id="top"
                          view="top"
                          tools={tools}
                          selectedFaces={faceSelection}
                        />
                      </Pane>
                      <Pane>
                        <Viewport
                          id="front"
                          view="front"
                          tools={tools}
                          selectedFaces={faceSelection}
                        />
                      </Pane>
                    </Split>
                  </Pane>
                </Split>
              </Pane>
              <Pane size={170} min={60}>
                <Panel
                  id="bottom"
                  actions={<BrushHint />}
                  tabs={[
                    { id: "console", label: "Console", content: <Console /> },
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
          <Pane size={310} min={240}>
            <Split id="right" direction="column">
              <Pane>
                <Panel title="Inspector">
                  <Inspector />
                </Panel>
              </Pane>
              <Pane size={330} min={120}>
                <Panel title="Face">
                  <FaceInspector />
                </Panel>
              </Pane>
            </Split>
          </Pane>
        </Split>
      </Workspace>
    </InkApp>
  );
}

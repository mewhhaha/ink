/**
 * Tile Lab: an editor for 2D tile platformers. Paint tiles with brush, erase,
 * rectangle, fill and picker tools over an auto-tiling tileset, place the
 * hero, coins, slimes, torches and the flag, and play the level in place:
 * everything keeps working while the game runs, and edits to the Blot code,
 * the tileset images, the atlas files and the tiles themselves reload live.
 */
import { useEffect, useState } from "react";
import { Store, useStore } from "@ink/react";
import { type EntityModel, hasComponent } from "@ink/schema";
import type { Line, RenderScene } from "@ink/render";
import {
  Brand,
  BuildStatus,
  CollaborateButtons,
  CommentList,
  Console,
  FrameProfiler,
  Group,
  HistoryButtons,
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
  useSession,
  useUi,
  Viewport,
  type ViewportContext,
  type ViewportTool,
  Workspace,
} from "@ink/react";
import {
  createTileTools,
  pixelGridLines,
  TileHint,
  TileLayers,
  TilePalette,
  useTileBrush,
} from "@ink/tiles";

// What the Place tool puts down. Each is a few entities in scene format;
// frames and animations come from the generated sprite atlas (animation ids
// follow `sprites.atlas.json`: 1 idle, 2 run, 5 coin, 6 slime, 7 flag, 8 torch).
interface Placeable {
  id: string;
  label: string;
  hint: string;
  frame: string;
  place(session: ReturnType<typeof useSession>, at: [number, number]): void;
}

const sprite = (anim: number, pivot: [number, number], layer: number) => ({
  atlas: "sprites.atlas.json",
  anim,
  pivot,
  layer,
});
const at = ([x, y]: [number, number], dy = 0) => ({
  position: [x, y + dy, 0],
});

const placeables: Placeable[] = [
  {
    id: "hero",
    label: "Hero start",
    hint: "Moves the hero here",
    frame: "hero_idle_0",
    place(session, cell) {
      const hero = session.world.entities.find((e) => e.components.hero);
      if (hero) {
        session.edit("Move hero", (world) => {
          const t = world.entities.find((e) => e.id === hero.id)?.components
            .transform;
          if (t) t.position = [cell[0], cell[1] - 0.1, 0];
        });
        session.select([hero.id]);
        return;
      }
      session.createEntity({
        name: "Hero",
        components: {
          transform: at(cell, -0.1),
          sprite: sprite(1, [0.5, 0.4], 2),
          hero: {},
        },
      });
    },
  },
  {
    id: "coin",
    label: "Coin",
    hint: "Collect them all",
    frame: "coin_0",
    place: (s, cell) =>
      void s.createEntity({
        name: "Coin",
        components: {
          transform: at(cell),
          sprite: sprite(5, [0.5, 0.5], 1),
          coin: {},
        },
      }),
  },
  {
    id: "slime",
    label: "Slime",
    hint: "Patrols its platform",
    frame: "slime_0",
    place: (s, cell) =>
      void s.createEntity({
        name: "Slime",
        components: {
          transform: at(cell, -0.2),
          sprite: sprite(6, [0.5, 0.2], 1),
          slime: {},
        },
      }),
  },
  {
    id: "flag",
    label: "Goal flag",
    hint: "Touch it to win",
    frame: "flag_0",
    place: (s, cell) =>
      void s.createEntity({
        name: "Flag",
        components: {
          transform: at(cell),
          sprite: sprite(7, [0.5, 0.5], 1),
          goal: {},
        },
      }),
  },
  {
    id: "torch",
    label: "Torch",
    hint: "A flickering light that casts shadows",
    frame: "torch_0",
    place(s, cell) {
      const tx = s.begin("Place torch");
      const torch = s.createEntity({
        name: "Torch",
        components: {
          transform: at(cell),
          sprite: sprite(8, [0.5, 0.5], 1),
        },
        select: false,
      });
      s.createEntity({
        name: "Torch light",
        parent: torch,
        components: {
          transform: { position: [0, 0.6, 0] },
          light2d: {
            kind: "lamp",
            color: [1, 0.6, 0.25, 1],
            intensity: 1.2,
            radius: 8,
            falloff: 1.6,
            height: 1.1,
            shadows: true,
          },
          flicker: { base: 1.15, amount: 0.18, speed: 9 },
        },
      });
      tx.commit();
      s.select([torch]);
    },
  },
];

const placing = new Store<{ kind: string }>({ kind: "coin" });

const placeTool: ViewportTool = (() => {
  let hover: [number, number] | null = null;
  const cellOf = (ctx: ViewportContext, e: { x: number; y: number }) => {
    const p = ctx.planePoint(e.x, e.y);
    return p
      ? [Math.floor(p[0]) + 0.5, Math.floor(p[1]) + 0.5] as [number, number]
      : null;
  };
  return {
    id: "place",
    label: "Place objects",
    icon: "plus",
    shortcut: "P",
    cursor: "copy",
    noGizmo: true,
    pointerDown(ctx, e) {
      if (e.button !== 0) return false;
      const cell = cellOf(ctx, e);
      const kind = placeables.find((p) => p.id === placing.get().kind);
      if (!cell || !kind) return false;
      kind.place(ctx.session, cell);
      return true;
    },
    pointerMove(ctx, e) {
      hover = cellOf(ctx, e);
      ctx.redraw();
    },
    overlay() {
      if (!hover) return [];
      const [x, y] = hover;
      const color: Line["color"] = [0.3, 0.85, 1, 1];
      const c: [number, number, number][] = [
        [x - 0.5, y - 0.5, 0],
        [x + 0.5, y - 0.5, 0],
        [x + 0.5, y + 0.5, 0],
        [x - 0.5, y + 0.5, 0],
      ];
      return c.map((from, i) => ({
        from,
        to: c[(i + 1) % 4],
        color,
        width: 2,
      }));
    },
  };
})();

function Placeables() {
  const ink = useInk();
  const current = useStore(placing, (s) => s.kind);
  const tool = useUi((u) => u.tool);
  const catalog = ink.session.catalog;
  const sprites = catalog.assets.atlas?.find((p) => p.includes("sprites"));
  const info = sprites ? catalog.atlases?.[sprites] : undefined;
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!info) return;
    const next = new Image();
    next.onload = () => setImage(next);
    next.src = ink.dev?.client.assetUrl(info.image) ??
      `/__ink/assets/${info.image}`;
  }, [info?.image]);
  return (
    <div style={{ display: "grid", gap: 4, padding: 8 }}>
      {placeables.map((p) => {
        const index = info?.frames.indexOf(p.frame) ?? -1;
        const rect = info?.rects[index];
        return (
          <button
            type="button"
            key={p.id}
            className="ink-button"
            data-place={p.id}
            aria-pressed={(tool as string) === "place" && current === p.id}
            title={p.hint}
            style={{ justifyContent: "flex-start", gap: 8, height: 36 }}
            onClick={() => {
              placing.set({ kind: p.id });
              ink.ui.set({ tool: "place" as never });
            }}
          >
            <canvas
              width={32}
              height={32}
              style={{ width: 28, height: 28, imageRendering: "pixelated" }}
              ref={(canvas) => {
                const c = canvas?.getContext("2d");
                if (!c || !image || !rect) return;
                c.clearRect(0, 0, 32, 32);
                c.imageSmoothingEnabled = false;
                c.drawImage(
                  image,
                  rect[0],
                  rect[1],
                  rect[2],
                  rect[3],
                  0,
                  0,
                  32,
                  32,
                );
              }}
            />
            {p.label}
          </button>
        );
      })}
      <div style={{ color: "var(--ink-muted)", fontSize: 11, paddingTop: 4 }}>
        Click in the level to place. Select an object and press Delete to remove
        it.
      </div>
    </div>
  );
}

/** The tile under the pointer and the current brush, in the toolbar. */
function BrushChip() {
  const brush = useTileBrush();
  const ink = useInk();
  const names = ink.session.catalog.atlases;
  const first = names
    ? Object.values(names).find((i) => i.image.includes("tiles"))
    : undefined;
  return (
    <span className="ink-status" data-testid="brush-chip">
      Brush {brush.tile ? first?.frames[brush.tile - 1] ?? brush.tile : "empty"}
      {brush.auto ? " · auto-tile" : ""}
    </span>
  );
}

const tileTools = createTileTools();
const tools = [...tileTools, placeTool];

/** The HUD lives under the game camera; the level view leaves it out. */
const isHud = (entity: EntityModel) => hasComponent(entity, "hud");

/** Open the level around where the hero starts, at a comfortable zoom. */
function startView(scene: RenderScene) {
  const camera = scene.cameras.find((c) => c.camera.active);
  const at = camera ? [camera.matrix[12], camera.matrix[13]] : [10, 7];
  return {
    position: [at[0] + 2, at[1], 0] as [number, number, number],
    size: 20,
  };
}

function pixelGrid(ctx: ViewportContext): Line[] {
  return pixelGridLines(ctx, { pixelsPerUnit: 16 });
}

export function App() {
  return (
    <InkApp
      project="examples/tiles"
      title="Tile Lab"
      tools={tools}
      ui={{ tool: "tile-paint" as never, grid: 1, snap: true, space: "world" }}
    >
      <TopBar>
        <Brand subtitle="tile editor" />
        <SaveButton />
        <HistoryButtons />
        <Group>
          <ToolPicker tools={tools} />
        </Group>
        <SnapControls />
        <BrushChip />
        <Spacer />
        <PlayControls />
        <Spacer />
        <BuildStatus />
        <FrameProfiler />
        <LanguageSelect />
        <ScenarioControls />
        <CollaborateButtons />
        <LayoutButton />
        <PaletteButton />
      </TopBar>
      <Workspace>
        <Split id="columns">
          <Pane size={290} min={220}>
            <Split id="left" direction="column">
              <Pane>
                <Panel title="Tiles" actions={<TileHint />}>
                  <TilePalette />
                </Panel>
              </Pane>
              <Pane size={230} min={120}>
                <Panel
                  id="left-bottom"
                  tabs={[
                    { id: "layers", label: "Layers", content: <TileLayers /> },
                    {
                      id: "objects",
                      label: "Objects",
                      content: <Placeables />,
                    },
                    { id: "scene", label: "Scene", content: <Outliner /> },
                  ]}
                />
              </Pane>
            </Split>
          </Pane>
          <Pane>
            <Split id="center" direction="column">
              <Pane>
                <Viewport
                  id="level"
                  view="front"
                  label="Level"
                  shading="lit"
                  background={[0.3, 0.42, 0.62, 1]}
                  tools={tools}
                  overlay={pixelGrid}
                  hideEntity={isHud}
                  frameOnOpen={startView}
                  diagnostics
                />
              </Pane>
              <Pane size={210} min={90}>
                <Split id="lower">
                  <Pane>
                    <Viewport id="game" view="game" label="Game" />
                  </Pane>
                  <Pane size={420} min={200}>
                    <Panel
                      id="bottom"
                      tabs={[
                        {
                          id: "timeline",
                          label: "Timeline",
                          content: <Timeline />,
                        },
                        {
                          id: "console",
                          label: "Console",
                          content: <Console />,
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
            </Split>
          </Pane>
          <Pane size={310} min={240}>
            <Panel title="Inspector">
              <Inspector />
            </Panel>
          </Pane>
        </Split>
      </Workspace>
    </InkApp>
  );
}

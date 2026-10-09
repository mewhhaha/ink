/** Panels for tile editing: the tileset palette, layers and a toolbar. */
import { type ReactElement, useEffect, useRef, useState } from "react";
import type { AtlasInfo } from "@ink/schema";
import {
  Group,
  Icon,
  jsonEqual,
  ToolPicker,
  useInk,
  useSession,
  useSessionValue,
  useUi,
  type ViewportTool,
} from "@ink/react";
import { resizeCells } from "./edit.ts";
import { chooseLayer, tileBrush, useTileBrush } from "./state.ts";

const FLAG_BADGES: [number, string, string][] = [
  [1, "S", "solid"],
  [2, "O", "one-way"],
  [4, "L", "ladder"],
  [8, "!", "hazard"],
];

/** The atlas path of the layer the tools edit. */
function useActiveTileset() {
  const brush = useTileBrush();
  return useSessionValue((s) => {
    const map = chooseLayer(s.world.entities, s.selection, brush.layer);
    const index = Number(map?.components.tilemap.tileset) - 1;
    const path = s.catalog.assets.atlas?.[index];
    return path ? { path, info: s.catalog.atlases?.[path] } : null;
  }, jsonEqual);
}

/** An atlas image, reloaded when its file changes. */
function useImage(path: string | undefined): HTMLImageElement | null {
  const ink = useInk();
  const [revision, setRevision] = useState(0);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(
    () =>
      ink.dev?.client.on("ink:asset", (event) => {
        if (event.path === path) setRevision((r) => r + 1);
      }),
    [ink, path],
  );
  useEffect(() => {
    if (!path) return setImage(null);
    const next = new Image();
    next.onload = () => setImage(next);
    next.src = ink.dev?.client.assetUrl(path, revision) ??
      `/__ink/assets/${path}?v=${revision}`;
  }, [ink, path, revision]);
  return image;
}

function Thumb(
  { image, rect, size }: {
    image: HTMLImageElement | null;
    rect: AtlasInfo["rects"][number];
    size: number;
  },
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current?.getContext("2d");
    if (!c || !image) return;
    c.clearRect(0, 0, size, size);
    c.imageSmoothingEnabled = false;
    const scale = Math.min(size / rect[2], size / rect[3]);
    c.drawImage(
      image,
      rect[0],
      rect[1],
      rect[2],
      rect[3],
      0,
      0,
      rect[2] * scale,
      rect[3] * scale,
    );
  }, [image, rect, size]);
  return (
    <canvas
      ref={canvas}
      width={size}
      height={size}
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}

/** The tileset of the active layer: click a tile to paint with it. */
export function TilePalette(
  { size = 40, columns }: { size?: number; columns?: number },
): ReactElement {
  const active = useActiveTileset();
  const brush = useTileBrush();
  const image = useImage(active?.info?.image);
  // Start with something paintable: the first solid tile of the set.
  const info0 = active?.info;
  useEffect(() => {
    if (!info0 || tileBrush.get().tile) return;
    const first = info0.tiles.findIndex((flags, i) =>
      i > 0 && (flags & 1) !== 0
    );
    tileBrush.set({ tile: first > 0 ? first : 1 });
  }, [info0]);
  if (!active?.info) {
    return (
      <div className="ink-empty">
        The active layer has no tileset. Pick an atlas in its inspector.
      </div>
    );
  }
  const { info } = active;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "6px 8px",
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <label
          title="Pick matching edge and corner tiles automatically"
          style={{ display: "flex", gap: 4, alignItems: "center" }}
        >
          <input
            type="checkbox"
            checked={brush.auto}
            onChange={(e) => tileBrush.set({ auto: e.target.checked })}
          />
          Auto-tile
        </label>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          Brush
          <select
            className="ink-input"
            value={brush.size}
            onChange={(e) => tileBrush.set({ size: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}×{n}
            </option>)}
          </select>
        </label>
        <span style={{ marginLeft: "auto", color: "var(--ink-muted)" }}>
          {brush.tile ? info.frames[brush.tile - 1] : "empty"}
        </span>
      </div>
      <div
        data-testid="tile-palette"
        style={{
          overflow: "auto",
          flex: 1,
          display: "grid",
          gridTemplateColumns: columns
            ? `repeat(${columns}, ${size}px)`
            : `repeat(auto-fill, ${size}px)`,
          gap: 3,
          padding: 8,
          alignContent: "start",
        }}
      >
        <button
          type="button"
          data-tile={0}
          aria-pressed={brush.tile === 0}
          title="Empty: paint it to clear tiles"
          onClick={() => tileBrush.set({ tile: 0 })}
          style={{
            width: size,
            height: size,
            padding: 0,
            border: brush.tile === 0
              ? "2px solid var(--ink-accent)"
              : "1px dashed var(--ink-border-strong)",
            borderRadius: 4,
            background: "transparent",
            color: "var(--ink-muted)",
            cursor: "pointer",
          }}
        >
          <Icon name="x" />
        </button>
        {info.frames.map((name, i) => {
          const flags = info.tiles[i + 1] ?? 0;
          const selected = brush.tile === i + 1;
          return (
            <button
              type="button"
              key={name}
              data-tile={i + 1}
              aria-pressed={selected}
              title={`${name}${
                FLAG_BADGES.filter(([bit]) => flags & bit).map(([, , label]) =>
                  ` · ${label}`
                ).join("")
              }`}
              onClick={() => tileBrush.set({ tile: i + 1 })}
              style={{
                position: "relative",
                width: size,
                height: size,
                padding: 0,
                border: selected
                  ? "2px solid var(--ink-accent)"
                  : "1px solid var(--ink-border)",
                borderRadius: 4,
                background:
                  "repeating-conic-gradient(#2a2d36 0% 25%, #343845 0% 50%) 0 0 / 8px 8px",
                cursor: "pointer",
              }}
            >
              <Thumb image={image} rect={info.rects[i]} size={size - 4} />
              {FLAG_BADGES.filter(([bit]) => flags & bit).map((
                [bit, badge],
              ) => (
                <span
                  key={bit}
                  style={{
                    position: "absolute",
                    right: 1,
                    bottom: 0,
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#fff",
                    textShadow: "0 0 2px #000, 0 0 2px #000",
                  }}
                >
                  {badge}
                </span>
              ))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The tile map layers: choose which one the tools edit, hide layers, add
 * one, or resize the active map. */
export function TileLayers(): ReactElement {
  const ink = useInk();
  const session = useSession();
  const brush = useTileBrush();
  const hidden = useUi((u) => u.hidden);
  const layers = useSessionValue(
    (s) =>
      s.world.entities.filter((e) => e.components.tilemap).map((e) => {
        const t = e.components.tilemap;
        return {
          id: e.id,
          name: s.nameOf(e.id),
          layer: Number(t.layer),
          width: Number(t.width),
          height: Number(t.height),
          tileset: Number(t.tileset),
        };
      }),
    jsonEqual,
  );
  const chosen = useSessionValue((s) =>
    chooseLayer(s.world.entities, s.selection, brush.layer)?.id
  );
  const active = layers.find((l) => l.id === chosen);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const shown = size[0] > 0 ? size : [active?.width ?? 0, active?.height ?? 0];
  useEffect(() => setSize([0, 0]), [active?.id]);
  const toggle = (id: number) =>
    ink.ui.set({
      hidden: hidden.includes(id)
        ? hidden.filter((h) => h !== id)
        : [...hidden, id],
    });
  const addLayer = () => {
    const id = session.createEntity({
      name: "Layer",
      components: {
        transform: { position: [0, 0, 0] },
        tilemap: {
          tileset: session.catalog.assets.atlas?.[(active?.tileset ?? 1) - 1],
          width: active?.width ?? 32,
          height: active?.height ?? 16,
          layer: Math.max(0, ...layers.map((l) => l.layer)) + 1,
        },
      },
    });
    tileBrush.set({ layer: id });
  };
  const resize = () => {
    if (!active) return;
    const [width, height] = [
      Math.max(1, Math.min(1024, Math.round(shown[0]))),
      Math.max(1, Math.min(1024, Math.round(shown[1]))),
    ];
    session.edit("Resize tile map", (world) => {
      const t = world.entities.find((e) => e.id === active.id)?.components
        .tilemap;
      if (!t) return;
      t.cells = resizeCells(
        {
          width: Number(t.width),
          height: Number(t.height),
          cells: t.cells as number[],
        },
        width,
        height,
      );
      t.width = width;
      t.height = height;
    });
  };
  return (
    <div
      style={{ padding: 6, display: "flex", flexDirection: "column", gap: 4 }}
    >
      {layers.length === 0 && (
        <div className="ink-empty">No tile map yet. Add a layer.</div>
      )}
      {[...layers].sort((a, b) => b.layer - a.layer).map((l) => (
        <div
          key={l.id}
          data-layer={l.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 6px",
            borderRadius: 6,
            background: active?.id === l.id
              ? "var(--ink-accent-soft)"
              : undefined,
            cursor: "pointer",
          }}
          onClick={() => {
            tileBrush.set({ layer: l.id });
            session.select([l.id]);
          }}
        >
          <button
            type="button"
            className="ink-button"
            aria-pressed={!hidden.includes(l.id)}
            title={hidden.includes(l.id) ? "Show layer" : "Hide layer"}
            onClick={(e) => {
              e.stopPropagation();
              toggle(l.id);
            }}
          >
            <Icon name="eye" />
          </button>
          <span style={{ flex: 1 }}>{l.name}</span>
          <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>
            z {l.layer} · {l.width}×{l.height}
          </span>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button type="button" className="ink-button" onClick={addLayer}>
          <Icon name="plus" /> Layer
        </button>
        {active && (
          <>
            <input
              className="ink-input"
              aria-label="Map width"
              style={{ width: 52 }}
              type="number"
              value={shown[0]}
              onChange={(e) => setSize([Number(e.target.value), shown[1]])}
              onKeyDown={(e) => e.stopPropagation()}
            />
            ×
            <input
              className="ink-input"
              aria-label="Map height"
              style={{ width: 52 }}
              type="number"
              value={shown[1]}
              onChange={(e) => setSize([shown[0], Number(e.target.value)])}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button type="button" className="ink-button" onClick={resize}>
              Resize
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const HINTS: Record<string, string> = {
  "tile-paint":
    "Drag to paint · Shift+click draws lines · Alt+click picks a tile",
  "tile-erase": "Drag to erase",
  "tile-rect": "Drag a rectangle · Shift draws the outline only · Esc cancels",
  "tile-fill": "Click to flood fill the connected tiles",
  "tile-pick": "Click a tile to use it as the brush",
};

/** A one-line hint for the active tile tool. */
export function TileHint(): ReactElement | null {
  const tool = useUi((u) => u.tool) as string;
  const hint = HINTS[tool];
  return hint ? <span className="ink-status">{hint}</span> : null;
}

export function TileToolbar(
  { tools }: { tools: ViewportTool[] },
): ReactElement {
  return (
    <Group>
      <ToolPicker tools={tools} builtins={false} />
    </Group>
  );
}

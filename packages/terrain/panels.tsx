/** Panels for terrain editing: the toolbar, brush settings, layer picker,
 * target and collision grid status, and the forms that make new assets. */
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Checkbox,
  Group,
  Icon,
  jsonEqual,
  NumberInput,
  ToolPicker,
  useInk,
  useRenderer,
  useSession,
  useSessionValue,
  useStore,
  useUi,
  type ViewportTool,
} from "@ink/react";
import type { Session } from "@ink/core";
import type { TerrainResource } from "@ink/render";
import { hasComponent } from "@ink/schema";
import { type FalloffShape, falloffShapes } from "./sculpt.ts";
import {
  heightPerDab,
  terrainBrush,
  terrainTargets,
  useTerrainBrush,
} from "./state.ts";
import { TerrainSync } from "./sync.tsx";
import { terrainHint } from "./tools.ts";
import { createScatter, createTerrain, layerNames } from "./create.ts";
import { rebuildCollisionGrids } from "./edit.ts";
import { gridState } from "./grid.ts";

// Reading the targets -----------------------------------------------------------

interface LayerInfo {
  albedo: string | undefined;
  color: [number, number, number, number];
}

interface TerrainInfo {
  entity: number;
  name: string;
  path: string;
  revision: number;
  size: number;
  heightScale: number;
  layers: LayerInfo[];
  collisionCells: number;
  gridLength: number;
}

interface TargetInfo {
  terrains: { entity: number; name: string }[];
  scatters: { entity: number; name: string }[];
  /** The terrain the panel describes: pinned, selected, else the first. */
  terrain: TerrainInfo | null;
}

function targetInfo(session: Session, pinned: number): TargetInfo {
  const all = session.world.entities;
  const terrains = all.filter((e) => hasComponent(e, "terrain")).map((e) => ({
    entity: e.id,
    name: session.nameOf(e.id),
  }));
  const scatters = all.filter((e) => hasComponent(e, "scatter")).map((e) => ({
    entity: e.id,
    name: session.nameOf(e.id),
  }));
  const id = terrains.find((t) => t.entity === pinned)?.entity ??
    terrains.find((t) => session.selection.includes(t.entity))?.entity ??
    terrains[0]?.entity;
  const t = id === undefined
    ? undefined
    : session.entity(id)?.components.terrain;
  let terrain: TerrainInfo | null = null;
  if (t && id !== undefined) {
    const path = session.catalog.assets.terrain?.[Number(t.heightmap) - 1];
    if (path) {
      const textures = session.catalog.assets.texture;
      terrain = {
        entity: id,
        name: session.nameOf(id),
        path,
        revision: Number(t.revision) || 0,
        size: Number(t.size) || 2048,
        heightScale: Number(t.height_scale) || 1,
        collisionCells: Number(t.collision_cells) || 128,
        gridLength: Array.isArray(t.grid) ? t.grid.length : 0,
        layers: ((t.layers as Record<string, unknown>[]) ?? []).map((l) => ({
          albedo: textures[Number(l.albedo) - 1],
          color: (l.color as [number, number, number, number]) ?? [1, 1, 1, 1],
        })),
      };
    }
  }
  return { terrains, scatters, terrain };
}

/** A running game changes the world every step: look at it now and then. */
const lastInfo = new WeakMap<Session, TargetInfo>();
function readTargets(session: Session, pinned: number): TargetInfo {
  const cached = lastInfo.get(session);
  if (cached && session.mode === "play" && !session.paused) return cached;
  const info = targetInfo(session, pinned);
  lastInfo.set(session, info);
  return info;
}

function useTargets(): TargetInfo {
  const pinned = useStore(terrainTargets, (t) => t.terrain);
  const select = useCallback((s: Session) => readTargets(s, pinned), [pinned]);
  return useSessionValue(select, jsonEqual);
}

/** Re-render when a resource's data or state changes. */
function useChanges(resource: TerrainResource | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!resource) return;
    const bump = () => tick((n) => n + 1);
    const off = [resource.onState(bump), resource.onChange(bump)];
    return () => off.forEach((f) => f());
  }, [resource]);
}

// Small pieces ------------------------------------------------------------------

function Section(
  { title, children }: { title: string; children: ReactNode },
): ReactElement {
  return (
    <section className="ink-section">
      <div className="ink-section-head">
        <span>{title}</span>
      </div>
      <div className="ink-section-body">{children}</div>
    </section>
  );
}

function Row(
  { label, children, title }: {
    label: string;
    children: ReactNode;
    title?: string;
  },
): ReactElement {
  return (
    <>
      <span className="ink-field-label" title={title}>{label}</span>
      <div>{children}</div>
    </>
  );
}

function Num(
  props: {
    value: number;
    onChange(v: number): void;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    integer?: boolean;
  },
): ReactElement {
  return (
    <NumberInput
      value={props.value}
      step={props.step}
      min={props.min}
      max={props.max}
      unit={props.unit}
      integer={props.integer}
      onChange={(v) => props.onChange(v)}
    />
  );
}

// Toolbar and hint --------------------------------------------------------------

/** The terrain tools as toolbar buttons, and the sync that saves edits and
 * follows undo (`<TerrainSync />`). */
export function TerrainToolbar(
  { tools }: { tools: ViewportTool[] },
): ReactElement {
  return (
    <Group>
      <ToolPicker tools={tools} builtins={false} />
      <TerrainSync />
    </Group>
  );
}

/** A line of help for the active terrain tool. */
export function TerrainHint(): ReactElement | null {
  const tool = useUi((u) => u.tool) as string;
  const hint = terrainHint(tool);
  return hint ? <span className="ink-status">{hint}</span> : null;
}

// Brush settings ----------------------------------------------------------------

function Swatch(
  { layer, selected, index, onPick }: {
    layer: LayerInfo;
    selected: boolean;
    index: number;
    onPick(): void;
  },
): ReactElement {
  const ink = useInk();
  const [src, setSrc] = useState<string | null>(null);
  const albedo = layer.albedo;
  useEffect(() => {
    setSrc(null);
    const client = ink.dev?.client;
    if (!client || !albedo || albedo.startsWith("builtin:")) return;
    let alive = true;
    let url: string | undefined;
    (async () => {
      for (let attempt = 0; attempt < 4 && alive; attempt++) {
        try {
          const status = (await client.imports()).find((s) =>
            s.path === albedo
          );
          if (status) {
            const response = await fetch(
              client.thumbnailUrl(albedo, "asset", status.source),
            );
            if (response.ok) {
              url = URL.createObjectURL(await response.blob());
              if (alive) setSrc(url);
              return;
            }
          }
        } catch { /* try again, then keep the colour */ }
        await new Promise((r) => setTimeout(r, 600));
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ink, albedo]);
  const [r, g, b] = layer.color.map((v) => Math.round(v * 255));
  return (
    <button
      type="button"
      className="ink-button"
      data-testid={`terrain-layer-${index}`}
      aria-pressed={selected}
      title={`${layerNames[index] ?? `Layer ${index + 1}`}${
        albedo ? `\n${albedo}` : ""
      }`}
      onClick={onPick}
      style={{
        width: 44,
        height: 44,
        padding: 0,
        flexDirection: "column",
        border: selected
          ? "2px solid var(--ink-accent)"
          : "1px solid var(--ink-border-strong)",
        borderRadius: 6,
        overflow: "hidden",
        background: `rgb(${r} ${g} ${b})`,
        backgroundImage: src ? `url(${src})` : undefined,
        backgroundSize: "cover",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 2,
          bottom: 1,
          fontSize: 10,
          color: "#fff",
          textShadow: "0 0 3px #000, 0 0 2px #000",
        }}
      >
        {index + 1}
      </span>
    </button>
  );
}

/** The brush settings for the active terrain tool, the target terrain with
 * its collision grid status, the layer picker and the scatter settings. */
export function TerrainBrushPanel(): ReactElement {
  const ink = useInk();
  const brush = useTerrainBrush();
  const tool = useUi((u) => u.tool) as string;
  const targets = useTargets();
  const set = terrainBrush.set;
  const sculpting = tool.startsWith("terrain-");
  const kind = tool.replace(/^terrain-/, "");
  const scattering = tool === "scatter-paint";
  const terrain = targets.terrain;
  return (
    <div className="ink-inspector" data-testid="terrain-panel">
      <TerrainStatus targets={targets} />
      <Section title="Brush">
        <Row label="Radius" title="Brush size in metres ([ and ] resize)">
          <Num
            value={brush.radius}
            min={0.5}
            max={1000}
            step={0.5}
            unit="m"
            onChange={(radius) => set({ radius })}
          />
        </Row>
        {!scattering && (
          <Row
            label="Strength"
            title={sculpting &&
                (kind === "raise" || kind === "lower" || kind === "noise")
              ? `About ${heightPerDab(brush).toFixed(2)} m per dab`
              : "How much each dab blends toward its goal"}
          >
            <Num
              value={brush.strength}
              min={0.01}
              max={1}
              step={0.01}
              onChange={(strength) => set({ strength })}
            />
          </Row>
        )}
        <Row label="Falloff">
          <select
            className="ink-input"
            value={brush.falloff}
            onChange={(e) => set({ falloff: e.target.value as FalloffShape })}
          >
            {falloffShapes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Row>
        <Row label="Hardness" title="Fraction of the radius at full strength">
          <Num
            value={brush.hardness}
            min={0}
            max={0.95}
            step={0.05}
            onChange={(hardness) => set({ hardness })}
          />
        </Row>
        <Row
          label="Spacing"
          title="Distance between dabs, as a fraction of the radius"
        >
          <Num
            value={brush.spacing}
            min={0.02}
            max={1}
            step={0.01}
            onChange={(spacing) => set({ spacing })}
          />
        </Row>
        {!scattering && (
          <Row
            label="Airbrush"
            title="Keep applying dabs while the button is held still"
          >
            <Checkbox
              checked={brush.airbrush}
              onChange={(airbrush) => set({ airbrush })}
            />
          </Row>
        )}
      </Section>

      {sculpting && kind === "flatten" && (
        <Section title="Flatten">
          <Row label="Level">
            <select
              className="ink-input"
              value={brush.flatten}
              onChange={(e) =>
                set({ flatten: e.target.value as "start" | "level" })}
            >
              <option value="start">where the stroke begins</option>
              <option value="level">a fixed height</option>
            </select>
          </Row>
          {brush.flatten === "level" && (
            <Row label="Height" title="Ctrl+click on the terrain samples it">
              <Num
                value={brush.level}
                step={0.5}
                unit="m"
                onChange={(level) =>
                  set({ level })}
              />
            </Row>
          )}
        </Section>
      )}

      {sculpting && kind === "noise" && (
        <Section title="Relief">
          <Row label="Scale" title="Wavelength of the first octave">
            <Num
              value={brush.noiseScale}
              min={1}
              max={2000}
              step={1}
              unit="m"
              onChange={(noiseScale) => set({ noiseScale })}
            />
          </Row>
          <Row label="Octaves">
            <Num
              value={brush.noiseOctaves}
              min={1}
              max={6}
              integer
              onChange={(noiseOctaves) => set({ noiseOctaves })}
            />
          </Row>
          <Row label="Seed">
            <Num
              value={brush.noiseSeed}
              min={0}
              integer
              onChange={(noiseSeed) => set({ noiseSeed })}
            />
          </Row>
        </Section>
      )}

      {terrain && sculpting && (
        <Section title="Layers">
          <div
            className="ink-field-wide"
            style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
          >
            {terrain.layers.length === 0 && (
              <span className="ink-empty">
                This terrain has no layers yet. Add some in its inspector.
              </span>
            )}
            {terrain.layers.map((layer, i) => (
              <Swatch
                key={i}
                index={i}
                layer={layer}
                selected={brush.layer === i}
                onPick={() => {
                  set({ layer: i });
                  // Choosing a layer means to paint it.
                  ink.ui.set({ tool: "terrain-paint" as never });
                }}
              />
            ))}
          </div>
        </Section>
      )}

      {scattering && (
        <Section title="Scatter">
          <Row label="Layer">
            <select
              className="ink-input"
              value={terrainTargets.get().scatter}
              onChange={(e) =>
                terrainTargets.set({ scatter: Number(e.target.value) })}
            >
              <option value={0}>selected, else first</option>
              {targets.scatters.map((s) => (
                <option key={s.entity} value={s.entity}>{s.name}</option>
              ))}
            </select>
          </Row>
          <Row label="Density" title="Instances per 100 square metres">
            <Num
              value={brush.density}
              min={0.1}
              max={400}
              step={0.5}
              onChange={(density) => set({ density })}
            />
          </Row>
          <Row label="Spacing" title="No two instances closer than this">
            <Num
              value={brush.minSpacing}
              min={0}
              step={0.25}
              unit="m"
              onChange={(minSpacing) => set({ minSpacing })}
            />
          </Row>
          <Row label="Scale">
            <div className="ink-vector">
              <Num
                value={brush.scaleMin}
                min={0.05}
                step={0.05}
                onChange={(scaleMin) => set({ scaleMin })}
              />
              <Num
                value={brush.scaleMax}
                min={0.05}
                step={0.05}
                onChange={(scaleMax) => set({ scaleMax })}
              />
            </div>
          </Row>
          <Row label="Tint">
            <div className="ink-vector">
              <Num
                value={brush.tintMin}
                min={0}
                max={1}
                step={0.05}
                onChange={(tintMin) => set({ tintMin })}
              />
              <Num
                value={brush.tintMax}
                min={0}
                max={1}
                step={0.05}
                onChange={(tintMax) => set({ tintMax })}
              />
            </div>
          </Row>
          <Row
            label="Max slope"
            title="Skip ground steeper than this (0 = no limit)"
          >
            <Num
              value={brush.maxSlope}
              min={0}
              max={90}
              step={1}
              unit="°"
              onChange={(maxSlope) => set({ maxSlope })}
            />
          </Row>
          <Row label="Lift" title="Height above the ground">
            <Num
              value={brush.lift}
              step={0.05}
              unit="m"
              onChange={(lift) => set({ lift })}
            />
          </Row>
          <Row label="Seed" title="Another seed grows another forest">
            <Num
              value={brush.seed}
              min={0}
              integer
              onChange={(seed) => set({ seed })}
            />
          </Row>
          <Row label="Erase" title="Remove instances instead (Ctrl swaps)">
            <Checkbox
              checked={brush.erase}
              onChange={(erase) => set({ erase })}
            />
          </Row>
        </Section>
      )}
    </div>
  );
}

// Target and collision grid -----------------------------------------------------

function TerrainStatus({ targets }: { targets: TargetInfo }): ReactElement {
  const ink = useInk();
  const renderer = useRenderer();
  const terrain = targets.terrain;
  const resource = terrain && renderer
    ? renderer.assets.terrain(terrain.path)
    : undefined;
  useChanges(resource);
  const state = resource?.state;
  // Compare the grid with the heightmap when the scene is editable.
  const grid = useMemo(() => {
    const field = resource?.field;
    if (!terrain || !field) return null;
    const t = ink.session.entity(terrain.entity)?.components.terrain;
    return t ? gridState(t, field) : null;
  }, [
    ink.session,
    resource,
    resource?.field,
    resource?.revision,
    terrain?.entity,
    terrain?.size,
    terrain?.heightScale,
    terrain?.collisionCells,
    terrain?.gridLength,
    terrain?.revision,
  ]);
  const pinned = terrainTargets.get().terrain;
  return (
    <Section title="Terrain">
      {!terrain && (
        <div className="ink-section-description">
          No terrain in the scene. Make one below, or add a terrain component to
          an entity.
        </div>
      )}
      {terrain && (
        <>
          <Row label="Edit" title="The terrain the sculpt and paint tools edit">
            <select
              className="ink-input"
              value={pinned}
              onChange={(e) =>
                terrainTargets.set({ terrain: Number(e.target.value) })}
            >
              <option value={0}>selected, else hovered</option>
              {targets.terrains.map((t) => (
                <option key={t.entity} value={t.entity}>{t.name}</option>
              ))}
            </select>
          </Row>
          <Row label="Data">
            <span data-testid="terrain-state">
              {state === "ready"
                ? `${terrain.path} · revision ${resource?.revision ?? 0}`
                : state === "failed"
                ? `failed: ${resource?.error ?? "could not load"}`
                : `loading ${Math.round((resource?.progress ?? 0) * 100)}%`}
            </span>
          </Row>
          {grid && grid !== "ok" && (
            <>
              <div
                className="ink-section-description ink-field-wide"
                style={{ color: "var(--ink-danger)" }}
                data-testid="terrain-grid-warning"
              >
                {grid === "missing"
                  ? "The collision grid game code reads is empty or the wrong size."
                  : "The collision grid no longer matches the heightmap."}
              </div>
              <div className="ink-field-wide">
                <button
                  type="button"
                  className="ink-button"
                  data-variant="primary"
                  onClick={() => {
                    if (!renderer) return;
                    const n = rebuildCollisionGrids(
                      ink.session,
                      renderer.assets,
                      [terrain.entity],
                    );
                    if (n) {
                      ink.session.info("rebuilt the collision grid", "session");
                    }
                  }}
                >
                  <Icon name="mountain" /> Rebuild collision grid
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Section>
  );
}

// New assets --------------------------------------------------------------------

const CELLS = [128, 256, 512, 1024, 2048, 4096];
const COLLISION = [32, 64, 128, 256];

/** A form that makes a flat terrain file and an entity for it. */
export function NewTerrainForm(): ReactElement {
  const ink = useInk();
  const [name, setName] = useState("world");
  const [cells, setCells] = useState(1024);
  const [size, setSize] = useState(1024);
  const [layers, setLayers] = useState(4);
  const [collision, setCollision] = useState(128);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const make = async () => {
    setBusy(true);
    setError("");
    try {
      const id = await createTerrain(ink, {
        name,
        cells,
        size,
        layers,
        collisionCells: collision,
      });
      ink.session.select([id]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="New terrain">
      <Row label="Name">
        <input
          className="ink-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Row>
      <Row label="Samples" title="Height samples per side minus one">
        <select
          className="ink-input"
          value={cells}
          onChange={(e) => setCells(Number(e.target.value))}
        >
          {CELLS.map((c) => <option key={c} value={c}>{c} × {c}</option>)}
        </select>
      </Row>
      <Row label="Size">
        <Num
          value={size}
          min={16}
          max={20000}
          step={16}
          unit="m"
          onChange={setSize}
        />
      </Row>
      <Row label="Layers">
        <Num value={layers} min={1} max={8} integer onChange={setLayers} />
      </Row>
      <Row label="Collision" title="Cells per side of the grid game code reads">
        <select
          className="ink-input"
          value={collision}
          onChange={(e) => setCollision(Number(e.target.value))}
        >
          {COLLISION.map((c) => <option key={c} value={c}>{c} × {c}</option>)}
        </select>
      </Row>
      <div className="ink-field-wide">
        <button
          type="button"
          className="ink-button"
          data-variant="primary"
          disabled={busy || !ink.dev}
          onClick={make}
          data-testid="terrain-create"
        >
          <Icon name="mountain" /> {busy ? "Creating…" : "Create terrain"}
        </button>
      </div>
      {error && (
        <div
          className="ink-section-description ink-field-wide"
          style={{ color: "var(--ink-danger)" }}
        >
          {error}
        </div>
      )}
      <div className="ink-section-description">
        {(size / cells).toFixed(2)} m per height sample, {Math.round(
          ((cells + 1) ** 2 * 4 +
            Math.ceil(layers / 4) * (cells >> 1) ** 2 * 4) / 1e6,
        )} MB on disk.
      </div>
    </Section>
  );
}

/** A form that makes an empty placements file and a scatter entity. */
export function NewScatterForm(): ReactElement {
  const ink = useInk();
  const session = useSession();
  const meshes = useSessionValue((s) => s.catalog.assets.mesh, jsonEqual);
  const [name, setName] = useState("trees");
  const [mesh, setMesh] = useState("builtin:cone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const make = async () => {
    setBusy(true);
    setError("");
    try {
      session.select([await createScatter(ink, { name, mesh })]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="New instance layer">
      <Row label="Name">
        <input
          className="ink-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Row>
      <Row label="Mesh">
        <select
          className="ink-input"
          value={mesh}
          onChange={(e) => setMesh(e.target.value)}
        >
          {meshes.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Row>
      <div className="ink-field-wide">
        <button
          type="button"
          className="ink-button"
          data-variant="primary"
          disabled={busy || !ink.dev}
          onClick={make}
          data-testid="scatter-create"
        >
          <Icon name="tree" /> {busy ? "Creating…" : "Create layer"}
        </button>
      </div>
      {error && (
        <div
          className="ink-section-description ink-field-wide"
          style={{ color: "var(--ink-danger)" }}
        >
          {error}
        </div>
      )}
    </Section>
  );
}

/**
 * Viewport tools for terrain:
 *
 *   raise   (1)  drag to build ground up;   Ctrl lowers, Shift smooths
 *   lower   (2)  drag to dig;               Ctrl raises, Shift smooths
 *   smooth  (3)  drag to relax the ground
 *   flatten (4)  drag to level the ground to where the stroke began (or a
 *                fixed level); Ctrl+click samples the level
 *   noise   (5)  drag to add relief;        Ctrl digs, Shift smooths
 *   paint   (6)  drag to paint the chosen layer; Ctrl erases it
 *   scatter (7)  drag to place instances on the ground; Ctrl erases
 *
 * `[` and `]` change the brush radius, Shift with them the strength. Hold the
 * button still to keep building up (airbrush). Esc cancels the stroke.
 *
 * The ground under the pointer is found on the CPU (`raycastTerrain`). A drag
 * edits the data directly so the renderer shows it at once; when it ends one
 * session edit records the new revision, which makes the whole drag a single
 * undo step (see `edit.ts`, `stroke.ts`).
 */
import { terrainHeightAt, terrainNormalAt, type Vec3 } from "@ink/geometry";
import type { Line } from "@ink/render";
import type { PointerInfo, ViewportContext, ViewportTool } from "@ink/react";
import { commitScatter, commitTerrain } from "./edit.ts";
import {
  planAdd,
  planErase,
  type ScatterBrush,
  scatterCandidates,
} from "./scatter_brush.ts";
import { ScatterStroke } from "./scatter_stroke.ts";
import {
  type Dab,
  DabPath,
  dabSpacing,
  flatten,
  footprint,
  noiseRelief,
  paintLayer,
  raise,
  smooth,
} from "./sculpt.ts";
import {
  heightPerDab,
  scaleRadius,
  type TerrainBrush,
  terrainBrush,
} from "./state.ts";
import { StrokeRecorder } from "./stroke.ts";
import {
  hitTerrain,
  pickTerrain,
  readyTerrains,
  type ScatterTarget,
  scatterTarget,
  type TerrainTarget,
} from "./targets.ts";

export type SculptKind =
  | "raise"
  | "lower"
  | "smooth"
  | "flatten"
  | "noise"
  | "paint";

type Color = Line["color"];

const kinds: Record<SculptKind, {
  label: string;
  icon: string;
  shortcut: string;
  color: Color;
  hint: string;
}> = {
  raise: {
    label: "Raise ground",
    icon: "terrainRaise",
    shortcut: "1",
    color: [0.45, 0.95, 0.5, 0.95],
    hint: "Drag to raise · Ctrl lowers · Shift smooths · [ ] resize",
  },
  lower: {
    label: "Lower ground",
    icon: "terrainLower",
    shortcut: "2",
    color: [1, 0.62, 0.3, 0.95],
    hint: "Drag to dig · Ctrl raises · Shift smooths · [ ] resize",
  },
  smooth: {
    label: "Smooth ground",
    icon: "terrainSmooth",
    shortcut: "3",
    color: [0.5, 0.8, 1, 0.95],
    hint: "Drag to smooth · [ ] resize",
  },
  flatten: {
    label: "Flatten ground",
    icon: "terrainFlatten",
    shortcut: "4",
    color: [1, 0.9, 0.4, 0.95],
    hint: "Drag to level to where you began · Ctrl+click samples a fixed level",
  },
  noise: {
    label: "Add relief",
    icon: "terrainNoise",
    shortcut: "5",
    color: [0.8, 0.62, 1, 0.95],
    hint: "Drag to add noise relief · Ctrl digs · Shift smooths",
  },
  paint: {
    label: "Paint layer",
    icon: "terrainPaint",
    shortcut: "6",
    color: [1, 0.55, 0.8, 0.95],
    hint: "Drag to paint the chosen layer · Ctrl erases it",
  },
};

const SCATTER_HINT = "Drag to place instances · Ctrl erases · [ ] resize";
const SCATTER_ADD: Color = [0.4, 1, 0.6, 0.95];
const SCATTER_ERASE: Color = [1, 0.35, 0.3, 0.95];

/** The hint shown for a tool id, or undefined for other tools. */
export function terrainHint(tool: string): string | undefined {
  if (tool === "scatter-paint") return SCATTER_HINT;
  const kind = tool.replace(/^terrain-/, "") as SculptKind;
  return tool.startsWith("terrain-") ? kinds[kind]?.hint : undefined;
}

// Drawing -----------------------------------------------------------------------

const SEGMENTS = 96;

/** A circle of `radius` metres on the ground around (x, z), terrain-local. */
function ring(
  target: TerrainTarget,
  x: number,
  z: number,
  radius: number,
  color: Color,
  width = 2,
): Line[] {
  const lines: Line[] = [];
  const { field } = target.ground;
  const { params, origin } = target;
  const point = (angle: number): Vec3 => {
    const px = x + Math.cos(angle) * radius, pz = z + Math.sin(angle) * radius;
    // Beyond the edge the ground continues flat; keep the ring on it.
    const h = terrainHeightAt(field, params, px, pz);
    return [origin[0] + px, origin[1] + h + 0.12, origin[2] + pz];
  };
  let from = point(0);
  for (let i = 1; i <= SEGMENTS; i++) {
    const to = point((i / SEGMENTS) * Math.PI * 2);
    lines.push({ from, to, color, width });
    from = to;
  }
  return lines;
}

/** The brush cursor: the outer ring, the full-strength ring, a stem. */
function cursor(
  target: TerrainTarget,
  x: number,
  z: number,
  brush: TerrainBrush,
  color: Color,
): Line[] {
  const lines = ring(target, x, z, brush.radius, color);
  if (brush.hardness > 0.05 && brush.hardness < 0.95) {
    lines.push(
      ...ring(
        target,
        x,
        z,
        brush.radius * brush.hardness,
        [color[0], color[1], color[2], 0.45],
        1,
      ),
    );
  }
  const h = terrainHeightAt(target.ground.field, target.params, x, z);
  const base: Vec3 = [
    target.origin[0] + x,
    target.origin[1] + h,
    target.origin[2] + z,
  ];
  lines.push({
    from: base,
    to: [base[0], base[1] + Math.max(1.5, brush.radius * 0.15), base[2]],
    color,
    width: 2,
  });
  return lines;
}

const kernelFor = (radius: number, cell: number) =>
  Math.max(1, Math.min(8, Math.round(radius / cell * 0.1)));

// Sculpt tools ------------------------------------------------------------------

interface Stroke {
  target: TerrainTarget;
  recorder: StrokeRecorder;
  path: DabPath;
  /** The data's revision when the stroke began. */
  start: number;
  kind: SculptKind;
  invert: boolean;
  /** Flatten level, field units. */
  level: number;
  last: [number, number];
  moved: boolean;
  /** Airbrush ticks since the pointer last moved. */
  idle: number;
  timer?: ReturnType<typeof setInterval>;
  label: string;
}

const AIRBRUSH_HZ = 8;

/** Whether the primary button is still held, as the pointer event reports
 * it (an event without the information counts as held). */
const buttonDown = (e: PointerInfo) => {
  const buttons = (e.event as { buttons?: number }).buttons;
  return buttons === undefined || (buttons & 1) !== 0;
};

function applyDab(s: Stroke, x: number, z: number) {
  const brush = terrainBrush.get();
  const { ground, params, resource } = s.target;
  const dab: Dab = {
    x,
    z,
    radius: brush.radius,
    falloff: { shape: brush.falloff, hardness: brush.hardness },
  };
  const paints = s.kind === "paint";
  const fp = footprint(ground, dab, paints);
  if (!fp.rect && !fp.splatRect) return;
  s.recorder.prepare(fp);
  // Amounts are world metres; the field stores metres before `height_scale`.
  const metres = heightPerDab(brush) / (params.heightScale || 1);
  const sign = s.invert ? -1 : 1;
  switch (s.kind) {
    case "raise":
      raise(ground, dab, metres * sign);
      break;
    case "lower":
      raise(ground, dab, -metres * sign);
      break;
    case "smooth":
      smooth(
        ground,
        dab,
        brush.strength,
        kernelFor(brush.radius, ground.size / ground.field.cells),
      );
      break;
    case "flatten":
      flatten(ground, dab, s.level, brush.strength);
      break;
    case "noise":
      noiseRelief(ground, dab, {
        seed: brush.noiseSeed,
        scale: brush.noiseScale,
        octaves: brush.noiseOctaves,
        metres: metres * sign,
      });
      break;
    case "paint":
      paintLayer(ground, dab, brush.layer, brush.strength, s.invert);
      break;
  }
  if (fp.rect) {
    resource.markDirty(fp.rect);
  } else if (fp.splatRect) {
    // Painting changes no heights: a one-sample rectangle stands in.
    const k = ground.field.cells / ground.field.splatCells;
    const x0 = Math.floor(fp.splatRect.x0 * k),
      z0 = Math.floor(fp.splatRect.z0 * k);
    resource.markDirty({ x0, z0, x1: x0 + 1, z1: z0 + 1 }, fp.splatRect);
  }
}

/** The stored height (before `height_scale`) under a terrain-local point. */
function baseHeight(target: TerrainTarget, x: number, z: number): number {
  const { field } = target.ground;
  const cell = target.ground.size / field.cells, half = target.ground.size / 2;
  return field.sampleCell((x + half) / cell, (z + half) / cell);
}

function sculptTool(base: SculptKind): ViewportTool {
  const info = kinds[base];
  let stroke: Stroke | null = null;
  let hover: { x: number; y: number } | null = null;

  const end = (
    ctx: { session: ViewportContext["session"]; redraw(): void },
  ) => {
    const s = stroke;
    if (!s) return;
    stroke = null;
    clearInterval(s.timer);
    const done = s.recorder.finish();
    if (done) {
      commitTerrain(
        ctx.session,
        s.target.entity,
        s.target.resource,
        done,
        s.start,
        s.label,
      );
    }
    ctx.redraw();
  };

  const continueStroke = (ctx: ViewportContext, e: PointerInfo) => {
    const s = stroke!;
    const hit = hitTerrain(ctx, s.target, e);
    if (!hit) return;
    s.last = [hit.x, hit.z];
    for (const [x, z] of s.path.move(hit.x, hit.z)) applyDab(s, x, z);
    s.moved = true;
  };

  return {
    id: `terrain-${base}`,
    label: info.label,
    icon: info.icon,
    shortcut: info.shortcut,
    cursor: "crosshair",
    noGizmo: true,
    pointerDown(ctx, e) {
      if (e.button !== 0) return false;
      end(ctx);
      const picked = pickTerrain(ctx, ctx.ray(e.x, e.y));
      if (!picked) return false;
      const { target, hit } = picked;
      const brush = terrainBrush.get();
      if (base === "flatten" && e.ctrl) {
        // Sample the level under the pointer instead of editing.
        terrainBrush.set({
          flatten: "level",
          level: baseHeight(target, hit.x, hit.z) * target.params.heightScale,
        });
        ctx.redraw();
        return true;
      }
      let kind: SculptKind = base;
      if (e.shift && base !== "smooth" && base !== "paint") kind = "smooth";
      const cell = target.ground.size / target.ground.field.cells;
      const s: Stroke = stroke = {
        target,
        recorder: new StrokeRecorder(target.resource),
        path: new DabPath(dabSpacing(brush.radius, brush.spacing, cell)),
        start: target.resource.revision,
        kind,
        invert: e.ctrl && kind !== "smooth",
        level: brush.flatten === "level"
          ? brush.level / (target.params.heightScale || 1)
          : baseHeight(target, hit.x, hit.z),
        last: [hit.x, hit.z],
        moved: true,
        idle: 0,
        label: kinds[
          kind === "raise" && e.ctrl
            ? "lower"
            : kind === "lower" && e.ctrl
            ? "raise"
            : kind
        ].label,
      };
      for (const [x, z] of s.path.start(hit.x, hit.z)) applyDab(s, x, z);
      if (brush.airbrush) {
        s.timer = setInterval(() => {
          if (stroke !== s) return;
          // Held still for a quarter of a minute: the release was lost.
          if (!s.moved && ++s.idle > AIRBRUSH_HZ * 15) return end(ctx);
          if (s.moved) s.idle = 0;
          else applyDab(s, s.last[0], s.last[1]);
          s.moved = false;
          ctx.redraw();
        }, 1000 / AIRBRUSH_HZ);
      }
      ctx.redraw();
      return true;
    },
    pointerMove(ctx, e, dragging) {
      hover = { x: e.x, y: e.y };
      // The button was let go where this page could not see it.
      if (stroke && !buttonDown(e)) end(ctx);
      else if (dragging && stroke) continueStroke(ctx, e);
      ctx.redraw();
    },
    pointerUp(ctx) {
      end(ctx);
    },
    keyDown(ctx, e) {
      if (e.key === "Escape" && stroke) {
        clearInterval(stroke.timer);
        stroke.recorder.revert();
        stroke = null;
        ctx.redraw();
        return true;
      }
      return brushKeys(e);
    },
    overlay(ctx) {
      if (!hover) return [];
      const picked = stroke
        ? { target: stroke.target, hit: hitTerrain(ctx, stroke.target, hover) }
        : pickTerrain(ctx, ctx.ray(hover.x, hover.y));
      if (!picked?.hit) return [];
      const brush = terrainBrush.get();
      const color = base === "paint"
        ? paintColor(picked.target, brush.layer, info.color)
        : info.color;
      return cursor(picked.target, picked.hit.x, picked.hit.z, brush, color);
    },
  };
}

function paintColor(
  target: TerrainTarget,
  layer: number,
  fallback: Color,
): Color {
  const c = target.draw.layers[layer]?.color;
  return c ? [c[0], c[1], c[2], 1] : fallback;
}

/** `[` and `]` resize the brush; with Shift they change its strength. */
function brushKeys(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const smaller = e.code === "BracketLeft", larger = e.code === "BracketRight";
  if (!smaller && !larger) return false;
  if (e.shiftKey) {
    terrainBrush.set((b) => ({
      strength: Math.min(
        1,
        Math.max(0.02, b.strength + (larger ? 0.05 : -0.05)),
      ),
    }));
  } else scaleRadius(larger ? 1.15 : 1 / 1.15);
  return true;
}

// Scatter -----------------------------------------------------------------------

interface ScatterState {
  scatter: ScatterTarget;
  terrain: TerrainTarget;
  stroke: ScatterStroke;
  path: DabPath;
  start: number;
  erase: boolean;
}

function scatterDab(s: ScatterState, x: number, z: number) {
  const b = terrainBrush.get();
  const set = s.scatter.resource.set;
  if (!set) return;
  // Placements are relative to the scatter entity.
  const lx = x + s.terrain.origin[0] - s.scatter.origin[0];
  const lz = z + s.terrain.origin[2] - s.scatter.origin[2];
  const falloff = { shape: b.falloff, hardness: b.hardness };
  if (s.erase) {
    s.stroke.remove(planErase(set, lx, lz, b.radius, falloff, b.seed));
    return;
  }
  const brush: ScatterBrush = {
    seed: b.seed,
    density: b.density / 100,
    minSpacing: b.minSpacing,
    scale: [Math.min(b.scaleMin, b.scaleMax), Math.max(b.scaleMin, b.scaleMax)],
    tint: [Math.min(b.tintMin, b.tintMax), Math.max(b.tintMin, b.tintMax)],
  };
  const { ground, params, origin } = s.terrain;
  const half = ground.size / 2;
  s.stroke.add(planAdd(
    set,
    scatterCandidates(brush, lx, lz, b.radius, falloff),
    b.minSpacing,
    (p) => {
      // Back to the terrain's frame for the ground height and slope.
      const tx = p.x + s.scatter.origin[0] - origin[0];
      const tz = p.z + s.scatter.origin[2] - origin[2];
      if (Math.abs(tx) > half || Math.abs(tz) > half) return null;
      if (b.maxSlope > 0) {
        const normal = terrainNormalAt(ground.field, params, tx, tz);
        if (Math.acos(normal[1]) * 180 / Math.PI > b.maxSlope) return null;
      }
      const ground_ = terrainHeightAt(ground.field, params, tx, tz);
      const y = s.scatter.followTerrain
        ? b.lift
        : origin[1] + ground_ + b.lift - s.scatter.origin[1];
      return { ...p, y };
    },
  ));
}

function scatterTool(): ViewportTool {
  let state: ScatterState | null = null;
  let hover: { x: number; y: number } | null = null;

  /** The terrain the instances go on (the first one when they follow it)
   * and where the pointer meets it. */
  const ground = (
    ctx: ViewportContext,
    scatter: ScatterTarget,
    pointer: { x: number; y: number },
  ) => {
    const terrains = readyTerrains(ctx);
    let best:
      | { terrain: TerrainTarget; x: number; z: number; d: number }
      | null = null;
    for (
      const terrain of scatter.followTerrain ? terrains.slice(0, 1) : terrains
    ) {
      const hit = hitTerrain(ctx, terrain, pointer);
      if (hit && (!best || hit.distance < best.d)) {
        best = { terrain, x: hit.x, z: hit.z, d: hit.distance };
      }
    }
    return best;
  };

  const end = (ctx: ViewportContext) => {
    const s = state;
    if (!s) return;
    state = null;
    const revision = s.stroke.finish();
    if (revision !== null) {
      commitScatter(
        ctx.session,
        s.scatter.entity,
        s.scatter.resource,
        revision,
        s.start,
        s.erase ? "Erase instances" : "Paint instances",
      );
    }
    ctx.redraw();
  };

  return {
    id: "scatter-paint",
    label: "Paint instances",
    icon: "tree",
    shortcut: "7",
    cursor: "crosshair",
    noGizmo: true,
    pointerDown(ctx, e) {
      if (e.button !== 0) return false;
      end(ctx);
      const scatter = scatterTarget(ctx);
      if (!scatter?.resource.set) return false;
      const found = ground(ctx, scatter, e);
      if (!found) return false;
      const brush = terrainBrush.get();
      const s: ScatterState = state = {
        scatter,
        terrain: found.terrain,
        stroke: new ScatterStroke(scatter.resource),
        path: new DabPath(Math.max(0.5, brush.radius * brush.spacing)),
        start: scatter.resource.revision,
        erase: brush.erase !== e.ctrl,
      };
      for (const [x, z] of s.path.start(found.x, found.z)) scatterDab(s, x, z);
      ctx.redraw();
      return true;
    },
    pointerMove(ctx, e, dragging) {
      hover = { x: e.x, y: e.y };
      const s = state;
      if (s && !buttonDown(e)) end(ctx);
      else if (dragging && s) {
        const found = ground(ctx, s.scatter, e);
        if (found) {
          for (const [x, z] of s.path.move(found.x, found.z)) {
            scatterDab(s, x, z);
          }
        }
      }
      ctx.redraw();
    },
    pointerUp(ctx) {
      end(ctx);
    },
    keyDown(ctx, e) {
      if (e.key === "Escape" && state) {
        state.stroke.revert();
        state = null;
        ctx.redraw();
        return true;
      }
      return brushKeys(e);
    },
    overlay(ctx) {
      if (!hover) return [];
      const scatter = scatterTarget(ctx);
      if (!scatter) return [];
      const found = ground(ctx, scatter, hover);
      if (!found) return [];
      const brush = terrainBrush.get();
      const erase = state ? state.erase : brush.erase;
      return cursor(
        found.terrain,
        found.x,
        found.z,
        brush,
        erase ? SCATTER_ERASE : SCATTER_ADD,
      );
    },
  };
}

/** The terrain tools: raise, lower, smooth, flatten, noise and paint on the
 * ground, and the scatter brush. Pass them to `<Viewport tools={...}>`,
 * `<InkApp tools={...}>` and `<TerrainToolbar>`. */
export function createTerrainTools(): ViewportTool[] {
  return [
    ...(Object.keys(kinds) as SculptKind[]).map(sculptTool),
    scatterTool(),
  ];
}

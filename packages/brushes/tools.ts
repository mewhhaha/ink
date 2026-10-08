/**
 * Viewport tools for editing brush levels. `createBrushTools()` returns them
 * all; pass the result to `<Viewport tools>`, `<InkApp tools>` (hotkeys and the
 * palette) and `<BrushToolbar>`.
 *
 *   block (B)  drag a box in a view; its third dimension follows the last brush
 *   edit  (V)  in 2D views: drag handles to resize, drag inside to move
 *   clip  (X)  two points in 2D or three surface points in 3D, Tab keep sides,
 *              Enter applies, Escape cancels
 *   face  (T)  click faces in 3D to select them (Shift adds, Ctrl the whole brush)
 *   vertex (J) drag vertices or edge midpoints in any editor view
 *
 * Every drag is one session transaction, so it is a single undo step and works
 * on the live world while the game runs.
 */
import {
  type Aabb,
  brushEdges,
  brushPolygons,
  type Mat4,
  mat4,
  type Plane,
  type Vec3,
  vec3,
  type Vec4,
} from "@ink/geometry";
import type { Line } from "@ink/render";
import type { Session } from "@ink/core";
import type { EntityModel } from "@ink/schema";
import {
  type PointerInfo,
  stationaryBrushTextures,
  viewPlane,
  type ViewportContext,
  type ViewportTool,
} from "@ink/react";
import {
  type Axis,
  boxEdges,
  type BrushEntityData,
  brushWorldBounds,
  clipBrushEntity,
  clipPlaneThrough,
  dragBox,
  type EdgeMove,
  invertible,
  newBrushComponents,
  nextClipKeep,
  resizeBrush,
} from "./edit.ts";
import {
  type BrushDefaults,
  brushDefaults,
  clipState,
  faceSelection,
} from "./state.ts";
import { vertexTool } from "./vertex_tool.ts";

export interface BrushToolOptions {
  /** Entity name for new brushes. */
  name?: string;
  /** Extra components for new brushes (a `solid` tag, say). */
  components?: Record<string, unknown>;
  /** Where the defaults live; the texture browser writes here. */
  defaults?: typeof brushDefaults;
}

const ORANGE: Vec4 = [1, 0.62, 0.16, 1];
const CYAN: Vec4 = [0.3, 0.85, 1, 1];
const GREEN: Vec4 = [0.35, 0.95, 0.45, 1];
const RED: Vec4 = [1, 0.35, 0.3, 0.7];
const WHITE: Vec4 = [1, 1, 1, 1];

// ---- Helpers ---------------------------------------------------------------------

interface Ortho {
  axes: [Axis, Axis];
  /** The axis the view looks along. */
  view: Axis;
  normal: Vec3;
}

/** The plane axes of a 2D view, or null in perspective and game views. */
export function orthoOf(ctx: ViewportContext): Ortho | null {
  if (ctx.kind !== "top" && ctx.kind !== "front" && ctx.kind !== "side") {
    return null;
  }
  const { normal, axes } = viewPlane(ctx.kind);
  return {
    axes: axes as [Axis, Axis],
    view: (3 - axes[0] - axes[1]) as Axis,
    normal,
  };
}

const line = (from: Vec3, to: Vec3, color: Vec4, width = 1.5): Line => ({
  from,
  to,
  color,
  width,
});

const linesOf = (edges: [Vec3, Vec3][], color: Vec4, width = 1.5): Line[] =>
  edges.map(([a, b]) => line(a, b, color, width));

/** A small square of `half` world units around a point in a 2D view. */
function squareLines(
  o: Ortho,
  centre: Vec3,
  half: number,
  color: Vec4,
  width = 2,
): Line[] {
  const [a, b] = o.axes;
  const corner = (sa: number, sb: number): Vec3 => {
    const p: Vec3 = [...centre];
    p[a] += sa * half;
    p[b] += sb * half;
    return p;
  };
  return [
    line(corner(-1, -1), corner(1, -1), color, width),
    line(corner(1, -1), corner(1, 1), color, width),
    line(corner(1, 1), corner(-1, 1), color, width),
    line(corner(-1, 1), corner(-1, -1), color, width),
  ];
}

const isBrush = (e: EntityModel | undefined): e is EntityModel =>
  !!e && !!e.components.brush && !!e.components.transform;

/** Faces and complete world transform of a brush entity (copies). */
export function brushDataOf(
  e: EntityModel,
  matrices: ReadonlyMap<number, Mat4>,
): BrushEntityData {
  const b = e.components.brush as unknown as {
    faces: BrushEntityData["faces"];
  };
  return {
    matrix: matrices.get(e.id)!.slice(),
    faces: structuredClone(b.faces),
  };
}

function editable(
  e: EntityModel | undefined,
  ctx: ViewportContext,
): e is EntityModel {
  if (!isBrush(e)) return false;
  const matrix = ctx.scene.matrices.get(e.id);
  return !!matrix && invertible(matrix);
}

/** World bounds of anything with a transform: a brush's solid, or a small box
 * around a point entity. */
function worldBounds(ctx: ViewportContext, e: EntityModel): Aabb | null {
  const m = ctx.scene.matrices.get(e.id);
  if (!m) return null;
  const brush = e.components.brush as { faces: { plane: Vec4 }[] } | undefined;
  if (brush) {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const poly of brushPolygons(brush.faces.map((f) => f.plane))) {
      for (const v of poly) {
        const p = mat4.transformPoint(m, v);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
    }
    return min[0] === Infinity ? null : { min, max };
  }
  const c: Vec3 = [m[12], m[13], m[14]];
  return {
    min: vec3.sub(c, [0.25, 0.25, 0.25]),
    max: vec3.add(c, [0.25, 0.25, 0.25]),
  };
}

/** The entity under a point in a 2D view: the smallest box that contains it. */
function hitEntity(
  ctx: ViewportContext,
  o: Ortho,
  x: number,
  y: number,
): number {
  const p = ctx.planePoint(x, y);
  if (!p) return 0;
  const [a, b] = o.axes;
  const slop = ctx.pixel() * 4;
  let best = 0;
  let bestScore = Infinity;
  for (const e of ctx.session.world.entities) {
    if (!e.components.transform) continue;
    const bounds = worldBounds(ctx, e);
    if (!bounds) continue;
    if (p[a] < bounds.min[a] - slop || p[a] > bounds.max[a] + slop) continue;
    if (p[b] < bounds.min[b] - slop || p[b] > bounds.max[b] + slop) continue;
    const point = !e.components.brush;
    const area = (bounds.max[a] - bounds.min[a]) *
      (bounds.max[b] - bounds.min[b]);
    const score = point
      ? -1
      : area - (ctx.session.selection.includes(e.id) ? 1e-6 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = e.id;
    }
  }
  return best;
}

const snapPlane = (
  ctx: ViewportContext,
  p: Vec3,
  invert: boolean,
  o?: Ortho,
): Vec3 => {
  const s = ctx.snap(p, invert);
  if (o) s[o.view] = 0;
  return s;
};

const setBrush = (e: EntityModel, data: BrushEntityData) => {
  (e.components.brush as { faces: unknown }).faces = structuredClone(
    data.faces,
  );
};

// ---- Block -------------------------------------------------------------------------

function blockTool(options: BrushToolOptions): ViewportTool {
  const defaults = options.defaults ?? brushDefaults;
  interface BlockDrag {
    o: Ortho | null;
    axes: [Axis, Axis];
    through: Vec3;
    start: Vec3;
    current: Vec3;
    base: number;
  }
  let drag: BlockDrag | null = null;
  let hover: Vec3 | null = null;

  const third = (d: BlockDrag, state: BrushDefaults): [number, number] => {
    if (d.o) return state.extent[d.o.view];
    const span = state.extent[1][1] - state.extent[1][0];
    return [d.base, d.base + span];
  };
  const boxOf = (d: BlockDrag): Aabb =>
    dragBox(d.axes, d.start, d.current, third(d, defaults.get()));

  return {
    id: "block",
    label: "Block",
    icon: "box",
    shortcut: "B",
    cursor: "crosshair",
    noGizmo: true,
    async pointerDown(ctx, e) {
      if (e.button !== 0) return false;
      const o = orthoOf(ctx);
      if (o) {
        const p = ctx.planePoint(e.x, e.y);
        if (!p) return false;
        const s = snapPlane(ctx, p, e.ctrl, o);
        drag = {
          o,
          axes: o.axes,
          through: [0, 0, 0],
          start: s,
          current: s,
          base: 0,
        };
        return true;
      }
      if (ctx.kind !== "perspective") return false;
      const hit = await ctx.pick(e.x, e.y);
      const base = hit ? ctx.snap([0, hit.point[1], 0], e.ctrl)[1] : 0;
      const through: Vec3 = [0, base, 0];
      const p = ctx.planePoint(e.x, e.y, through);
      if (!p) return false;
      const s = ctx.snap(p, e.ctrl);
      s[1] = base;
      drag = { o: null, axes: [0, 2], through, start: s, current: s, base };
      return true;
    },
    pointerMove(ctx, e, dragging) {
      const o = orthoOf(ctx);
      if (dragging && drag) {
        const p = ctx.planePoint(e.x, e.y, drag.through);
        if (!p) return;
        const s = ctx.snap(p, e.ctrl);
        if (drag.o) s[drag.o.view] = 0;
        else s[1] = drag.base;
        drag.current = s;
      } else if (o) {
        const p = ctx.planePoint(e.x, e.y);
        hover = p ? snapPlane(ctx, p, e.ctrl, o) : null;
      }
      ctx.redraw();
    },
    pointerUp(ctx) {
      const d = drag;
      drag = null;
      if (!d) return;
      const box = boxOf(d);
      const [a, b] = d.axes;
      const least = 1e-3;
      if (box.max[a] - box.min[a] < least || box.max[b] - box.min[b] < least) {
        return;
      }
      const state = defaults.get();
      ctx.session.createEntity({
        name: options.name ?? "Brush",
        components: newBrushComponents(box.min, box.max, {
          texture: state.texture || undefined,
          extra: options.components,
        }),
      });
      const extent = structuredClone(state.extent);
      extent[a] = [box.min[a], box.max[a]];
      extent[b] = [box.min[b], box.max[b]];
      if (!d.o) extent[1] = [box.min[1], box.max[1]];
      defaults.set({ extent });
    },
    keyDown(ctx, e) {
      if (e.key === "Escape" && drag) {
        drag = null;
        ctx.redraw();
        return true;
      }
    },
    overlay(ctx) {
      if (drag) return linesOf(boxEdges(boxOf(drag)), CYAN, 2);
      const o = orthoOf(ctx);
      if (!o || !hover) return [];
      const r = ctx.pixel() * 8;
      const [a, b] = o.axes;
      const h1: Vec3 = [...hover],
        h2: Vec3 = [...hover],
        v1: Vec3 = [...hover],
        v2: Vec3 = [...hover];
      h1[a] -= r;
      h2[a] += r;
      v1[b] -= r;
      v2[b] += r;
      return [line(h1, h2, CYAN, 1), line(v1, v2, CYAN, 1)];
    },
  };
}

// ---- Edit --------------------------------------------------------------------------

type HandleKey = `${-1 | 0 | 1},${-1 | 0 | 1}`;

function editTool(): ViewportTool {
  interface Handle {
    key: HandleKey;
    sides: [-1 | 0 | 1, -1 | 0 | 1];
    at: Vec3;
  }
  type Drag =
    | {
      kind: "move";
      tx: ReturnType<Session["begin"]>;
      start: Vec3;
      anchor: Vec3;
      ids: number[];
      origins: Map<number, Vec3>;
      parents: Map<number, Mat4>;
      last: string;
      preserve: ReturnType<typeof stationaryBrushTextures>;
    }
    | {
      kind: "resize";
      tx: ReturnType<Session["begin"]>;
      id: number;
      origin: BrushEntityData;
      handle: Handle;
      bounds: Aabb;
      last: string;
    };
  let drag: Drag | null = null;
  let hovered: HandleKey | null = null;

  const target = (
    ctx: ViewportContext,
  ): { entity: EntityModel; bounds: Aabb } | null => {
    const sel = ctx.session.selection;
    if (sel.length !== 1) return null;
    const entity = ctx.session.world.entities.find((x) => x.id === sel[0]);
    if (!editable(entity, ctx)) return null;
    const bounds = brushWorldBounds(brushDataOf(entity, ctx.scene.matrices));
    return bounds ? { entity, bounds } : null;
  };

  const handles = (o: Ortho, bounds: Aabb): Handle[] => {
    const [a, b] = o.axes;
    const mid = vec3.scale(vec3.add(bounds.min, bounds.max), 0.5);
    const out: Handle[] = [];
    for (const sa of [-1, 0, 1] as const) {
      for (const sb of [-1, 0, 1] as const) {
        if (sa === 0 && sb === 0) continue;
        const at: Vec3 = [...mid];
        at[a] = sa < 0 ? bounds.min[a] : sa > 0 ? bounds.max[a] : mid[a];
        at[b] = sb < 0 ? bounds.min[b] : sb > 0 ? bounds.max[b] : mid[b];
        out.push({ key: `${sa},${sb}`, sides: [sa, sb], at });
      }
    }
    return out;
  };

  const handleAt = (
    ctx: ViewportContext,
    o: Ortho,
    bounds: Aabb,
    x: number,
    y: number,
  ): Handle | null => {
    let best: Handle | null = null;
    let bestDistance = 10;
    for (const h of handles(o, bounds)) {
      const s = ctx.project(h.at);
      if (!s) continue;
      const d = Math.hypot(s[0] - x, s[1] - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = h;
      }
    }
    return best;
  };

  const moveTo = (
    ctx: ViewportContext,
    d: Extract<Drag, { kind: "move" }>,
    e: PointerInfo,
    o: Ortho,
  ) => {
    const p = ctx.planePoint(e.x, e.y);
    if (!p) return;
    const raw = vec3.sub(p, d.start);
    raw[o.view] = 0;
    const wanted = ctx.snap(vec3.add(d.anchor, raw), e.ctrl);
    const delta = vec3.sub(wanted, d.anchor);
    delta[o.view] = 0;
    const key = delta.join(",");
    if (key === d.last) return;
    d.last = key;
    d.tx.update((world) => {
      for (const id of d.ids) {
        const t = world.entities.find((x) => x.id === id)?.components
          .transform as { position: Vec3 } | undefined;
        if (t) {
          t.position = vec3.add(
            d.origins.get(id)!,
            mat4.transformDirection(d.parents.get(id)!, delta),
          );
        }
      }
      if (!ctx.ui.textureLock) d.preserve(world);
    });
  };

  const resizeTo = (
    ctx: ViewportContext,
    d: Extract<Drag, { kind: "resize" }>,
    e: PointerInfo,
    o: Ortho,
  ) => {
    const p = ctx.planePoint(e.x, e.y);
    if (!p) return;
    const snapped = ctx.snap(p, e.ctrl);
    const least = ctx.ui.snap !== e.ctrl ? ctx.ui.grid : 0.05;
    const moves: EdgeMove[] = [];
    d.handle.sides.forEach((side, i) => {
      if (side === 0) return;
      const axis = o.axes[i];
      const value = side > 0
        ? Math.max(snapped[axis], d.bounds.min[axis] + least)
        : Math.min(snapped[axis], d.bounds.max[axis] - least);
      moves.push({ axis, side, value });
    });
    const key = moves.map((m) => m.value).join(",");
    if (key === d.last) return;
    const next = resizeBrush(d.origin, moves, 1e-3, ctx.ui.textureLock);
    if (!next) return;
    d.last = key;
    d.tx.update((world) => {
      const entity = world.entities.find((x) => x.id === d.id);
      if (entity) setBrush(entity, next);
    });
  };

  return {
    id: "brush-edit",
    label: "Edit brushes",
    icon: "select",
    shortcut: "V",
    noGizmo: true,
    cursor(ctx, e) {
      if (drag?.kind === "move") return "grabbing";
      const o = orthoOf(ctx);
      const t = o ? target(ctx) : null;
      const handle = drag?.kind === "resize"
        ? drag.handle
        : o && t && e
        ? handleAt(ctx, o, t.bounds, e.x, e.y)
        : null;
      if (handle) {
        const [a, b] = handle.sides;
        if (!a) return "ns-resize";
        if (!b) return "ew-resize";
        const bounds = drag?.kind === "resize" ? drag.bounds : t!.bounds;
        const center = ctx.project(
          vec3.scale(vec3.add(bounds.min, bounds.max), 0.5),
        );
        const at = ctx.project(handle.at);
        return center && at && (at[0] - center[0]) * (at[1] - center[1]) > 0
          ? "nwse-resize"
          : "nesw-resize";
      }
      return o && e && hitEntity(ctx, o, e.x, e.y) ? "grab" : "default";
    },
    pointerDown(ctx, e) {
      const o = orthoOf(ctx);
      if (!o || e.button !== 0) return false;
      const { session } = ctx;
      const t = target(ctx);
      if (t) {
        const handle = handleAt(ctx, o, t.bounds, e.x, e.y);
        const p = ctx.planePoint(e.x, e.y);
        if (handle && p) {
          drag = {
            kind: "resize",
            tx: session.begin(`Resize ${session.nameOf(t.entity.id)}`),
            id: t.entity.id,
            origin: brushDataOf(t.entity, ctx.scene.matrices),
            handle,
            bounds: t.bounds,
            last: "",
          };
          return true;
        }
      }
      const hit = hitEntity(ctx, o, e.x, e.y);
      if (!hit) return false;
      if (e.shift && session.selection.includes(hit)) {
        session.select([hit], "toggle");
        return true;
      }
      if (!session.selection.includes(hit)) {
        session.select([hit], e.shift || e.ctrl ? "add" : "replace");
      }
      const entities = new Map(session.world.entities.map((e) => [e.id, e]));
      const ids = session.selection.filter((id) => {
        const entity = entities.get(id);
        if (!entity?.components.transform) return false;
        // Selected descendants already move with their selected ancestor.
        let parent = entity.parent;
        const seen = new Set<number>();
        while (parent && !seen.has(parent)) {
          if (session.selection.includes(parent)) return false;
          seen.add(parent);
          parent = entities.get(parent)?.parent ?? 0;
        }
        const matrix = ctx.scene.matrices.get(entity.parent) ?? mat4.identity();
        return invertible(matrix);
      });
      const origins = new Map<number, Vec3>();
      const parents = new Map<number, Mat4>();
      for (const id of ids) {
        const tr = session.world.entities.find((x) => x.id === id)!.components
          .transform as { position: Vec3 };
        origins.set(id, [...tr.position] as Vec3);
        parents.set(
          id,
          mat4.invert(
            ctx.scene.matrices.get(entities.get(id)!.parent) ?? mat4.identity(),
          ),
        );
      }
      const primary = session.world.entities.find((x) => x.id === hit)!;
      const bounds = worldBounds(ctx, primary);
      const p = ctx.planePoint(e.x, e.y);
      if (!p || !bounds) return true;
      drag = {
        kind: "move",
        tx: session.begin(
          ids.length === 1
            ? `Move ${session.nameOf(ids[0])}`
            : `Move ${ids.length} entities`,
        ),
        start: p,
        anchor: bounds.min,
        ids,
        origins,
        parents,
        preserve: stationaryBrushTextures(session.world),
        last: "",
      };
      return true;
    },
    pointerMove(ctx, e, dragging) {
      const o = orthoOf(ctx);
      if (!o) return;
      if (dragging && drag) {
        if (drag.kind === "move") moveTo(ctx, drag, e, o);
        else resizeTo(ctx, drag, e, o);
        return;
      }
      const t = target(ctx);
      const h = t ? handleAt(ctx, o, t.bounds, e.x, e.y) : null;
      if ((h?.key ?? null) !== hovered) {
        hovered = h?.key ?? null;
        ctx.redraw();
      }
    },
    pointerUp() {
      drag?.tx.commit();
      drag = null;
    },
    keyDown(ctx, e) {
      if (e.key === "Escape" && drag) {
        drag.tx.cancel();
        drag = null;
        ctx.redraw();
        return true;
      }
    },
    overlay(ctx) {
      const o = orthoOf(ctx);
      const t = o ? target(ctx) : null;
      if (!o || !t) return [];
      const bounds = drag?.kind === "resize"
        ? (() => {
          const e = ctx.session.world.entities.find((x) =>
            x.id === t.entity.id
          );
          return (e && brushWorldBounds(brushDataOf(e, ctx.scene.matrices))) ??
            t.bounds;
        })()
        : t.bounds;
      const mid = vec3.scale(vec3.add(bounds.min, bounds.max), 0.5);
      const [a, b] = o.axes;
      const corner = (sa: number, sb: number): Vec3 => {
        const p: Vec3 = [...mid];
        p[a] = sa < 0 ? bounds.min[a] : bounds.max[a];
        p[b] = sb < 0 ? bounds.min[b] : bounds.max[b];
        return p;
      };
      const out: Line[] = [
        line(corner(-1, -1), corner(1, -1), ORANGE, 1),
        line(corner(1, -1), corner(1, 1), ORANGE, 1),
        line(corner(1, 1), corner(-1, 1), ORANGE, 1),
        line(corner(-1, 1), corner(-1, -1), ORANGE, 1),
      ];
      const half = ctx.pixel() * 4;
      for (const h of handles(o, bounds)) {
        const active = (drag?.kind === "resize" && drag.handle.key === h.key) ||
          hovered === h.key;
        out.push(
          ...squareLines(
            o,
            h.at,
            half * (active ? 1.4 : 1),
            active ? WHITE : ORANGE,
            active ? 3 : 2,
          ),
        );
      }
      return out;
    },
  };
}

// ---- Clip --------------------------------------------------------------------------

function clipTool(): ViewportTool {
  let points: Vec3[] = [];
  let hover: Vec3 | null = null;
  let kind: string | null = null;
  let keep = clipState.get().keep;

  const publish = () => clipState.set({ keep, points: points.length });
  const reset = () => {
    points = [];
    hover = null;
    kind = null;
    publish();
  };

  const planeOf = (
    o: Ortho | null,
  ): { plane: Plane; a: Vec3; b: Vec3 } | null => {
    const a = points[0];
    const b = points[1] ?? hover;
    if (!a || !b) return null;
    const c = points[2] ?? hover;
    if (!o && (!c || points.length < 2)) return null;
    const plane = o ? clipPlaneThrough(a, b, o.normal) : (() => {
      const n = vec3.cross(vec3.sub(b, a), vec3.sub(c!, a));
      if (vec3.length(n) < 1e-6) return null;
      const u = vec3.normalize(n);
      return [...u, vec3.dot(u, a)] as Plane;
    })();
    return plane ? { plane, a, b } : null;
  };

  const targets = (ctx: ViewportContext) =>
    ctx.session.selection.map((id) =>
      ctx.session.world.entities.find((e) => e.id === id)
    ).filter((e): e is EntityModel => editable(e, ctx));

  const apply = (ctx: ViewportContext, plane: Plane) => {
    const { session } = ctx;
    const created: number[] = [];
    session.edit("Clip brush", (world, names) => {
      for (const target of targets(ctx)) {
        const entity = world.entities.find((e) => e.id === target.id);
        if (!entity) continue;
        const result = clipBrushEntity(
          brushDataOf(entity, ctx.scene.matrices),
          plane,
        );
        if (!result) continue;
        const pieces = keep === "front"
          ? [result.front]
          : keep === "back"
          ? [result.back]
          : [result.front, result.back];
        setBrush(entity, pieces[0]);
        created.push(entity.id);
        for (const extra of pieces.slice(1)) {
          const id = ctx.session.allocateEntity(world);
          const clone = {
            id,
            parent: entity.parent,
            components: structuredClone(entity.components),
          };
          setBrush(clone, extra);
          world.entities.splice(world.entities.indexOf(entity) + 1, 0, clone);
          const name = names.get(entity.id);
          if (name) names.set(id, name);
          created.push(id);
        }
      }
      if (created.length === 0) {
        throw new Error("the clip line does not cut through a selected brush");
      }
    });
    if (created.length) session.select(created);
  };

  return {
    id: "clip",
    label: "Clip",
    icon: "clip",
    shortcut: "X",
    cursor: "crosshair",
    noGizmo: true,
    async pointerDown(ctx, e) {
      const o = orthoOf(ctx);
      if (e.button !== 0 || ctx.kind === "game") return false;
      const p = o
        ? ctx.planePoint(e.x, e.y)
        : (await ctx.pick(e.x, e.y))?.point ?? ctx.planePoint(e.x, e.y);
      if (!p) return false;
      if (kind !== ctx.kind || points.length >= (o ? 2 : 3)) points = [];
      kind = ctx.kind;
      points.push(snapPlane(ctx, p, e.ctrl, o ?? undefined));
      hover = null;
      publish();
      return true;
    },
    pointerMove(ctx, e) {
      const o = orthoOf(ctx);
      if (
        kind !== ctx.kind || points.length < 1 || points.length >= (o ? 2 : 3)
      ) return;
      const p = ctx.planePoint(e.x, e.y);
      hover = p ? snapPlane(ctx, p, e.ctrl, o ?? undefined) : null;
      ctx.redraw();
    },
    keyDown(ctx, e) {
      const o = orthoOf(ctx);
      if (e.key === "Tab") {
        keep = nextClipKeep(keep);
        publish();
        ctx.redraw();
        return true;
      }
      if (e.key === "Escape" && points.length) {
        reset();
        ctx.redraw();
        return true;
      }
      if (
        e.key === "Enter" && points.length === (o ? 2 : 3) && kind === ctx.kind
      ) {
        const clip = planeOf(o);
        if (clip) apply(ctx, clip.plane);
        reset();
        ctx.redraw();
        return true;
      }
    },
    overlay(ctx) {
      const o = orthoOf(ctx);
      if (kind !== ctx.kind) return [];
      const out: Line[] = [];
      for (const p of points) {
        if (o) out.push(...squareLines(o, p, ctx.pixel() * 4, WHITE, 2));
        else {for (const axis of [0, 1, 2]) {
            const a: Vec3 = [...p], b: Vec3 = [...p];
            a[axis] -= ctx.pixel(p) * 4;
            b[axis] += ctx.pixel(p) * 4;
            out.push(line(a, b, WHITE, 2));
          }}
      }
      const clip = planeOf(o);
      if (!clip) return out;
      const direction = vec3.normalize(vec3.sub(clip.b, clip.a));
      out.push(
        line(
          vec3.add(clip.a, vec3.scale(direction, -2000)),
          vec3.add(clip.b, vec3.scale(direction, 2000)),
          [1, 0.9, 0.3, 0.9],
          1.5,
        ),
      );
      for (const target of targets(ctx)) {
        const result = clipBrushEntity(
          brushDataOf(target, ctx.scene.matrices),
          clip.plane,
        );
        if (!result) continue;
        for (
          const [piece, kept] of [[result.front, keep !== "back"], [
            result.back,
            keep !== "front",
          ]] as const
        ) {
          const edges = brushEdges(piece.faces.map((f) => f.plane)).map((
            [p, q],
          ): [Vec3, Vec3] => [
            mat4.transformPoint(piece.matrix, p),
            mat4.transformPoint(piece.matrix, q),
          ]);
          out.push(...linesOf(edges, kept ? GREEN : RED, kept ? 2 : 1));
        }
      }
      return out;
    },
  };
}

// ---- Face --------------------------------------------------------------------------

function faceTool(): ViewportTool {
  return {
    id: "brush-face",
    label: "Select faces",
    icon: "layers",
    shortcut: "T",
    cursor: "pointer",
    noGizmo: true,
    async pointerDown(ctx, e) {
      if (e.button !== 0) return false;
      const hit = await ctx.pick(e.x, e.y);
      if (!hit || hit.face < 0 || !hit.entity) {
        if (!e.shift) faceSelection.clear();
        return true;
      }
      const brush = ctx.session.world.entities.find((x) => x.id === hit.entity)
        ?.components.brush as { faces: unknown[] } | undefined;
      const refs = e.ctrl && brush
        ? brush.faces.map((_, face) => ({ entity: hit.entity, face }))
        : [{ entity: hit.entity, face: hit.face }];
      if (e.shift) faceSelection.toggle(refs);
      else faceSelection.set(refs);
      ctx.session.select([hit.entity]);
      return true;
    },
    keyDown(_ctx, e) {
      if (e.key === "Escape" && faceSelection.get().length) {
        faceSelection.clear();
        return true;
      }
    },
  };
}

/**
 * The brush tools: block, edit, clip, face and vertex. B, V, X, T and J
 * they do not clash with the built-in Q W E R G C F [ ] bindings.
 */
export function createBrushTools(
  options: BrushToolOptions = {},
): ViewportTool[] {
  return [editTool(), blockTool(options), clipTool(), faceTool(), vertexTool()];
}

/** The tools with default options, for editors that need nothing special. */
export const brushTools: ViewportTool[] = createBrushTools();

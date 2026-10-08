import {
  brushEdges,
  brushPolygons,
  mat4,
  type Vec3,
  vec3,
} from "@ink/geometry";
import { viewPlane, type ViewportContext, type ViewportTool } from "@ink/react";
import type { Line } from "@ink/render";
import {
  type BrushEntityData,
  brushVertices,
  moveBrushVertices,
} from "./edit.ts";

/** Squares, edge midpoints and face diamonds move their vertices together. */
export function vertexTool(): ViewportTool {
  type Handle = {
    entity: number;
    indices: number[];
    at: Vec3;
    data: BrushEntityData;
  };
  let chosen: { entity: number; indices: number[] } | null = null;
  let drag: {
    handle: Handle;
    anchor: Vec3;
    normal: Vec3;
    start: Vec3;
    tx: ReturnType<ViewportContext["session"]["begin"]>;
  } | null = null;
  const handles = (ctx: ViewportContext): Handle[] => {
    const out: Handle[] = [];
    for (const id of ctx.session.selection) {
      const entity = ctx.session.entity(id);
      const faces = (entity?.components.brush as unknown as {
        faces: BrushEntityData["faces"];
      })?.faces;
      const matrix = ctx.scene.matrices.get(id);
      if (!faces || !matrix) continue;
      const data = { matrix, faces };
      const vertices = brushVertices(faces);
      vertices.forEach((point, i) =>
        out.push({
          entity: id,
          indices: [i],
          at: mat4.transformPoint(matrix, point),
          data,
        })
      );
      for (const [a, b] of brushEdges(faces.map((f) => f.plane))) {
        const indices = [a, b].map((p) =>
          vertices.findIndex((v) => vec3.distance(v, p) < 1e-4)
        );
        if (indices.some((i) => i < 0)) continue;
        out.push({
          entity: id,
          indices,
          at: mat4.transformPoint(matrix, vec3.scale(vec3.add(a, b), 0.5)),
          data,
        });
      }
      for (const polygon of brushPolygons(faces.map((f) => f.plane))) {
        if (polygon.length < 3) continue;
        const indices = polygon.map((p) =>
          vertices.findIndex((v) => vec3.distance(v, p) < 1e-4)
        );
        if (indices.some((i) => i < 0)) continue;
        out.push({
          entity: id,
          indices,
          data,
          at: mat4.transformPoint(
            matrix,
            vec3.scale(polygon.reduce(vec3.add), 1 / polygon.length),
          ),
        });
      }
    }
    return out;
  };
  const hit = (ctx: ViewportContext, x: number, y: number) =>
    handles(ctx)
      .map((handle) => {
        const p = ctx.project(handle.at);
        return {
          handle,
          distance: p ? Math.hypot(p[0] - x, p[1] - y) : Infinity,
          depth: vec3.distance(ctx.camera.position, handle.at),
        };
      }).filter((h) => h.distance < 9).sort((a, b) =>
        Math.abs(a.distance - b.distance) < 0.1
          ? a.depth - b.depth
          : a.distance - b.distance
      )[0]?.handle;
  const planePoint = (
    ctx: ViewportContext,
    x: number,
    y: number,
    at: Vec3,
    normal: Vec3,
  ) => {
    const ray = ctx.ray(x, y);
    const denominator = vec3.dot(ray.direction, normal);
    if (Math.abs(denominator) < 1e-6) return null;
    const t = vec3.dot(vec3.sub(at, ray.origin), normal) / denominator;
    return t >= 0 ? vec3.add(ray.origin, vec3.scale(ray.direction, t)) : null;
  };
  return {
    id: "brush-vertex",
    label: "Vertices, edges and faces",
    icon: "select",
    shortcut: "J",
    noGizmo: true,
    cursor: (ctx, p) =>
      drag ? "grabbing" : p && hit(ctx, p.x, p.y) ? "grab" : "default",
    pointerDown(ctx, p) {
      if (p.button !== 0) return false;
      const handle = hit(ctx, p.x, p.y);
      if (!handle) {
        chosen = null;
        return false;
      }
      if (p.shift && chosen?.entity === handle.entity) {
        chosen.indices = [...new Set([...chosen.indices, ...handle.indices])];
        ctx.redraw();
        return true;
      }
      if (
        chosen?.entity !== handle.entity ||
        !handle.indices.every((i) => chosen!.indices.includes(i))
      ) {
        chosen = { entity: handle.entity, indices: handle.indices };
      }
      const normal: Vec3 = ctx.kind === "perspective" || ctx.kind === "game"
        ? [ctx.camera.view[2], ctx.camera.view[6], ctx.camera.view[10]]
        : viewPlane(ctx.kind).normal;
      const start = planePoint(ctx, p.x, p.y, handle.at, normal);
      if (!start) return true;
      drag = {
        handle,
        anchor: handle.at,
        normal,
        start,
        tx: ctx.session.begin(
          handle.indices.length > 2 ? "Move brush face" : "Move brush vertices",
        ),
      };
      return true;
    },
    pointerMove(ctx, p, dragging) {
      if (!dragging || !drag || !chosen) return;
      const point = planePoint(ctx, p.x, p.y, drag.anchor, drag.normal);
      if (!point) return;
      const wanted = ctx.snap(
        vec3.add(drag.anchor, vec3.sub(point, drag.start)),
        p.ctrl,
      );
      const next = moveBrushVertices(
        drag.handle.data,
        chosen.indices,
        vec3.sub(wanted, drag.anchor),
        ctx.ui.textureLock,
      );
      if (!next) return;
      const field = ctx.session.schema.component("brush")?.fields.find((f) =>
        f.name === "faces"
      )?.node;
      if (
        field?.kind === "list" &&
        next.faces.length > (field.field.max ?? Infinity)
      ) return;
      const id = drag.handle.entity;
      drag.tx.update((world) => {
        const entity = world.entities.find((e) => e.id === id);
        if (entity) {
          (entity.components.brush as { faces: unknown }).faces =
            structuredClone(next.faces);
        }
      });
    },
    pointerUp() {
      drag?.tx.commit();
      drag = null;
      chosen = null;
    },
    keyDown(ctx, e) {
      if (e.key !== "Escape") return;
      drag?.tx.cancel();
      drag = null;
      chosen = null;
      ctx.redraw();
      return true;
    },
    overlay(ctx) {
      const out: Line[] = [];
      const right: Vec3 = [
        ctx.camera.view[0],
        ctx.camera.view[4],
        ctx.camera.view[8],
      ];
      const up: Vec3 = [
        ctx.camera.view[1],
        ctx.camera.view[5],
        ctx.camera.view[9],
      ];
      for (const h of handles(ctx)) {
        const active = chosen?.entity === h.entity &&
          h.indices.every((i) => chosen!.indices.includes(i));
        const size = ctx.pixel(h.at) * (h.indices.length === 2 ? 2.5 : 4);
        const corner = (a: number, b: number) =>
          vec3.add(
            h.at,
            vec3.add(vec3.scale(right, a * size), vec3.scale(up, b * size)),
          );
        const corners = h.indices.length > 2
          ? [corner(0, -1), corner(1, 0), corner(0, 1), corner(-1, 0)]
          : [
            corner(-1, -1),
            corner(1, -1),
            corner(1, 1),
            corner(-1, 1),
          ];
        for (let i = 0; i < 4; i++) {
          out.push({
            from: corners[i],
            to: corners[(i + 1) % 4],
            color: active ? [1, 1, 1, 1] : [1, 0.62, 0.16, 1],
            width: 2,
          });
        }
      }
      return out;
    },
  };
}

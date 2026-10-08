/** Packs the overlay primitives of a frame (lines, face fills, the grid) into
 * the arrays the overlay shaders read. */
import { mat4, type Vec3, type Vec4 } from "@ink/geometry";
import { srgbToLinear } from "./gpu.ts";
import type { Line, Overlays, RenderScene } from "./types.ts";

export const LINE_FLOATS = 12;
export const FILL_FLOATS = 8;

export interface OverlayData {
  /** Depth-tested lines first, then lines drawn over everything. */
  lines: Float32Array;
  testedLines: number;
  overlayLines: number;
  /** Triangles: vec4 position, vec4 colour per vertex. */
  fills: Float32Array;
  fillVertices: number;
  /** Grid uniform (5 × vec4), or null. */
  grid: Float32Array | null;
}

const SELECTION: Vec4 = [1, 0.62, 0.16, 1];
const HOVER: Vec4 = [0.92, 0.96, 1, 1];
const EDGE: Vec4 = [0.02, 0.02, 0.04, 0.5];
const WIRE: Vec4 = [0.72, 0.82, 0.95, 0.95];

const linear = (c: Vec4): Vec4 => [
  srgbToLinear(c[0]),
  srgbToLinear(c[1]),
  srgbToLinear(c[2]),
  c[3],
];

function writeLine(
  out: number[],
  from: Vec3,
  to: Vec3,
  color: Vec4,
  width: number,
) {
  const c = linear(color);
  out.push(
    from[0],
    from[1],
    from[2],
    width,
    to[0],
    to[1],
    to[2],
    0,
    c[0],
    c[1],
    c[2],
    c[3],
  );
}

export function buildOverlays(
  scene: RenderScene,
  overlays: Overlays,
): OverlayData {
  const tested: number[] = [];
  const over: number[] = [];
  const fills: number[] = [];
  const selected = new Set(overlays.selection ?? []);
  const hovered = overlays.hovered ?? 0;
  const wire = overlays.shading === "wireframe";

  for (const line of overlays.lines ?? []) {
    writeLine(
      line.depthTest ? tested : over,
      line.from,
      line.to,
      line.color,
      line.width ?? 1,
    );
  }

  if (overlays.edges || wire) {
    for (const brush of scene.brushes) {
      const isSelected = selected.has(brush.entity);
      const isHovered = brush.entity === hovered;
      const color = isSelected
        ? SELECTION
        : isHovered
        ? HOVER
        : wire
        ? WIRE
        : EDGE;
      const width = isSelected ? 2 : isHovered ? 1.5 : 1;
      for (const [a, b] of brush.geometry.edges) {
        writeLine(
          tested,
          mat4.transformPoint(brush.matrix, a),
          mat4.transformPoint(brush.matrix, b),
          color,
          width,
        );
      }
    }
  }

  for (const { entity, face } of overlays.selectedFaces ?? []) {
    const brush = scene.brushes.find((b) => b.entity === entity);
    const polygon = brush?.geometry.polygons[face];
    if (!brush || !polygon || polygon.length < 3) continue;
    const world = polygon.map((p) => mat4.transformPoint(brush.matrix, p));
    const c = linear([SELECTION[0], SELECTION[1], SELECTION[2], 0.38]);
    for (let i = 1; i + 1 < world.length; i++) {
      for (const p of [world[0], world[i], world[i + 1]]) {
        fills.push(p[0], p[1], p[2], 1, c[0], c[1], c[2], c[3]);
      }
    }
    for (let i = 0; i < world.length; i++) {
      writeLine(
        tested,
        world[i],
        world[(i + 1) % world.length],
        SELECTION,
        2.5,
      );
    }
  }

  let grid: Float32Array | null = null;
  if (overlays.grid) {
    const g = overlays.grid;
    const plane = g.plane === "xz" ? 0 : g.plane === "xy" ? 1 : 2;
    // The first plane coordinate's zero line runs along the second axis.
    const X: Vec4 = [0.95, 0.3, 0.3, 0.9];
    const Y: Vec4 = [0.45, 0.85, 0.35, 0.9];
    const Z: Vec4 = [0.3, 0.5, 0.98, 0.9];
    const axes = plane === 0 ? [Z, X] : plane === 1 ? [Y, X] : [Z, Y];
    const minor = linear([0.68, 0.74, 0.86, 0.2]);
    const major = linear([0.72, 0.78, 0.9, 0.38]);
    grid = new Float32Array(20);
    grid.set([plane, g.spacing, g.major ?? 10, 0], 0);
    grid.set(minor, 4);
    grid.set(major, 8);
    grid.set(linear(axes[0]), 12);
    grid.set(linear(axes[1]), 16);
  }

  return {
    lines: new Float32Array([...tested, ...over]),
    testedLines: tested.length / LINE_FLOATS,
    overlayLines: over.length / LINE_FLOATS,
    fills: new Float32Array(fills),
    fillVertices: fills.length / FILL_FLOATS,
    grid,
  };
}

export type { Line };

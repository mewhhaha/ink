/**
 * Editor gizmos for 2D content: outlines of selected and hovered sprites,
 * tile maps and text, and the position and reach of `light2d` entities.
 * Pass the result in `Overlays.lines` next to `sceneGizmos`.
 */
import { type Mat4, mat4, type Vec3, type Vec4 } from "@ink/geometry";
import { type Item2d, layout2d, type Layout2dAssets } from "./layout2d.ts";
import type { Line, RenderScene } from "./types.ts";

const SELECTED: Vec4 = [1, 0.62, 0.16, 1];
const HOVERED: Vec4 = [1, 1, 1, 0.7];
const LIGHT: Vec4 = [1, 0.86, 0.35, 0.95];

function outline(matrix: Mat4, color: Vec4, width: number, out: Line[]) {
  const corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([u, v]) =>
    mat4.transformPoint(matrix, [u, v, 0])
  );
  for (let i = 0; i < 4; i++) {
    out.push({ from: corners[i], to: corners[(i + 1) % 4], color, width });
  }
}

export function itemOutline(item: Item2d, color: Vec4, width: number): Line[] {
  const out: Line[] = [];
  if (item.kind === "text") {
    // One box around the whole text block.
    let low: Vec3 | undefined, high: Vec3 | undefined;
    for (const g of item.glyphs) {
      for (const [u, v] of [[0, 0], [1, 1]]) {
        const p = mat4.transformPoint(g.matrix, [u, v, 0]);
        low = low ? [Math.min(low[0], p[0]), Math.min(low[1], p[1]), p[2]] : p;
        high = high
          ? [Math.max(high[0], p[0]), Math.max(high[1], p[1]), p[2]]
          : p;
      }
    }
    if (low && high) {
      const c: Vec3[] = [
        [low[0], low[1], low[2]],
        [high[0], low[1], low[2]],
        [high[0], high[1], low[2]],
        [low[0], high[1], low[2]],
      ];
      for (let i = 0; i < 4; i++) {
        out.push({ from: c[i], to: c[(i + 1) % 4], color, width });
      }
    }
  } else outline(item.matrix, color, width, out);
  return out;
}

function circle(center: Vec3, radius: number, color: Vec4, out: Line[]) {
  let prev: Vec3 | null = null;
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const p: Vec3 = [
      center[0] + Math.cos(a) * radius,
      center[1] + Math.sin(a) * radius,
      center[2],
    ];
    if (prev) out.push({ from: prev, to: p, color, width: 1 });
    prev = p;
  }
}

export function sceneGizmos2d(
  scene: RenderScene,
  assets: Layout2dAssets,
  options: { selection?: readonly number[]; hovered?: number } = {},
): Line[] {
  const out: Line[] = [];
  const selected = new Set(options.selection ?? []);
  if (selected.size || options.hovered) {
    for (const item of layout2d(scene, assets)) {
      if (selected.has(item.entity)) {
        out.push(...itemOutline(item, SELECTED, 2));
      } else if (item.entity === options.hovered) {
        out.push(...itemOutline(item, HOVERED, 1));
      }
    }
  }
  for (const light of scene.lights2d ?? []) {
    const color = selected.has(light.entity) ? SELECTED : LIGHT;
    const [x, y, z] = light.position;
    if (light.kind === "ambient") continue;
    const r = 0.18;
    out.push(
      { from: [x - r, y, z], to: [x + r, y, z], color, width: 1.5 },
      { from: [x, y - r, z], to: [x, y + r, z], color, width: 1.5 },
    );
    if (light.kind === "sun" || light.kind === "spotlight") {
      const [dx, dy] = light.direction;
      out.push({
        from: [x, y, z],
        to: [x + dx * 0.9, y + dy * 0.9, z],
        color,
        width: 1.5,
      });
    }
    if (selected.has(light.entity) && light.kind !== "sun") {
      circle([x, y, z], light.radius, color, out);
    }
  }
  return out;
}

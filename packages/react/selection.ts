import { mat4, type Vec3 } from "@ink/geometry";
import type { RenderScene } from "@ink/render";
import type { EntityModel } from "@ink/schema";

export function selectionDescendants(
  entities: readonly EntityModel[],
  selected: readonly number[],
): Set<number> {
  const result = new Set(selected);
  const children = new Map<number, number[]>();
  for (const e of entities) {
    children.set(e.parent, [...children.get(e.parent) ?? [], e.id]);
  }
  const pending = [...selected];
  for (let i = 0; i < pending.length; i++) {
    for (const child of children.get(pending[i]) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        pending.push(child);
      }
    }
  }
  return result;
}

/** Window selection contains the whole projected bounds; a right-to-left
 * crossing selection includes anything whose bounds overlap the rectangle. */
export function marqueeEntities(
  scene: RenderScene,
  project: (point: Vec3) => [number, number] | null,
  start: [number, number],
  end: [number, number],
): number[] {
  const bounds = new Map<number, [number, number, number, number]>();
  const include = (id: number, point: Vec3) => {
    const p = project(point);
    if (!p || !p.every(Number.isFinite)) return;
    const b = bounds.get(id) ?? [Infinity, Infinity, -Infinity, -Infinity];
    b[0] = Math.min(b[0], p[0]);
    b[1] = Math.min(b[1], p[1]);
    b[2] = Math.max(b[2], p[0]);
    b[3] = Math.max(b[3], p[1]);
    bounds.set(id, b);
  };
  for (const [id, matrix] of scene.matrices) {
    include(id, mat4.transformPoint(matrix, [0, 0, 0]));
  }
  for (const brush of scene.brushes) {
    bounds.delete(brush.entity);
    for (const point of brush.geometry.polygons.flat()) {
      include(brush.entity, mat4.transformPoint(brush.matrix, point));
    }
  }
  for (const draw of scene.draws) {
    for (const x of [-0.5, 0.5]) {
      for (const y of [-0.5, 0.5]) {
        for (const z of [-0.5, 0.5]) {
          include(draw.entity, mat4.transformPoint(draw.matrix, [x, y, z]));
        }
      }
    }
  }
  const minX = Math.min(start[0], end[0]), maxX = Math.max(start[0], end[0]);
  const minY = Math.min(start[1], end[1]), maxY = Math.max(start[1], end[1]);
  const crossing = end[0] < start[0];
  return [...bounds].filter(([, b]) =>
    crossing
      ? b[2] >= minX && b[0] <= maxX && b[3] >= minY && b[1] <= maxY
      : b[0] >= minX && b[2] <= maxX && b[1] >= minY && b[3] <= maxY
  ).map(([id]) => id);
}

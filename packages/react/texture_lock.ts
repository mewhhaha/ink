import { type BrushFace, mat4, transformBrushSurface } from "@ink/geometry";
import { worldMatrices } from "@ink/render";
import type { WorldModel } from "@ink/schema";

/** Capture once at drag start; apply after changing transforms when unlocked.
 * Includes children: moving a selected group must not drag their textures. */
export function stationaryBrushTextures(
  before: WorldModel,
): (world: WorldModel) => void {
  const matrices = worldMatrices(before);
  const brushes = before.entities.filter((e) => e.components.brush).map((
    e,
  ) => ({
    id: e.id,
    matrix: matrices.get(e.id)!,
    faces: e.components.brush.faces as unknown as BrushFace[],
  }));
  return (world) => {
    const current = worldMatrices(world);
    for (const brush of brushes) {
      const matrix = current.get(brush.id);
      if (
        !matrix || matrix.every((v, i) => Math.abs(v - brush.matrix[i]) < 1e-8)
      ) continue;
      const entity = world.entities.find((e) => e.id === brush.id);
      if (!entity?.components.brush) continue;
      const edit = mat4.multiply(mat4.invert(matrix), brush.matrix);
      (entity.components.brush as { faces: unknown }).faces = brush.faces.map((
        f,
      ) => transformBrushSurface(f, edit));
    }
  };
}

/**
 * Level of detail for imported meshes. The asset importer stores simplified
 * index buffers over a primitive's own vertices (`GpuMesh.lods`), each with the
 * geometric error it introduces in mesh units. A draw uses the coarsest level
 * whose error projects to under `LOD_PIXELS` on screen, so the choice depends
 * on the camera and viewport only, never on frame history. Skinned and morphed
 * meshes have no levels.
 */
import type { Mat4 } from "@ink/geometry";
import type { GpuMesh } from "./assets.ts";
import type { Camera } from "./types.ts";

/** Largest on-screen geometric error (pixels) a simplified level may have. */
export const LOD_PIXELS = 1.5;

/** 0 is the full-resolution mesh, `n` is `mesh.lods[n - 1]`. */
export function chooseLod(
  mesh: GpuMesh,
  matrix: Mat4,
  camera: Camera,
  viewportHeight: number,
): number {
  const lods = mesh.lods;
  if (!lods?.length) return 0;
  const scale = Math.sqrt(Math.max(
    matrix[0] ** 2 + matrix[1] ** 2 + matrix[2] ** 2,
    matrix[4] ** 2 + matrix[5] ** 2 + matrix[6] ** 2,
    matrix[8] ** 2 + matrix[9] ** 2 + matrix[10] ** 2,
  ));
  const { min, max } = mesh.bounds;
  const cx = (min[0] + max[0]) / 2,
    cy = (min[1] + max[1]) / 2,
    cz = (min[2] + max[2]) / 2;
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) /
    2 * scale;
  const pixelsPerUnit = viewportHeight / 2 * camera.projection[5];
  let distance = 1;
  if (!camera.orthographic) {
    const wx = matrix[0] * cx + matrix[4] * cy + matrix[8] * cz + matrix[12],
      wy = matrix[1] * cx + matrix[5] * cy + matrix[9] * cz + matrix[13],
      wz = matrix[2] * cx + matrix[6] * cy + matrix[10] * cz + matrix[14];
    distance = Math.max(
      camera.near,
      Math.hypot(
        wx - camera.position[0],
        wy - camera.position[1],
        wz - camera.position[2],
      ) - radius,
    );
  }
  const unit = scale * pixelsPerUnit / distance;
  for (let i = lods.length; i >= 1; i--) {
    if (lods[i - 1].error * unit <= LOD_PIXELS) return i;
  }
  return 0;
}

/** Index buffer and count a batch draws at a level. */
export function lodGeometry(
  mesh: GpuMesh,
  lod: number,
): { index: GPUBuffer; count: number } {
  const level = lod > 0 ? mesh.lods?.[lod - 1] : undefined;
  return level
    ? { index: level.index, count: level.indexCount }
    : { index: mesh.index, count: mesh.indexCount };
}

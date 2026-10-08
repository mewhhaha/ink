import { type Aabb, type Mat4, mat4 } from "@ink/geometry";

/** Conservative homogeneous frustum test, including near-plane crossings. */
export function boundsInClip(bounds: Aabb, matrix: Mat4): boolean {
  let outside = 63;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const px = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        const py = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        const pz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
        outside &= (px < -w ? 1 : 0) | (px > w ? 2 : 0) | (py < -w ? 4 : 0) |
          (py > w ? 8 : 0) | (pz < 0 ? 16 : 0) | (pz > w ? 32 : 0);
        if (!outside) {
          return true;
        }
      }
    }
  }
  return false;
}

export function instanceInClip(
  bounds: Aabb,
  viewProjection: Mat4,
  matrix: Mat4,
): boolean {
  return boundsInClip(bounds, mat4.multiply(viewProjection, matrix));
}

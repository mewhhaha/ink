import {
  intersectTriangle,
  mat4,
  type MeshData,
  type Ray,
  rayAt,
  type Vec3,
  vec3,
} from "@ink/geometry";
import type { AssetStore, RenderScene } from "@ink/render";

/** Geometry targets in world space; selected entities never attract their own drag. */
export function snapGeometry(options: {
  scene: RenderScene;
  assets?: Pick<AssetStore, "meshData">;
  exclude: ReadonlySet<number>;
  mode: "surface" | "vertex";
  ray: Ray;
  project(point: Vec3): [number, number] | null;
  screen: [number, number];
}): Vec3 | null {
  let best: Vec3 | null = null;
  let bestDistance = Infinity;
  let bestPixels = 10;
  const vertex = (p: Vec3) => {
    const screen = options.project(p);
    if (!screen) return;
    const pixels = Math.hypot(
      screen[0] - options.screen[0],
      screen[1] - options.screen[1],
    );
    if (
      pixels > 10 ||
      vec3.dot(vec3.sub(p, options.ray.origin), options.ray.direction) < 0
    ) return;
    const distance = vec3.distance(options.ray.origin, p);
    if (
      pixels < bestPixels - 0.1 ||
      (Math.abs(pixels - bestPixels) < 0.1 && distance < bestDistance)
    ) {
      best = p;
      bestPixels = pixels;
      bestDistance = distance;
    }
  };
  const geometry = (
    matrix: Float32Array,
    data: Pick<MeshData, "positions" | "indices">,
  ) => {
    const at = (
      i: number,
    ): Vec3 => [
      data.positions[i * 3],
      data.positions[i * 3 + 1],
      data.positions[i * 3 + 2],
    ];
    if (options.mode === "vertex") {
      for (let i = 0; i < data.positions.length / 3; i++) {
        vertex(mat4.transformPoint(matrix, at(i)));
      }
    } else {
      const inverse = mat4.invert(matrix);
      const local = {
        origin: mat4.transformPoint(inverse, options.ray.origin),
        direction: mat4.transformDirection(inverse, options.ray.direction),
      };
      for (let i = 0; i < data.indices.length; i += 3) {
        const t = intersectTriangle(
          local,
          at(data.indices[i]),
          at(data.indices[i + 1]),
          at(data.indices[i + 2]),
        );
        if (t !== null && t < bestDistance) {
          bestDistance = t;
          best = rayAt(options.ray, t);
        }
      }
    }
  };
  for (const draw of options.scene.draws) {
    if (options.exclude.has(draw.entity)) continue;
    const mesh = options.assets?.meshData(draw.mesh);
    if (mesh) geometry(draw.matrix, mesh);
  }
  for (const brush of options.scene.brushes) {
    if (options.exclude.has(brush.entity)) continue;
    for (const part of brush.geometry.parts) geometry(brush.matrix, part.mesh);
  }
  return best;
}

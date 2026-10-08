/** Convex CSG in the source brush's local frame, including parent transforms. */
import {
  type BrushFace,
  brushPolygons,
  clipBrush,
  mat4,
  transformBrush,
  vec3,
} from "@ink/geometry";
import {
  type BrushEntityData,
  brushVertices,
  hullBrush,
  invertible,
  surfaceOf,
} from "./edit.ts";

export function brushVolume(faces: readonly BrushFace[]): number {
  const polygons = brushPolygons(faces.map((f) => f.plane));
  const origin = polygons.find((p) => p.length)?.[0];
  if (!origin) return 0;
  let volume = 0;
  for (const poly of polygons) {
    for (let i = 1; i + 1 < poly.length; i++) {
      volume += vec3.dot(
        vec3.sub(poly[0], origin),
        vec3.cross(vec3.sub(poly[i], origin), vec3.sub(poly[i + 1], origin)),
      ) / 6;
    }
  }
  return Math.abs(volume);
}

/** Disjoint convex pieces of source minus cutter; cut faces use cutter surfaces. */
export function subtractBrush(
  source: BrushEntityData,
  cutter: BrushEntityData,
): BrushEntityData[] {
  if (!invertible(source.matrix) || !invertible(cutter.matrix)) {
    throw new Error("CSG needs invertible transforms");
  }
  const cut = transformBrush(
    cutter.faces,
    mat4.multiply(mat4.invert(source.matrix), cutter.matrix),
    true,
  );
  let remainder: BrushFace[] | null = source.faces;
  const pieces: BrushEntityData[] = [];
  for (const face of cut) {
    if (!remainder) break;
    const halves = clipBrush(remainder, face.plane, surfaceOf(face));
    if (halves.front && brushVolume(halves.front) > 1e-8) {
      pieces.push({ ...source, faces: halves.front });
    }
    remainder = halves.back && brushVolume(halves.back) > 1e-8
      ? halves.back
      : null;
  }
  return pieces;
}

/** Enclose all inputs in one convex brush, retaining the first transform. */
export function mergeBrushes(
  brushes: readonly BrushEntityData[],
): BrushEntityData | null {
  const first = brushes[0];
  if (!first || brushes.some((b) => !invertible(b.matrix))) return null;
  const inverse = mat4.invert(first.matrix);
  const faces = brushes.flatMap((b) =>
    transformBrush(b.faces, mat4.multiply(inverse, b.matrix), true)
  );
  const points = brushes.flatMap((b) =>
    brushVertices(b.faces).map((p) =>
      mat4.transformPoint(mat4.multiply(inverse, b.matrix), p)
    )
  );
  return hullBrush({ matrix: first.matrix, faces }, points);
}

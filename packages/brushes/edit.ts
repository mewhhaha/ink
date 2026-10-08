/**
 * Pure brush-editing logic: no DOM, no session. The tools and panels in this
 * package are thin wrappers over these functions, so they can be tested (and
 * reused by other editors) without a browser.
 *
 * A brush entity is an entity with `transform` + `brush`. Its planes are in the
 * entity's local space. Edits use the complete world matrix, including parents,
 * and keep the entity's transform intact so children do not move with its pivot.
 */
import {
  type Aabb,
  boxBrush,
  brushBounds,
  type BrushFace,
  brushPolygons,
  brushUv,
  clipBrush,
  defaultFace,
  type Mat4,
  mat4,
  type Plane,
  transformBrush,
  type Vec2,
  type Vec3,
  vec3,
  type Vec4,
} from "@ink/geometry";

export type Axis = 0 | 1 | 2;

/** What a brush entity's data looks like on the host. */
export interface BrushEntityData {
  /** Local to world, including the parent hierarchy. */
  matrix: Mat4;
  faces: BrushFace[];
}

/** Surface parameters of a face: everything except the plane. */
export type Surface = Omit<BrushFace, "plane">;

export interface NewBrushOptions {
  /** Texture asset path (scene style) or catalog id. */
  texture?: string | number;
  color?: Vec4;
  /** Extra components for the entity, e.g. `{ solid: {} }`. */
  extra?: Record<string, unknown>;
}

/** Order the corners of two points. */
export function normalizeBox(a: Vec3, b: Vec3): Aabb {
  return { min: vec3.min(a, b), max: vec3.max(a, b) };
}

/**
 * Scene-style components for a new axis-aligned brush spanning `min..max`:
 * identity rotation and scale, `transform.position` at the centre of the box
 * and the six planes in local space. Pass to `session.createEntity`.
 */
export function newBrushComponents(
  min: Vec3,
  max: Vec3,
  options: NewBrushOptions = {},
): Record<string, unknown> {
  const box = normalizeBox(min, max);
  const centre = vec3.scale(vec3.add(box.min, box.max), 0.5);
  const face: Surface = {
    ...defaultFace([0, 0, 0, 0]),
    texture: (options.texture ?? 0) as number,
    color: options.color ?? [1, 1, 1, 1],
  };
  return {
    transform: {
      position: centre,
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    brush: {
      faces: boxBrush(
        vec3.sub(box.min, centre),
        vec3.sub(box.max, centre),
        face,
      ),
    },
    ...options.extra,
  };
}

/**
 * The box of a drag in a view: `a` and `b` are the drag's corners in the view
 * plane (their coordinate along the view axis is ignored) and `third` is the
 * extent along the view axis.
 */
export function dragBox(
  axes: readonly [Axis, Axis],
  a: Vec3,
  b: Vec3,
  third: readonly [number, number],
): Aabb {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  const view = (3 - axes[0] - axes[1]) as Axis;
  for (const axis of axes) {
    min[axis] = Math.min(a[axis], b[axis]);
    max[axis] = Math.max(a[axis], b[axis]);
  }
  min[view] = Math.min(third[0], third[1]);
  max[view] = Math.max(third[0], third[1]);
  return { min, max };
}

/** The 12 edges of a box. */
export function boxEdges(box: Aabb): [Vec3, Vec3][] {
  const { min, max } = box;
  const corner = (i: number): Vec3 => [
    i & 1 ? max[0] : min[0],
    i & 2 ? max[1] : min[1],
    i & 4 ? max[2] : min[2],
  ];
  const edges: [Vec3, Vec3][] = [];
  for (let i = 0; i < 8; i++) {
    for (const bit of [1, 2, 4]) {
      if (!(i & bit)) edges.push([corner(i), corner(i | bit)]);
    }
  }
  return edges;
}

const tidy = (v: number) => Math.round(v * 1e5) / 1e5 + 0;

/** Bounds of the solid in local space, rounded to 1e-5 to drop clipping noise. */
export function localBounds(faces: readonly BrushFace[]): Aabb | null {
  const b = brushBounds(faces);
  if (!b) return null;
  return { min: b.min.map(tidy) as Vec3, max: b.max.map(tidy) as Vec3 };
}

/** World bounds of the solid, including rotations, scales and parent shear. */
export function brushWorldBounds(entity: BrushEntityData): Aabb | null {
  const points = brushPolygons(entity.faces.map((f) => f.plane)).flat()
    .map((p) => mat4.transformPoint(entity.matrix, p));
  if (!points.length) return null;
  return {
    min: points.reduce(vec3.min).map(tidy) as Vec3,
    max: points.reduce(vec3.max).map(tidy) as Vec3,
  };
}

/** A collapsed transform has no meaningful inverse for editing. */
export function invertible(matrix: Mat4): boolean {
  const x: Vec3 = [matrix[0], matrix[1], matrix[2]];
  const y: Vec3 = [matrix[4], matrix[5], matrix[6]];
  const z: Vec3 = [matrix[8], matrix[9], matrix[10]];
  const volume = vec3.length(x) * vec3.length(y) * vec3.length(z);
  return Number.isFinite(volume) && volume > 1e-12 &&
    Math.abs(vec3.dot(x, vec3.cross(y, z))) / volume > 1e-6;
}

/** One side of a brush's bounds to move to a world coordinate. */
export interface EdgeMove {
  axis: Axis;
  /** -1 moves the minimum side, +1 the maximum side. */
  side: -1 | 1;
  value: number;
}

/**
 * Stretch the world-space bounds, keeping the opposite sides fixed. The
 * affine edit applies to every face, including sloped and rotated brushes.
 * Returns null for collapsed transforms or a result thinner than `minSize`.
 */
export function resizeBrush(
  entity: BrushEntityData,
  moves: readonly EdgeMove[],
  minSize = 1e-3,
): BrushEntityData | null {
  if (!invertible(entity.matrix)) return null;
  const bounds = brushWorldBounds(entity);
  if (!bounds) return null;
  const next = structuredClone(bounds);
  for (const move of moves) {
    if (!Number.isFinite(move.value)) return null;
    (move.side < 0 ? next.min : next.max)[move.axis] = move.value;
  }
  const scale: Vec3 = [1, 1, 1];
  const offset: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const size = next.max[i] - next.min[i];
    const old = bounds.max[i] - bounds.min[i];
    if (size < minSize - 1e-9 || old < 1e-9) return null;
    scale[i] = size / old;
    offset[i] = next.min[i] - bounds.min[i] * scale[i];
  }
  const edit = mat4.multiply(
    mat4.invert(entity.matrix),
    mat4.multiply(
      mat4.compose(offset, [0, 0, 0, 1], scale),
      entity.matrix,
    ),
  );
  return { ...entity, faces: transformBrush(entity.faces, edit) };
}

/**
 * The clip plane through two points of an orthographic view. `viewNormal` is
 * the view axis (towards the viewer). The returned plane's normal points to
 * the left of the line a -> b as drawn; "front" is that side.
 */
export function clipPlaneThrough(
  a: Vec3,
  b: Vec3,
  viewNormal: Vec3,
): Plane | null {
  const n = vec3.cross(viewNormal, vec3.sub(b, a));
  if (vec3.length(n) < 1e-9) return null;
  const u = vec3.normalize(n);
  return [u[0], u[1], u[2], vec3.dot(u, a)];
}

export type ClipKeep = "front" | "back" | "both";

export const clipKeepOrder: readonly ClipKeep[] = ["front", "back", "both"];

export const nextClipKeep = (keep: ClipKeep): ClipKeep =>
  clipKeepOrder[(clipKeepOrder.indexOf(keep) + 1) % clipKeepOrder.length];

export interface ClipResult {
  front: BrushEntityData;
  back: BrushEntityData;
}

/**
 * Split a brush entity by a world-space plane. Returns null when the plane
 * does not cut through the solid. The cut face copies the surface of the
 * brush's first face; both halves retain their original transform and parent.
 */
export function clipBrushEntity(
  entity: BrushEntityData,
  plane: Plane,
): ClipResult | null {
  if (!invertible(entity.matrix)) return null;
  const m = entity.matrix;
  const n: Vec3 = [plane[0], plane[1], plane[2]];
  const localNormal = mat4.transformDirection(mat4.transpose(m), n);
  const length = vec3.length(localNormal);
  if (length < 1e-9) return null;
  const local: Plane = [
    ...vec3.scale(localNormal, 1 / length),
    (plane[3] - vec3.dot(n, [m[12], m[13], m[14]])) / length,
  ];
  const first = entity.faces[0];
  const cap: Surface | undefined = first
    ? { ...first, offset: [0, 0], rotation: 0, scale: [1, 1] }
    : undefined;
  const { front, back } = clipBrush(entity.faces, local, cap);
  if (!front || !back) return null;
  return {
    front: { ...entity, faces: front },
    back: { ...entity, faces: back },
  };
}

// ---- Surfaces ---------------------------------------------------------------

/** Unique local vertices in stable coordinate order. */
export function brushVertices(faces: readonly BrushFace[]): Vec3[] {
  const points = new Map<string, Vec3>();
  for (const p of brushPolygons(faces.map((f) => f.plane)).flat()) {
    const key = p.map((v) => Math.round(v * 1e4)).join(",");
    if (!points.has(key)) points.set(key, p);
  }
  return [...points.values()].sort((a, b) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  );
}

/** Move vertices (or both ends of an edge) and rebuild the convex hull.
 * Interior points disappear; collapsed solids are refused. */
export function moveBrushVertices(
  entity: BrushEntityData,
  selected: readonly number[],
  worldDelta: Vec3,
): BrushEntityData | null {
  if (!invertible(entity.matrix) || !worldDelta.every(Number.isFinite)) {
    return null;
  }
  const delta = mat4.transformDirection(mat4.invert(entity.matrix), worldDelta);
  const points = brushVertices(entity.faces).map((p, i) =>
    selected.includes(i) ? vec3.add(p, delta) : p
  );
  const faces: BrushFace[] = [];
  const epsilon = 1e-5;
  let volume = false;
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      for (let c = b + 1; c < points.length; c++) {
        let n = vec3.cross(
          vec3.sub(points[b], points[a]),
          vec3.sub(points[c], points[a]),
        );
        if (vec3.length(n) < epsilon) {
          continue;
        }
        n = vec3.normalize(n);
        let d = vec3.dot(n, points[a]);
        const distances = points.map((p) => vec3.dot(n, p) - d);
        const min = Math.min(...distances), max = Math.max(...distances);
        if (min < -epsilon && max > epsilon) continue;
        if (min >= -epsilon && max <= epsilon) continue;
        volume = true;
        if (max > epsilon) {
          n = vec3.negate(n);
          d = -d;
        }
        const plane: Plane = [...n, d];
        if (
          faces.some((f) =>
            f.plane.every((v, k) => Math.abs(v - plane[k]) < epsilon)
          )
        ) continue;
        const surface = entity.faces.reduce((best, f) => {
          const score = (p: Plane) =>
            vec3.dot(n, [p[0], p[1], p[2]]) - Math.abs(p[3] - d) * 1e-4;
          return score(f.plane) > score(best.plane) ? f : best;
        });
        faces.push({ ...structuredClone(surface), plane });
      }
    }
  }
  return volume && faces.length >= 4 ? { ...entity, faces } : null;
}

/** Texture-space extents (in texels at scale 1, offset 0) of the face's polygon. */
function texelExtents(face: BrushFace, polygon: readonly Vec3[], scale: Vec2) {
  const probe: BrushFace = { ...face, offset: [0, 0], scale };
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  for (const p of polygon) {
    const uv = brushUv(probe, p, [1, 1]);
    for (let k = 0; k < 2; k++) {
      min[k] = Math.min(min[k], uv[k]);
      max[k] = Math.max(max[k], uv[k]);
    }
  }
  return { min, max };
}

/** Offset that puts the face's texture origin at the corner of its polygon. */
export function alignFace(
  face: BrushFace,
  polygon: readonly Vec3[],
): BrushFace {
  if (polygon.length < 3) return face;
  const { min } = texelExtents(face, polygon, face.scale);
  return { ...face, offset: [-min[0], -min[1]] };
}

/**
 * Scale and offset so the texture covers the face `repeat` times across each
 * direction, starting at the polygon's corner. `size` is the texture in pixels.
 */
export function fitFace(
  face: BrushFace,
  polygon: readonly Vec3[],
  size: Vec2,
  repeat: Vec2 = [1, 1],
): BrushFace {
  if (polygon.length < 3) return face;
  const { min, max } = texelExtents(face, polygon, [1, 1]);
  const signs = [Math.sign(face.scale[0]) || 1, Math.sign(face.scale[1]) || 1];
  const scale: Vec2 = [0, 1].map((k) => {
    const extent = Math.max(1e-6, max[k] - min[k]);
    return (extent / (size[k] * repeat[k])) * signs[k];
  }) as Vec2;
  const fitted = { ...face, scale };
  return alignFace(fitted, polygon);
}

/** Replace the surface (not the plane) of a face. */
export function withSurface(face: BrushFace, surface: Surface): BrushFace {
  return { ...structuredClone(surface), plane: face.plane };
}

export const surfaceOf = (face: BrushFace): Surface => ({
  texture: face.texture,
  color: [...face.color] as Vec4,
  offset: [...face.offset] as Vec2,
  scale: [...face.scale] as Vec2,
  rotation: face.rotation,
});

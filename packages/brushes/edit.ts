/**
 * Pure brush-editing logic: no DOM, no session. The tools and panels in this
 * package are thin wrappers over these functions, so they can be tested (and
 * reused by other editors) without a browser.
 *
 * A brush entity is an entity with `transform` + `brush`. Its planes are in the
 * entity's local space and new brushes are placed with their origin at the
 * centre of the solid. Resizing and clipping only support entities whose
 * transform is a translation (see `isTranslationOnly`); everything else can
 * still be moved.
 */
import {
  type Aabb,
  boxBrush,
  brushBounds,
  type BrushFace,
  brushUv,
  clipBrush,
  defaultFace,
  type Plane,
  translateBrush,
  type Vec2,
  type Vec3,
  vec3,
  type Vec4,
} from "@ink/geometry";

export type Axis = 0 | 1 | 2;

/** What a brush entity's data looks like on the host. */
export interface BrushEntityData {
  position: Vec3;
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

/** Only a translation: identity rotation and unit scale. */
export function isTranslationOnly(
  transform: { rotation: readonly number[]; scale: readonly number[] },
): boolean {
  const [x, y, z, w] = transform.rotation;
  const q = Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-6 &&
    Math.abs(w) > 0.999999;
  return q && transform.scale.every((s) => Math.abs(s - 1) < 1e-6);
}

const tidy = (v: number) => Math.round(v * 1e5) / 1e5 + 0;

/** Bounds of the solid in local space, rounded to 1e-5 to drop clipping noise. */
export function localBounds(faces: readonly BrushFace[]): Aabb | null {
  const b = brushBounds(faces);
  if (!b) return null;
  return { min: b.min.map(tidy) as Vec3, max: b.max.map(tidy) as Vec3 };
}

/** World bounds of a translation-only brush entity. */
export function brushWorldBounds(entity: BrushEntityData): Aabb | null {
  const local = localBounds(entity.faces);
  if (!local) return null;
  return {
    min: vec3.add(local.min, entity.position),
    max: vec3.add(local.max, entity.position),
  };
}

const axisOf = (plane: Vec4): { axis: Axis; sign: 1 | -1 } | null => {
  for (const axis of [0, 1, 2] as const) {
    const others = [0, 1, 2].filter((i) => i !== axis);
    if (
      others.every((i) => Math.abs(plane[i]) < 1e-5) &&
      Math.abs(Math.abs(plane[axis]) - 1) < 1e-5
    ) {
      return { axis, sign: plane[axis] > 0 ? 1 : -1 };
    }
  }
  return null;
};

/** Texture offset that keeps a face's texture pinned to the world when its
 * brush's local origin moves by `shift` (new local = old local - shift). */
function lockTexture(face: BrushFace, shift: Vec3): BrushFace {
  const unit: Vec2 = [1, 1];
  const a = brushUv(face, [0, 0, 0], unit);
  const b = brushUv(face, shift, unit);
  return {
    ...face,
    offset: [face.offset[0] + (b[0] - a[0]), face.offset[1] + (b[1] - a[1])],
  };
}

/**
 * Put the brush's origin back at the centre of its solid, adjusting the planes,
 * the entity position and the face offsets so nothing moves on screen.
 */
export function rebaseBrush(entity: BrushEntityData): BrushEntityData {
  const bounds = localBounds(entity.faces);
  if (!bounds) return entity;
  const centre = vec3.scale(vec3.add(bounds.min, bounds.max), 0.5);
  if (vec3.length(centre) < 1e-9) return entity;
  const faces = translateBrush(entity.faces, vec3.scale(centre, -1)).map((
    f,
    i,
  ) => ({
    ...lockTexture(entity.faces[i], centre),
    plane: f.plane,
  }));
  return { position: vec3.add(entity.position, centre), faces };
}

/** One side of a brush's bounds to move to a world coordinate. */
export interface EdgeMove {
  axis: Axis;
  /** -1 moves the minimum side, +1 the maximum side. */
  side: -1 | 1;
  value: number;
}

/**
 * Move the axis-aligned faces on the given sides of a brush. A side without
 * an axis-aligned face (a corner or slope left by clipping) is left alone.
 * Returns null if the result would be thinner than `minSize` on any axis.
 */
export function resizeBrush(
  entity: BrushEntityData,
  moves: readonly EdgeMove[],
  minSize = 1e-3,
): BrushEntityData | null {
  const faces = entity.faces.map((f) => ({
    ...f,
    plane: [...f.plane] as Vec4,
  }));
  for (const move of moves) {
    const local = move.value - entity.position[move.axis];
    for (const face of faces) {
      const a = axisOf(face.plane);
      if (a && a.axis === move.axis && a.sign === move.side) {
        face.plane[3] = move.side * local;
      }
    }
  }
  const bounds = localBounds(faces);
  if (!bounds) return null;
  for (let i = 0; i < 3; i++) {
    if (bounds.max[i] - bounds.min[i] < minSize - 1e-9) return null;
  }
  // Textures are pinned to the local origin, so keep them pinned to the world
  // while the origin is recentred.
  const textured = faces.map((f, i) => ({
    ...entity.faces[i],
    plane: f.plane,
  }));
  return rebaseBrush({ position: entity.position, faces: textured });
}

/** Move a brush by an offset in world space. */
export function moveBrush(
  entity: BrushEntityData,
  delta: Vec3,
): BrushEntityData {
  return { ...entity, position: vec3.add(entity.position, delta) };
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
 * brush's first face; both halves are rebased to their own centres.
 */
export function clipBrushEntity(
  entity: BrushEntityData,
  plane: Plane,
): ClipResult | null {
  const n: Vec3 = [plane[0], plane[1], plane[2]];
  const local: Plane = [
    n[0],
    n[1],
    n[2],
    plane[3] - vec3.dot(n, entity.position),
  ];
  const first = entity.faces[0];
  const cap: Surface | undefined = first
    ? { ...first, offset: [0, 0], rotation: 0, scale: [1, 1] }
    : undefined;
  const { front, back } = clipBrush(entity.faces, local, cap);
  if (!front || !back) return null;
  return {
    front: rebaseBrush({ position: entity.position, faces: front }),
    back: rebaseBrush({ position: entity.position, faces: back }),
  };
}

// ---- Surfaces ---------------------------------------------------------------

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

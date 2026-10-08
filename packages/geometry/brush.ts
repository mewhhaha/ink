/**
 * Convex brushes, the Quake/TrenchBroom way: a solid is the intersection of the
 * half-spaces `n · p <= d` (one per face, in local space) and its geometry is
 * derived from the planes alone. Each face also carries surface parameters.
 */
import {
  invert,
  normalMatrix,
  transformDirection,
  transformPoint,
} from "./mat4.ts";
import type { MeshData } from "./mesh.ts";
import type { Aabb, Mat4, Plane, Vec2, Vec3, Vec4 } from "./types.ts";
import * as vec3 from "./vec3.ts";

/** One face of a brush; mirrors `standard.brush` (texture is a catalog id). */
export interface BrushFace {
  plane: Vec4;
  texture: number;
  color: Vec4;
  offset: Vec2;
  scale: Vec2;
  /** Degrees. */
  rotation: number;
  /** Affine projection in metres before rotation/scale/offset. Zero = automatic. */
  uv_u?: Vec4;
  uv_v?: Vec4;
}

/** Texels per world unit at texture scale 1. Brushes are measured in metres,
 * so a 64 px texture repeats every metre unless scaled. */
export const TEXELS_PER_UNIT = 64;

const EPS = 1e-4;

export function defaultFace(plane: Vec4, texture = 0): BrushFace {
  return {
    plane,
    texture,
    color: [1, 1, 1, 1],
    offset: [0, 0],
    scale: [1, 1],
    rotation: 0,
    uv_u: [0, 0, 0, 0],
    uv_v: [0, 0, 0, 0],
  };
}

const planeNormal = (p: Plane): Vec3 => [p[0], p[1], p[2]];

/** Snap to a grid; a grid of 0 (or less) leaves the value alone. */
export function snap(value: number, grid: number): number {
  return grid > 0 ? Math.round(value / grid) * grid + 0 : value;
}

export const snapVec3 = (v: Vec3, grid: number): Vec3 => [
  snap(v[0], grid),
  snap(v[1], grid),
  snap(v[2], grid),
];

/** Sutherland-Hodgman against the half-space `n · p <= d`. */
function clipPolygon(poly: Vec3[], plane: Plane, eps: number): Vec3[] {
  const n = planeNormal(plane);
  const out: Vec3[] = [];
  const dist = poly.map((p) => vec3.dot(n, p) - plane[3]);
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const a = poly[i], b = poly[j];
    const da = dist[i], db = dist[j];
    const inA = da <= eps, inB = db <= eps;
    if (inA) out.push(a);
    if (inA !== inB) {
      const t = da / (da - db);
      out.push(vec3.lerp(a, b, t));
    }
  }
  return out;
}

function polygonArea2(poly: Vec3[]): number {
  let sum: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < poly.length; i++) {
    sum = vec3.add(
      sum,
      vec3.cross(vec3.sub(poly[i], poly[0]), vec3.sub(poly[i + 1], poly[0])),
    );
  }
  return vec3.length(sum);
}

function dedupe(poly: Vec3[], eps: number): Vec3[] {
  const out: Vec3[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || vec3.distance(last, p) > eps) out.push(p);
  }
  while (out.length > 1 && vec3.distance(out[0], out[out.length - 1]) <= eps) {
    out.pop();
  }
  return out;
}

/**
 * The polygon of every face, aligned with `planes`, vertices counter-clockwise
 * seen from outside. A face the other planes cut away entirely (redundant,
 * duplicated or degenerate) has an empty polygon, so indices stay meaningful.
 */
export function brushPolygons(
  planes: readonly Plane[],
  epsilon = EPS,
): Vec3[][] {
  const big = 1e5;
  return planes.map((plane, i) => {
    const n = vec3.normalize(planeNormal(plane));
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) return [];
    const nd = plane[3] / Math.hypot(plane[0], plane[1], plane[2]);
    // A huge square lying in the plane; u × v = n so it winds CCW from outside.
    const helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = vec3.normalize(vec3.cross(helper, n));
    const v = vec3.cross(n, u);
    const origin = vec3.scale(n, nd);
    const at = (a: number, b: number): Vec3 =>
      vec3.add(
        origin,
        vec3.add(vec3.scale(u, a * big), vec3.scale(v, b * big)),
      );
    let poly: Vec3[] = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
    for (let j = 0; j < planes.length && poly.length >= 3; j++) {
      if (j === i) continue;
      const other = planes[j];
      const ol = Math.hypot(other[0], other[1], other[2]);
      if (ol === 0) continue;
      const unit: Plane = [
        other[0] / ol,
        other[1] / ol,
        other[2] / ol,
        other[3] / ol,
      ];
      const same = Math.abs(unit[0] - n[0]) + Math.abs(unit[1] - n[1]) +
              Math.abs(unit[2] - n[2]) < 1e-6 &&
        Math.abs(unit[3] - nd) < epsilon;
      if (same) {
        if (j < i) return []; // duplicate plane: the first one owns the face
        continue;
      }
      poly = clipPolygon(poly, unit, epsilon);
    }
    poly = dedupe(poly, epsilon);
    if (poly.length < 3 || polygonArea2(poly) < epsilon * epsilon) return [];
    return poly;
  });
}

/** Quake-style axis choice for projecting textures onto a face. Returns the
 * world axes (signed unit vectors) that map to texture u and v. */
function projectionAxes(n: Vec3): [Vec3, Vec3] {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) {
    return n[1] >= 0 ? [[1, 0, 0], [0, 0, -1]] : [[1, 0, 0], [0, 0, 1]];
  }
  if (ax >= az) {
    return n[0] >= 0 ? [[0, 0, -1], [0, -1, 0]] : [[0, 0, 1], [0, -1, 0]];
  }
  return n[2] >= 0 ? [[1, 0, 0], [0, -1, 0]] : [[-1, 0, 0], [0, -1, 0]];
}

/** Texture coordinate of a point on a face. Projects onto the axis plane
 * closest to the face normal, rotates, scales and offsets in texels, then
 * divides by the texture size. */
export function brushUv(
  face: BrushFace,
  point: Vec3,
  size: Vec2 = [TEXELS_PER_UNIT, TEXELS_PER_UNIT],
): Vec2 {
  const [ua, va] = faceUvAxes(face);
  const a = point[0] * ua[0] + point[1] * ua[1] + point[2] * ua[2] + ua[3];
  const b = point[0] * va[0] + point[1] * va[1] + point[2] * va[2] + va[3];
  const r = (face.rotation * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const ra = a * c - b * s;
  const rb = a * s + b * c;
  const sx = face.scale[0] || 1, sy = face.scale[1] || 1;
  const tx = (ra * TEXELS_PER_UNIT) / sx + face.offset[0];
  const ty = (rb * TEXELS_PER_UNIT) / sy + face.offset[1];
  return [tx / size[0], ty / size[1]];
}

export function faceUvAxes(face: BrushFace): [Vec4, Vec4] {
  const axes = projectionAxes(vec3.normalize(planeNormal(face.plane)));
  return [face.uv_u, face.uv_v].map((axis, i) =>
    axis && Math.hypot(axis[0], axis[1], axis[2]) > 1e-12
      ? [...axis]
      : [...axes[i], 0]
  ) as [Vec4, Vec4];
}

/** Carry a surface projection through any invertible affine geometry edit. */
export function transformBrushSurface(
  face: BrushFace,
  matrix: Mat4,
): BrushFace {
  const inverse = invert(matrix);
  const [uv_u, uv_v] = faceUvAxes(face).map((axis) =>
    [0, 1, 2, 3].map((col) =>
      axis.reduce((sum, value, row) => sum + value * inverse[col * 4 + row], 0)
    ) as Vec4
  );
  return { ...face, uv_u, uv_v };
}

export interface BrushMesh extends MeshData {
  /** The brush face each triangle belongs to. */
  faceOfTriangle: Uint32Array;
  /** Face index of each vertex. */
  faceOfVertex: Uint32Array;
  /** Face colour of each vertex (rgba). */
  colors: Float32Array;
}

/** Triangulate a brush: flat-shaded, one fan per face, with UVs from the face
 * projection. Faces without a polygon contribute nothing. `textureSize`
 * receives the face's texture id (0 = none) and returns pixel size. */
export function brushMesh(
  faces: readonly BrushFace[],
  textureSize?: (texture: number) => Vec2 | undefined,
): BrushMesh {
  const polygons = brushPolygons(faces.map((f) => f.plane));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const faceOfTriangle: number[] = [];
  const faceOfVertex: number[] = [];
  polygons.forEach((poly, fi) => {
    if (poly.length < 3) return;
    const face = faces[fi];
    const n = vec3.normalize(planeNormal(face.plane));
    const size = textureSize?.(face.texture) ??
      [TEXELS_PER_UNIT, TEXELS_PER_UNIT];
    const base = positions.length / 3;
    for (const p of poly) {
      positions.push(p[0], p[1], p[2]);
      normals.push(n[0], n[1], n[2]);
      uvs.push(...brushUv(face, p, size));
      colors.push(face.color[0], face.color[1], face.color[2], face.color[3]);
      faceOfVertex.push(fi);
    }
    for (let k = 1; k + 1 < poly.length; k++) {
      indices.push(base, base + k, base + k + 1);
      faceOfTriangle.push(fi);
    }
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    faceOfTriangle: new Uint32Array(faceOfTriangle),
    faceOfVertex: new Uint32Array(faceOfVertex),
    colors: new Float32Array(colors),
  };
}

/** The six faces of an axis-aligned box: +X, -X, +Y, -Y, +Z, -Z. */
export function boxBrush(
  min: Vec3,
  max: Vec3,
  face: Omit<BrushFace, "plane"> = defaultFace([0, 0, 0, 0]),
): BrushFace[] {
  const planes: Vec4[] = [
    [1, 0, 0, max[0]],
    [-1, 0, 0, -min[0]],
    [0, 1, 0, max[1]],
    [0, -1, 0, -min[1]],
    [0, 0, 1, max[2]],
    [0, 0, -1, -min[2]],
  ];
  return planes.map((plane) => ({
    ...structuredClone(face),
    texture: face.texture,
    color: [...face.color] as Vec4,
    offset: [...face.offset] as Vec2,
    scale: [...face.scale] as Vec2,
    rotation: face.rotation,
    plane,
  }));
}

/** Move planes through an affine matrix (negative scales and shears
 * included). Surface parameters are kept as they are. */
export function transformBrush(
  faces: readonly BrushFace[],
  matrix: Mat4,
  textureLock = false,
): BrushFace[] {
  const nm = normalMatrix(matrix);
  return faces.map((face) => {
    const n = planeNormal(face.plane);
    const onPlane = transformPoint(
      matrix,
      vec3.scale(n, face.plane[3] / (vec3.dot(n, n) || 1)),
    );
    const tn = vec3.normalize(transformDirection(nm, n));
    const [uv_u, uv_v] = faceUvAxes(face);
    const surface = textureLock
      ? transformBrushSurface(face, matrix)
      : { ...face, uv_u, uv_v };
    return { ...surface, plane: [tn[0], tn[1], tn[2], vec3.dot(tn, onPlane)] };
  });
}

export function translateBrush(
  faces: readonly BrushFace[],
  offset: Vec3,
): BrushFace[] {
  return faces.map((face) => ({
    ...face,
    plane: [
      face.plane[0],
      face.plane[1],
      face.plane[2],
      face.plane[3] + vec3.dot(planeNormal(face.plane), offset),
    ],
  }));
}

/** Bounds of the solid, or `null` if the planes enclose nothing. */
export function brushBounds(
  faces: readonly (BrushFace | Plane)[],
): Aabb | null {
  const planes = faces.map((f) =>
    Array.isArray(f) ? f as Plane : (f as BrushFace).plane
  );
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const poly of brushPolygons(planes)) {
    for (const p of poly) {
      any = true;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  }
  return any ? { min, max } : null;
}

export function pointInBrush(
  planes: readonly Plane[],
  point: Vec3,
  epsilon = 1e-6,
): boolean {
  return planes.every((pl) =>
    vec3.dot(planeNormal(pl), point) <= pl[3] + epsilon
  );
}

/** Split a brush by a plane. `back` is the part where `n · p <= d`, `front`
 * the part where `n · p >= d`; a side the plane misses is `null`. The new cut
 * face copies `cap` (default: plain face). */
export function clipBrush(
  faces: readonly BrushFace[],
  plane: Plane,
  cap?: Omit<BrushFace, "plane">,
): { front: BrushFace[] | null; back: BrushFace[] | null } {
  const make = (p: Plane): BrushFace => ({
    ...(cap ?? defaultFace(p)),
    plane: p,
  });
  const side = (extra: Plane): BrushFace[] | null => {
    const all = [...faces, make(extra)];
    const polygons = brushPolygons(all.map((f) => f.plane));
    const kept = all.filter((_, i) => polygons[i].length >= 3);
    if (kept.length < 4) return null;
    return kept;
  };
  return {
    back: side(plane),
    front: side([-plane[0], -plane[1], -plane[2], -plane[3]]),
  };
}

/** Unique edges of the solid, for wireframe display. */
export function brushEdges(planes: readonly Plane[]): [Vec3, Vec3][] {
  const seen = new Set<string>();
  const out: [Vec3, Vec3][] = [];
  const q = (p: Vec3) => p.map((x) => Math.round(x * 1e3)).join(",");
  for (const poly of brushPolygons(planes)) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ka = q(a), kb = q(b);
      if (ka === kb) continue;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([a, b]);
    }
  }
  return out;
}

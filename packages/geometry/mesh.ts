/**
 * Indexed triangle meshes and the builtin primitives. Triangles wind
 * counter-clockwise seen from outside; UVs have +v pointing down the image.
 */
import type { Aabb, Vec3 } from "./types.ts";

export interface MeshData {
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz per vertex, unit length. */
  normals: Float32Array;
  /** uv per vertex. */
  uvs: Float32Array;
  indices: Uint32Array;
}

class Builder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];

  vertex(p: Vec3, n: Vec3, u: number, v: number): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.indices.push(a, b, c);
  }

  /** A quad a-b-c-d, counter-clockwise from the front. */
  quad(a: number, b: number, c: number, d: number) {
    this.indices.push(a, b, c, a, c, d);
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
  }
}

export function meshBounds(mesh: Pick<MeshData, "positions">): Aabb {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}

/** Area-weighted smooth normals, for meshes that come without any. */
export function computeNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (l > 1e-12) {
      normals[i] /= l;
      normals[i + 1] /= l;
      normals[i + 2] /= l;
    } else normals[i + 1] = 1;
  }
  return normals;
}

export function cubeMesh(): MeshData {
  const b = new Builder();
  // [normal, u axis, v axis]; v axis points down the texture.
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const corner = (su: number, sv: number): Vec3 => [
      (n[0] + u[0] * su + v[0] * sv) * 0.5,
      (n[1] + u[1] * su + v[1] * sv) * 0.5,
      (n[2] + u[2] * su + v[2] * sv) * 0.5,
    ];
    const i0 = b.vertex(corner(-1, -1), n, 0, 0);
    const i1 = b.vertex(corner(1, -1), n, 1, 0);
    const i2 = b.vertex(corner(1, 1), n, 1, 1);
    const i3 = b.vertex(corner(-1, 1), n, 0, 1);
    b.quad(i0, i1, i2, i3);
  }
  return fixWinding(b.build());
}

/** Flip any triangle whose geometric normal disagrees with its vertex
 * normals, so primitive builders can be written without winding worries. */
function fixWinding(mesh: MeshData): MeshData {
  const p = mesh.positions, n = mesh.normals, idx = mesh.indices;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1: Vec3 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2: Vec3 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const gx = e1[1] * e2[2] - e1[2] * e2[1];
    const gy = e1[2] * e2[0] - e1[0] * e2[2];
    const gz = e1[0] * e2[1] - e1[1] * e2[0];
    const d = gx * (n[a] + n[b] + n[c]) +
      gy * (n[a + 1] + n[b + 1] + n[c + 1]) +
      gz * (n[a + 2] + n[b + 2] + n[c + 2]);
    if (d < 0) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
  }
  return mesh;
}

export function planeMesh(): MeshData {
  const b = new Builder();
  const n: Vec3 = [0, 1, 0];
  const a0 = b.vertex([-0.5, 0, -0.5], n, 0, 0);
  const a1 = b.vertex([0.5, 0, -0.5], n, 1, 0);
  const a2 = b.vertex([0.5, 0, 0.5], n, 1, 1);
  const a3 = b.vertex([-0.5, 0, 0.5], n, 0, 1);
  b.quad(a0, a3, a2, a1);
  return fixWinding(b.build());
}

/** A latitude/longitude ring grid between two poles described by `profile`,
 * a list of [radius, y, normalAngleFromHorizontal] rings from top to bottom. */
function revolve(
  b: Builder,
  profile: { r: number; y: number; nr: number; ny: number; v: number }[],
  segments: number,
) {
  const rows = profile.length;
  const first = b.positions.length / 3;
  for (const ring of profile) {
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const c = Math.cos(a), si = Math.sin(a);
      b.vertex(
        [c * ring.r, ring.y, si * ring.r],
        [c * ring.nr, ring.ny, si * ring.nr],
        s / segments,
        ring.v,
      );
    }
  }
  const stride = segments + 1;
  for (let r = 0; r < rows - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = first + r * stride + s;
      const c = first + (r + 1) * stride + s;
      b.quad(a, c, c + 1, a + 1);
    }
  }
}

export function sphereMesh(segments = 32, rings = 16): MeshData {
  const b = new Builder();
  const profile = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    profile.push({
      r: Math.sin(phi) * 0.5,
      y: Math.cos(phi) * 0.5,
      nr: Math.sin(phi),
      ny: Math.cos(phi),
      v: r / rings,
    });
  }
  revolve(b, profile, segments);
  return fixWinding(b.build());
}

function disc(
  b: Builder,
  y: number,
  radius: number,
  up: boolean,
  segments: number,
) {
  const n: Vec3 = [0, up ? 1 : -1, 0];
  const center = b.vertex([0, y, 0], n, 0.5, 0.5);
  const first = b.positions.length / 3;
  for (let s = 0; s <= segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    const c = Math.cos(a), si = Math.sin(a);
    b.vertex([c * radius, y, si * radius], n, 0.5 + c * 0.5, 0.5 + si * 0.5);
  }
  for (let s = 0; s < segments; s++) b.tri(center, first + s + 1, first + s);
}

export function cylinderMesh(segments = 32): MeshData {
  const b = new Builder();
  revolve(b, [
    { r: 0.5, y: 0.5, nr: 1, ny: 0, v: 0 },
    { r: 0.5, y: -0.5, nr: 1, ny: 0, v: 1 },
  ], segments);
  disc(b, 0.5, 0.5, true, segments);
  disc(b, -0.5, 0.5, false, segments);
  return fixWinding(b.build());
}

export function coneMesh(segments = 32): MeshData {
  const b = new Builder();
  // Slope normal of a cone with radius 0.5 and height 1.
  const k = Math.hypot(1, 0.5);
  const nr = 1 / k, ny = 0.5 / k;
  revolve(b, [
    { r: 0, y: 0.5, nr, ny, v: 0 },
    { r: 0.5, y: -0.5, nr, ny, v: 1 },
  ], segments);
  disc(b, -0.5, 0.5, false, segments);
  return fixWinding(b.build());
}

export function capsuleMesh(segments = 32, capRings = 8): MeshData {
  const b = new Builder();
  const radius = 0.25;
  const half = 0.25; // half the straight section
  const profile = [];
  for (let r = 0; r <= capRings; r++) {
    const phi = (r / capRings) * (Math.PI / 2);
    profile.push({
      r: Math.sin(phi) * radius,
      y: half + Math.cos(phi) * radius,
      nr: Math.sin(phi),
      ny: Math.cos(phi),
      v: 0,
    });
  }
  for (let r = 0; r <= capRings; r++) {
    const phi = Math.PI / 2 + (r / capRings) * (Math.PI / 2);
    profile.push({
      r: Math.sin(phi) * radius,
      y: -half + Math.cos(phi) * radius,
      nr: Math.sin(phi),
      ny: Math.cos(phi),
      v: 1,
    });
  }
  profile.forEach((ring, i) => ring.v = i / (profile.length - 1));
  revolve(b, profile, segments);
  return fixWinding(b.build());
}

const builtins: Record<string, () => MeshData> = {
  "builtin:cube": cubeMesh,
  "builtin:sphere": () => sphereMesh(),
  "builtin:plane": planeMesh,
  "builtin:cylinder": () => cylinderMesh(),
  "builtin:capsule": () => capsuleMesh(),
  "builtin:cone": () => coneMesh(),
};

/** Mesh for a `builtin:*` catalog path, or `undefined` for any other path. */
export function builtinMesh(path: string): MeshData | undefined {
  return builtins[path]?.();
}

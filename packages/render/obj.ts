/** Wavefront .obj loading: v/vt/vn/f, polygons fan-triangulated, vertices
 * merged by their index triple. Missing normals are computed. */
import { computeNormals } from "@ink/geometry";
import type { RenderMeshData } from "./types.ts";

export function parseObj(text: string): RenderMeshData {
  const v: number[] = [], vt: number[] = [], vn: number[] = [];
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const indices: number[] = [];
  const merged = new Map<string, number>();
  let hasNormals = true;
  const resolve = (token: string, count: number) => {
    const n = parseInt(token, 10);
    return n < 0 ? count + n : n - 1;
  };
  const vertex = (token: string): number => {
    const known = merged.get(token);
    if (known !== undefined) return known;
    const [a, b, c] = token.split("/");
    const pi = resolve(a, v.length / 3) * 3;
    positions.push(v[pi], v[pi + 1], v[pi + 2]);
    if (b) {
      const ti = resolve(b, vt.length / 2) * 2;
      uvs.push(vt[ti], 1 - vt[ti + 1]);
    } else uvs.push(0, 0);
    if (c) {
      const ni = resolve(c, vn.length / 3) * 3;
      normals.push(vn[ni], vn[ni + 1], vn[ni + 2]);
    } else {
      hasNormals = false;
      normals.push(0, 0, 0);
    }
    const index = merged.size;
    merged.set(token, index);
    return index;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case "v":
        v.push(+parts[1], +parts[2], +parts[3]);
        break;
      case "vt":
        vt.push(+parts[1], +(parts[2] ?? 0));
        break;
      case "vn":
        vn.push(+parts[1], +parts[2], +parts[3]);
        break;
      case "f": {
        const ids = parts.slice(1).map(vertex);
        for (let i = 1; i + 1 < ids.length; i++) {
          indices.push(ids[0], ids[i], ids[i + 1]);
        }
        break;
      }
    }
  }
  if (indices.length === 0) throw new Error("OBJ has no faces");
  const p = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  return {
    positions: p,
    normals: hasNormals ? new Float32Array(normals) : computeNormals(p, idx),
    uvs: new Float32Array(uvs),
    indices: idx,
  };
}

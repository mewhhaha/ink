/** Static triangles, a median-split BVH, and one padded chart per brush face. */
import { type Mat4, mat4, type Vec3, vec3 } from "@ink/geometry";
import type { AssetStore, RenderMeshData, RenderScene } from "./types.ts";
import { srgbToLinear } from "./gpu.ts";
import { modelDraws, skinMesh } from "./model.ts";

export const LIGHTMAP_TEXELS = 12;
export const LIGHTMAP_TILE = LIGHTMAP_TEXELS + 2;
export const CHART_FLOATS = 24;

interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  color: Vec3;
  emission: Vec3;
}
export interface LightmapGeometry {
  triangles: Float32Array;
  nodes: Float32Array;
  charts: Float32Array;
  vertices: Float32Array;
  offsets: Map<number, number>;
  size: number;
  columns: number;
  count: number;
}

export function lightmapGeometry(
  scene: RenderScene,
  assets?: AssetStore,
): LightmapGeometry {
  const triangles: Triangle[] = [];
  const charts: number[] = [], vertices: number[] = [];
  const offsets = new Map<number, number>();
  const mesh = (
    data: RenderMeshData,
    matrix: Mat4,
    color: Vec3,
    emission: Vec3,
  ) => {
    const point = (index: number): Vec3 =>
      mat4.transformPoint(matrix, [
        data.positions[index * 3],
        data.positions[index * 3 + 1],
        data.positions[index * 3 + 2],
      ]);
    for (let i = 0; i < data.indices.length; i += 3) {
      const a = data.indices[i],
        b = data.indices[i + 1],
        c = data.indices[i + 2];
      const tint = color.map((v, k) =>
        v *
        (data.colors
          ? (srgbToLinear(data.colors[a * 4 + k]) +
            srgbToLinear(data.colors[b * 4 + k]) +
            srgbToLinear(data.colors[c * 4 + k])) / 3
          : 1)
      ) as Vec3;
      triangles.push({
        a: point(a),
        b: point(b),
        c: point(c),
        color: tint,
        emission,
      });
    }
  };
  for (const brush of scene.brushes) {
    if (brush.bakeLighting === false) continue;
    offsets.set(brush.entity, charts.length / CHART_FLOATS + 1);
    for (const local of brush.geometry.polygons) {
      if (local.length < 3) {
        charts.push(...new Array(CHART_FLOATS).fill(0));
        continue;
      }
      const polygon = local.map((p) => mat4.transformPoint(brush.matrix, p));
      const normal = vec3.normalize(
        mat4.transformDirection(
          mat4.normalMatrix(brush.matrix),
          vec3.cross(
            vec3.sub(local[1], local[0]),
            vec3.sub(local[2], local[0]),
          ),
        ),
      );
      if (
        vec3.dot(
          vec3.cross(
            vec3.sub(polygon[1], polygon[0]),
            vec3.sub(polygon[2], polygon[0]),
          ),
          normal,
        ) < 0
      ) polygon.reverse();
      const u = vec3.normalize(vec3.sub(polygon[1], polygon[0]));
      const v = vec3.cross(normal, u);
      const us = polygon.map((p) => vec3.dot(p, u)),
        vs = polygon.map((p) => vec3.dot(p, v));
      const minU = Math.min(...us), minV = Math.min(...vs);
      const extentU = Math.max(...us) - minU, extentV = Math.max(...vs) - minV;
      const origin = vec3.add(
        vec3.add(vec3.scale(u, minU), vec3.scale(v, minV)),
        vec3.scale(normal, vec3.dot(polygon[0], normal)),
      );
      charts.push(
        ...origin,
        0,
        ...u,
        extentU,
        ...v,
        extentV,
        ...normal,
        0,
        vertices.length / 4,
        polygon.length,
        0,
        0,
        0,
        0,
        0,
        0,
      );
      for (const p of polygon) vertices.push(...p, 0);
    }
    for (const part of brush.geometry.parts) {
      mesh(part.mesh, brush.matrix, [1, 1, 1], [0, 0, 0]);
    }
  }
  for (const draw of scene.draws) {
    if (!draw.bakeLighting || !assets) continue;
    const model = assets.modelData(draw.mesh);
    for (const part of model ? modelDraws(model, draw) : [draw]) {
      if (part.alphaMode === "blend" || part.alphaMode === "additive") continue;
      let data = assets.meshData(part.mesh);
      if (!data) continue;
      if (part.skin || part.morphWeights) {
        data = skinMesh(data, part.skin, part.morphWeights);
      }
      mesh(
        data,
        part.matrix,
        part.color.slice(0, 3).map(srgbToLinear) as Vec3,
        part.emissive.slice(0, 3).map((v) =>
          srgbToLinear(v) * part.emissive[3] * part.emissiveStrength
        ) as Vec3,
      );
    }
  }
  const packed: number[] = [], nodes: number[] = [];
  const integers: [number, number][] = [];
  const build = (list: Triangle[]): number => {
    const at = nodes.length / 8;
    const lo: Vec3 = [Infinity, Infinity, Infinity],
      hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const triangle of list) {
      for (const p of [triangle.a, triangle.b, triangle.c]) {
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], p[k]);
          hi[k] = Math.max(hi[k], p[k]);
        }
      }
    }
    nodes.push(...lo, 0, ...hi, 0);
    if (list.length <= 4) {
      integers.push([at * 8 + 3, packed.length / 20], [
        at * 8 + 7,
        (0x80000000 | list.length) >>> 0,
      ]);
      for (const t of list) {
        packed.push(
          ...t.a,
          0,
          ...vec3.sub(t.b, t.a),
          0,
          ...vec3.sub(t.c, t.a),
          0,
          ...t.color,
          0,
          ...t.emission,
          0,
        );
      }
    } else {
      const extent = vec3.sub(hi, lo),
        axis = extent.indexOf(Math.max(...extent));
      list.sort((a, b) =>
        (a.a[axis] + a.b[axis] + a.c[axis]) -
        (b.a[axis] + b.b[axis] + b.c[axis])
      );
      const mid = Math.floor(list.length / 2);
      integers.push([at * 8 + 3, build(list.slice(0, mid))], [
        at * 8 + 7,
        build(list.slice(mid)),
      ]);
    }
    return at;
  };
  if (triangles.length) build(triangles);
  const bvh = new Float32Array(Math.max(8, nodes.length));
  bvh.set(nodes);
  const words = new Uint32Array(bvh.buffer);
  if (!triangles.length) words[7] = 0x80000000;
  for (const [at, value] of integers) words[at] = value;
  const count = charts.length / CHART_FLOATS,
    columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  for (let i = 0; i < count; i++) {
    charts[i * CHART_FLOATS + 20] = (i % columns) * LIGHTMAP_TILE;
    charts[i * CHART_FLOATS + 21] = Math.floor(i / columns) * LIGHTMAP_TILE;
  }
  return {
    triangles: new Float32Array(packed.length ? packed : new Array(20).fill(0)),
    nodes: bvh,
    charts: new Float32Array(
      charts.length ? charts : new Array(CHART_FLOATS).fill(0),
    ),
    vertices: new Float32Array(vertices.length ? vertices : [0, 0, 0, 0]),
    offsets,
    count,
    columns,
    size: columns * LIGHTMAP_TILE,
  };
}

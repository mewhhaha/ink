/**
 * Turns a RenderScene into GPU work for one frame: draws are grouped into
 * instanced batches (same mesh, texture and shadow flag), instance data is
 * packed into one array, and the bounds of shadow casters are collected.
 */
import {
  type Aabb,
  aabbEmpty,
  aabbTransform,
  aabbUnion,
  type Mat4,
  mat4,
} from "@ink/geometry";
import type { Assets, GpuMesh } from "./assets.ts";
import { INSTANCE_FLOATS, srgbToLinear } from "./gpu.ts";
import type { Overlays, RenderScene } from "./types.ts";

export interface Batch {
  mesh: GpuMesh;
  /** Group 1: base colour, normal and ORM textures. */
  material: GPUBindGroup;
  first: number;
  count: number;
  castsShadows: boolean;
  /** Brush faces have no mesh-style wireframe; their edges are lines. */
  brush: boolean;
  /** Contains a selected or hovered instance. */
  flagged: boolean;
}

export interface Plan {
  batches: Batch[];
  data: Float32Array;
  instanceCount: number;
  /** Bounds of everything that casts shadows. */
  casterBounds: Aabb;
}

interface Pending {
  mesh: GpuMesh;
  material: GPUBindGroup;
  castsShadows: boolean;
  brush: boolean;
  flagged: boolean;
  items: Item[];
}
interface Item {
  matrix: Mat4;
  color: [number, number, number, number];
  emissive: [number, number, number];
  roughness: number;
  metallic: number;
  uv: [number, number];
  normalStrength: number;
  id: number;
  flags: number;
}

const normalCache = new WeakMap<Mat4, Mat4>();
function normalOf(matrix: Mat4): Mat4 {
  let n = normalCache.get(matrix);
  if (!n) normalCache.set(matrix, n = mat4.normalMatrix(matrix));
  return n;
}

export function buildPlan(
  scene: RenderScene,
  overlays: Overlays,
  assets: Assets,
  frame: number,
): Plan {
  const selected = new Set(overlays.selection ?? []);
  const hovered = overlays.hovered ?? 0;
  const flagsOf = (entity: number) =>
    (selected.has(entity) ? 1 : 0) | (entity === hovered ? 2 : 0);

  const pending = new Map<string, Pending>();
  let casterBounds = aabbEmpty();

  const add = (
    mesh: GpuMesh,
    materialKey: string,
    material: GPUBindGroup,
    castsShadows: boolean,
    brush: boolean,
    item: Item,
  ) => {
    const key = `${mesh.key}|${materialKey}|${castsShadows ? 1 : 0}`;
    let batch = pending.get(key);
    if (!batch) {
      pending.set(
        key,
        batch = {
          mesh,
          material,
          castsShadows,
          brush,
          flagged: false,
          items: [],
        },
      );
    }
    batch.items.push(item);
    if (item.flags) batch.flagged = true;
    if (castsShadows) {
      casterBounds = aabbUnion(
        casterBounds,
        aabbTransform(mesh.bounds, item.matrix),
      );
    }
  };

  for (const draw of scene.draws) {
    const mesh = assets.getMesh(draw.mesh, frame);
    if (!mesh) continue; // still loading
    const failed = assets.meshFailed(draw.mesh);
    const base = failed ? assets.placeholder : assets.getTexture(draw.texture);
    const normal = assets.getTexture(draw.normalMap, "normal");
    const orm = assets.getTexture(draw.ormMap, "orm");
    add(
      mesh,
      `${base.id}:${normal.id}:${orm.id}`,
      assets.material(base, normal, orm),
      draw.castShadows,
      false,
      {
        matrix: draw.matrix,
        color: [
          srgbToLinear(draw.color[0]),
          srgbToLinear(draw.color[1]),
          srgbToLinear(draw.color[2]),
          draw.color[3],
        ],
        emissive: [
          srgbToLinear(draw.emissive[0]) * draw.emissive[3] *
          draw.emissiveStrength,
          srgbToLinear(draw.emissive[1]) * draw.emissive[3] *
          draw.emissiveStrength,
          srgbToLinear(draw.emissive[2]) * draw.emissive[3] *
          draw.emissiveStrength,
        ],
        roughness: draw.roughness,
        metallic: draw.metallic,
        uv: draw.uvScale,
        normalStrength: draw.normalStrength,
        id: draw.entity,
        flags: flagsOf(draw.entity),
      },
    );
  }

  for (const brush of scene.brushes) {
    for (const part of brush.geometry.parts) {
      if (!assets.hasMesh(part.key)) assets.register(part.key, part.mesh);
      const mesh = assets.getMesh(part.key, frame)!;
      const texture = assets.getTexture(part.texture);
      add(
        mesh,
        `${texture.id}`,
        assets.material(texture, assets.flatNormal, assets.whiteLinear),
        true,
        true,
        {
          matrix: brush.matrix,
          color: [1, 1, 1, 1],
          emissive: [0, 0, 0],
          roughness: 0.85,
          metallic: 0,
          uv: part.texture
            ? [1 / texture.size[0], 1 / texture.size[1]]
            : [1, 1],
          normalStrength: 1,
          id: brush.entity,
          flags: flagsOf(brush.entity),
        },
      );
    }
  }

  const total = [...pending.values()].reduce((n, b) => n + b.items.length, 0);
  const data = new Float32Array(Math.max(1, total) * INSTANCE_FLOATS);
  const ints = new Uint32Array(data.buffer);
  const batches: Batch[] = [];
  let index = 0;
  for (const p of pending.values()) {
    batches.push({
      mesh: p.mesh,
      material: p.material,
      first: index,
      count: p.items.length,
      castsShadows: p.castsShadows,
      brush: p.brush,
      flagged: p.flagged,
    });
    for (const item of p.items) {
      const o = index * INSTANCE_FLOATS;
      data.set(item.matrix, o);
      const n = normalOf(item.matrix);
      data.set(
        [n[0], n[1], n[2], 0, n[4], n[5], n[6], 0, n[8], n[9], n[10], 0],
        o + 16,
      );
      data.set(item.color, o + 28);
      data.set([...item.emissive, item.roughness], o + 32);
      data.set(
        [item.metallic, item.uv[0], item.uv[1], item.normalStrength],
        o + 36,
      );
      ints[o + 40] = item.id;
      ints[o + 41] = item.flags;
      index++;
    }
  }
  return { batches, data, instanceCount: total, casterBounds };
}

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
import type { Camera, Draw, Overlays, RenderScene } from "./types.ts";
import { modelDraws } from "./model.ts";

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
  alphaMode: NonNullable<Draw["alphaMode"]>;
  doubleSided: boolean;
  depth: number;
}

export interface Plan {
  batches: Batch[];
  data: Float32Array;
  joints: Float32Array;
  morphs: Float32Array;
  instanceBounds: Aabb[];
  instanceKeys: string[];
  instanceMeshes: GpuMesh[];
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
  alphaMode: NonNullable<Draw["alphaMode"]>;
  doubleSided: boolean;
  depth: number;
}
interface Item {
  motionKey?: string;
  matrix: Mat4;
  color: [number, number, number, number];
  emissive: [number, number, number];
  roughness: number;
  metallic: number;
  uv: [number, number];
  normalStrength: number;
  id: number;
  flags: number;
  alphaMode: number;
  alphaCutoff: number;
  skin?: Mat4[];
  morphWeights?: number[];
  bounds?: Aabb;
  uvMask?: number;
  materialFlags?: number;
  occlusionStrength?: number;
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
  camera: Camera,
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
    alphaMode: Pending["alphaMode"] = "opaque",
    doubleSided = false,
  ) => {
    const transparent = alphaMode === "blend" || alphaMode === "additive";
    castsShadows &&= !transparent;
    const key = `${mesh.key}|${materialKey}|${
      castsShadows ? 1 : 0
    }|${alphaMode}|${doubleSided}|${transparent ? pending.size : ""}`;
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
          alphaMode,
          doubleSided,
          depth: transparent
            ? -mat4.transformPoint(
              camera.view,
              mat4.transformPoint(item.matrix, [
                ((item.bounds ?? mesh.bounds).min[0] +
                  (item.bounds ?? mesh.bounds).max[0]) / 2,
                ((item.bounds ?? mesh.bounds).min[1] +
                  (item.bounds ?? mesh.bounds).max[1]) / 2,
                ((item.bounds ?? mesh.bounds).min[2] +
                  (item.bounds ?? mesh.bounds).max[2]) / 2,
              ]),
            )[2]
            : 0,
        },
      );
    }
    batch.items.push(item);
    if (item.flags) batch.flagged = true;
    if (castsShadows) {
      casterBounds = aabbUnion(
        casterBounds,
        aabbTransform(item.bounds ?? mesh.bounds, item.matrix),
      );
    }
  };

  const draws = scene.draws.flatMap((draw) => {
    const model = assets.modelData(draw.mesh);
    return model ? modelDraws(model, draw) : [draw];
  });
  for (const draw of draws) {
    const mesh = assets.getMesh(draw.mesh, frame);
    if (!mesh) continue; // still loading
    const failed = assets.meshFailed(draw.mesh);
    const base = failed ? assets.placeholder : assets.getTexture(draw.texture);
    const normal = assets.getTexture(draw.normalMap, "normal");
    const orm = assets.getTexture(draw.ormMap, "orm");
    const m = draw.material;
    const occlusion = assets.getTexture(m?.occlusion?.uri, "orm");
    const emission = assets.getTexture(m?.emission?.uri);
    const maps = [
      m?.base,
      m?.normal,
      m?.metallicRoughness,
      m?.occlusion,
      m?.emission,
    ];
    const samplers = m ? maps.map((t) => t?.sampler) : [];
    const material = assets.material(base, normal, orm, {
      occlusion,
      emission,
      samplers,
    });
    let bounds = mesh.bounds;
    if (draw.morphWeights?.length && mesh.morphBounds) {
      bounds = { min: [...bounds.min], max: [...bounds.max] };
      mesh.morphBounds.forEach((b, i) => {
        const w = draw.morphWeights![i] ?? 0;
        for (let k = 0; k < 3; k++) {
          bounds.min[k] += Math.min(b.min[k] * w, b.max[k] * w);
          bounds.max[k] += Math.max(b.min[k] * w, b.max[k] * w);
        }
      });
    }
    if (draw.skin?.length) {
      const localBounds = bounds;
      bounds = draw.skin.reduce(
        (box, joint) => aabbUnion(box, aabbTransform(localBounds, joint)),
        aabbEmpty(),
      );
    }
    add(
      mesh,
      `${base.id}:${normal.id}:${orm.id}:${occlusion.id}:${emission.id}:${
        JSON.stringify(samplers)
      }`,
      material,
      draw.castShadows,
      false,
      {
        matrix: draw.matrix,
        motionKey: draw.motionKey,
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
        alphaMode: ["opaque", "mask", "blend", "additive"].indexOf(
          draw.alphaMode ?? "opaque",
        ),
        alphaCutoff: draw.alphaCutoff ?? 0.5,
        skin: draw.skin,
        morphWeights: draw.morphWeights,
        bounds,
        uvMask: maps.reduce(
          (mask, t, i) => mask | ((t?.texCoord ?? 0) << i),
          0,
        ),
        materialFlags: m ? (m.unlit ? 1 : 0) | 2 : 0,
        occlusionStrength: m?.occlusionStrength ?? 1,
      },
      draw.alphaMode,
      draw.doubleSided,
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
          alphaMode: 0,
          alphaCutoff: 0.5,
        },
      );
    }
  }

  const total = [...pending.values()].reduce((n, b) => n + b.items.length, 0);
  const data = new Float32Array(Math.max(1, total) * INSTANCE_FLOATS);
  const ints = new Uint32Array(data.buffer);
  const batches: Batch[] = [];
  const joints: number[] = [];
  const palettes = new Map<Mat4[], number>();
  const morphs: number[] = [];
  const morphTargets = new Map<GpuMesh, number>();
  const instanceBounds: Aabb[] = [];
  const instanceKeys: string[] = [], instanceMeshes: GpuMesh[] = [];
  const duplicates = new Map<string, number>();
  let index = 0;
  // Opaque batches retain instancing; transparent surfaces are individual,
  // ordered back-to-front by their transformed bounds' centres.
  const ordered = [...pending.values()].sort((a, b) => b.depth - a.depth);
  for (const p of ordered) {
    batches.push({
      mesh: p.mesh,
      material: p.material,
      first: index,
      count: p.items.length,
      castsShadows: p.castsShadows,
      brush: p.brush,
      flagged: p.flagged,
      alphaMode: p.alphaMode,
      doubleSided: p.doubleSided,
      depth: p.depth,
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
      ints[o + 42] = item.alphaMode;
      data[o + 43] = item.alphaCutoff;
      let skinOffset = 0;
      if (item.skin?.length) {
        const known = palettes.get(item.skin);
        if (known !== undefined) skinOffset = known;
        else {
          skinOffset = joints.length / 32;
          palettes.set(item.skin, skinOffset);
          for (const matrix of item.skin) {
            joints.push(...matrix, ...mat4.normalMatrix(matrix));
          }
        }
      }
      ints.set([
        skinOffset,
        item.skin?.length ?? 0,
        item.uvMask ?? 0,
        item.materialFlags ?? 0,
      ], o + 44);
      data[o + 48] = item.occlusionStrength ?? 1;
      if (item.morphWeights?.length && p.mesh.data.targets?.length) {
        const count = p.mesh.data.positions.length / 3;
        let targetOffset = morphTargets.get(p.mesh);
        if (targetOffset === undefined) {
          targetOffset = morphs.length;
          morphTargets.set(p.mesh, targetOffset);
          for (const target of p.mesh.data.targets) {
            for (let vertex = 0; vertex < count; vertex++) {
              for (const attr of [target.positions, target.normals]) {
                for (let k = 0; k < 3; k++) {
                  morphs.push(attr?.[vertex * 3 + k] ?? 0);
                }
              }
            }
          }
        }
        ints.set([
          morphs.length,
          targetOffset,
          count,
          p.mesh.data.targets.length,
        ], o + 52);
        for (let t = 0; t < p.mesh.data.targets.length; t++) {
          morphs.push(item.morphWeights[t] ?? 0);
        }
      }
      instanceBounds.push(item.bounds ?? p.mesh.bounds);
      const key = `${item.id}:${p.mesh.key}:${item.motionKey ?? ""}`;
      const occurrence = duplicates.get(key) ?? 0;
      duplicates.set(key, occurrence + 1);
      instanceKeys.push(`${key}:${occurrence}`);
      instanceMeshes.push(p.mesh);
      index++;
    }
  }
  return {
    batches,
    data,
    joints: joints.length ? new Float32Array(joints) : new Float32Array(32),
    morphs: morphs.length ? new Float32Array(morphs) : new Float32Array(1),
    instanceBounds,
    instanceKeys,
    instanceMeshes,
    instanceCount: total,
    casterBounds,
  };
}

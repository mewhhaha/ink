/** A glTF scene and its deterministic, stateless animation poses. */
import {
  type Mat4,
  mat4,
  type Quat,
  quat,
  type Vec3,
  vec3,
  type Vec4,
} from "@ink/geometry";
import type { Draw, RenderMeshData } from "./types.ts";
import { srgbToLinear } from "./gpu.ts";

export interface ModelTexture {
  uri: string;
  texCoord: number;
  sampler: {
    magFilter?: number;
    minFilter?: number;
    wrapS?: number;
    wrapT?: number;
  };
}
export interface ModelMaterial {
  name: string;
  /** Factors in the renderer's sRGB convention; glTF stores linear factors. */
  color: Vec4;
  roughness: number;
  metallic: number;
  emissive: Vec4;
  emissiveStrength: number;
  normalStrength: number;
  occlusionStrength: number;
  alphaMode: Draw["alphaMode"];
  alphaCutoff: number;
  doubleSided: boolean;
  unlit: boolean;
  base?: ModelTexture;
  normal?: ModelTexture;
  metallicRoughness?: ModelTexture;
  occlusion?: ModelTexture;
  emission?: ModelTexture;
}
export interface ModelNode {
  name: string;
  children: number[];
  mesh?: number;
  skin?: number;
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
  matrix?: Mat4;
  weights: number[];
}
export interface ModelPrimitive {
  mesh: RenderMeshData;
  material: number;
}
export interface ModelChannel {
  node: number;
  path: "translation" | "rotation" | "scale" | "weights";
  /** Number of morph weights for a weights channel. */
  width?: number;
  interpolation: "STEP" | "LINEAR" | "CUBICSPLINE";
  times: Float32Array;
  values: Float32Array;
}
export interface ModelClip {
  name: string;
  duration: number;
  channels: ModelChannel[];
}
export interface Model {
  /** External binary buffers that invalidate this model when edited. */
  dependencies: string[];
  nodes: ModelNode[];
  roots: number[];
  meshes: ModelPrimitive[][];
  materials: ModelMaterial[];
  skins: { joints: number[]; inverseBind: Mat4[] }[];
  clips: ModelClip[];
}
export interface AnimationPose {
  /** One-based clip indices; 0 is the bind pose. */
  clip: number;
  time: number;
  loop: boolean;
  previousClip?: number;
  previousTime?: number;
  previousLoop?: boolean;
  /** 0 is the previous pose, 1 is the current one. */
  blend?: number;
}
export interface ModelPose {
  /** Transforms in the asset's coordinate system. */
  nodes: Mat4[];
  /** Local-to-mesh palettes, keyed by the node carrying a skin. */
  skins: Map<number, Mat4[]>;
  weights: number[][];
}

/** glTF interpolation, including time-scaled cubic tangents and quaternion
 * normalization. No accumulated clock or pose survives between calls. */
export function sampleChannel(channel: ModelChannel, time: number): number[] {
  const { times, values, interpolation, path } = channel;
  const width = path === "weights"
    ? channel.width!
    : path === "rotation"
    ? 4
    : 3;
  const cubic = interpolation === "CUBICSPLINE";
  const value = (index: number, part = 1) => {
    const offset = (cubic ? index * 3 + part : index) * width;
    return Array.from(values.subarray(offset, offset + width));
  };
  if (time <= times[0]) return value(0);
  if (time >= times[times.length - 1]) return value(times.length - 1);
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const a = value(lo), b = value(hi);
  if (interpolation === "STEP") return a;
  const duration = times[hi] - times[lo];
  const t = (time - times[lo]) / duration;
  if (!cubic && path === "rotation") return quat.slerp(a as Quat, b as Quat, t);
  const result = a.map((v, i) => {
    if (!cubic) return v + (b[i] - v) * t;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * v +
      (t3 - 2 * t2 + t) * duration * value(lo, 2)[i] +
      (-2 * t3 + 3 * t2) * b[i] + (t3 - t2) * duration * value(hi, 0)[i];
  });
  return path === "rotation" ? quat.normalize(result as Quat) : result;
}

function locals(model: Model, index: number, time: number, loop: boolean) {
  const poses = model.nodes.map((n) => ({
    t: [...n.translation] as Vec3,
    r: [...n.rotation] as Quat,
    s: [...n.scale] as Vec3,
    w: [...n.weights],
  }));
  const clip = model.clips[index - 1];
  if (!clip) return poses;
  if (loop && clip.duration > 0) {
    time = ((time % clip.duration) + clip.duration) % clip.duration;
  }
  for (const c of clip.channels) {
    const value = sampleChannel(c, time);
    const p = poses[c.node];
    if (c.path === "translation") p.t = value as Vec3;
    else if (c.path === "rotation") p.r = value as Quat;
    else if (c.path === "scale") p.s = value as Vec3;
    else p.w = value;
  }
  return poses;
}

export function poseModel(model: Model, animation?: AnimationPose): ModelPose {
  const local = locals(
    model,
    animation?.clip ?? 0,
    animation?.time ?? 0,
    animation?.loop ?? false,
  );
  const blend = Math.max(0, Math.min(1, animation?.blend ?? 1));
  if (blend < 1 && animation) {
    const previous = locals(
      model,
      animation.previousClip ?? 0,
      animation.previousTime ?? 0,
      animation.previousLoop ?? animation.loop,
    );
    for (let i = 0; i < local.length; i++) {
      const a = previous[i], b = local[i];
      b.t = a.t.map((v, k) => v + (b.t[k] - v) * blend) as Vec3;
      b.s = a.s.map((v, k) => v + (b.s[k] - v) * blend) as Vec3;
      b.r = quat.slerp(a.r, b.r, blend);
      b.w = a.w.map((v, k) => v + (b.w[k] - v) * blend);
    }
  }
  const parents = new Map<number, number>();
  model.nodes.forEach((n, i) => n.children.forEach((c) => parents.set(c, i)));
  const nodes: Mat4[] = [];
  const visiting = new Set<number>();
  const node = (i: number): Mat4 => {
    if (nodes[i]) return nodes[i];
    if (visiting.has(i)) {
      throw new Error("glTF node hierarchy contains a cycle");
    }
    visiting.add(i);
    const p = local[i];
    const own = model.nodes[i].matrix ?? mat4.compose(p.t, p.r, p.s);
    const parent = parents.get(i);
    nodes[i] = parent === undefined ? own : mat4.multiply(node(parent), own);
    visiting.delete(i);
    return nodes[i];
  };
  model.nodes.forEach((_, i) => node(i));
  const skins = new Map<number, Mat4[]>();
  model.nodes.forEach((n, i) => {
    if (n.skin === undefined) return;
    const skin = model.skins[n.skin];
    const inverse = mat4.invert(nodes[i]);
    skins.set(
      i,
      skin.joints.map((joint, k) =>
        mat4.multiply(inverse, mat4.multiply(nodes[joint], skin.inverseBind[k]))
      ),
    );
  });
  return { nodes, skins, weights: local.map((p) => p.w) };
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function visibleNodes(model: Model): number[] {
  const result: number[] = [];
  const visit = (i: number) => {
    result.push(i);
    model.nodes[i].children.forEach(visit);
  };
  model.roots.forEach(visit);
  return result;
}

/** CPU reference for tools, import bounds and GPU skinning tests. */
export function skinMesh(
  mesh: RenderMeshData,
  palette?: Mat4[],
  morphWeights?: number[],
): RenderMeshData {
  if (mesh.targets && morphWeights) {
    const positions = mesh.positions.slice(), normals = mesh.normals.slice();
    mesh.targets.forEach((t, i) => {
      const weight = morphWeights[i] ?? 0;
      for (let k = 0; k < positions.length; k++) {
        positions[k] += (t.positions?.[k] ?? 0) * weight;
        normals[k] += (t.normals?.[k] ?? 0) * weight;
      }
    });
    mesh = { ...mesh, positions, normals, targets: undefined };
  }
  if (!palette || !mesh.joints || !mesh.weights) return mesh;
  const positions = new Float32Array(mesh.positions.length),
    normals = new Float32Array(mesh.normals.length);
  const normalMatrices = palette.map(mat4.normalMatrix);
  for (let i = 0; i < positions.length / 3; i++) {
    const p = Array.from(mesh.positions.subarray(i * 3, i * 3 + 3)) as Vec3;
    const n = Array.from(mesh.normals.subarray(i * 3, i * 3 + 3)) as Vec3;
    const position: Vec3 = [0, 0, 0], normal: Vec3 = [0, 0, 0];
    for (let k = 0; k < 8; k++) {
      const indices = k < 4 ? mesh.joints : mesh.joints1;
      const weights = k < 4 ? mesh.weights : mesh.weights1;
      const joint = indices?.[i * 4 + k % 4] ?? 0,
        weight = weights?.[i * 4 + k % 4] ?? 0;
      if (!weight) continue;
      const v = mat4.transformPoint(palette[joint], p),
        m = mat4.transformDirection(normalMatrices[joint], n);
      for (let axis = 0; axis < 3; axis++) {
        position[axis] += v[axis] * weight;
        normal[axis] += m[axis] * weight;
      }
    }
    positions.set(position, i * 3);
    normals.set(vec3.normalize(normal), i * 3);
  }
  return { ...mesh, positions, normals };
}

/** Bind-pose preview geometry for bounds, snapping and the asset browser. */
export function flattenModel(model: Model): RenderMeshData {
  const pose = poseModel(model);
  const parts = visibleNodes(model).flatMap((node) =>
    (model.meshes[model.nodes[node].mesh ?? -1] ?? []).map((p) => ({
      node,
      mesh: skinMesh(p.mesh, pose.skins.get(node), pose.weights[node]),
    }))
  );
  const vertices = parts.reduce(
    (sum, p) => sum + p.mesh.positions.length / 3,
    0,
  );
  const positions = new Float32Array(vertices * 3),
    normals = new Float32Array(vertices * 3),
    uvs = new Float32Array(vertices * 2);
  const indices = new Uint32Array(
    parts.reduce((sum, p) => sum + p.mesh.indices.length, 0),
  );
  let offset = 0, index = 0;
  for (const p of parts) {
    const normal = mat4.normalMatrix(pose.nodes[p.node]);
    for (let i = 0; i < p.mesh.positions.length / 3; i++) {
      positions.set(
        mat4.transformPoint(
          pose.nodes[p.node],
          Array.from(p.mesh.positions.subarray(i * 3, i * 3 + 3)) as Vec3,
        ),
        (offset + i) * 3,
      );
      normals.set(
        vec3.normalize(
          mat4.transformDirection(
            normal,
            Array.from(p.mesh.normals.subarray(i * 3, i * 3 + 3)) as Vec3,
          ),
        ),
        (offset + i) * 3,
      );
    }
    uvs.set(p.mesh.uvs, offset * 2);
    for (const i of p.mesh.indices) indices[index++] = i + offset;
    offset += p.mesh.positions.length / 3;
  }
  return { positions, normals, uvs, indices };
}

export const modelMeshKey = (path: string, mesh: number, primitive: number) =>
  `${path}#mesh=${mesh}/${primitive}`;

export function modelDraws(model: Model, draw: Draw): Draw[] {
  const pose = poseModel(model, draw.animation);
  return visibleNodes(model).flatMap((node) => {
    const mesh = model.nodes[node].mesh;
    if (mesh === undefined) return [];
    return model.meshes[mesh].map((p, primitive) => {
      const material = draw.useMaterials === false
        ? undefined
        : model.materials[p.material];
      const result: Draw = {
        ...draw,
        mesh: modelMeshKey(draw.mesh, mesh, primitive),
        matrix: mat4.multiply(draw.matrix, pose.nodes[node]),
        skin: pose.skins.get(node),
        morphWeights: pose.weights[node],
        material,
      };
      if (material) {
        Object.assign(result, {
          color: draw.color.map((c, i) =>
            i === 3
              ? c * material.color[i]
              : linearToSrgb(srgbToLinear(c) * srgbToLinear(material.color[i]))
          ),
          texture: draw.texture ?? material.base?.uri,
          normalMap: draw.normalMap ?? material.normal?.uri,
          ormMap: draw.ormMap ?? material.metallicRoughness?.uri,
          roughness: material.roughness,
          metallic: material.metallic,
          emissive: material.emissive,
          emissiveStrength: material.emissiveStrength,
          normalStrength: material.normalStrength,
          alphaMode: material.alphaMode,
          alphaCutoff: material.alphaCutoff,
          doubleSided: material.doubleSided,
        });
      }
      return result;
    });
  });
}

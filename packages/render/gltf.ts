/** glTF 2.0 scenes: hierarchy, PBR materials, skins and animation clips. */
import {
  computeNormals,
  mat4,
  type Quat,
  quat,
  type Vec3,
  type Vec4,
} from "@ink/geometry";
import { type Gltf, gltfData, type GltfTextureInfo } from "./gltf_data.ts";
import {
  linearToSrgb,
  type Model,
  type ModelChannel,
  type ModelMaterial,
  type ModelTexture,
  poseModel,
} from "./model.ts";
import type { RenderMeshData } from "./types.ts";

function color(value: number[], alpha = 1): Vec4 {
  return [
    linearToSrgb(value[0]),
    linearToSrgb(value[1]),
    linearToSrgb(value[2]),
    value[3] ?? alpha,
  ];
}

/** Where embedded image bytes go; returns the URI textures will use. */
export type ImageSink = (bytes: Uint8Array, mimeType: string) => string;

/** The default sink keeps images inline as data URLs. */
export const dataUrlSink: ImageSink = (bytes, mimeType) => {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:${mimeType};base64,${btoa(raw)}`;
};

export async function parseGltf(
  bytes: ArrayBuffer,
  url: string,
  sink: ImageSink = dataUrlSink,
): Promise<Model> {
  const { json, read, bufferView } = await gltfData(bytes, url);
  const images = (json.images ?? []).map((image) => {
    if (image.uri) return new URL(image.uri, url).href;
    if (image.bufferView === undefined || !image.mimeType) {
      throw new Error("glTF image has no source");
    }
    const view = bufferView(image.bufferView).data;
    return sink(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      image.mimeType,
    );
  });
  const texture = (info?: GltfTextureInfo): ModelTexture | undefined => {
    if (!info) return undefined;
    const tex = json.textures?.[info.index];
    const source = tex?.extensions?.KHR_texture_basisu?.source ?? tex?.source;
    const uri = source === undefined ? undefined : images[source];
    if (!uri) throw new Error(`invalid glTF texture ${info.index}`);
    const texCoord = info.texCoord ?? 0;
    if (texCoord < 0 || texCoord > 1) {
      throw new Error(
        "glTF texture needs an unsupported UV set (only 0 and 1 are supported)",
      );
    }
    return {
      uri,
      texCoord,
      sampler: json.samplers?.[tex!.sampler ?? -1] ?? {},
    };
  };
  const materials: ModelMaterial[] = (json.materials ?? []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness;
    return {
      name: m.name ?? `Material ${i + 1}`,
      color: color(pbr?.baseColorFactor ?? [1, 1, 1, 1]),
      roughness: pbr?.roughnessFactor ?? 1,
      metallic: pbr?.metallicFactor ?? 1,
      emissive: color(m.emissiveFactor ?? [0, 0, 0]),
      emissiveStrength:
        m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
      normalStrength: m.normalTexture?.scale ?? 1,
      occlusionStrength: m.occlusionTexture?.strength ?? 1,
      alphaMode: m.alphaMode === "BLEND"
        ? "blend"
        : m.alphaMode === "MASK"
        ? "mask"
        : "opaque",
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: m.doubleSided ?? false,
      unlit: m.extensions?.KHR_materials_unlit !== undefined,
      base: texture(pbr?.baseColorTexture),
      normal: texture(m.normalTexture),
      metallicRoughness: texture(pbr?.metallicRoughnessTexture),
      occlusion: texture(m.occlusionTexture),
      emission: texture(m.emissiveTexture),
    };
  });
  const fallback = materials.length;
  materials.push({
    name: "Default",
    color: [1, 1, 1, 1],
    roughness: 1,
    metallic: 1,
    emissive: [0, 0, 0, 1],
    emissiveStrength: 1,
    normalStrength: 1,
    occlusionStrength: 1,
    alphaMode: "opaque",
    alphaCutoff: 0.5,
    doubleSided: false,
    unlit: false,
  });
  const meshes = (json.meshes ?? []).map((mesh) =>
    mesh.primitives.map((p) => {
      const positions = read(p.attributes.POSITION);
      if (positions.width !== 3) throw new Error("glTF positions must be VEC3");
      const count = positions.count;
      const attribute = (name: string, width: number) => {
        if (p.attributes[name] === undefined) return undefined;
        const value = read(p.attributes[name]);
        if (value.count !== count || value.width !== width) {
          throw new Error(`invalid glTF attribute ${name}`);
        }
        return value.data;
      };
      const raw = p.indices === undefined
        ? Uint32Array.from({ length: count }, (_, i) => i)
        : new Uint32Array(read(p.indices).data);
      if (raw.some((v) => v >= count)) {
        throw new Error("glTF index exceeds vertex count");
      }
      const mode = p.mode ?? 4;
      const triangles: number[] = [];
      if (mode === 5 || mode === 6) {
        for (let i = 2; i < raw.length; i++) {
          if (mode === 6) triangles.push(raw[0], raw[i - 1], raw[i]);
          else if (i % 2) triangles.push(raw[i - 1], raw[i - 2], raw[i]);
          else triangles.push(raw[i - 2], raw[i - 1], raw[i]);
        }
      } else if (mode !== 4) {
        throw new Error(
          `glTF primitive mode ${mode} is not a triangle surface`,
        );
      }
      const indices = mode === 4 ? raw : new Uint32Array(triangles);
      if (!indices.length || indices.length % 3) {
        throw new Error(
          "glTF primitive has incomplete triangles",
        );
      }
      const pos = new Float32Array(positions.data);
      const normal = attribute("NORMAL", 3);
      const uv0 = attribute("TEXCOORD_0", 2);
      const data: RenderMeshData = {
        positions: pos,
        normals: normal
          ? new Float32Array(normal)
          : computeNormals(pos, indices),
        uvs: uv0 ? new Float32Array(uv0) : new Float32Array(count * 2),
        indices,
      };
      const uv1 = attribute("TEXCOORD_1", 2);
      if (uv1) data.uvs1 = new Float32Array(uv1);
      if (p.attributes.COLOR_0 !== undefined) {
        const c = read(p.attributes.COLOR_0);
        if (
          c.count !== count || (c.width !== 3 && c.width !== 4)
        ) throw new Error("invalid glTF vertex color");
        data.colors = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) {
          data.colors.set(
            color(Array.from(c.data.subarray(i * c.width, (i + 1) * c.width))),
            i * 4,
          );
        }
      }
      const joints = attribute("JOINTS_0", 4),
        weights = attribute("WEIGHTS_0", 4);
      const joints1 = attribute("JOINTS_1", 4),
        weights1 = attribute("WEIGHTS_1", 4);
      if (
        Object.keys(p.attributes).some((key) =>
          /^(JOINTS|WEIGHTS)_[2-9][0-9]*$/.test(key)
        )
      ) {
        throw new Error("glTF skins support up to eight influences per vertex");
      }
      if (
        !!joints !== !!weights || !!joints1 !== !!weights1 ||
        (joints1 && !joints)
      ) {
        throw new Error(
          "glTF skin requires both joints and weights",
        );
      }
      if (joints && weights) {
        data.joints = new Uint32Array(joints);
        data.weights = new Float32Array(weights);
        if (joints1 && weights1) {
          data.joints1 = new Uint32Array(joints1);
          data.weights1 = new Float32Array(weights1);
        }
        for (let i = 0; i < count; i++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            const w = weights[i * 4 + k], w1 = weights1?.[i * 4 + k] ?? 0;
            if (w < 0 || w1 < 0) {
              throw new Error("glTF skin weights must be nonnegative");
            }
            sum += w + w1;
          }
          if (sum <= 0 || !Number.isFinite(sum)) {
            throw new Error(
              "glTF skin weights must have a positive sum",
            );
          }
          for (let k = 0; k < 4; k++) {
            data.weights[i * 4 + k] /= sum;
            if (data.weights1) data.weights1[i * 4 + k] /= sum;
          }
        }
      }
      if (p.targets) {
        data.targets = p.targets.map((target) => {
          const delta = (name: string) => {
            if (target[name] === undefined) return undefined;
            const value = read(target[name]);
            if (value.count !== count || value.width !== 3) {
              throw new Error(`invalid glTF morph ${name}`);
            }
            return new Float32Array(value.data);
          };
          return { positions: delta("POSITION"), normals: delta("NORMAL") };
        });
      }
      const levels = p.extensions?.INK_mesh_lods?.levels;
      if (levels?.length && !data.joints && !data.targets) {
        data.lods = levels.map((level) => ({
          indices: new Uint32Array(read(level.indices).data),
          error: level.error,
        }));
      }
      const material = p.material ?? fallback;
      if (!materials[material]) throw new Error("invalid glTF material index");
      return { mesh: data, material };
    })
  );
  if (!meshes.length) throw new Error("glTF has no mesh");
  const rawNodes: NonNullable<Gltf["nodes"]> = json.nodes ??
    meshes.map((_, mesh) => ({ mesh }));
  const nodes = rawNodes.map((n, i) => ({
    name: n.name ?? `Node ${i + 1}`,
    children: n.children ?? [],
    mesh: n.mesh,
    skin: n.skin,
    matrix: n.matrix ? new Float32Array(n.matrix) : undefined,
    translation: (n.translation ?? [0, 0, 0]) as Vec3,
    rotation: quat.normalize((n.rotation ?? [0, 0, 0, 1]) as Quat),
    scale: (n.scale ?? [1, 1, 1]) as Vec3,
    weights: n.weights ?? json.meshes?.[n.mesh ?? -1]?.weights ??
      Array(meshes[n.mesh ?? -1]?.[0]?.mesh.targets?.length ?? 0).fill(0),
  }));
  const parented = new Set<number>();
  for (const n of nodes) {
    if (n.mesh !== undefined && !meshes[n.mesh]) {
      throw new Error("invalid glTF node mesh");
    }
    if (
      (meshes[n.mesh ?? -1] ?? []).some((p) =>
        (p.mesh.targets?.length ?? 0) !== n.weights.length
      )
    ) {
      throw new Error("glTF morph weights do not match target count");
    }
    for (const c of n.children) {
      if (!nodes[c] || parented.has(c)) {
        throw new Error("invalid glTF node parent");
      }
      parented.add(c);
    }
  }
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ??
    nodes.map((_, i) => i).filter((i) => !parented.has(i));
  if (roots.some((i) => !nodes[i])) throw new Error("invalid glTF scene root");
  const skins = (json.skins ?? []).map((skin) => {
    const bind = skin.inverseBindMatrices === undefined
      ? undefined
      : read(skin.inverseBindMatrices);
    if (
      skin.joints.some((i) => !nodes[i]) ||
      (bind && (bind.width !== 16 || bind.count !== skin.joints.length))
    ) throw new Error("invalid glTF skin");
    return {
      joints: skin.joints,
      inverseBind: skin.joints.map((_, i) =>
        bind
          ? new Float32Array(bind.data.subarray(i * 16, (i + 1) * 16))
          : mat4.identity()
      ),
    };
  });
  for (const node of nodes) {
    if (node.skin === undefined) continue;
    if (!skins[node.skin]) throw new Error("invalid glTF node skin");
    for (const primitive of meshes[node.mesh ?? -1] ?? []) {
      if (
        !primitive.mesh.joints ||
        primitive.mesh.joints.some((j) =>
          j >= skins[node.skin!].joints.length
        ) ||
        primitive.mesh.joints1?.some((j) =>
          j >= skins[node.skin!].joints.length
        )
      ) throw new Error("glTF joint index exceeds the skin palette");
    }
  }
  const clips = (json.animations ?? []).map((clip, index) => {
    const channels: ModelChannel[] = clip.channels.map((channel) => {
      const sampler = clip.samplers[channel.sampler];
      const node = nodes[channel.target.node], path = channel.target.path;
      if (
        !sampler || !node || (node.matrix && path !== "weights") ||
        !["translation", "rotation", "scale", "weights"].includes(path)
      ) throw new Error(`unsupported glTF animation target ${path}`);
      const times = read(sampler.input), values = read(sampler.output);
      const interpolation = sampler.interpolation ?? "LINEAR";
      const width = path === "weights"
        ? node.weights.length
        : path === "rotation"
        ? 4
        : 3;
      if (
        !["STEP", "LINEAR", "CUBICSPLINE"].includes(interpolation) ||
        times.width !== 1 || width === 0 ||
        values.width !== (path === "weights" ? 1 : width) ||
        values.count * values.width !==
          times.count * width * (interpolation === "CUBICSPLINE" ? 3 : 1)
      ) throw new Error("invalid glTF animation sampler");
      if (
        times.data.some((t, i) =>
          !Number.isFinite(t) || t < 0 || (i > 0 && t <= times.data[i - 1])
        )
      ) throw new Error("glTF animation times must increase");
      return {
        node: channel.target.node,
        path: path as ModelChannel["path"],
        width,
        interpolation: interpolation as ModelChannel["interpolation"],
        times: new Float32Array(times.data),
        values: new Float32Array(values.data),
      };
    });
    return {
      name: clip.name ?? `Clip ${index + 1}`,
      duration: Math.max(0, ...channels.map((c) => c.times.at(-1)!)),
      channels,
    };
  });
  const dependencies = (json.buffers ?? []).flatMap((b) =>
    b.uri && !b.uri.startsWith("data:") ? [new URL(b.uri, url).href] : []
  );
  const model: Model = {
    dependencies,
    nodes,
    roots,
    meshes,
    materials,
    skins,
    clips,
  };
  poseModel(model); // Validate the hierarchy before handing it to the renderer.
  return model;
}

/** glTF binary containers and accessor decoding, independent of GPU resources.
 * https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
 * Also reads `EXT_meshopt_compression` buffer views, which the asset importer
 * writes. */
import { MeshoptDecoder } from "meshoptimizer/decoder";

export interface GltfTextureInfo {
  index: number;
  texCoord?: number;
}
export interface Gltf {
  asset?: { version: string };
  extensionsRequired?: string[];
  buffers?: {
    uri?: string;
    byteLength: number;
    extensions?: { EXT_meshopt_compression?: { fallback?: boolean } };
  }[];
  bufferViews?: {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    extensions?: {
      EXT_meshopt_compression?: {
        buffer: number;
        byteOffset?: number;
        byteLength: number;
        byteStride: number;
        count: number;
        mode: "ATTRIBUTES" | "TRIANGLES" | "INDICES";
        filter?: "NONE" | "OCTAHEDRAL" | "QUATERNION" | "EXPONENTIAL";
      };
    };
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: string;
    sparse?: {
      count: number;
      indices: {
        bufferView: number;
        byteOffset?: number;
        componentType: number;
      };
      values: { bufferView: number; byteOffset?: number };
    };
  }[];
  meshes?: {
    weights?: number[];
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
      material?: number;
      targets?: Record<string, number>[];
      extensions?: {
        /** Simplified index buffers sharing the vertex buffer. */
        INK_mesh_lods?: {
          levels: { indices: number; error: number; triangles?: number }[];
        };
      };
    }[];
  }[];
  nodes?: {
    name?: string;
    children?: number[];
    mesh?: number;
    skin?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    weights?: number[];
  }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  animations?: {
    name?: string;
    samplers: { input: number; output: number; interpolation?: string }[];
    channels: { sampler: number; target: { node: number; path: string } }[];
  }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  textures?: {
    source?: number;
    sampler?: number;
    extensions?: { KHR_texture_basisu?: { source: number } };
  }[];
  samplers?: {
    magFilter?: number;
    minFilter?: number;
    wrapS?: number;
    wrapT?: number;
  }[];
  materials?: {
    name?: string;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: GltfTextureInfo;
      metallicFactor?: number;
      roughnessFactor?: number;
      metallicRoughnessTexture?: GltfTextureInfo;
    };
    normalTexture?: GltfTextureInfo & { scale?: number };
    occlusionTexture?: GltfTextureInfo & { strength?: number };
    emissiveTexture?: GltfTextureInfo;
    emissiveFactor?: number[];
    alphaMode?: string;
    alphaCutoff?: number;
    doubleSided?: boolean;
    extensions?: {
      KHR_materials_unlit?: object;
      KHR_materials_emissive_strength?: { emissiveStrength: number };
    };
  }[];
}

const COMPONENT = {
  5120: { size: 1, read: (v: DataView, o: number) => v.getInt8(o), max: 127 },
  5121: { size: 1, read: (v: DataView, o: number) => v.getUint8(o), max: 255 },
  5122: {
    size: 2,
    read: (v: DataView, o: number) => v.getInt16(o, true),
    max: 32767,
  },
  5123: {
    size: 2,
    read: (v: DataView, o: number) => v.getUint16(o, true),
    max: 65535,
  },
  5125: {
    size: 4,
    read: (v: DataView, o: number) => v.getUint32(o, true),
    max: 1,
  },
  5126: {
    size: 4,
    read: (v: DataView, o: number) => v.getFloat32(o, true),
    max: 1,
  },
} as const;
const WIDTH: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
function component(type: number) {
  const comp = COMPONENT[type as keyof typeof COMPONENT];
  if (!comp) throw new Error(`unsupported glTF component type ${type}`);
  return comp;
}
async function loadBinary(uri: string, base: string): Promise<ArrayBuffer> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(","),
      meta = uri.slice(5, comma),
      body = uri.slice(comma + 1);
    if (meta.endsWith(";base64")) {
      return Uint8Array.from(atob(body), (c) => c.charCodeAt(0)).buffer;
    }
    return new TextEncoder().encode(decodeURIComponent(body))
      .buffer as ArrayBuffer;
  }
  const res = await fetch(new URL(uri, base), { cache: "no-cache" });
  if (!res.ok) throw new Error(`${uri}: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

export async function gltfData(bytes: ArrayBuffer, url: string) {
  let json: Gltf;
  let embedded: ArrayBuffer | undefined;
  const head = new DataView(bytes);
  if (bytes.byteLength >= 12 && head.getUint32(0, true) === 0x46546c67) {
    if (
      head.getUint32(4, true) !== 2 ||
      head.getUint32(8, true) !== bytes.byteLength
    ) throw new Error("invalid GLB header");
    let o = 12, text = "";
    while (o < bytes.byteLength) {
      if (o + 8 > bytes.byteLength) throw new Error("truncated GLB chunk");
      const length = head.getUint32(o, true),
        type = head.getUint32(o + 4, true);
      if (length % 4 || o + 8 + length > bytes.byteLength) {
        throw new Error("invalid GLB chunk size");
      }
      const body = bytes.slice(o + 8, o + 8 + length);
      if (type === 0x4e4f534a) text = new TextDecoder().decode(body);
      else if (type === 0x004e4942) embedded = body;
      o += 8 + length;
    }
    json = JSON.parse(text);
  } else json = JSON.parse(new TextDecoder().decode(bytes));
  if (json.asset?.version !== "2.0") throw new Error("expected glTF 2.0");
  for (const extension of json.extensionsRequired ?? []) {
    if (
      ![
        "KHR_materials_unlit",
        "KHR_materials_emissive_strength",
        "EXT_meshopt_compression",
        "KHR_texture_basisu",
      ].includes(extension)
    ) throw new Error(`unsupported required glTF extension ${extension}`);
  }
  const buffers = await Promise.all((json.buffers ?? []).map(async (b, i) => {
    // Meshopt fallback buffers are never stored.
    if (b.extensions?.EXT_meshopt_compression?.fallback) {
      return new ArrayBuffer(0);
    }
    const data = i === 0 && !b.uri && embedded
      ? embedded
      : await loadBinary(b.uri ?? "", url);
    if (data.byteLength < b.byteLength) {
      throw new Error(`truncated glTF buffer ${i}`);
    }
    return data;
  }));
  const decoded = new Map<number, { data: DataView; stride?: number }>();
  const compressed = (json.bufferViews ?? []).flatMap((v, i) =>
    v.extensions?.EXT_meshopt_compression ? [i] : []
  );
  if (compressed.length) {
    await MeshoptDecoder.ready;
    for (const i of compressed) {
      const v = json.bufferViews![i];
      const c = v.extensions!.EXT_meshopt_compression!;
      const source = buffers[c.buffer];
      if (!source || (c.byteOffset ?? 0) + c.byteLength > source.byteLength) {
        throw new Error(`invalid meshopt buffer view ${i}`);
      }
      const target = new Uint8Array(c.count * c.byteStride);
      MeshoptDecoder.decodeGltfBuffer(
        target,
        c.count,
        c.byteStride,
        new Uint8Array(source, c.byteOffset ?? 0, c.byteLength),
        c.mode,
        c.filter && c.filter !== "NONE" ? c.filter : undefined,
      );
      decoded.set(i, {
        data: new DataView(target.buffer),
        stride: c.mode === "ATTRIBUTES" ? c.byteStride : undefined,
      });
    }
  }
  function bufferView(index: number) {
    const known = decoded.get(index);
    if (known) return known;
    const v = json.bufferViews?.[index];
    const buffer = v && buffers[v.buffer];
    if (
      !v || !buffer || (v.byteOffset ?? 0) + v.byteLength > buffer.byteLength
    ) throw new Error(`invalid glTF buffer view ${index}`);
    return {
      data: new DataView(buffer, v.byteOffset ?? 0, v.byteLength),
      stride: v.byteStride,
    };
  }
  function read(index: number) {
    const accessor = json.accessors?.[index];
    if (
      !accessor || !WIDTH[accessor.type] || !Number.isInteger(accessor.count) ||
      accessor.count < 1
    ) throw new Error(`invalid glTF accessor ${index}`);
    const width = WIDTH[accessor.type],
      comp = component(accessor.componentType);
    const data = accessor.componentType === 5125
      ? new Uint32Array(accessor.count * width)
      : new Float32Array(accessor.count * width);
    const columns = accessor.type.startsWith("MAT")
      ? Number(accessor.type.slice(3))
      : 1;
    const rows = width / columns;
    const columnStride = columns > 1
      ? Math.ceil(rows * comp.size / 4) * 4
      : width * comp.size;
    const elementSize = columns * columnStride;
    const normalize = (value: number) =>
      accessor.normalized && comp.max > 1
        ? Math.max(-1, value / comp.max)
        : value;
    const element = (view: DataView, offset: number, into: number) => {
      for (let k = 0; k < width; k++) {
        data[into + k] = normalize(
          comp.read(
            view,
            offset + Math.floor(k / rows) * columnStride +
              (k % rows) * comp.size,
          ),
        );
      }
    };
    if (accessor.bufferView !== undefined) {
      const view = bufferView(accessor.bufferView);
      const stride = view.stride ?? elementSize;
      if (stride < elementSize) {
        throw new Error("glTF accessor stride is too small");
      }
      const at = (accessor.byteOffset ?? 0) + view.data.byteOffset;
      const last = (accessor.byteOffset ?? 0) + (accessor.count - 1) * stride +
        elementSize;
      if (last > view.data.byteLength) {
        throw new Error(`glTF accessor ${index} exceeds its buffer view`);
      }
      const tight = columns === 1 && stride === elementSize &&
        at % comp.size === 0;
      if (tight && !accessor.normalized) {
        // Aligned, tightly packed: a typed array copy instead of a read per
        // component.
        const source = new (
          {
            5121: Uint8Array,
            5123: Uint16Array,
            5125: Uint32Array,
            5126: Float32Array,
            5120: Int8Array,
            5122: Int16Array,
          }[accessor.componentType as 5121]!
        )(view.data.buffer, at, accessor.count * width);
        (data as Float32Array).set(source as ArrayLike<number>);
      } else if (columns === 1) {
        const count = accessor.count;
        for (let i = 0; i < count; i++) {
          const o = (accessor.byteOffset ?? 0) + i * stride;
          for (let k = 0; k < width; k++) {
            data[i * width + k] = normalize(
              comp.read(view.data, o + k * comp.size),
            );
          }
        }
      } else {
        for (let i = 0; i < accessor.count; i++) {
          element(
            view.data,
            (accessor.byteOffset ?? 0) + i * stride,
            i * width,
          );
        }
      }
    }
    if (accessor.sparse) {
      const sparse = accessor.sparse,
        indices = bufferView(sparse.indices.bufferView).data,
        values = bufferView(sparse.values.bufferView).data;
      if (
        ![5121, 5123, 5125].includes(sparse.indices.componentType) ||
        sparse.count > accessor.count
      ) throw new Error("invalid sparse glTF accessor");
      const idx = component(sparse.indices.componentType);
      let previous = -1;
      for (let i = 0; i < sparse.count; i++) {
        const into = idx.read(
          indices,
          (sparse.indices.byteOffset ?? 0) + i * idx.size,
        );
        if (into <= previous || into >= accessor.count) {
          throw new Error("invalid sparse glTF index");
        }
        previous = into;
        element(
          values,
          (sparse.values.byteOffset ?? 0) + i * elementSize,
          into * width,
        );
      }
    }
    return { data, width, count: accessor.count };
  }
  return { json, read, bufferView };
}

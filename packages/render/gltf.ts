/**
 * glTF 2.0 loading (.glb and .gltf). Reads the first mesh, merges its
 * triangle primitives and ignores nodes, materials and animation: Ink's mesh
 * component supplies the material.
 */
import { computeNormals } from "@ink/geometry";
import type { RenderMeshData } from "./types.ts";

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
}
interface BufferView {
  buffer: number;
  byteOffset?: number;
  byteStride?: number;
}
interface Gltf {
  buffers?: { uri?: string }[];
  bufferViews?: BufferView[];
  accessors?: Accessor[];
  meshes?: {
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
    }[];
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
};

async function loadBinary(uri: string, base: string): Promise<ArrayBuffer> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    const meta = uri.slice(5, comma);
    const body = uri.slice(comma + 1);
    if (meta.endsWith(";base64")) {
      const text = atob(body);
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      return bytes.buffer;
    }
    return new TextEncoder().encode(decodeURIComponent(body))
      .buffer as ArrayBuffer;
  }
  const res = await fetch(new URL(uri, base));
  if (!res.ok) throw new Error(`${uri}: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

/** `url` is the absolute URL the bytes came from, for resolving relative
 * buffer references of .gltf files. */
export async function parseGltf(
  bytes: ArrayBuffer,
  url: string,
): Promise<RenderMeshData> {
  let json: Gltf;
  const buffers: ArrayBuffer[] = [];
  const head = new DataView(bytes);
  if (bytes.byteLength >= 12 && head.getUint32(0, true) === 0x46546c67) {
    let o = 12;
    let embedded: ArrayBuffer | undefined;
    let text = "";
    while (o + 8 <= bytes.byteLength) {
      const length = head.getUint32(o, true);
      const type = head.getUint32(o + 4, true);
      const body = bytes.slice(o + 8, o + 8 + length);
      if (type === 0x4e4f534a) text = new TextDecoder().decode(body);
      else if (type === 0x004e4942) embedded = body;
      o += 8 + length + ((4 - (length % 4)) % 4);
    }
    json = JSON.parse(text);
    buffers.push(embedded ?? new ArrayBuffer(0));
    for (let i = 1; i < (json.buffers?.length ?? 0); i++) {
      buffers.push(await loadBinary(json.buffers![i].uri ?? "", url));
    }
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes));
    for (const b of json.buffers ?? []) {
      buffers.push(await loadBinary(b.uri ?? "", url));
    }
  }

  const read = (index: number): { data: Float32Array; width: number } => {
    const accessor = json.accessors![index];
    const width = WIDTH[accessor.type];
    const comp = COMPONENT[accessor.componentType as keyof typeof COMPONENT];
    const data = new Float32Array(accessor.count * width);
    if (accessor.bufferView === undefined) return { data, width };
    const view = json.bufferViews![accessor.bufferView];
    const dv = new DataView(buffers[view.buffer]);
    const stride = view.byteStride || comp.size * width;
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const normalize = accessor.normalized && comp.max > 1;
    for (let i = 0; i < accessor.count; i++) {
      for (let k = 0; k < width; k++) {
        const v = comp.read(dv, base + i * stride + k * comp.size);
        data[i * width + k] = normalize ? Math.max(v / comp.max, -1) : v;
      }
    }
    return { data, width };
  };

  const mesh = json.meshes?.[0];
  if (!mesh) throw new Error("glTF has no mesh");
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const indices: number[] = [];
  let missingNormals = false;
  for (const prim of mesh.primitives) {
    if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) {
      continue;
    }
    const base = positions.length / 3;
    const p = read(prim.attributes.POSITION).data;
    const count = p.length / 3;
    for (const v of p) positions.push(v);
    if (prim.attributes.NORMAL !== undefined) {
      for (const v of read(prim.attributes.NORMAL).data) normals.push(v);
    } else {
      missingNormals = true;
      for (let i = 0; i < count * 3; i++) normals.push(0);
    }
    if (prim.attributes.TEXCOORD_0 !== undefined) {
      for (const v of read(prim.attributes.TEXCOORD_0).data) uvs.push(v);
    } else for (let i = 0; i < count * 2; i++) uvs.push(0);
    if (prim.indices !== undefined) {
      for (const v of read(prim.indices).data) indices.push(base + v);
    } else for (let i = 0; i < count; i++) indices.push(base + i);
  }
  if (indices.length === 0) throw new Error("glTF mesh has no triangles");
  const mergedPositions = new Float32Array(positions);
  const mergedIndices = new Uint32Array(indices);
  return {
    positions: mergedPositions,
    normals: missingNormals
      ? computeNormals(mergedPositions, mergedIndices)
      : new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: mergedIndices,
  };
}

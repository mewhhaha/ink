/**
 * Mesh import for one glTF primitive: vertex cache/fetch reordering,
 * simplified LODs that share the vertex buffer, attribute quantisation through
 * meshopt filters and meshopt compression. Runs inside workers.
 */
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import type { ImportSettings } from "./format.ts";

export interface PrimitiveInput {
  count: number;
  /** Triangle list. */
  indices: Uint32Array;
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  uvs1?: Float32Array;
  colors?: Float32Array;
  colorWidth?: number;
  joints?: Uint16Array;
  weights?: Float32Array;
  joints1?: Uint16Array;
  weights1?: Float32Array;
  targets?: { positions?: Float32Array; normals?: Float32Array }[];
  /** Skinned or morphed primitives never get simplified levels. */
  deformed: boolean;
  lods: boolean;
}

/** One compressed glTF buffer view. */
export interface Stream {
  /** Compressed bytes. */
  data: Uint8Array;
  /** Decoded size: count * stride. */
  count: number;
  stride: number;
  mode: "ATTRIBUTES" | "TRIANGLES";
  filter: "NONE" | "OCTAHEDRAL" | "EXPONENTIAL";
  /** Accessor description. */
  componentType: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}

export interface PrimitiveOutput {
  vertexCount: number;
  /** Keyed by glTF attribute name; morph deltas as `TARGET<i>_POSITION`. */
  attributes: Record<string, Stream>;
  indices: Stream;
  lods: { stream: Stream; error: number; triangles: number }[];
  /** Raw (decoded) byte size, for statistics. */
  rawBytes: number;
}

const FLOAT = 5126, USHORT = 5123, SHORT = 5122, UINT = 5125;

function gather(
  source: Float32Array | Uint16Array,
  width: number,
  remap: Uint32Array,
  unique: number,
): typeof source {
  const out = new (source.constructor as Float32ArrayConstructor)(
    unique * width,
  );
  for (let i = 0; i < remap.length; i++) {
    const to = remap[i];
    if (to === 0xffffffff) continue;
    for (let k = 0; k < width; k++) out[to * width + k] = source[i * width + k];
  }
  return out;
}

function bytes(array: ArrayBufferView): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function attribute(
  data: Uint8Array,
  count: number,
  stride: number,
  filter: Stream["filter"],
  componentType: number,
  type: string,
  normalized?: boolean,
): Stream {
  return {
    data: MeshoptEncoder.encodeGltfBuffer(data, count, stride, "ATTRIBUTES"),
    count,
    stride,
    mode: "ATTRIBUTES",
    filter,
    componentType,
    type,
    normalized,
  };
}

function indexStream(indices: Uint32Array, vertexCount: number): Stream {
  const wide = vertexCount > 65535;
  const source = wide ? indices : Uint16Array.from(indices);
  return {
    data: MeshoptEncoder.encodeGltfBuffer(
      bytes(source),
      indices.length,
      wide ? 4 : 2,
      "TRIANGLES",
    ),
    count: indices.length,
    stride: wide ? 4 : 2,
    mode: "TRIANGLES",
    filter: "NONE",
    componentType: wide ? UINT : USHORT,
    type: "SCALAR",
  };
}

export async function processPrimitive(
  input: PrimitiveInput,
  settings: ImportSettings["meshes"],
): Promise<PrimitiveOutput> {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const { count } = input;
  const triangles = input.indices.length / 3;
  const quantize = count >= settings.quantizeAbove;

  // Simplified levels come from the original, unreordered indices.
  const levels: { indices: Uint32Array; error: number }[] = [];
  if (
    input.lods && !input.deformed && triangles >= settings.lodAbove &&
    MeshoptSimplifier.supported
  ) {
    const scale = MeshoptSimplifier.getScale(input.positions, 3);
    const weights: number[] = [];
    let width = 0;
    const parts: Float32Array[] = [];
    if (input.normals) {
      parts.push(input.normals);
      width += 3;
      weights.push(0.5, 0.5, 0.5);
    }
    if (input.uvs) {
      parts.push(input.uvs);
      width += 2;
      weights.push(1, 1);
    }
    let attrs: Float32Array | null = null;
    if (width) {
      attrs = new Float32Array(count * width);
      let at = 0;
      for (const p of parts) {
        const w = p.length / count;
        for (let i = 0; i < count; i++) {
          for (let k = 0; k < w; k++) attrs[i * width + at + k] = p[i * w + k];
        }
        at += w;
      }
    }
    let current = input.indices;
    let error = 0;
    for (const ratio of settings.lodRatios) {
      const target = Math.floor(current.length / 3 * ratio) * 3;
      if (target < 300) break;
      const [next, e] = attrs
        ? MeshoptSimplifier.simplifyWithAttributes(
          current,
          input.positions,
          3,
          attrs,
          width,
          weights,
          null,
          target,
          0.15,
          ["Sparse"],
        )
        : MeshoptSimplifier.simplify(
          current,
          input.positions,
          3,
          target,
          0.15,
          ["Sparse"],
        );
      if (next.length >= current.length * 0.9) break;
      error += e * scale;
      levels.push({ indices: next, error });
      current = next;
    }
  }

  // Locality: reorder triangles and vertices; every stream follows.
  const indices = Uint32Array.from(input.indices);
  const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, true);
  const vertexCount = unique;
  const attributes: Record<string, Stream> = {};
  let rawBytes = 0;
  const add = (name: string, stream: Stream) => {
    attributes[name] = stream;
    rawBytes += stream.count * stream.stride;
  };

  const positions = gather(input.positions, 3, remap, unique) as Float32Array;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], positions[i]);
    max[i % 3] = Math.max(max[i % 3], positions[i]);
  }
  {
    const stream = quantize
      ? attribute(
        MeshoptEncoder.encodeFilterExp(positions, unique, 12, 16),
        unique,
        12,
        "EXPONENTIAL",
        FLOAT,
        "VEC3",
      )
      : attribute(bytes(positions), unique, 12, "NONE", FLOAT, "VEC3");
    stream.min = min;
    stream.max = max;
    add("POSITION", stream);
  }
  if (input.normals) {
    const normals = gather(input.normals, 3, remap, unique) as Float32Array;
    if (quantize) {
      const padded = new Float32Array(unique * 4);
      for (let i = 0; i < unique; i++) {
        padded.set(normals.subarray(i * 3, i * 3 + 3), i * 4);
      }
      add(
        "NORMAL",
        attribute(
          MeshoptEncoder.encodeFilterOct(padded, unique, 8, 12),
          unique,
          8,
          "OCTAHEDRAL",
          SHORT,
          "VEC3",
          true,
        ),
      );
    } else {
      add(
        "NORMAL",
        attribute(bytes(normals), unique, 12, "NONE", FLOAT, "VEC3"),
      );
    }
  }
  for (
    const [name, source] of [["TEXCOORD_0", input.uvs], [
      "TEXCOORD_1",
      input.uvs1,
    ]] as const
  ) {
    if (!source) continue;
    const uvs = gather(source, 2, remap, unique) as Float32Array;
    add(
      name,
      quantize
        ? attribute(
          MeshoptEncoder.encodeFilterExp(uvs, unique, 8, 18),
          unique,
          8,
          "EXPONENTIAL",
          FLOAT,
          "VEC2",
        )
        : attribute(bytes(uvs), unique, 8, "NONE", FLOAT, "VEC2"),
    );
  }
  if (input.colors) {
    const w = input.colorWidth ?? 4;
    const colors = gather(input.colors, w, remap, unique) as Float32Array;
    add(
      "COLOR_0",
      attribute(bytes(colors), unique, w * 4, "NONE", FLOAT, `VEC${w}`),
    );
  }
  for (
    const [suffix, j, w] of [["0", input.joints, input.weights], [
      "1",
      input.joints1,
      input.weights1,
    ]] as const
  ) {
    if (!j || !w) continue;
    add(
      `JOINTS_${suffix}`,
      attribute(
        bytes(gather(j, 4, remap, unique)),
        unique,
        8,
        "NONE",
        USHORT,
        "VEC4",
      ),
    );
    add(
      `WEIGHTS_${suffix}`,
      attribute(
        bytes(gather(w, 4, remap, unique)),
        unique,
        16,
        "NONE",
        FLOAT,
        "VEC4",
      ),
    );
  }
  (input.targets ?? []).forEach((target, i) => {
    for (
      const [name, data] of [["POSITION", target.positions], [
        "NORMAL",
        target.normals,
      ]] as const
    ) {
      if (!data) continue;
      add(
        `TARGET${i}_${name}`,
        attribute(
          bytes(gather(data, 3, remap, unique)),
          unique,
          12,
          "NONE",
          FLOAT,
          "VEC3",
        ),
      );
    }
  });

  const indexOut = indexStream(indices, unique);
  rawBytes += indexOut.count * indexOut.stride;
  const lods = levels.map((level) => {
    const mapped = new Uint32Array(level.indices.length);
    for (let i = 0; i < mapped.length; i++) mapped[i] = remap[level.indices[i]];
    const stream = indexStream(mapped, unique);
    rawBytes += stream.count * stream.stride;
    return { stream, error: level.error, triangles: mapped.length / 3 };
  });
  return { vertexCount, attributes, indices: indexOut, lods, rawBytes };
}

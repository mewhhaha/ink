/**
 * glTF import: re-emits a model as one GLB whose geometry is meshopt
 * compressed (with simplified levels sharing each primitive's vertices) and
 * whose images are KTX2. Heavy work happens in `Runner` jobs (workers); this
 * module only reads and writes containers.
 */
import {
  BASISU_EXTENSION,
  type ImportSettings,
  type ImportStage,
  LOD_EXTENSION,
  MESHOPT_EXTENSION,
} from "./format.ts";
import { sniffImage } from "./image.ts";
import type { PrimitiveInput, PrimitiveOutput, Stream } from "./mesh.ts";
import type { TextureResult, TextureRole } from "./texture.ts";

export class Unsupported extends Error {}

/** Runs a named job in a worker. */
export interface Runner {
  run<T>(
    op: string,
    payload: unknown,
    options?: {
      transfer?: Transferable[];
      priority?: number;
      skip?: () => boolean;
    },
  ): Promise<T>;
}

// deno-lint-ignore no-explicit-any
type Json = any;

const COMPONENTS: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const WIDTH: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export interface Container {
  json: Json;
  buffers: Uint8Array[];
}

/** Material names, read from the JSON alone (no buffers). */
export function gltfMaterialNames(bytes: Uint8Array): string[] {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let text: string;
    if (bytes.length >= 20 && view.getUint32(0, true) === 0x46546c67) {
      text = new TextDecoder().decode(
        bytes.subarray(20, 20 + view.getUint32(12, true)),
      );
    } else text = new TextDecoder().decode(bytes);
    const json = JSON.parse(text);
    return (json.materials ?? []).map((m: Json, i: number) =>
      m.name ?? `Material ${i + 1}`
    );
  } catch {
    return [];
  }
}

export async function readContainer(
  bytes: Uint8Array,
  readFile: (uri: string) => Promise<Uint8Array>,
): Promise<Container> {
  let json: Json;
  let embedded: Uint8Array | undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 12 && view.getUint32(0, true) === 0x46546c67) {
    let o = 12, text = "";
    while (o + 8 <= bytes.length) {
      const length = view.getUint32(o, true),
        type = view.getUint32(o + 4, true);
      const body = bytes.subarray(o + 8, o + 8 + length);
      if (type === 0x4e4f534a) text = new TextDecoder().decode(body);
      else if (type === 0x004e4942 && !embedded) embedded = body;
      o += 8 + length;
    }
    json = JSON.parse(text);
  } else json = JSON.parse(new TextDecoder().decode(bytes));
  if (json.asset?.version !== "2.0") throw new Error("expected glTF 2.0");
  const buffers = await Promise.all(
    (json.buffers ?? []).map(async (b: Json, i: number) => {
      if (!b.uri) {
        if (i === 0 && embedded) return embedded;
        throw new Error("glTF buffer has no data");
      }
      return await readUri(b.uri, readFile);
    }),
  );
  return { json, buffers };
}

export async function readUri(
  uri: string,
  readFile: (uri: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(","), meta = uri.slice(5, comma);
    const body = uri.slice(comma + 1);
    return meta.endsWith(";base64")
      ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body));
  }
  return await readFile(decodeURIComponent(uri));
}

/** Decode an accessor to floats (honouring `normalized`) or unsigned ints. */
function decodeAccessor(
  { json, buffers }: Container,
  index: number,
  as: "float" | "uint",
): { data: Float32Array | Uint32Array; width: number; count: number } {
  const accessor = json.accessors?.[index];
  const width = WIDTH[accessor?.type];
  const size = COMPONENTS[accessor?.componentType];
  if (!accessor || !width || !size || accessor.sparse) {
    throw new Unsupported(`unsupported glTF accessor ${index}`);
  }
  const count: number = accessor.count;
  const data = as === "float"
    ? new Float32Array(count * width)
    : new Uint32Array(count * width);
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) return { data, width, count };
  if (view.extensions?.[MESHOPT_EXTENSION]) {
    throw new Unsupported("glTF is already meshopt compressed");
  }
  const buffer = buffers[view.buffer];
  const start = buffer.byteOffset + (view.byteOffset ?? 0) +
    (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? width * size;
  const base = new DataView(
    buffer.buffer,
    buffer.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
  );
  const t = accessor.componentType as number;
  const normalized = !!accessor.normalized;
  const max = t === 5120
    ? 127
    : t === 5122
    ? 32767
    : t === 5121
    ? 255
    : t === 5123
    ? 65535
    : 1;
  const read = (o: number): number => {
    switch (t) {
      case 5120:
        return base.getInt8(o);
      case 5121:
        return base.getUint8(o);
      case 5122:
        return base.getInt16(o, true);
      case 5123:
        return base.getUint16(o, true);
      case 5125:
        return base.getUint32(o, true);
      default:
        return base.getFloat32(o, true);
    }
  };
  if (
    t === 5126 && as === "float" && stride === width * 4 && start % 4 === 0
  ) {
    data.set(new Float32Array(buffer.buffer, start, count * width));
    return { data, width, count };
  }
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < width; k++) {
      const v = read(i * stride + k * size);
      data[i * width + k] = normalized && max > 1 && as === "float"
        ? Math.max(-1, v / max)
        : v;
    }
  }
  return { data, width, count };
}

type Role = TextureRole;
const ROLE_RANK: Record<Role, number> = { color: 0, data: 1, normal: 2 };

function imageRoles(json: Json): Map<number, Role> {
  const roles = new Map<number, Role>();
  const use = (info: Json, role: Role) => {
    const texture = json.textures?.[info?.index];
    const source = texture?.extensions?.[BASISU_EXTENSION]?.source ??
      texture?.source;
    if (source === undefined) return;
    const old = roles.get(source);
    if (old === undefined || ROLE_RANK[role] > ROLE_RANK[old]) {
      roles.set(source, role);
    }
  };
  for (const m of json.materials ?? []) {
    const pbr = m.pbrMetallicRoughness;
    if (pbr?.baseColorTexture) use(pbr.baseColorTexture, "color");
    if (m.emissiveTexture) use(m.emissiveTexture, "color");
    if (pbr?.metallicRoughnessTexture) {
      use(pbr.metallicRoughnessTexture, "data");
    }
    if (m.occlusionTexture) use(m.occlusionTexture, "data");
    if (m.normalTexture) use(m.normalTexture, "normal");
  }
  return roles;
}

function triangulate(raw: Uint32Array, mode: number): Uint32Array {
  if (mode === 4) return raw;
  if (mode !== 5 && mode !== 6) {
    throw new Unsupported(
      `glTF primitive mode ${mode} is not a triangle surface`,
    );
  }
  const out: number[] = [];
  for (let i = 2; i < raw.length; i++) {
    if (mode === 6) out.push(raw[0], raw[i - 1], raw[i]);
    else if (i % 2) out.push(raw[i - 1], raw[i - 2], raw[i]);
    else out.push(raw[i - 2], raw[i - 1], raw[i]);
  }
  return new Uint32Array(out);
}

export interface GltfImport {
  glb: Uint8Array;
  materials: string[];
  stats: {
    primitives: number;
    vertices: number;
    triangles: number;
    lodLevels: number;
    images: number;
    compressedImages: number;
    inputBytes: number;
    outputBytes: number;
  };
}

class Binary {
  parts: Uint8Array[] = [];
  length = 0;
  add(data: Uint8Array): number {
    const at = this.length;
    this.parts.push(data);
    const pad = (4 - (data.length % 4)) % 4;
    if (pad) this.parts.push(new Uint8Array(pad));
    this.length += data.length + pad;
    return at;
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

export function writeGlb(json: Json, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binLength = Math.ceil(bin.length / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  const at = 20 + jsonLength;
  view.setUint32(at, binLength, true);
  view.setUint32(at + 4, 0x004e4942, true);
  out.set(bin, at + 8);
  return out;
}

export async function importGltf(
  bytes: Uint8Array,
  readFile: (uri: string) => Promise<Uint8Array>,
  stage: ImportStage,
  settings: ImportSettings,
  runner: Runner,
  progress: (done: number, total: number) => void = () => {},
): Promise<GltfImport> {
  const container = await readContainer(bytes, readFile);
  const { json, buffers } = container;
  for (const ext of json.extensionsRequired ?? []) {
    if (
      !["KHR_materials_unlit", "KHR_materials_emissive_strength"].includes(ext)
    ) throw new Unsupported(`unsupported required glTF extension ${ext}`);
  }
  const priority = stage === "preview" ? 0 : 10;

  // Primitives -----------------------------------------------------------------
  const skinned = new Set<number>();
  for (const node of json.nodes ?? []) {
    if (node.skin !== undefined && node.mesh !== undefined) {
      skinned.add(node.mesh);
    }
  }
  let done = 0;
  let total = 0;
  const tick = () => progress(++done, total);
  const processed = new Map<string, Promise<PrimitiveOutput>>();
  const meshOutputs: Promise<PrimitiveOutput>[][] = (json.meshes ?? []).map(
    (mesh: Json, meshIndex: number) =>
      mesh.primitives.map((p: Json) => {
        const key = JSON.stringify([
          p.attributes,
          p.indices,
          p.mode,
          p.targets,
          skinned.has(meshIndex),
        ]);
        let job = processed.get(key);
        if (!job) {
          total++;
          const attr = (name: string, as: "float" | "uint" = "float") =>
            p.attributes[name] === undefined
              ? undefined
              : decodeAccessor(container, p.attributes[name], as);
          const pos = decodeAccessor(container, p.attributes.POSITION, "float");
          const count = pos.count;
          const idx = p.indices === undefined
            ? Uint32Array.from({ length: count }, (_, i) => i)
            : decodeAccessor(container, p.indices, "uint").data as Uint32Array;
          const indices = triangulate(
            idx instanceof Uint32Array ? idx : Uint32Array.from(idx),
            p.mode ?? 4,
          );
          const f = (name: string) =>
            attr(name)?.data as Float32Array | undefined;
          const u16 = (name: string) => {
            const a = attr(name, "uint");
            return a ? Uint16Array.from(a.data) : undefined;
          };
          const color = attr("COLOR_0");
          const input: PrimitiveInput = {
            count,
            indices,
            positions: pos.data as Float32Array,
            normals: f("NORMAL"),
            uvs: f("TEXCOORD_0"),
            uvs1: f("TEXCOORD_1"),
            colors: color?.data as Float32Array | undefined,
            colorWidth: color?.width,
            joints: u16("JOINTS_0"),
            weights: f("WEIGHTS_0"),
            joints1: u16("JOINTS_1"),
            weights1: f("WEIGHTS_1"),
            targets: p.targets?.map((t: Json) => ({
              positions: t.POSITION === undefined
                ? undefined
                : decodeAccessor(container, t.POSITION, "float")
                  .data as Float32Array,
              normals: t.NORMAL === undefined
                ? undefined
                : decodeAccessor(container, t.NORMAL, "float")
                  .data as Float32Array,
            })),
            deformed: !!p.attributes.JOINTS_0 || !!p.targets?.length ||
              skinned.has(meshIndex),
            lods: stage === "full",
          };
          const transfer = Object.values(input).flatMap((v) =>
            ArrayBuffer.isView(v) ? [v.buffer as ArrayBuffer] : []
          );
          job = runner.run<PrimitiveOutput>(
            "mesh",
            { input, settings: settings.meshes },
            { priority, transfer: [...new Set(transfer)] },
          ).finally(tick);
          processed.set(key, job);
        }
        return job;
      }),
  );

  // Images ---------------------------------------------------------------------
  const roles = imageRoles(json);
  const imageJobs: (Promise<
    { data: Uint8Array; mime: string; converted: boolean } | null
  >)[] = (json.images ?? []).map(async (image: Json, i: number) => {
    let source: Uint8Array;
    if (image.uri) source = await readUri(image.uri, readFile);
    else if (image.bufferView !== undefined) {
      const v = json.bufferViews[image.bufferView];
      const b = buffers[v.buffer];
      source = b.subarray(
        v.byteOffset ?? 0,
        (v.byteOffset ?? 0) + v.byteLength,
      );
    } else return null;
    const kind = sniffImage(source);
    if (kind !== "png" && kind !== "jpeg") {
      return {
        data: source,
        mime: kind === "ktx2" ? "image/ktx2" : image.mimeType ?? "image/png",
        converted: false,
      };
    }
    total++;
    try {
      const result = await runner.run<TextureResult>(
        stage === "preview" ? "texture.preview" : "texture.full",
        {
          bytes: source,
          role: roles.get(i) ?? "color",
          settings: settings.textures,
        },
        { priority: priority + 1 },
      );
      return { data: result.ktx2, mime: "image/ktx2", converted: true };
    } catch (error) {
      console.warn(`ink: keeping image ${i} as is: ${error}`);
      return {
        data: source,
        mime: image.mimeType ?? "image/png",
        converted: false,
      };
    } finally {
      tick();
    }
  });
  progress(0, total);
  const [primitives, images] = await Promise.all([
    Promise.all(meshOutputs.map((m) => Promise.all(m))),
    Promise.all(imageJobs),
  ]);

  // Assemble -------------------------------------------------------------------
  const bin = new Binary();
  let fallback = 0;
  const bufferViews: Json[] = [];
  const accessors: Json[] = [];
  const stats = {
    primitives: 0,
    vertices: 0,
    triangles: 0,
    lodLevels: 0,
    images: images.length,
    compressedImages: 0,
    inputBytes: bytes.length,
    outputBytes: 0,
  };

  const addStream = (stream: Stream, accessorCount: number): number => {
    const at = bin.add(stream.data);
    const raw = stream.count * stream.stride;
    const fallbackAt = fallback;
    fallback += Math.ceil(raw / 4) * 4;
    const isIndex = stream.mode === "TRIANGLES";
    bufferViews.push({
      buffer: 1,
      byteOffset: fallbackAt,
      byteLength: raw,
      ...(isIndex ? {} : { byteStride: stream.stride }),
      target: isIndex ? 34963 : 34962,
      extensions: {
        [MESHOPT_EXTENSION]: {
          buffer: 0,
          byteOffset: at,
          byteLength: stream.data.length,
          byteStride: stream.stride,
          count: stream.count,
          mode: stream.mode,
          filter: stream.filter,
        },
      },
    });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: stream.componentType,
      count: accessorCount,
      type: stream.type,
      ...(stream.normalized ? { normalized: true } : {}),
      ...(stream.min ? { min: stream.min, max: stream.max } : {}),
    });
    return accessors.length - 1;
  };

  const outMeshes = (json.meshes ?? []).map((mesh: Json, mi: number) => ({
    ...mesh,
    primitives: mesh.primitives.map((p: Json, pi: number) => {
      const out = primitives[mi][pi];
      stats.primitives++;
      stats.vertices += out.vertexCount;
      stats.triangles += out.indices.count / 3;
      const attributes: Record<string, number> = {};
      const targets: Record<string, number>[] = (p.targets ?? []).map(
        () => ({}),
      );
      for (const [name, stream] of Object.entries(out.attributes)) {
        const index = addStream(stream, out.vertexCount);
        const m = /^TARGET(\d+)_(.+)$/.exec(name);
        if (m) targets[Number(m[1])][m[2]] = index;
        else attributes[name] = index;
      }
      const result: Json = {
        ...p,
        attributes,
        indices: addStream(out.indices, out.indices.count),
        mode: 4,
      };
      if (p.targets) result.targets = targets;
      if (out.lods.length) {
        stats.lodLevels += out.lods.length;
        result.extensions = {
          ...p.extensions,
          [LOD_EXTENSION]: {
            levels: out.lods.map((l) => ({
              indices: addStream(l.stream, l.stream.count),
              error: l.error,
              triangles: l.triangles,
            })),
          },
        };
      }
      return result;
    }),
  }));

  // Everything else that points into the old buffers (animation, skins) is
  // copied through with its buffer view.
  const passViews = new Map<number, number>();
  const passView = (old: number): number => {
    let index = passViews.get(old);
    if (index === undefined) {
      const v = json.bufferViews[old];
      if (v.extensions?.[MESHOPT_EXTENSION]) {
        throw new Unsupported("glTF is already meshopt compressed");
      }
      const b = buffers[v.buffer];
      const at = bin.add(
        b.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength),
      );
      bufferViews.push({
        buffer: 0,
        byteOffset: at,
        byteLength: v.byteLength,
        ...(v.byteStride ? { byteStride: v.byteStride } : {}),
      });
      index = bufferViews.length - 1;
      passViews.set(old, index);
    }
    return index;
  };
  const passAccessors = new Map<number, number>();
  const passAccessor = (old: number): number => {
    let index = passAccessors.get(old);
    if (index === undefined) {
      const a = { ...json.accessors[old] };
      if (a.bufferView !== undefined) a.bufferView = passView(a.bufferView);
      if (a.sparse) {
        a.sparse = {
          ...a.sparse,
          indices: {
            ...a.sparse.indices,
            bufferView: passView(a.sparse.indices.bufferView),
          },
          values: {
            ...a.sparse.values,
            bufferView: passView(a.sparse.values.bufferView),
          },
        };
      }
      accessors.push(a);
      index = accessors.length - 1;
      passAccessors.set(old, index);
    }
    return index;
  };
  const animations = (json.animations ?? []).map((a: Json) => ({
    ...a,
    samplers: a.samplers.map((s: Json) => ({
      ...s,
      input: passAccessor(s.input),
      output: passAccessor(s.output),
    })),
  }));
  const skins = (json.skins ?? []).map((s: Json) =>
    s.inverseBindMatrices === undefined
      ? s
      : { ...s, inverseBindMatrices: passAccessor(s.inverseBindMatrices) }
  );

  // Images become KTX2 buffer views.
  const outImages = (json.images ?? []).map((image: Json, i: number) => {
    const result = images[i];
    if (!result) return image;
    const at = bin.add(result.data);
    bufferViews.push({
      buffer: 0,
      byteOffset: at,
      byteLength: result.data.length,
    });
    if (result.converted) stats.compressedImages++;
    const { uri: _uri, bufferView: _view, ...rest } = image;
    return {
      ...rest,
      mimeType: result.mime,
      bufferView: bufferViews.length - 1,
    };
  });
  const converted = new Set<number>();
  images.forEach((r, i) => r?.converted && converted.add(i));
  const textures = (json.textures ?? []).map((t: Json) => {
    const source = t.extensions?.[BASISU_EXTENSION]?.source ?? t.source;
    if (!converted.has(source)) return t;
    const { source: _source, ...rest } = t;
    return {
      ...rest,
      extensions: { ...t.extensions, [BASISU_EXTENSION]: { source } },
    };
  });

  const used = new Set<string>(json.extensionsUsed ?? []);
  const required = new Set<string>(json.extensionsRequired ?? []);
  used.add(MESHOPT_EXTENSION);
  required.add(MESHOPT_EXTENSION);
  if (stats.lodLevels) used.add(LOD_EXTENSION);
  if (converted.size) {
    used.add(BASISU_EXTENSION);
    required.add(BASISU_EXTENSION);
  }
  const binary = bin.concat();
  const out: Json = {
    ...json,
    asset: { ...json.asset, generator: "ink asset importer" },
    extensionsUsed: [...used],
    extensionsRequired: [...required],
    buffers: [
      { byteLength: binary.length },
      {
        byteLength: fallback,
        extensions: { [MESHOPT_EXTENSION]: { fallback: true } },
      },
    ],
    bufferViews,
    accessors,
    meshes: outMeshes,
    images: outImages,
    textures,
  };
  if (!out.images.length) delete out.images;
  if (!out.textures.length) delete out.textures;
  if (animations.length) out.animations = animations;
  if (skins.length) out.skins = skins;
  const glb = writeGlb(out, binary);
  stats.outputBytes = glb.length;
  return {
    glb,
    materials: (json.materials ?? []).map((m: Json, i: number) =>
      m.name ?? `Material ${i + 1}`
    ),
    stats,
  };
}

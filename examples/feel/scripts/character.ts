/** Reproducible original skinned character; no external asset or licence needed.
 * deno run -A examples/feel/scripts/character.ts */
import { builtinMesh, mat4, quat, type Vec3, vec3 } from "@ink/geometry";

export function characterGlb(): Uint8Array {
  const nodes: {
    name: string;
    translation?: Vec3;
    children?: number[];
    mesh?: number;
    skin?: number;
  }[] = [];
  const centers: Vec3[] = [];
  const joint = (name: string, parent: number, translation: Vec3) => {
    const i = nodes.length;
    nodes.push({ name, translation });
    if (parent >= 0) (nodes[parent].children ??= []).push(i);
    centers.push(
      translation.map((v, axis) => v + (centers[parent]?.[axis] ?? 0)) as Vec3,
    );
    return i;
  };
  joint("Hips", -1, [0, 0, 0]);
  joint("Chest", 0, [0, 0.15, 0]);
  joint("Head", 1, [0, 0.24, 0]);
  joint("Left thigh", 0, [-0.13, -0.05, 0]);
  joint("Left shin", 3, [0, -0.21, 0]);
  joint("Left foot", 4, [0, -0.19, 0.035]);
  joint("Right thigh", 0, [0.13, -0.05, 0]);
  joint("Right shin", 6, [0, -0.21, 0]);
  joint("Right foot", 7, [0, -0.19, 0.035]);
  joint("Left shoulder", 1, [-0.22, 0.1, 0]);
  joint("Left elbow", 9, [0, -0.19, 0]);
  joint("Left hand", 10, [0, -0.16, 0]);
  joint("Right shoulder", 1, [0.22, 0.1, 0]);
  joint("Right elbow", 12, [0, -0.19, 0]);
  joint("Right hand", 13, [0, -0.16, 0]);
  const jointCount = nodes.length;
  nodes.push({ name: "Suit", mesh: 0, skin: 0 });

  type Geometry = {
    p: number[];
    n: number[];
    uv: number[];
    j: number[];
    w: number[];
    indices: number[];
  };
  const groups: Geometry[] = Array.from(
    { length: 3 },
    () => ({ p: [], n: [], uv: [], j: [], w: [], indices: [] }),
  );
  const part = (
    bone: number,
    offset: Vec3,
    size: Vec3,
    material = 0,
    shape = "builtin:cube",
    other = bone,
  ) => {
    const mesh = builtinMesh(shape)!;
    const center = centers[bone].map((v, i) => v + offset[i]) as Vec3;
    const matrix = mat4.compose(center, [0, 0, 0, 1], size),
      normal = mat4.normalMatrix(matrix);
    const group = groups[material], base = group.p.length / 3;
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const v = Array.from(mesh.positions.subarray(i * 3, i * 3 + 3)) as Vec3;
      group.p.push(...mat4.transformPoint(matrix, v));
      group.n.push(
        ...vec3.normalize(
          mat4.transformDirection(
            normal,
            Array.from(mesh.normals.subarray(i * 3, i * 3 + 3)) as Vec3,
          ),
        ),
      );
      group.uv.push(mesh.uvs[i * 2], mesh.uvs[i * 2 + 1]);
      const weight = other === bone
        ? 0
        : Math.max(0, Math.min(0.4, (-v[1] + 0.1) * 0.4));
      group.j.push(bone, other, 0, 0);
      group.w.push(1 - weight, weight, 0, 0);
    }
    group.indices.push(...Array.from(mesh.indices, (i) => i + base));
  };
  part(0, [0, -0.005, 0], [0.32, 0.14, 0.2], 1);
  part(1, [0, 0.035, 0], [0.37, 0.27, 0.22]);
  part(2, [0, 0.005, 0], [0.29, 0.28, 0.27], 0, "builtin:sphere");
  part(2, [0, 0.015, 0.107], [0.225, 0.09, 0.055], 2);
  for (const [thigh, shin, foot] of [[3, 4, 5], [6, 7, 8]]) {
    part(thigh, [0, -0.09, 0], [0.135, 0.23, 0.15], 0, "builtin:capsule", shin);
    part(shin, [0, -0.08, 0], [0.12, 0.2, 0.13]);
    part(foot, [0, -0.015, 0.025], [0.15, 0.09, 0.23], 1);
  }
  for (const [shoulder, elbow, hand] of [[9, 10, 11], [12, 13, 14]]) {
    part(
      shoulder,
      [0, -0.06, 0],
      [0.11, 0.2, 0.12],
      0,
      "builtin:capsule",
      elbow,
    );
    part(elbow, [0, -0.07, 0], [0.09, 0.18, 0.1]);
    part(hand, [0, -0.015, 0], [0.11, 0.085, 0.115], 1, "builtin:sphere");
  }
  const chunks: Uint8Array[] = [],
    views: object[] = [],
    accessors: object[] = [];
  let byteLength = 0;
  const accessor = (
    data: Float32Array | Uint16Array | Uint32Array,
    type: string,
    width: number,
  ) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const padding = (4 - byteLength % 4) % 4;
    if (padding) {
      chunks.push(new Uint8Array(padding));
      byteLength += padding;
    }
    const bufferView = views.length;
    views.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length });
    chunks.push(bytes);
    byteLength += bytes.length;
    const bounds = (fn: (a: number, b: number) => number, start: number) =>
      Array.from({ length: width }, (_, c) => {
        let value = start;
        for (let i = c; i < data.length; i += width) value = fn(value, data[i]);
        return value;
      });
    accessors.push({
      bufferView,
      componentType: data instanceof Float32Array
        ? 5126
        : data instanceof Uint16Array
        ? 5123
        : 5125,
      count: data.length / width,
      type,
      ...(type.startsWith("MAT") ? {} : {
        min: bounds(Math.min, Infinity),
        max: bounds(Math.max, -Infinity),
      }),
    });
    return accessors.length - 1;
  };
  const primitives = groups.map((g, material) => ({
    material,
    attributes: {
      POSITION: accessor(new Float32Array(g.p), "VEC3", 3),
      NORMAL: accessor(new Float32Array(g.n), "VEC3", 3),
      TEXCOORD_0: accessor(new Float32Array(g.uv), "VEC2", 2),
      JOINTS_0: accessor(new Uint16Array(g.j), "VEC4", 4),
      WEIGHTS_0: accessor(new Float32Array(g.w), "VEC4", 4),
    },
    indices: accessor(new Uint32Array(g.indices), "SCALAR", 1),
  }));
  const inverseBind = new Float32Array(jointCount * 16);
  for (let i = 0; i < jointCount; i++) {
    inverseBind.set(
      mat4.invert(mat4.compose(centers[i], [0, 0, 0, 1], [1, 1, 1])),
      i * 16,
    );
  }
  const inverseBindMatrices = accessor(inverseBind, "MAT4", 16);
  const animations = ["Idle", "Walk", "Jump"].map((name, clip) => {
    const duration = [2, 0.7, 0.8][clip], frames = clip === 2 ? 5 : 9;
    const times = Float32Array.from(
      { length: frames },
      (_, i) => i * duration / (frames - 1),
    );
    const input = accessor(times, "SCALAR", 1);
    const samplers: object[] = [], channels: object[] = [];
    for (const bone of [0, 1, 2, 3, 4, 6, 7, 9, 10, 12, 13]) {
      const values: number[] = [];
      for (let frame = 0; frame < frames; frame++) {
        const phase = frame / (frames - 1),
          sine = Math.sin(phase * Math.PI * 2);
        let x = 0, y = 0, z = 0;
        if (clip === 0) {
          if (bone === 1) z = sine * 2;
          if (bone === 2) y = sine * 5;
          if (bone === 9) z = -8;
          if (bone === 12) z = 8;
        } else if (clip === 1) {
          if (bone === 3 || bone === 6) x = sine * (bone === 3 ? 35 : -35);
          if (bone === 4 || bone === 7) {
            x = Math.max(0, sine * (bone === 4 ? -1 : 1)) * 65;
          }
          if (bone === 9 || bone === 12) x = sine * (bone === 9 ? -32 : 32);
          if (bone === 10 || bone === 13) x = -20;
          if (bone === 0) z = sine * 3;
          if (bone === 1) y = sine * 7;
        } else {
          const tuck = Math.sin(Math.min(1, phase * 1.5) * Math.PI * 0.8);
          if (bone === 3 || bone === 6) x = -42 * tuck;
          if (bone === 4 || bone === 7) x = 75 * tuck;
          if (bone === 9 || bone === 12) {
            x = -100 * tuck;
            z = bone === 9 ? -12 : 12;
          }
          if (bone === 10 || bone === 13) x = -25;
          if (bone === 1) x = 10 * tuck;
        }
        values.push(...quat.fromEuler([x, y, z]));
      }
      samplers.push({
        input,
        output: accessor(new Float32Array(values), "VEC4", 4),
        interpolation: "LINEAR",
      });
      channels.push({
        sampler: samplers.length - 1,
        target: { node: bone, path: "rotation" },
      });
    }
    return { name, samplers, channels };
  });
  const json = {
    asset: {
      version: "2.0",
      generator: "Ink Feel Lab character.ts",
      copyright: "Original Ink example asset",
    },
    buffers: [{ byteLength }],
    bufferViews: views,
    accessors,
    nodes,
    scenes: [{ nodes: [0, jointCount] }],
    scene: 0,
    meshes: [{ primitives }],
    skins: [{
      joints: Array.from({ length: jointCount }, (_, i) => i),
      inverseBindMatrices,
    }],
    animations,
    materials: [
      {
        name: "Suit panels",
        pbrMetallicRoughness: {
          baseColorFactor: [0.82, 0.82, 0.82, 1],
          metallicFactor: 0.15,
          roughnessFactor: 0.45,
        },
      },
      {
        name: "Boots and gloves",
        pbrMetallicRoughness: {
          baseColorFactor: [0.08, 0.09, 0.12, 1],
          metallicFactor: 0.2,
          roughnessFactor: 0.65,
        },
      },
      {
        name: "Visor",
        pbrMetallicRoughness: {
          baseColorFactor: [0.02, 0.1, 0.13, 1],
          metallicFactor: 0.6,
          roughnessFactor: 0.2,
        },
        emissiveFactor: [0.08, 0.6, 0.8],
      },
    ],
  };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const textSize = Math.ceil(text.length / 4) * 4,
    binSize = Math.ceil(byteLength / 4) * 4;
  const out = new Uint8Array(12 + 8 + textSize + 8 + binSize),
    header = new DataView(out.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, out.length, true);
  header.setUint32(12, textSize, true);
  header.setUint32(16, 0x4e4f534a, true);
  out.fill(32, 20, 20 + textSize);
  out.set(text, 20);
  let offset = 20 + textSize;
  header.setUint32(offset, binSize, true);
  header.setUint32(offset + 4, 0x004e4942, true);
  offset += 8;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

if (import.meta.main) {
  const dir = new URL("../assets/models/", import.meta.url);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(new URL("runner.glb", dir), characterGlb());
}

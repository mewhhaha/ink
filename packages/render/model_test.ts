import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
} from "@std/assert";
import { mat4, type Quat } from "@ink/geometry";
import { parseGltf } from "./gltf.ts";
import { type Gltf, gltfData } from "./gltf_data.ts";
import {
  flattenModel,
  type ModelChannel,
  modelDraws,
  poseModel,
  sampleChannel,
  skinMesh,
} from "./model.ts";
import type { Draw } from "./types.ts";

/** Independent tiny fixtures: two joint influences in different attribute sets,
 * a hidden mesh, multiple materials, a sparse morph and an animated node. */
function fixture() {
  const json: Gltf = {
    asset: { version: "2.0" },
    buffers: [],
    bufferViews: [],
    accessors: [],
  };
  const view = (data: ArrayBufferView, stride?: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const buffer = json.buffers!.length;
    json.buffers!.push({
      byteLength: bytes.length,
      uri: `data:application/octet-stream;base64,${
        btoa(String.fromCharCode(...bytes))
      }`,
    });
    const index = json.bufferViews!.length;
    json.bufferViews!.push({
      buffer,
      byteLength: bytes.length,
      byteStride: stride,
    });
    return index;
  };
  const accessor = (
    data: Float32Array | Uint8Array,
    type: string,
    width: number,
  ) => {
    const index = json.accessors!.length;
    json.accessors!.push({
      bufferView: view(data),
      componentType: data instanceof Float32Array ? 5126 : 5121,
      count: data.length / width,
      type,
    });
    return index;
  };
  const positions = accessor(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    "VEC3",
    3,
  );
  const joints = accessor(new Uint8Array(12), "VEC4", 4);
  const weights = accessor(
    new Uint8Array([64, 0, 0, 0, 64, 0, 0, 0, 64, 0, 0, 0]),
    "VEC4",
    4,
  );
  const joints1 = accessor(
    new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    "VEC4",
    4,
  );
  const weights1 = accessor(
    new Uint8Array([192, 0, 0, 0, 192, 0, 0, 0, 192, 0, 0, 0]),
    "VEC4",
    4,
  );
  json.accessors![weights].normalized =
    json.accessors![weights1].normalized =
      true;
  const target = json.accessors!.length;
  json.accessors!.push({
    componentType: 5126,
    count: 3,
    type: "VEC3",
    sparse: {
      count: 1,
      indices: { bufferView: view(new Uint8Array([2])), componentType: 5121 },
      values: { bufferView: view(new Float32Array([0, 1, 0])) },
    },
  });
  const ibm = accessor(
    new Float32Array([...mat4.identity(), ...mat4.identity()]),
    "MAT4",
    16,
  );
  const input = accessor(new Float32Array([0, 2]), "SCALAR", 1);
  const output = accessor(new Float32Array([0, 0, 0, 0, 2, 0]), "VEC3", 3);
  const morph = accessor(new Float32Array([0, 1]), "SCALAR", 1);
  json.meshes = [{ primitives: [{ attributes: { POSITION: positions } }] }, {
    weights: [0.25],
    primitives: [0, 1].map((material) => ({
      attributes: {
        POSITION: positions,
        JOINTS_0: joints,
        WEIGHTS_0: weights,
        JOINTS_1: joints1,
        WEIGHTS_1: weights1,
      },
      targets: [{ POSITION: target }],
      material,
    })),
  }];
  json.nodes = [
    { name: "Hidden", mesh: 0 },
    { name: "Root", translation: [10, 0, 0], children: [2, 3] },
    { name: "Joint", children: [4] },
    { name: "Mesh", mesh: 1, skin: 0, translation: [3, 0, 0] },
    { name: "Tip" },
  ];
  json.scenes = [{ nodes: [1] }];
  json.skins = [{ joints: [2, 4], inverseBindMatrices: ibm }];
  json.animations = [{
    name: "Lift",
    samplers: [{ input, output }, { input, output: morph }],
    channels: [{ sampler: 0, target: { node: 4, path: "translation" } }, {
      sampler: 1,
      target: { node: 3, path: "weights" },
    }],
  }];
  json.images = [{ uri: "textures/check.png" }];
  json.samplers = [{ wrapS: 33071, wrapT: 33648, minFilter: 9728 }];
  json.textures = [{ source: 0, sampler: 0 }];
  json.materials = [
    {
      name: "Red",
      pbrMetallicRoughness: {
        baseColorFactor: [0.5, 0, 0, 0.7],
        metallicFactor: 0.25,
        roughnessFactor: 0.8,
        baseColorTexture: { index: 0, texCoord: 1 },
      },
      alphaMode: "BLEND",
      doubleSided: true,
    },
    {
      name: "Lamp",
      extensions: {
        KHR_materials_unlit: {},
        KHR_materials_emissive_strength: { emissiveStrength: 3 },
      },
      emissiveFactor: [0, 1, 0],
      occlusionTexture: { index: 0, strength: 0.4 },
    },
  ];
  const bytes = () =>
    new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
  return { json, view, bytes };
}

Deno.test("glTF preserves scene hierarchy, materials, sparse morphs and normalized eight-weight skins", async () => {
  const f = fixture(),
    model = await parseGltf(
      f.bytes(),
      "https://assets.invalid/robot/model.gltf",
    );
  assertEquals(model.roots, [1]);
  assertEquals(
    model.materials[0].base?.uri,
    "https://assets.invalid/robot/textures/check.png",
  );
  assertEquals(model.materials[0].base?.texCoord, 1);
  assertEquals(model.materials[0].base?.sampler.wrapT, 33648);
  assertAlmostEquals(model.materials[0].color[0], 0.7353569830524495);
  assertEquals(model.materials[1].emissiveStrength, 3);
  assertEquals(model.materials[1].unlit, true);
  assertEquals(model.materials[1].occlusionStrength, 0.4);
  const pose = poseModel(model, { clip: 1, time: 1, loop: false });
  assertEquals(Array.from(pose.nodes[4].slice(12, 15)), [10, 1, 0]);
  assertEquals(pose.weights[3], [0.5]);
  const primitive = model.meshes[1][0].mesh;
  assertAlmostEquals(primitive.weights![0], 0.25);
  assertAlmostEquals(primitive.weights1![0], 0.75);
  const deformed = skinMesh(primitive, pose.skins.get(3), pose.weights[3]);
  // Mesh translation cancels inside its skin palette. Root translation applies once.
  const points = [0, 1, 2].map((i) =>
    mat4.transformPoint(
      pose.nodes[3],
      Array.from(deformed.positions.slice(i * 3, i * 3 + 3)) as [
        number,
        number,
        number,
      ],
    )
  );
  assertEquals(points, [[10, 0.75, 0], [11, 0.75, 0], [10, 2.25, 0]]);
  const draw = {
    mesh: "robot.gltf",
    matrix: mat4.identity(),
    color: [1, 1, 1, 1],
    animation: { clip: 1, time: 1, loop: false },
  } as Draw;
  const draws = modelDraws(model, draw);
  assertEquals(draws.length, 2); // The first mesh belongs to the unselected scene.
  assertEquals(draws[0].alphaMode, "blend");
  assertEquals(draws[0].doubleSided, true);
  assertEquals(draws[1].material?.unlit, true);
  assertEquals(flattenModel(model).positions.length, 18);
  assertEquals(poseModel(model, { clip: 1, time: 5, loop: true }), pose);
  const crossfade = poseModel(model, {
    clip: 1,
    time: 2,
    loop: false,
    previousClip: 0,
    previousTime: 0,
    blend: 0.5,
  });
  assertEquals(Array.from(crossfade.nodes[4].slice(12, 15)), [10, 1, 0]);
  assertEquals(crossfade.weights[3], [0.625]);
});

Deno.test("glTF interpolation clamps, steps, uses shortest quaternion arcs and time-scaled cubic tangents", () => {
  const channel: ModelChannel = {
    node: 0,
    path: "translation",
    interpolation: "LINEAR",
    times: new Float32Array([1, 3]),
    values: new Float32Array([0, 0, 0, 2, 4, 6]),
  };
  assertEquals(sampleChannel(channel, -4), [0, 0, 0]);
  assertEquals(sampleChannel(channel, 2), [1, 2, 3]);
  assertEquals(sampleChannel({ ...channel, interpolation: "STEP" }, 2.99), [
    0,
    0,
    0,
  ]);
  assertEquals(sampleChannel({ ...channel, interpolation: "STEP" }, 3), [
    2,
    4,
    6,
  ]);
  const cubic: ModelChannel = {
    ...channel,
    interpolation: "CUBICSPLINE",
    values: new Float32Array([
      0,
      0,
      0,
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]),
  };
  assertEquals(sampleChannel(cubic, 2), [0.5, 0, 0]); // h10(.5) × 2 seconds × tangent 2
  const rotation: ModelChannel = {
    ...channel,
    path: "rotation",
    values: new Float32Array([0, 0, 0, 1, 0, 0, 0, -1]),
  };
  assertEquals(sampleChannel(rotation, 2), [0, 0, 0, 1]);
  const q = sampleChannel({
    ...rotation,
    values: new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]),
  }, 2) as Quat;
  assertAlmostEquals(q[1], Math.SQRT1_2);
  assertAlmostEquals(q[3], Math.SQRT1_2);
  const normalized = sampleChannel({
    ...rotation,
    interpolation: "CUBICSPLINE",
    values: new Float32Array([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
    ]),
  }, 2);
  assertAlmostEquals(Math.hypot(...normalized), 1);
});

Deno.test("glTF accessors honor interleaving, signed normalization, sparse data and matrix column padding", async () => {
  const f = fixture();
  const strided = f.view(new Int8Array([-128, 0, 127, 33, 127, -64, 0, 99]), 4);
  const padded = f.view(
    new Uint8Array([1, 2, 3, 99, 4, 5, 6, 99, 7, 8, 9, 99]),
  );
  const base = f.json.accessors!.length;
  f.json.accessors!.push({
    bufferView: strided,
    componentType: 5120,
    count: 2,
    type: "VEC3",
    normalized: true,
  }, { bufferView: padded, componentType: 5121, count: 1, type: "MAT3" });
  const { read } = await gltfData(f.bytes(), "file:///test.gltf");
  assertEquals(Array.from(read(base).data.slice(0, 3)), [-1, 0, 1]);
  assertAlmostEquals(read(base).data[4], -64 / 127, 1e-7);
  assertEquals(Array.from(read(base + 1).data), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

Deno.test("glTF rejects cycles, bad joints, unsupported required extensions and malformed animation data", async () => {
  for (
    const alter of [
      (j: Gltf) => {
        j.nodes![4].children = [1];
      },
      (j: Gltf) => {
        j.skins![0].joints = [2];
      },
      (j: Gltf) => {
        j.extensionsRequired = ["NOT_supported"];
      },
      (j: Gltf) => {
        j.animations![0].samplers[0].output = 0;
      },
      (j: Gltf) => {
        j.nodes![3].weights = [0, 1];
      },
    ]
  ) {
    const f = fixture();
    alter(f.json);
    await assertRejects(() => parseGltf(f.bytes(), "file:///invalid.gltf"));
  }
  const f = fixture(), model = await parseGltf(f.bytes(), "file:///valid.gltf");
  const current = poseModel(model, {
    clip: 1,
    time: 0,
    loop: false,
    previousClip: 1,
    previousTime: 3,
    previousLoop: true,
    blend: 0,
  });
  assertEquals(current, poseModel(model, { clip: 1, time: 1, loop: false }));
  assert(model.clips[0].duration === 2);
});

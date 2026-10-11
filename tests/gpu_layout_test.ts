import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import * as gpu from "../adapters/gpu.ts";
import { compile } from "./support.ts";

/** Deliberately narrow test reflection; unsupported WGSL types fail visibly. */
function reflect(source: string, name: string): Record<string, number> {
  source = source.replace(/\/\/[^\n]*/g, "");
  const body = source.match(new RegExp(`struct ${name}\\s*\\{([^}]+)\\}`))?.[1];
  if (!body) throw new Error(`Missing WGSL struct ${name}`);
  const offsets: Record<string, number> = {};
  let offset = 0;
  let alignment = 4;
  for (
    const field of body.matchAll(/(\w+)\s*:\s*(array<[^>]+>|\w+)\s*(?:,|$)/g)
  ) {
    const type = field[2].replaceAll(" ", "");
    let align = 4;
    let bytes = 4;
    if (type === "vec2f") {
      align = 8;
      bytes = 8;
    } else if (type === "vec4f") {
      align = 16;
      bytes = 16;
    } else if (type === "mat4x4f") {
      align = 16;
      bytes = 64;
    } else if (/^array<mat4x4f,\d+>$/.test(type)) {
      align = 16;
      bytes = Number(type.match(/,(\d+)>/)![1]) * 64;
    } else if (type !== "f32" && type !== "u32") {
      throw new Error(`Unsupported reflected type ${type}`);
    }
    alignment = Math.max(alignment, align);
    offset = Math.ceil(offset / align) * align;
    offsets[field[1]] = offset / 4;
    offset += bytes;
  }
  return { ...offsets, length: Math.ceil(offset / alignment) * alignment / 4 };
}

Deno.test("GPU packing offsets and lengths agree with shipped WGSL structs", async () => {
  const geometry = await Deno.readTextFile(
    new URL("../shaders/geometry.wgsl", import.meta.url),
  );
  const post = await Deno.readTextFile(
    new URL("../shaders/post.wgsl", import.meta.url),
  );
  assertEquals(reflect(geometry, "Object"), gpu.layout.object);
  assertEquals(reflect(geometry, "Frame"), gpu.layout.frame);
  assertEquals(reflect(geometry, "Light"), gpu.layout.light);
  assertEquals(reflect(post, "Parameters"), gpu.layout.post);
  const environment = await Deno.readTextFile(
    new URL("../shaders/environment.wgsl", import.meta.url),
  );
  assertEquals(reflect(environment, "Settings"), {
    roughness: 0,
    samples: 1,
    diffuse: 2,
    unused: 3,
    length: 4,
  });
});

Deno.test("reusable pack outputs clear padding and preserve caller storage", () => {
  const normal = new Float32Array(16).fill(99);
  assertStrictEquals(gpu.normalMatrix(gpu.identity, normal), normal);
  assertEquals(normal[3], 0);
  const object = new Float32Array(gpu.layout.object.length).fill(99);
  assertStrictEquals(gpu.materialData({ model: gpu.identity }, object), object);
  assertEquals(object[55], 0);
  assertEquals(object[59], 0);
  const frame = new Float32Array(gpu.layout.frame.length).fill(99);
  assertStrictEquals(
    gpu.frameData({
      viewProjection: gpu.identity,
      inverseViewProjection: gpu.identity,
      view: gpu.identity,
      eye: [2, 3, 4],
    }, frame),
    frame,
  );
  assertEquals(
    Array.from(frame.slice(gpu.layout.frame.eye, gpu.layout.frame.eye + 4)),
    [2, 3, 4, 0],
  );
  const post = new Float32Array(gpu.layout.post.length).fill(99);
  assertStrictEquals(
    gpu.postData({
      stage: "temporal",
      blend: 0.75,
      reset: true,
      depthTolerance: 0.125,
    }, post),
    post,
  );
  assertEquals(Array.from(post.slice(16)), [0.75, 1, 0.125, 0, 0, 0, 0, 0]);
  gpu.postData({ stage: "combine", strength: 1 }, post);
  assertEquals(Array.from(post.slice(16)), [1, 0, 0, 0, 0, 0, 0, 0]);
  const lights = new Float32Array(gpu.layout.light.length).fill(99);
  assertStrictEquals(
    gpu.lightData(
      [{ position: [1, 2, 3], range: 4, intensity: [5, 6, 7] }],
      lights,
    ),
    lights,
  );
  assertEquals(Array.from(lights.slice(0, 8)), [1, 2, 3, 4, 5, 6, 7, 0]);
  assertEquals(Array.from(lights.slice(13)), [0, 0, 0]);
  gpu.lightData([], lights);
  assertEquals(Array.from(lights), Array(gpu.layout.light.length).fill(0));
  assertThrows(
    () => gpu.postData({ stage: "combine", strength: 1 }, new Float32Array(4)),
    RangeError,
  );
});

Deno.test("Blot sprite and debug streams agree with GPU vertex strides", async () => {
  const fixture = await compile(
    new URL("./game_modules.blot", import.meta.url),
  );
  try {
    assertEquals(
      fixture.guest.call("sprite_workload", 3),
      3 * 6 * gpu.layout.vertex.sprite / 4,
    );
    const debug = fixture.guest.call(
      "debug_probe",
      new Float32Array([0]),
    ) as Float32Array;
    assertEquals(debug[2] * 4, debug[0] * 2 * gpu.layout.vertex.debug);
    assertEquals(gpu.layout.vertex.mesh, 6 * Float32Array.BYTES_PER_ELEMENT);
  } finally {
    await fixture.dispose();
  }
});

/** Compilation witnesses for the named API; this function is never called. */
export function namedPostTypeWitness(
  passes: gpu.Passes,
  encoder: GPUCommandEncoder,
  parameters: GPUBuffer,
  output: gpu.Texture,
  view: GPUTextureView,
) {
  // @ts-expect-error temporal requires motion and previousDepth
  passes.post(encoder, {
    stage: "temporal",
    parameters,
    output,
    current: view,
    history: view,
    normalDepth: view,
  });
  // @ts-expect-error combine requires an occlusion texture
  passes.post(encoder, {
    stage: "combine",
    parameters,
    output,
    direct: view,
    indirect: view,
  });
  // @ts-expect-error positional settings no longer describe an explicit stage
  gpu.postData([1, 0, 0, 0]);
}

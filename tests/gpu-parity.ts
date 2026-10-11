import { cascadeSplits } from "../adapters/gpu.ts";
import type { NumericCorpus, NumericRow } from "./numeric-corpus.ts";

interface Measurement {
  rows: number;
  maxRelativeError: number;
  maxAbsoluteError: number;
}
/** Runs shipped helpers, not test copies of their formulas. */
export async function parity(corpus: NumericCorpus) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener(
    "uncapturederror",
    (event) => errors.push(event.error.message),
  );
  const resources: GPUBuffer[] = [];
  const bindings = `
@group(0) @binding(7) var<storage, read> parityInputs: array<f32>;
@group(0) @binding(8) var<storage, read_write> parityOutputs: array<f32>;
`;
  async function compute(source: string, entryPoint: string, rows: number[][]) {
    const module = device.createShaderModule({ code: source });
    const compilation = await module.getCompilationInfo();
    const diagnostics = compilation.messages.filter((message) =>
      message.type === "error"
    );
    if (diagnostics.length) {
      throw new Error(diagnostics.map((message) => message.message).join("\n"));
    }
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint },
    });
    const input = new Float32Array(rows.flat());
    const bytes = rows.length * 3 * 4;
    const storage = device.createBuffer({
      size: input.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const output = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const read = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    resources.push(storage, output, read);
    device.queue.writeBuffer(storage, 0, input);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 7, resource: { buffer: storage } },
        { binding: 8, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(rows.length / 32));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(read.getMappedRange()));
    read.unmap();
    if (errors.length) throw new Error(errors.join("\n"));
    return rows.map((_, i) => values.slice(i * 3, i * 3 + 3));
  }
  const report: Record<string, Measurement> = {};
  function compare(
    family: string,
    rows: NumericRow[],
    results: number[][],
    select: (values: number[]) => number[],
    relative: number,
    absolute: number,
  ) {
    const measurement = {
      rows: rows.length,
      maxRelativeError: 0,
      maxAbsoluteError: 0,
    };
    function near(actual: number, expected: number, label: string) {
      const error = Math.abs(actual - expected);
      measurement.maxAbsoluteError = Math.max(
        measurement.maxAbsoluteError,
        error,
      );
      measurement.maxRelativeError = Math.max(
        measurement.maxRelativeError,
        error / Math.max(absolute, Math.abs(expected)),
      );
      if (
        !Number.isFinite(actual) ||
        error > absolute + Math.abs(expected) * relative
      ) {
        throw new Error(
          `${family} ${label}: ${actual} != ${expected}; absolute=${absolute}, relative=${relative}`,
        );
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const actual = select(rows[i].actual),
        expected = select(rows[i].expected);
      for (let j = 0; j < expected.length; j++) {
        near(actual[j], expected[j], `Blot/host row ${i} channel ${j}`);
        near(results[i][j], expected[j], `GPU/host row ${i} channel ${j}`);
        near(results[i][j], actual[j], `GPU/Blot row ${i} channel ${j}`);
      }
    }
    report[family] = measurement;
  }
  try {
    const [display, geometry] = await Promise.all([
      fetch("/shaders/display.wgsl").then((response) => response.text()),
      fetch("/shaders/geometry.wgsl").then((response) => response.text()),
    ]);
    const colors = await compute(
      display + bindings + `
@compute @workgroup_size(32) fn parityColor(@builtin(global_invocation_id) invocation: vec3u) {
  let index = invocation.x;
  if index * 3u >= arrayLength(&parityOutputs) { return; }
  let value = vec3f(parityInputs[index * 2u]);
  parityOutputs[index * 3u] = srgb(value).x;
  parityOutputs[index * 3u + 1u] = tone(value).x;
  parityOutputs[index * 3u + 2u] = srgb(tone(value * exp2(parityInputs[index * 2u + 1u]))).x;
}`,
      "parityColor",
      corpus.color.map((row) => row.inputs),
    );
    compare(
      "color",
      corpus.color,
      colors,
      (values) => values.slice(1),
      0.00001,
      0.000002,
    );
    const ggx = await compute(
      geometry + bindings + `
fn parityVec(offset: u32) -> vec3f {
  return vec3f(parityInputs[offset], parityInputs[offset + 1u], parityInputs[offset + 2u]);
}
@compute @workgroup_size(32) fn parityBRDF(@builtin(global_invocation_id) invocation: vec3u) {
  let index = invocation.x;
  if index * 3u >= arrayLength(&parityOutputs) { return; }
  let offset = index * 14u;
  let result = brdf(parityVec(offset), parityInputs[offset + 3u], parityInputs[offset + 4u], normalize(parityVec(offset + 5u)), normalize(parityVec(offset + 8u)), normalize(parityVec(offset + 11u)));
  parityOutputs[index * 3u] = result.x;
  parityOutputs[index * 3u + 1u] = result.y;
  parityOutputs[index * 3u + 2u] = result.z;
}`,
      "parityBRDF",
      corpus.brdf.map((row) => row.inputs),
    );
    // Sharp roughness=.04 peaks amplify cancellation in the F32 GGX denominator.
    compare("brdf", corpus.brdf, ggx, (values) => values, 0.004, 0.00002);
    const projected = await compute(
      geometry + bindings + `
fn parityColumn(offset: u32) -> vec4f {
  return vec4f(parityInputs[offset], parityInputs[offset + 1u], parityInputs[offset + 2u], parityInputs[offset + 3u]);
}
@compute @workgroup_size(32) fn parityProjection(@builtin(global_invocation_id) invocation: vec3u) {
  let index = invocation.x;
  if index * 3u >= arrayLength(&parityOutputs) { return; }
  let offset = index * 19u;
  let matrix = mat4x4f(parityColumn(offset + 3u), parityColumn(offset + 7u), parityColumn(offset + 11u), parityColumn(offset + 15u));
  let clip = matrix * vec4f(parityInputs[offset], parityInputs[offset + 1u], parityInputs[offset + 2u], 1.0);
  let result = clip.xyz / clip.w;
  parityOutputs[index * 3u] = result.x;
  parityOutputs[index * 3u + 1u] = result.y;
  parityOutputs[index * 3u + 2u] = result.z;
}`,
      "parityProjection",
      corpus.projection.map((
        row,
      ) => [...row.inputs.slice(6), ...row.actual.slice(3)]),
    );
    compare(
      "projection",
      corpus.projection,
      projected,
      (values) => values.slice(0, 3),
      0.000002,
      0.000002,
    );
    // Matrix columns also have their own independent homogeneous host oracle.
    for (const row of corpus.projection) {
      for (let i = 3; i < row.actual.length; i++) {
        if (Math.abs(row.actual[i] - row.expected[i]) > 0.000002) {
          throw new Error(`Projection matrix column ${i} differs from host`);
        }
      }
    }
    const splits = corpus.splits.map((row) =>
      cascadeSplits(row.inputs[0], row.inputs[1], row.inputs[2], row.inputs[3])
    );
    compare(
      "splits",
      corpus.splits,
      splits,
      (values) => values,
      0.000002,
      0.0001,
    );
    return report;
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
}

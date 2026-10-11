/// <reference lib="deno.unstable" />

// Native offscreen witnesses: no window, renderer, or platform integration.
const started = performance.now();
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("WebGPU adapter unavailable");
const device = await adapter.requestDevice();
const resources: Array<{ destroy(): void }> = [];
let witnesses = 0;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function buffer(values: number[], usage: number = GPUBufferUsage.UNIFORM) {
  const result = device.createBuffer({
    size: values.length * 4,
    usage: usage | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(result, 0, new Float32Array(values));
  resources.push(result);
  return result;
}
function texture(format: GPUTextureFormat, width = 1, height = 1) {
  const result = device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  resources.push(result);
  return result;
}
function close(
  actual: number,
  expected: number,
  label: string,
  tolerance = 2 / 255,
) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: ${actual}, expected ${expected}`);
  }
  witnesses++;
}
const sampler = device.createSampler({
  magFilter: "nearest",
  minFilter: "nearest",
});
const modules = new Map<string, GPUShaderModule>();
async function pipeline(
  name: string,
  buffers: GPUVertexBufferLayout[] = [],
  format: GPUTextureFormat = "rgba8unorm",
  constants: Record<string, number> = {},
) {
  let module = modules.get(name);
  if (!module) {
    module = device.createShaderModule({
      code: await Deno.readTextFile(`shaders/${name}.wgsl`),
    });
    const info = await module.getCompilationInfo();
    if (info.messages.length) {
      throw new Error(
        `${name}: ${info.messages.map((m) => m.message).join("\n")}`,
      );
    }
    modules.set(name, module);
  }
  device.pushErrorScope("validation");
  const descriptor: GPURenderPipelineDescriptor = {
    layout: "auto",
    vertex: { module, entryPoint: "vertex", buffers },
    primitive: { topology: "triangle-list" },
  };
  if (name === "debug") descriptor.primitive = { topology: "line-list" };
  if (name === "shadow") {
    descriptor.depthStencil = {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "always",
    };
  } else {
    descriptor.fragment = {
      module,
      entryPoint: "fragment",
      constants,
      targets: [{ format }],
    };
  }
  const result = await device.createRenderPipelineAsync(descriptor);
  const error = await device.popErrorScope();
  if (error) throw new Error(`${name}: ${error.message}`);
  return result;
}
function group(
  p: GPURenderPipeline,
  index: number,
  bindings: Array<GPUBuffer | GPUTexture | GPUSampler>,
) {
  return device.createBindGroup({
    layout: p.getBindGroupLayout(index),
    entries: bindings.map((value, binding) => {
      let resource: GPUBindingResource = value as GPUSampler;
      if (value instanceof GPUBuffer) resource = { buffer: value };
      if (value instanceof GPUTexture) resource = value.createView();
      return { binding, resource };
    }),
  });
}
async function render(
  p: GPURenderPipeline,
  groups: GPUBindGroup[],
  target: GPUTexture,
  vertices?: GPUBuffer,
  depth = false,
  count = 3,
) {
  const read = device.createBuffer({
    size: 256 * target.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  resources.push(read);
  device.pushErrorScope("validation");
  const encoder = device.createCommandEncoder();
  const descriptor: GPURenderPassDescriptor = { colorAttachments: [] };
  if (depth) {
    descriptor.depthStencilAttachment = {
      view: target.createView(),
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    };
  } else {
    descriptor.colorAttachments = [{
      view: target.createView(),
      clearValue: [0.1, 0.2, 0.3, 0.4],
      loadOp: "clear",
      storeOp: "store",
    }];
  }
  const pass = encoder.beginRenderPass(descriptor);
  pass.setPipeline(p);
  groups.forEach((g, i) => pass.setBindGroup(i, g));
  if (vertices) pass.setVertexBuffer(0, vertices);
  pass.draw(count);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, {
    buffer: read,
    bytesPerRow: 256,
  }, [target.width, target.height]);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(read.getMappedRange()).slice();
  read.unmap();
  const error = await device.popErrorScope();
  if (error) throw new Error(error.message);
  return bytes;
}
const positions = [-1, -1, 0, 3, -1, 0, -1, 3, 0];
function layout(widths: number[]): GPUVertexBufferLayout[] {
  let offset = 0;
  const attributes = widths.map((width, shaderLocation) => {
    const attribute = {
      shaderLocation,
      offset,
      format: `float32x${width}` as GPUVertexFormat,
    };
    offset += width * 4;
    return attribute;
  });
  return [{ arrayStride: offset, attributes }];
}
function vertices(extra: number[]) {
  return buffer(
    positions.flatMap((_, i) => {
      if (i % 3) return [];
      return [...positions.slice(i, i + 3), ...extra];
    }),
    GPUBufferUsage.VERTEX,
  );
}
function tone(x: number) {
  return Math.min(1, x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14));
}
function srgb(x: number) {
  if (x <= 0.0031308) return x * 12.92;
  return 1.055 * x ** (1 / 2.4) - 0.055;
}
try {
  const display = await pipeline("display");
  const linear = await pipeline("display", [], "rgba8unorm-srgb", {
    encodeSRGB: 0,
  });
  const source = texture("rgba16float", 2, 2);
  device.queue.writeTexture(
    { texture: source },
    new Uint16Array([
      0x211f,
      0x3266,
      0x4000,
      0x3c00,
      0xbc00,
      0x7bff,
      0,
      0x3c00,
      0x3666,
      0x38cd,
      0x3a66,
      0x3c00,
      0x3c00,
      0x3c00,
      0x3c00,
      0x3c00,
    ]),
    { bytesPerRow: 16 },
    [2, 2],
  );
  for (const exposure of [0, 2, -20, 20]) {
    for (const p of [display, linear]) {
      let format: GPUTextureFormat = "rgba8unorm";
      if (p === linear) format = "rgba8unorm-srgb";
      const bytes = await render(p, [
        group(p, 0, [buffer([exposure, 0, 0, 0]), source, sampler]),
      ], texture(format, 2, 2));
      const values = [0.01, 0.2, 2, -1, 65504, 0, 0.4, 0.6, 0.8, 1, 1, 1];
      for (let pixel = 0; pixel < 4; pixel++) {
        for (let channel = 0; channel < 3; channel++) {
          const input = Math.max(0, values[pixel * 3 + channel]) *
            2 ** Math.max(-16, Math.min(16, exposure));
          close(
            bytes[Math.floor(pixel / 2) * 256 + pixel % 2 * 4 + channel] / 255,
            srgb(tone(input)),
            "display orientation/exposure/encoding",
          );
        }
      }
    }
  }
  const camera = buffer(identity);
  const debug = await pipeline("debug", layout([3, 4]));
  const debugBytes = await render(
    debug,
    [group(debug, 0, [camera])],
    texture("rgba8unorm"),
    buffer(
      [-1, 0, 0, 0.2, 0.4, 0.6, 0.8, 1, 0, 0, 0.2, 0.4, 0.6, 0.8],
      GPUBufferUsage.VERTEX,
    ),
    false,
    2,
  );
  [0.2, 0.4, 0.6, 0.8].forEach((v, i) =>
    close(debugBytes[i] / 255, v, "debug color")
  );
  const sprite = await pipeline("sprite", layout([3, 2, 4]));
  const atlas = texture("rgba8unorm");
  device.queue.writeTexture(
    { texture: atlas },
    new Uint8Array([128, 64, 255, 128]),
    {},
    [1, 1],
  );
  for (const alpha of [0.5, 0]) {
    const bytes = await render(
      sprite,
      [group(sprite, 0, [camera, atlas, sampler])],
      texture("rgba8unorm"),
      vertices([0.5, 0.5, 0.5, 1, 0.25, alpha]),
    );
    let expected = [128 / 255 * 0.5, 64 / 255, 0.25, 128 / 255 * alpha];
    if (alpha === 0) expected = [0.1, 0.2, 0.3, 0.4];
    expected.forEach((v, i) =>
      close(bytes[i] / 255, v, "sprite tint/alpha/discard")
    );
  }
  const shadow = await pipeline("shadow", layout([3]));
  const model = [...identity];
  model[14] = 0.37;
  const shadowBytes = await render(
    shadow,
    [group(shadow, 0, [camera]), group(shadow, 1, [buffer(model)])],
    texture("depth32float"),
    buffer(positions, GPUBufferUsage.VERTEX),
    true,
  );
  close(
    new DataView(shadowBytes.buffer).getFloat32(0, true),
    0.37,
    "shadow model depth",
    1e-6,
  );
  const mesh = await pipeline("mesh", layout([3, 3]));
  for (const [metallic, roughness] of [[0, 0.7], [1, 0.04]]) {
    let radiance = 1;
    if (roughness === 0.04) radiance = 0.00001;
    const frame = buffer([
      ...identity,
      0,
      0,
      10,
      0,
      0,
      0,
      -1,
      0,
      radiance,
      radiance,
      radiance,
      0,
    ]);
    const base = [0.2, 0.4, 0.6];
    const emission = [0.1, 0.05, 0.02];
    const object = buffer([
      ...identity,
      ...identity,
      ...base,
      0.8,
      metallic,
      roughness,
      0,
      0,
      ...emission,
      0,
    ]);
    const bytes = await render(
      mesh,
      [group(mesh, 0, [frame]), group(mesh, 1, [object])],
      texture("rgba8unorm"),
      vertices([0, 0, 1]),
    );
    // At the center n=v=l, GGX D=1/(pi*r^4), visibility=1/4.
    base.forEach((b, i) => {
      const fresnel = 0.04 * (1 - metallic) + b * metallic;
      const diffuse = b * (1 - fresnel) * (1 - metallic) / Math.PI;
      const specular = fresnel / (4 * Math.PI * roughness ** 4);
      close(
        bytes[i] / 255,
        Math.min(1, (diffuse + specular) * radiance + emission[i]),
        "mesh GGX/metallic/emission",
      );
    });
    close(bytes[3] / 255, 0.8, "mesh alpha");
  }
  console.log(
    `shaders: ${modules.size} modules and 6 pipelines validated, ${witnesses} pixel witnesses (${
      (performance.now() - started).toFixed(0)
    } ms)`,
  );
} finally {
  resources.forEach((resource) => resource.destroy());
  device.destroy();
}

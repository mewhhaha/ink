import * as gpu from "../adapters/gpu.ts";
function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
function near(
  actual: number,
  expected: number,
  tolerance: number,
  message: string,
) {
  assert(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} != ${expected} ± ${tolerance}`,
  );
}

export async function witnesses() {
  const adapter = await navigator.gpu.requestAdapter();
  assert(!!adapter, "WebGPU adapter unavailable");
  const timestamp = adapter!.features.has("timestamp-query");
  const requiredFeatures: GPUFeatureName[] = [];
  if (timestamp) requiredFeatures.push("timestamp-query");
  const device = await adapter!.requestDevice({ requiredFeatures });
  const errors: string[] = [];
  device.addEventListener(
    "uncapturederror",
    (event) => errors.push(event.error.message),
  );
  const resources: { destroy(): void }[] = [];
  const keep = <T extends { destroy(): void }>(value: T) => {
    resources.push(value);
    return value;
  };
  const timings: { stage: string; queueWallMs: number; gpuMs?: number }[] = [];
  async function submit(
    stage: string,
    encode: (encoder: GPUCommandEncoder) => void,
  ) {
    const encoder = device.createCommandEncoder();
    let queries: GPUQuerySet | undefined;
    let resolve: GPUBuffer | undefined;
    let read: GPUBuffer | undefined;
    if (timestamp) {
      queries = device.createQuerySet({ type: "timestamp", count: 2 });
      resolve = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      read = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.beginComputePass({
        timestampWrites: { querySet: queries, beginningOfPassWriteIndex: 0 },
      }).end();
    }
    encode(encoder);
    if (queries && resolve && read) {
      encoder.beginComputePass({
        timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 },
      }).end();
      encoder.resolveQuerySet(queries, 0, 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, read, 0, 16);
    }
    const start = performance.now();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const timing: { stage: string; queueWallMs: number; gpuMs?: number } = {
      stage,
      queueWallMs: performance.now() - start,
    };
    if (read) {
      await read.mapAsync(GPUMapMode.READ);
      const times = new BigUint64Array(read.getMappedRange());
      timing.gpuMs = Number(times[1] - times[0]) / 1e6;
      read.unmap();
      read.destroy();
    }
    resolve?.destroy();
    queries?.destroy();
    timings.push(timing);
    assert(errors.length === 0, `${stage}: ${errors.join("\n")}`);
  }
  function image(
    width: number,
    height: number,
    pixel: (x: number, y: number) => readonly number[],
  ) {
    const target = keep(gpu.texture(device, width, height));
    const data = new Float16Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data.set(pixel(x, y), (y * width + x) * 4);
      }
    }
    device.queue.writeTexture({ texture: target.texture }, data, {
      bytesPerRow: width * 8,
    }, [width, height]);
    return target;
  }
  async function pixels(target: gpu.Texture, mip = 0, layer = 0) {
    const width = Math.max(1, target.width >> mip);
    const height = Math.max(1, target.height >> mip);
    let bytes = 8;
    if (
      target.texture.format === "rgba8unorm" ||
      target.texture.format === "rgba8unorm-srgb"
    ) bytes = 4;
    if (target.texture.format === "r32float") bytes = 4;
    const row = Math.ceil(width * bytes / 256) * 256;
    const buffer = device.createBuffer({
      size: row * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target.texture, mipLevel: mip, origin: [0, 0, layer] },
      { buffer, bytesPerRow: row },
      [width, height],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = buffer.getMappedRange();
    const output: number[] = [];
    for (let y = 0; y < height; y++) {
      if (target.texture.format === "r32float") {
        for (const value of new Float32Array(mapped, y * row, width)) {
          output.push(value, 0, 0, 1);
        }
      } else if (bytes === 8) {
        output.push(...new Float16Array(mapped, y * row, width * 4));
      } else {output.push(
          ...Array.from(
            new Uint8Array(mapped, y * row, width * 4),
            (value) => value / 255,
          ),
        );}
    }
    buffer.unmap();
    buffer.destroy();
    return output;
  }
  try {
    const passes = await gpu.createPasses(
      device,
      "rgba8unorm",
      new URL("../shaders/", location.href),
    );
    const cases: string[] = [];
    const parameters = (
      stage: gpu.PostSettings["stage"],
      values: readonly number[] = [],
      inverse: gpu.Matrix = gpu.identity,
    ) => {
      let settings: gpu.PostSettings;
      switch (stage) {
        case "occlusion":
          settings = {
            stage,
            inverseProjection: inverse,
            radius: values[0],
            visibility: values[1],
            noise: values[2],
          };
          break;
        case "combine":
          settings = { stage, strength: values[0] };
          break;
        case "threshold":
        case "bloom":
          settings = {
            stage,
            threshold: values[0],
            knee: values[1],
            exposure: values[2] ?? 0,
          };
          break;
        case "temporal":
          settings = {
            stage,
            blend: values[0],
            reset: values[1] > 0.5,
            depthTolerance: values[2],
          };
          break;
        default:
          settings = { stage };
          break;
      }
      return keep(gpu.uniform(device, gpu.postData(settings)));
    };
    const post = async (
      stage: gpu.PostStage,
      inputs: readonly gpu.Texture[],
      settings: readonly number[],
      inverse = gpu.identity,
    ) => {
      let format: GPUTextureFormat = "rgba16float";
      if (stage === "occlusion" || stage === "denoise" || stage === "depth") {
        format = "r32float";
      }
      const output = keep(
        gpu.texture(device, inputs[0].width, inputs[0].height, format),
      );
      const values = parameters(stage, settings, inverse);
      let previousDepth: gpu.Texture | undefined;
      if (stage === "temporal") {
        previousDepth = keep(
          gpu.texture(device, inputs[4].width, inputs[4].height, "r32float"),
        );
        await submit(
          "depth/history",
          (encoder) =>
            passes.post(encoder, {
              stage: "depth",
              parameters: values.buffer,
              normalDepth: inputs[4].view,
              output: previousDepth!,
            }),
        );
      }
      await submit(stage, (encoder) => {
        const target = { parameters: values.buffer, output };
        switch (stage) {
          case "occlusion":
          case "depth":
            passes.post(encoder, {
              ...target,
              stage,
              normalDepth: inputs[0].view,
            });
            break;
          case "denoise":
            passes.post(encoder, {
              ...target,
              stage,
              occlusion: inputs[0].view,
              normalDepth: inputs[1].view,
            });
            break;
          case "combine":
            passes.post(encoder, {
              ...target,
              stage,
              direct: inputs[0].view,
              indirect: inputs[1].view,
              occlusion: inputs[2].view,
            });
            break;
          case "threshold":
          case "downsample":
            passes.post(encoder, { ...target, stage, source: inputs[0].view });
            break;
          case "upsample":
            passes.post(encoder, {
              ...target,
              stage,
              source: inputs[0].view,
              lower: inputs[1].view,
            });
            break;
          case "temporal":
            passes.post(encoder, {
              ...target,
              stage,
              current: inputs[0].view,
              motion: inputs[1].view,
              history: inputs[2].view,
              normalDepth: inputs[3].view,
              previousDepth: previousDepth!.view,
            });
            break;
        }
      });
      return await pixels(output);
    };
    const hdrValues = [0, 0.001, 0.18, 0.7, 1, 2, 4, 16];
    const hdr = image(
      8,
      1,
      (x) => [hdrValues[x], hdrValues[x], hdrValues[x], 1],
    );
    const zero = image(8, 1, () => [0, 0, 0, 1]);
    const displaySettings = keep(gpu.uniform(device, [0, 0, 0, 0]));
    const displayReference = (value: number) => {
      const tone = Math.max(
        0,
        Math.min(
          1,
          value * (2.51 * value + 0.03) /
            (value * (2.43 * value + 0.59) + 0.14),
        ),
      );
      if (tone <= 0.0031308) return tone * 12.92;
      return 1.055 * tone ** (1 / 2.4) - 0.055;
    };
    for (const format of ["rgba8unorm", "rgba8unorm-srgb"] as const) {
      let displayPass = passes;
      if (format.endsWith("srgb")) {
        displayPass = await gpu.createPasses(
          device,
          format,
          new URL("../shaders/", location.href),
        );
      }
      const output = keep(gpu.texture(device, 8, 1, format));
      await submit(
        `display/${format}`,
        (encoder) =>
          displayPass.display(
            encoder,
            hdr.view,
            zero.view,
            displaySettings.buffer,
            output.view,
          ),
      );
      const values = await pixels(output);
      for (let x = 0; x < 8; x++) {
        near(
          values[x * 4],
          displayReference(hdrValues[x]),
          1 / 255 + 0.001,
          `${format} CPU tone/sRGB pixel ${x}`,
        );
        near(values[x * 4 + 1], values[x * 4], 0, "neutral highlights");
        near(values[x * 4 + 2], values[x * 4], 0, "neutral highlights");
      }
      assert(values[7 * 4] > 0.99, "HDR white highlights must remain white");
    }
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 1;
    document.body.append(canvas);
    const context = canvas.getContext("webgpu") as unknown as GPUCanvasContext;
    context.configure({
      device,
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const canvasRead = keep(
      device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
    );
    await submit("display/canvas", (encoder) => {
      const present = context.getCurrentTexture();
      passes.display(
        encoder,
        hdr.view,
        zero.view,
        displaySettings.buffer,
        present.createView(),
      );
      encoder.copyTextureToBuffer({ texture: present }, {
        buffer: canvasRead,
        bytesPerRow: 256,
      }, [8, 1]);
    });
    await canvasRead.mapAsync(GPUMapMode.READ);
    const canvasPixels = new Uint8Array(canvasRead.getMappedRange());
    near(
      canvasPixels[2 * 4] / 255,
      displayReference(0.18),
      1 / 255 + 0.001,
      "canvas swapchain pixel",
    );
    canvasRead.unmap();
    context.unconfigure();
    canvas.remove();
    cases.push(
      "CPU tone curve, sRGB once, neutral HDR highlights, real canvas swapchain",
    );
    const overflowSource = image(4, 1, () => [1000, 1000, 1000, 1]);
    const overflowDisplay = keep(gpu.texture(device, 4, 1, "rgba8unorm"));
    const overflowSettings = keep(gpu.uniform(device, [1024, 0, 0, 0]));
    await submit(
      "display/overflow",
      (encoder) =>
        passes.display(
          encoder,
          overflowSource.view,
          zero.view,
          overflowSettings.buffer,
          overflowDisplay.view,
        ),
    );
    near(
      (await pixels(overflowDisplay))[0],
      1,
      0.002,
      "overflowing exposure still maps HDR white to white",
    );
    const bright = image(16, 16, () => [2, 2, 2, 1]);
    const threshold = await post("threshold", [bright], [1, 0.5, 0]);
    near(
      threshold[0],
      1,
      0.001,
      "threshold retains linear bright contribution",
    );
    const exposed = await post("threshold", [bright], [1, 0.5, 1]);
    near(exposed[0], 1.5, 0.001, "threshold changes with exposure");
    const dark = image(16, 16, () => [0.25, 0.25, 0.25, 1]);
    near(
      (await post("threshold", [dark], [1, 0.5, 0]))[0],
      0,
      0.001,
      "dark pixels do not bloom",
    );
    const pyramid = keep(gpu.bloomPyramid(device, 16, 16));
    const bloomSettings = parameters("bloom", [1, 0.5, 0]);
    let bloomView: GPUTextureView;
    await submit("bloom/pyramid", (encoder) => {
      bloomView = passes.bloom(
        encoder,
        bright.view,
        bloomSettings.buffer,
        pyramid,
      );
    });
    void bloomView!;
    const bloomPixels = await pixels(pyramid.up[0]);
    for (let index = 0; index < bloomPixels.length; index += 4) {
      near(
        bloomPixels[index],
        1,
        0.001,
        "bloom pyramid preserves constant energy",
      );
    }
    cases.push("bloom threshold, exposure, normalized multi-scale energy");
    const projection = [
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      -10 / 9.9,
      -1,
      0,
      0,
      -1 / 9.9,
      0,
    ];
    const inverseProjection = [
      1,
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
      -9.9,
      0,
      0,
      -1,
      10,
    ];
    const flat = image(32, 32, () => [0, 0, 1, 2]);
    const flatAO = await post(
      "occlusion",
      [flat],
      [3, 1, 0],
      inverseProjection,
    );
    near(flatAO[(16 * 32 + 16) * 4], 1, 0.015, "flat plane is unoccluded");
    for (const axis of [0, 1]) {
      const sloped = image(32, 32, (x, y) => {
        let screen = (x + 0.5) / 32 * 2 - 1;
        let normal = [0.6, 0, 0.8];
        if (axis === 1) {
          screen = 1 - (y + 0.5) / 32 * 2;
          normal = [0, 0.6, 0.8];
        }
        return [...normal, 1.6 / (0.8 - 0.6 * screen)];
      });
      const slopedAO = await post(
        "occlusion",
        [sloped],
        [3, 1, 0],
        inverseProjection,
      );
      let mean = 0;
      for (let y = 12; y < 20; y++) {
        for (let x = 12; x < 20; x++) mean += slopedAO[(y * 32 + x) * 4] / 64;
      }
      near(mean, 1, 0.035, `sloped plane axis ${axis} must not self-occlude`);
    }
    const step = image(32, 32, (x) => {
      let depth = 2;
      if (x >= 16) depth = 1;
      return [0, 0, 1, depth];
    });
    const stepAO = await post(
      "occlusion",
      [step],
      [3, 1, 0],
      inverseProjection,
    );
    const nearEdge = stepAO[(16 * 32 + 15) * 4];
    const away = stepAO[(16 * 32 + 3) * 4];
    assert(
      nearEdge < away - 0.03,
      `depth step occlusion ${nearEdge} vs open ${away}`,
    );
    // Independent cosine-weighted ray reference: a finite raised shelf includes
    // its depth-discontinuity side wall, not just its visible front face.
    let referenceBlocked = 0;
    const count = 8192;
    const origin = [-0.0625, -0.0625, -2];
    for (let i = 0; i < count; i++) {
      const disk = Math.sqrt((i + 0.5) / count);
      const angle = i * 2.399963229728653;
      const direction = [
        disk * Math.cos(angle),
        disk * Math.sin(angle),
        Math.sqrt(1 - disk * disk),
      ];
      let enter = 0;
      let exit = Infinity;
      for (let axis = 0; axis < 3; axis++) {
        const low = [0, -1, -2][axis];
        const high = [1, 1, -1][axis];
        const first = (low - origin[axis]) / direction[axis];
        const second = (high - origin[axis]) / direction[axis];
        enter = Math.max(enter, Math.min(first, second));
        exit = Math.min(exit, Math.max(first, second));
      }
      if (enter <= exit && enter < 3) referenceBlocked += 1 - enter * enter / 9;
    }
    const referenceAO = 1 - referenceBlocked / count;
    near(
      nearEdge,
      referenceAO,
      0.06,
      "sampled horizons agree with finite ray visibility",
    );
    const noise = image(32, 32, (x, y) => {
      let base = 0.2;
      if (x >= 16) base = 0.8;
      let delta = -0.1;
      if ((x + y) % 2) delta = 0.1;
      return [base + delta, 0, 0, 1];
    });
    const denoised = await post("denoise", [noise, step], []);
    near(
      denoised[(16 * 32 + 15) * 4],
      0.2,
      0.03,
      "denoise preserves left depth boundary",
    );
    near(
      denoised[(16 * 32 + 16) * 4],
      0.8,
      0.03,
      "denoise preserves right depth boundary",
    );
    const direct = image(4, 4, () => [4, 1, 0, 1]);
    const indirect = image(4, 4, () => [2, 2, 2, 1]);
    const visibility = image(4, 4, () => [0.25, 0, 0, 1]);
    const combined = await post("combine", [direct, indirect, visibility], [1]);
    for (let c = 0; c < 3; c++) {
      near(
        combined[c],
        [4.5, 1.5, 0.5][c],
        0.001,
        "AO affects indirect light only",
      );
    }
    cases.push(
      `AO flat/step/ray reference (${nearEdge.toFixed(3)} GPU vs ${
        referenceAO.toFixed(3)
      } rays), depth-aware denoise, indirect-only combine`,
    );
    const current = image(8, 4, (x) => {
      let value = 0;
      if (x % 2 === 0) value = 1;
      return [value, value, value, 1];
    });
    const history = image(8, 4, (x) => [x / 7, x / 7, x / 7, 1]);
    const motion = image(8, 4, () => [0, 0, 0, 0]);
    const shifted = image(8, 4, () => [1 / 8, 0, 0, 0]);
    const offscreen = image(8, 4, () => [1, 0, 0, 0]);
    const depth = image(8, 4, () => [0, 0, 1, 2]);
    const wrongDepth = image(8, 4, () => [0, 0, 1, 1]);
    const cameraMotion = image(8, 4, () => [0, 0, 1, 0]);
    const sample = (values: number[]) => values[(2 * 8 + 3) * 4];
    near(
      sample(
        await post("temporal", [current, motion, history, depth, depth], [
          0.5,
          0,
          0.01,
        ]),
      ),
      3 / 14,
      0.001,
      "stationary history blend",
    );
    near(
      sample(
        await post("temporal", [current, shifted, history, depth, depth], [
          0.5,
          0,
          0.01,
        ]),
      ),
      2 / 14,
      0.001,
      "motion reprojects in UV direction",
    );
    near(
      sample(
        await post("temporal", [current, motion, history, depth, depth], [
          0.5,
          1,
          0.01,
        ]),
      ),
      0,
      0.001,
      "explicit camera-cut reset",
    );
    near(
      sample(
        await post("temporal", [current, motion, history, depth, wrongDepth], [
          0.5,
          0,
          0.01,
        ]),
      ),
      0,
      0.001,
      "depth rejection",
    );
    near(
      sample(
        await post("temporal", [
          current,
          cameraMotion,
          history,
          depth,
          wrongDepth,
        ], [0.5, 0, 0.01]),
      ),
      3 / 14,
      0.001,
      "expected previous camera depth preserves valid history",
    );
    near(
      sample(
        await post("temporal", [current, offscreen, history, depth, depth], [
          0.5,
          0,
          0.01,
        ]),
      ),
      0,
      0.001,
      "offscreen history rejection",
    );
    const firefly = image(8, 4, () => [8, 8, 8, 1]);
    near(
      sample(
        await post("temporal", [current, motion, firefly, depth, depth], [
          0.5,
          0,
          0.01,
        ]),
      ),
      0.5,
      0.001,
      "history clamps to current neighbourhood",
    );
    cases.push(
      "temporal motion, reset, depth/offscreen rejection, neighbourhood clamp",
    );
    const maximum = image(8, 4, () => [65504, 65504, 65504, 1]);
    const maximumTemporal = await post("temporal", [
      maximum,
      motion,
      maximum,
      depth,
      depth,
    ], [0.98, 0, 0.01]);
    assert(
      maximumTemporal.every(Number.isFinite),
      "HDR temporal history must remain finite",
    );
    near(
      maximumTemporal[0],
      65504,
      1,
      "HDR temporal history preserves bright limit",
    );
    const whiteEnvironment = image(32, 16, () => [1, 1, 1, 1]);
    const env = keep(gpu.environment(device, 8));
    const envUniforms = gpu.environmentParameters(device, env.mips, 64).map(
      keep,
    );
    await submit(
      "environment/constant",
      (encoder) =>
        passes.prefilter(
          encoder,
          whiteEnvironment.view,
          env,
          envUniforms.map((value) => value.buffer),
        ),
    );
    for (let mip = 0; mip < env.mips; mip++) {
      for (let face = 0; face < 6; face++) {
        const values = await pixels(env.specular, mip, face);
        for (let index = 0; index < values.length; index += 4) {
          near(
            values[index],
            1,
            0.002,
            `white environment mip ${mip} face ${face}`,
          );
        }
      }
    }
    for (let face = 0; face < 6; face++) {
      near(
        (await pixels(env.diffuse, 0, face))[0],
        Math.PI,
        0.005,
        "cosine irradiance is pi for white sky",
      );
    }
    const directionalEnvironment = image(128, 64, (x, y) => {
      const theta = (y + 0.5) / 64 * Math.PI;
      const phi = ((x + 0.5) / 128 - 0.5) * 2 * Math.PI;
      return [
        0.5 + Math.cos(phi) * Math.sin(theta) * 0.5,
        0.5 + Math.cos(theta) * 0.5,
        0.5 + Math.sin(phi) * Math.sin(theta) * 0.5,
        1,
      ];
    });
    await submit(
      "environment/directions",
      (encoder) =>
        passes.prefilter(
          encoder,
          directionalEnvironment.view,
          env,
          envUniforms.map((value) => value.buffer),
        ),
    );
    for (let face = 0; face < 6; face++) {
      const values = await pixels(env.specular, 0, face);
      const axis = Math.floor(face / 2);
      let expected = 0;
      if (face % 2 === 0) expected = 1;
      near(
        values[(3 * 8 + 3) * 4 + axis],
        expected,
        0.015,
        `cube face axis ${face}`,
      );
      if (face === 0) {
        assert(values[1] > 0.6, "+X cube top is +Y");
        assert(values[2] > 0.6, "+X cube left is +Z");
      }
    }
    cases.push(
      "white environment all faces/mips, diffuse pi, cube axis/orientation conventions",
    );
    const receiver = keep(gpu.mesh(
      device,
      new Float32Array([
        -1,
        -1,
        -2,
        0,
        0,
        1,
        1,
        -1,
        -2,
        0,
        0,
        1,
        1,
        1,
        -2,
        0,
        0,
        1,
        -1,
        1,
        -2,
        0,
        0,
        1,
      ]),
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    ));
    const caster = keep(gpu.mesh(
      device,
      new Float32Array([
        -0.5,
        -0.5,
        -1,
        0,
        0,
        1,
        0.5,
        -0.5,
        -1,
        0,
        0,
        1,
        0.5,
        0.5,
        -1,
        0,
        0,
        1,
        -0.5,
        0.5,
        -1,
        0,
        0,
        1,
      ]),
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    ));
    const object = keep(
      gpu.uniform(device, gpu.materialData({ model: gpu.identity })),
    );
    const objectGroup = passes.object(object.buffer);
    const shadowMap = keep(gpu.texture(device, 32, 32, "depth32float", 4));
    const shadowMatrix = [
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      -0.5,
      0,
      0,
      0,
      -0.25,
      1,
    ];
    const shadowCamera = keep(gpu.uniform(device, shadowMatrix));
    let lastMotion: gpu.Texture | undefined;
    const render = async (
      label: string,
      lights: readonly gpu.Light[],
      sun: gpu.Vector,
      blocked = false,
      material: gpu.Material = { model: gpu.identity },
    ) => {
      const target = keep(gpu.surface(device, 32, 32));
      lastMotion = target.motion;
      const objectValues = keep(
        gpu.uniform(device, gpu.materialData(material)),
      );
      const lightValues = keep(gpu.lightBuffer(device, lights));
      const frame = keep(gpu.uniform(
        device,
        gpu.frameData({
          viewProjection: projection,
          inverseViewProjection: inverseProjection,
          view: gpu.identity,
          eye: [0, 0, 0],
          sunDirection: [0, 0, -1],
          sunRadiance: sun,
          environmentIntensity: 0,
          lights,
          shadowMatrices: [
            shadowMatrix,
            shadowMatrix,
            shadowMatrix,
            shadowMatrix,
          ],
        }),
      ));
      const frameGroup = passes.frame(
        frame.buffer,
        lightValues,
        shadowMap.view,
        env,
      );
      await submit(label, (encoder) => {
        const casters: gpu.Draw[] = [];
        if (blocked) casters.push({ mesh: caster, object: objectGroup });
        passes.shadows(encoder, shadowMap, [
          shadowCamera.buffer,
          shadowCamera.buffer,
          shadowCamera.buffer,
          shadowCamera.buffer,
        ], casters);
        passes.geometry(encoder, target, frameGroup, [{
          mesh: receiver,
          object: passes.object(objectValues.buffer),
        }], false);
      });
      return await pixels(target.direct);
    };
    const central = (values: number[]) => values[(16 * 32 + 16) * 4];
    const brdf = (light: readonly number[], metallic = 0, roughness = 0.5) => {
      const view = [-0.0625, 0.0625, 2];
      const viewLength = Math.hypot(...view);
      const lightLength = Math.hypot(...light);
      const v = view.map((value) => value / viewLength);
      const l = light.map((value) => value / lightLength);
      const half = v.map((value, i) => value + l[i]);
      const halfLength = Math.hypot(...half);
      const h = half.map((value) => value / halfLength);
      const nv = v[2];
      const nl = Math.max(0, l[2]);
      const nh = Math.max(0, h[2]);
      const vh = Math.max(
        0,
        v.reduce((sum, value, i) => sum + value * h[i], 0),
      );
      const alphaSquared = roughness ** 4;
      const distribution = alphaSquared /
        (Math.PI * (nh * nh * (alphaSquared - 1) + 1) ** 2);
      const smith = 0.5 /
        (nl * Math.sqrt(nv * nv * (1 - alphaSquared) + alphaSquared) +
          nv * Math.sqrt(nl * nl * (1 - alphaSquared) + alphaSquared));
      const f0 = 0.04 + 0.96 * metallic;
      const fresnel = f0 + (1 - f0) * (1 - vh) ** 5;
      return ((1 - fresnel) * (1 - metallic) / Math.PI +
        fresnel * distribution * smith) * nl;
    };
    const lit = await render("PBR/directional", [], [1, 1, 1]);
    near(central(lit), brdf([0, 0, 1]), 0.003, "directional GGX vs CPU BRDF");
    const metal = await render("PBR/metallic", [], [1, 1, 1], false, {
      model: gpu.identity,
      metallic: 1,
      roughness: 1,
    });
    near(
      central(metal),
      brdf([0, 0, 1], 1, 1),
      0.002,
      "metallic GGX vs CPU BRDF",
    );
    const point: gpu.Light = {
      position: [0, 0, 0],
      range: 10,
      intensity: [4, 4, 4],
    };
    const pointLit = central(await render("PBR/point", [point], [0, 0, 0]));
    const distanceSquared = 4 + 2 * 0.0625 ** 2;
    const fade = (1 - distanceSquared ** 2 / 10 ** 4) ** 2;
    near(
      pointLit,
      brdf([-0.0625, 0.0625, 2]) * 4 * fade / distanceSquared,
      0.003,
      "point GGX inverse square vs CPU",
    );
    const spotLit = central(
      await render("PBR/spot", [{
        ...point,
        direction: [0, 0, -1],
        innerCos: 0.9,
        outerCos: 0.7,
      }], [0, 0, 0]),
    );
    near(spotLit, pointLit, 0.001, "inside spotlight cone matches point light");
    near(
      central(
        await render("PBR/spot-away", [{ ...point, direction: [0, 0, 1] }], [
          0,
          0,
          0,
        ]),
      ),
      0,
      0.001,
      "outside spotlight cone is dark",
    );
    near(
      central(await render("PBR/range", [{ ...point, range: 1 }], [0, 0, 0])),
      0,
      0.001,
      "local light finite range",
    );
    const shadowed = await render("PBR/shadow", [], [1, 1, 1], true);
    near(central(shadowed), 0, 0.002, "caster blocks directional light");
    assert(shadowed[(23 * 32 + 23) * 4] > 0.2, "outside caster remains lit");
    const emission = await render("PBR/emission", [], [0, 0, 0], false, {
      model: gpu.identity,
      emission: [8, 0, 0],
    });
    near(central(emission), 8, 0.002, "linear HDR emission survives geometry");
    const sharp = await render("PBR/sharp-metal", [], [100, 100, 100], false, {
      model: gpu.identity,
      metallic: 1,
      roughness: 0,
    });
    assert(
      sharp.every(Number.isFinite),
      "sharp metallic highlights must not overflow half precision",
    );
    assert(central(sharp) > 1, "sharp metal retains HDR highlights");
    const oldModel = [...gpu.identity];
    oldModel[14] = 1;
    await render("geometry/previous-depth", [], [0, 0, 0], false, {
      model: gpu.identity,
      previousModel: oldModel,
    });
    const previousDepth = await pixels(lastMotion!);
    near(
      previousDepth[(16 * 32 + 16) * 4 + 2],
      1,
      0.002,
      "geometry writes previous model/view depth for TAA",
    );
    cases.push(
      "directional/point/spot GGX vs CPU, metallic response, finite range, cascaded shadow occluder, HDR emission",
    );
    const vertexBuffer = (values: readonly number[]) => {
      const buffer = keep(
        device.createBuffer({
          size: values.length * 4,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(buffer, 0, new Float32Array(values));
      return buffer;
    };
    const camera = keep(gpu.uniform(device, gpu.identity));
    const spriteVertices = vertexBuffer([
      -0.8,
      -0.8,
      0.4,
      0,
      1,
      2,
      2,
      2,
      1,
      0.8,
      -0.8,
      0.4,
      1,
      1,
      2,
      2,
      2,
      1,
      0.8,
      0.8,
      0.4,
      1,
      0,
      2,
      2,
      2,
      1,
      -0.8,
      -0.8,
      0.4,
      0,
      1,
      2,
      2,
      2,
      1,
      0.8,
      0.8,
      0.4,
      1,
      0,
      2,
      2,
      2,
      1,
      -0.8,
      0.8,
      0.4,
      0,
      0,
      2,
      2,
      2,
      1,
    ]);
    const atlas = image(2, 2, () => [2, 1, 0.5, 0.5]);
    const transparentAtlas = image(2, 2, () => [2, 1, 0.5, 0]);
    const spriteTarget = keep(gpu.texture(device, 32, 32));
    const spriteDepth = keep(gpu.texture(device, 32, 32, "depth32float"));
    const sprite = async (
      label: string,
      source: gpu.Texture,
      clearDepth: number,
    ) => {
      await submit(label, (encoder) => {
        encoder.beginRenderPass({
          colorAttachments: [{
            view: spriteTarget.view,
            loadOp: "clear",
            storeOp: "store",
            clearValue: [0.2, 0.4, 0.6, 1],
          }],
          depthStencilAttachment: {
            view: spriteDepth.view,
            depthLoadOp: "clear",
            depthStoreOp: "store",
            depthClearValue: clearDepth,
          },
        }).end();
        passes.sprites(
          encoder,
          spriteTarget,
          spriteDepth,
          camera.buffer,
          source.view,
          spriteVertices,
          6,
        );
      });
      return await pixels(spriteTarget);
    };
    const visibleSprite = await sprite("sprite/alpha-HDR", atlas, 1);
    for (let channel = 0; channel < 3; channel++) {
      near(
        visibleSprite[(16 * 32 + 16) * 4 + channel],
        [2.1, 1.2, 0.8][channel],
        0.003,
        "sprite alpha/HDR blend",
      );
    }
    const hiddenSprite = await sprite("sprite/depth", atlas, 0.2);
    const transparentSprite = await sprite(
      "sprite/transparent",
      transparentAtlas,
      1,
    );
    for (const values of [hiddenSprite, transparentSprite]) {
      for (let channel = 0; channel < 3; channel++) {
        near(
          values[(16 * 32 + 16) * 4 + channel],
          [0.2, 0.4, 0.6][channel],
          0.001,
          "sprite depth and alpha discard",
        );
      }
    }
    const debugSurface = keep(gpu.surface(device, 32, 32));
    const lines = vertexBuffer([
      -0.75,
      0,
      0.4,
      3,
      0,
      0,
      1,
      0.75,
      0,
      0.4,
      3,
      0,
      0,
      1,
      0,
      -0.75,
      0.4,
      0,
      2,
      0,
      0.5,
      0,
      0.75,
      0.4,
      0,
      2,
      0,
      0.5,
    ]);
    await submit("debug/batched-lines", (encoder) => {
      encoder.beginRenderPass({
        colorAttachments: [{
          view: debugSurface.direct.view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        }],
        depthStencilAttachment: {
          view: debugSurface.depth.view,
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 1,
        },
      }).end();
      passes.debug(encoder, debugSurface, camera.buffer, lines, 4);
    });
    const debugPixels = await pixels(debugSurface.direct);
    near(
      Math.max(...debugPixels.filter((_, index) => index % 4 === 0)),
      3,
      0.001,
      "debug line batch retains HDR red",
    );
    near(
      Math.max(...debugPixels.filter((_, index) => index % 4 === 1)),
      1,
      0.001,
      "debug line batch alpha-blends green",
    );
    cases.push(
      "atlas sprites HDR/alpha/depth/discard, packed debug line batch colors",
    );
    const reversed = await gpu.createPasses(
      device,
      "rgba8unorm",
      new URL("../shaders/", location.href),
      { reversedDepth: true },
    );
    const reverseProjection = [...projection];
    for (let column = 0; column < 4; column++) {
      reverseProjection[column * 4 + 2] = projection[column * 4 + 3] -
        projection[column * 4 + 2];
    }
    const reverseInverse = [...inverseProjection];
    for (let row = 0; row < 4; row++) {
      reverseInverse[8 + row] = -inverseProjection[8 + row];
      reverseInverse[12 + row] = inverseProjection[8 + row] +
        inverseProjection[12 + row];
    }
    const reversedSurface = keep(gpu.surface(device, 32, 32));
    const noLights = keep(gpu.lightBuffer(device, []));
    const reversedObject = keep(
      gpu.uniform(
        device,
        gpu.materialData({ model: gpu.identity, emission: [0, 2, 0] }),
      ),
    );
    const reversedFrame = keep(
      gpu.uniform(
        device,
        gpu.frameData({
          viewProjection: reverseProjection,
          inverseViewProjection: reverseInverse,
          view: gpu.identity,
          eye: [0, 0, 0],
          environmentIntensity: 1,
        }),
      ),
    );
    const reverseGroup = reversed.frame(
      reversedFrame.buffer,
      noLights,
      shadowMap.view,
      env,
    );
    await submit(
      "geometry/reversed-depth",
      (encoder) =>
        reversed.geometry(encoder, reversedSurface, reverseGroup, [{
          mesh: receiver,
          object: reversed.object(reversedObject.buffer),
        }]),
    );
    const reversedPixels = await pixels(reversedSurface.direct);
    near(
      reversedPixels[(16 * 32 + 16) * 4 + 1],
      2,
      0.002,
      "reversed depth geometry appears ahead of sky",
    );
    assert(
      reversedPixels.slice(0, 3).some((value) => value > 0.05),
      "reversed sky remains visible behind geometry",
    );
    const orthoFrame = keep(
      gpu.uniform(
        device,
        gpu.frameData({
          viewProjection: gpu.identity,
          inverseViewProjection: gpu.identity,
          view: gpu.identity,
          eye: [0, 0, 0],
          environmentIntensity: 1,
        }),
      ),
    );
    const orthoSurface = keep(gpu.surface(device, 32, 32));
    await submit(
      "geometry/orthographic-sky",
      (encoder) =>
        passes.geometry(
          encoder,
          orthoSurface,
          passes.frame(orthoFrame.buffer, noLights, shadowMap.view, env),
          [],
        ),
    );
    const orthoMotion = await pixels(orthoSurface.motion);
    assert(
      orthoMotion.every(Number.isFinite),
      "orthographic sky motion cannot divide by zero",
    );
    for (let index = 0; index < orthoMotion.length; index += 4) {
      near(
        orthoMotion[index],
        0,
        0.002,
        "stationary orthographic sky horizontal motion",
      );
      near(
        orthoMotion[index + 1],
        0,
        0.002,
        "stationary orthographic sky vertical motion",
      );
    }
    cases.push(
      "reversed-depth geometry/sky and stationary orthographic sky motion",
    );
    return {
      compiled: true,
      cases,
      timestamp,
      timings,
      adapter: adapter!.info.description,
    };
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
}
Object.assign(globalThis, { gpuWitnesses: witnesses, inkReady: true });

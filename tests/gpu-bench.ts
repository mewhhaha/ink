import * as gpu from "../adapters/gpu.ts";

/** Full-size pass measurements, separate from small correctness witnesses. */
export async function benchmark(width: number, height: number, rounds = 3) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU is unavailable");
  const features: GPUFeatureName[] = [];
  if (adapter.features.has("timestamp-query")) features.push("timestamp-query");
  const device = await adapter.requestDevice({ requiredFeatures: features });
  const errors: string[] = [];
  device.addEventListener(
    "uncapturederror",
    (event) => errors.push(event.error.message),
  );
  const owned: { destroy(): void }[] = [];
  const keep = <T extends { destroy(): void }>(value: T) => {
    owned.push(value);
    return value;
  };
  try {
    const passes = await gpu.createPasses(
      device,
      "rgba8unorm",
      new URL("/shaders/", location.href),
    );
    const radiance = keep(gpu.texture(device, width, height));
    const normals = keep(gpu.texture(device, width, height));
    const motion = keep(gpu.texture(device, width, height));
    const history = keep(gpu.texture(device, width, height));
    const output = keep(gpu.texture(device, width, height));
    const ao = keep(gpu.texture(device, width, height, "r32float"));
    const filtered = keep(gpu.texture(device, width, height, "r32float"));
    const pyramid = keep(gpu.bloomPyramid(device, width, height));
    let bloomOutput = pyramid.down[0].view;
    const display = keep(gpu.texture(device, width, height, "rgba8unorm"));
    const pixels = new Uint16Array(width * height * 4);
    const depth = new Uint16Array(pixels.length);
    const velocity = new Uint16Array(pixels.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        pixels.set([0x4000, 0x3c00, 0x3400, 0x3c00], i);
        let distance = 0x4000;
        if (x >= width / 2) distance = 0x3c00;
        depth.set([0, 0, 0x3c00, distance], i);
        velocity[i + 2] = distance;
      }
    }
    for (
      const [target, data] of [[radiance, pixels], [history, pixels], [
        normals,
        depth,
      ], [motion, velocity]] as const
    ) {
      device.queue.writeTexture({ texture: target.texture }, data, {
        bytesPerRow: width * 8,
      }, [width, height]);
    }
    const inverseProjection = [...gpu.identity];
    inverseProjection[0] = 10 * width / height;
    inverseProjection[5] = 10;
    inverseProjection[10] = -20;
    const aoParams = keep(
      gpu.uniform(
        device,
        gpu.postData({ stage: "occlusion", radius: 1.4, inverseProjection }),
      ),
    );
    const temporalParams = keep(
      gpu.uniform(
        device,
        gpu.postData({
          stage: "temporal",
          blend: 0.9,
          reset: false,
          depthTolerance: 0.02,
        }),
      ),
    );
    const bloomParams = keep(
      gpu.uniform(
        device,
        gpu.postData({ stage: "bloom", threshold: 1, knee: 0.5, exposure: 0 }),
      ),
    );
    const displayParams = keep(gpu.uniform(device, [0, 0.12, 0, 0]));
    const previousDepth = keep(gpu.texture(device, width, height, "r32float"));
    const prepare = device.createCommandEncoder();
    passes.post(prepare, {
      stage: "depth",
      parameters: temporalParams.buffer,
      normalDepth: normals.view,
      output: previousDepth,
    });
    device.queue.submit([prepare.finish()]);
    await device.queue.onSubmittedWorkDone();
    const stages: [string, (encoder: GPUCommandEncoder) => void][] = [
      [
        "ao",
        (encoder) =>
          passes.post(encoder, {
            stage: "occlusion",
            parameters: aoParams.buffer,
            normalDepth: normals.view,
            output: ao,
          }),
      ],
      [
        "denoise",
        (encoder) =>
          passes.post(encoder, {
            stage: "denoise",
            parameters: aoParams.buffer,
            occlusion: ao.view,
            normalDepth: normals.view,
            output: filtered,
          }),
      ],
      ["temporal", (encoder) =>
        passes.post(encoder, {
          stage: "temporal",
          parameters: temporalParams.buffer,
          current: radiance.view,
          motion: motion.view,
          history: history.view,
          normalDepth: normals.view,
          previousDepth: previousDepth.view,
          output,
        })],
      ["bloom", (encoder) => {
        bloomOutput = passes.bloom(
          encoder,
          radiance.view,
          bloomParams.buffer,
          pyramid,
        );
      }],
      [
        "display",
        (encoder) =>
          passes.display(
            encoder,
            radiance.view,
            bloomOutput,
            displayParams.buffer,
            display.view,
          ),
      ],
    ];
    const results: Record<string, { gpuMs: number[]; queueWallMs: number[] }> =
      {};
    for (const [name, encode] of stages) {
      const queueSamples: number[] = [];
      const gpuSamples: number[] = [];
      for (let round = -1; round < rounds; round++) {
        const encoder = device.createCommandEncoder();
        let queries: GPUQuerySet | undefined;
        let resolved: GPUBuffer | undefined;
        let read: GPUBuffer | undefined;
        if (features.length) {
          queries = device.createQuerySet({ type: "timestamp", count: 2 });
          resolved = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
          });
          read = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          encoder.beginComputePass({
            timestampWrites: {
              querySet: queries,
              beginningOfPassWriteIndex: 0,
            },
          }).end();
        }
        encode(encoder);
        if (queries && resolved && read) {
          encoder.beginComputePass({
            timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 },
          }).end();
          encoder.resolveQuerySet(queries, 0, 2, resolved, 0);
          encoder.copyBufferToBuffer(resolved, 0, read, 0, 16);
        }
        const started = performance.now();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        if (round >= 0) queueSamples.push(performance.now() - started);
        if (read) {
          await read.mapAsync(GPUMapMode.READ);
          const stamps = new BigUint64Array(read.getMappedRange());
          if (round >= 0) gpuSamples.push(Number(stamps[1] - stamps[0]) / 1e6);
          read.unmap();
          read.destroy();
        }
        resolved?.destroy();
        queries?.destroy();
        if (errors.length) throw new Error(errors.join("\n"));
      }
      results[name] = { queueWallMs: queueSamples, gpuMs: gpuSamples };
    }
    const read = keep(device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }));
    const witness = device.createCommandEncoder();
    witness.copyTextureToBuffer(
      {
        texture: display.texture,
        origin: [Math.floor(width / 2), Math.floor(height / 2)],
      },
      { buffer: read, bytesPerRow: 256 },
      [1, 1],
    );
    device.queue.submit([witness.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const displayCenter = Array.from(
      new Uint8Array(read.getMappedRange(), 0, 4),
    );
    read.unmap();
    if (errors.length) throw new Error(errors.join("\n"));
    if (
      displayCenter[3] !== 255 || displayCenter.slice(0, 3).some((x) => x === 0)
    ) {
      throw new Error(`Invalid display witness: ${displayCenter}`);
    }
    return {
      width,
      height,
      rounds,
      warmup: 1,
      fixture: "constant HDR, split depth, zero velocity, noise frame 0",
      witness: { displayCenter },
      timestamp: features.length > 0,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
        fallback: adapter.info.isFallbackAdapter,
      },
      results,
    };
  } finally {
    await device.queue.onSubmittedWorkDone();
    for (const value of owned) value.destroy();
    device.destroy();
  }
}

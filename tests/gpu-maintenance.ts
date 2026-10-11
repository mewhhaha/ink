import * as gpu from "../adapters/gpu.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function maintenance() {
  const adapter = await navigator.gpu.requestAdapter();
  assert(!!adapter, "WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener(
    "uncapturederror",
    (event) => errors.push(event.error.message),
  );
  const live = new Set<GPUBuffer | GPUTexture>();
  const counts = {
    buffers: 0,
    textures: 0,
    textureBytes: 0,
    groups: 0,
    views: 0,
    render: 0,
    compute: 0,
    modules: [] as string[],
  };
  const vertexLayouts: GPUVertexBufferLayout[] = [];
  const writes: AllowSharedBufferSource[] = [];
  const createBuffer = device.createBuffer;
  device.createBuffer = (descriptor) => {
    const value = createBuffer.call(device, descriptor);
    counts.buffers++;
    live.add(value);
    const destroy = value.destroy;
    value.destroy = () => {
      live.delete(value);
      destroy.call(value);
    };
    return value;
  };
  const createTexture = device.createTexture;
  device.createTexture = (descriptor) => {
    const value = createTexture.call(device, descriptor);
    counts.textures++;
    let pixelBytes = 4;
    if (value.format === "rgba16float") pixelBytes = 8;
    for (let mip = 0; mip < value.mipLevelCount; mip++) {
      counts.textureBytes += Math.max(1, value.width >> mip) *
        Math.max(1, value.height >> mip) * value.depthOrArrayLayers *
        pixelBytes;
    }
    live.add(value);
    const destroy = value.destroy;
    value.destroy = () => {
      live.delete(value);
      destroy.call(value);
    };
    const createView = value.createView;
    value.createView = (options) => {
      counts.views++;
      return createView.call(value, options);
    };
    return value;
  };
  const createGroup = device.createBindGroup;
  device.createBindGroup = (descriptor) => {
    counts.groups++;
    return createGroup.call(device, descriptor);
  };
  const createModule = device.createShaderModule;
  device.createShaderModule = (descriptor) => {
    counts.modules.push(descriptor.label ?? "");
    return createModule.call(device, descriptor);
  };
  const createRender = device.createRenderPipelineAsync;
  device.createRenderPipelineAsync = (descriptor) => {
    counts.render++;
    for (const layout of descriptor.vertex.buffers ?? []) {
      if (layout) vertexLayouts.push(layout);
    }
    return createRender.call(device, descriptor);
  };
  const createCompute = device.createComputePipelineAsync;
  device.createComputePipelineAsync = (descriptor) => {
    counts.compute++;
    return createCompute.call(device, descriptor);
  };
  const writeBuffer = device.queue.writeBuffer;
  device.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
    writes.push(data);
    writeBuffer.call(device.queue, buffer, offset, data, dataOffset, size);
  };
  const snapshot = () => ({
    render: counts.render,
    compute: counts.compute,
    modules: [...counts.modules],
  });
  try {
    device.pushErrorScope("validation");
    let started = performance.now();
    const selected = await gpu.createPasses(
      device,
      "rgba8unorm",
      new URL("/shaders/", location.href),
      { passes: ["bloom"] },
    );
    const selectedMs = performance.now() - started;
    const selectedCount = snapshot();
    assert(
      selectedCount.render === 0 && selectedCount.compute === 3,
      "Bloom selection compiled unrelated pipelines",
    );
    assert(
      selectedCount.modules.length === 1 &&
        selectedCount.modules[0] === "ink/post",
      "Bloom selection loaded unrelated WGSL",
    );
    counts.render = 0;
    counts.compute = 0;
    counts.modules.length = 0;
    started = performance.now();
    const passes = await gpu.createPasses(
      device,
      "rgba8unorm",
      new URL("/shaders/", location.href),
    );
    const allMs = performance.now() - started;
    const allCount = snapshot();
    assert(
      allCount.render > 0 && allCount.compute > selectedCount.compute &&
        allCount.modules.length === 7,
      "Default pass coverage changed",
    );
    for (
      const [stride, attributes] of [
        [gpu.layout.vertex.mesh, [[0, 0, "float32x3"], [1, 12, "float32x3"]]],
        [gpu.layout.vertex.debug, [[0, 0, "float32x3"], [1, 12, "float32x4"]]],
        [gpu.layout.vertex.sprite, [[0, 0, "float32x3"], [1, 12, "float32x2"], [
          2,
          20,
          "float32x4",
        ]]],
      ] as const
    ) {
      const layout = vertexLayouts.find((value) =>
        value.arrayStride === stride
      );
      assert(!!layout, `Missing vertex stride ${stride}`);
      assert(
        JSON.stringify(
          Array.from(
            layout.attributes,
            (value) => [value.shaderLocation, value.offset, value.format],
          ),
        ) === JSON.stringify(attributes),
        `Vertex attributes changed for stride ${stride}`,
      );
    }
    const uniform = gpu.uniform(device, [1, 2, 3]);
    const beforeWrites = writes.length;
    for (let i = 0; i < 20; i++) uniform.update([i]);
    assert(
      writes.slice(beforeWrites).every((value) =>
        value === writes[beforeWrites]
      ),
      "Uniform updates allocate staging arrays",
    );
    const staging = writes[beforeWrites] as Float32Array;
    assert(
      staging[0] === 19 && staging[1] === 0 && staging[3] === 0,
      "Uniform update padding retained stale values",
    );
    uniform.destroy();

    const environmentWrites = writes.length;
    const environmentParameters = gpu.environmentParameters(device, 3, 257);
    for (let i = 0; i < environmentParameters.length; i++) {
      const data = writes[environmentWrites + i] as Float32Array;
      const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
      assert(bits[1] === 257, "Environment sample count lost its U32 bits");
      let diffuse = 0;
      if (i === 3) diffuse = 1;
      assert(
        bits[2] === diffuse && bits[3] === 0,
        "Environment mode/padding layout changed",
      );
      environmentParameters[i].destroy();
    }

    const frameResources = () => {
      const surface = gpu.surface(device, 16, 16);
      const shadows = gpu.texture(device, 8, 8, "depth32float", 4);
      const env = gpu.environment(device, 8);
      const object = gpu.uniform(
        device,
        gpu.materialData({ model: gpu.identity }),
      );
      const camera = gpu.uniform(
        device,
        gpu.frameData({
          viewProjection: gpu.identity,
          inverseViewProjection: gpu.identity,
          view: gpu.identity,
          eye: [0, 0, 3],
        }),
      );
      const shadowCamera = gpu.uniform(device, gpu.identity);
      const lights = gpu.lightBuffer(device, []);
      const mesh = gpu.mesh(
        device,
        new Float32Array([
          -0.5,
          -0.5,
          0,
          0,
          0,
          1,
          0.5,
          -0.5,
          0,
          0,
          0,
          1,
          0,
          0.5,
          0,
          0,
          0,
          1,
        ]),
        new Uint32Array([0, 1, 2]),
      );
      const ao = gpu.texture(device, 16, 16, "r32float");
      const combined = gpu.texture(device, 16, 16);
      const output = gpu.texture(device, 16, 16, "rgba8unorm");
      const pyramid = gpu.bloomPyramid(device, 16, 16);
      const combine = gpu.uniform(
        device,
        gpu.postData({ stage: "combine", strength: 1 }),
      );
      const bloom = gpu.uniform(
        device,
        gpu.postData({ stage: "bloom", threshold: 1, knee: 0.5, exposure: 0 }),
      );
      const display = gpu.uniform(device, [0, 0.1, 0, 0]);
      const resources = [
        surface,
        shadows,
        env,
        object,
        camera,
        shadowCamera,
        lights,
        mesh,
        ao,
        combined,
        output,
        pyramid,
        combine,
        bloom,
        display,
      ];
      function encode() {
        const encoder = device.createCommandEncoder();
        const draws = [{ mesh, object: passes.object(object.buffer) }];
        const frame = passes.frame(camera.buffer, lights, shadows.view, env);
        passes.shadows(encoder, shadows, [
          shadowCamera.buffer,
          shadowCamera.buffer,
          shadowCamera.buffer,
          shadowCamera.buffer,
        ], draws);
        passes.geometry(encoder, surface, frame, draws);
        passes.post(encoder, {
          stage: "combine",
          parameters: combine.buffer,
          direct: surface.direct.view,
          indirect: surface.indirect.view,
          occlusion: ao.view,
          output: combined,
        });
        const light = selected.bloom(
          encoder,
          combined.view,
          bloom.buffer,
          pyramid,
        );
        passes.display(
          encoder,
          combined.view,
          light,
          display.buffer,
          output.view,
        );
        device.queue.submit([encoder.finish()]);
      }
      return {
        encode,
        destroy() {
          for (const resource of resources) {
            resource.destroy();
            resource.destroy();
          }
        },
      };
    };
    let frame = frameResources();
    const before = { groups: counts.groups, views: counts.views };
    frame.encode();
    await device.queue.onSubmittedWorkDone();
    const cold = {
      groups: counts.groups - before.groups,
      views: counts.views - before.views,
    };
    const warmed = { groups: counts.groups, views: counts.views };
    for (let i = 0; i < 10; i++) frame.encode();
    await device.queue.onSubmittedWorkDone();
    const retained = {
      groups: counts.groups - warmed.groups,
      views: counts.views - warmed.views,
    };
    assert(
      cold.groups > 0 && cold.views > 0,
      "Allocation witness did not exercise binding/view creation",
    );
    assert(
      retained.groups === 0 && retained.views === 0,
      `Repeated frames allocated groups/views: ${JSON.stringify(retained)}`,
    );
    frame.destroy();
    assert(live.size === 0, `Warm frame leaked ${live.size} resources`);
    for (let i = 0; i < 100; i++) {
      frame = frameResources();
      frame.encode();
      await device.queue.onSubmittedWorkDone();
      frame.destroy();
      assert(
        live.size === 0,
        `Cycle ${i} leaked ${live.size} buffers/textures`,
      );
    }

    const footprint = (optimized: boolean) => {
      const width = 1920, height = 1080;
      const requestedBefore = counts.textureBytes;
      const surface = gpu.surface(device, width, height);
      let scalar: GPUTextureFormat = "rgba16float";
      if (optimized) scalar = "r32float";
      const textures = [
        surface.direct,
        surface.indirect,
        surface.normalDepth,
        surface.motion,
        surface.depth,
      ];
      for (let i = 0; i < 2; i++) {
        textures.push(gpu.texture(device, width, height, scalar));
      }
      for (let i = 0; i < 2; i++) {
        textures.push(gpu.texture(device, width, height));
      }
      for (let i = 0; i < 2; i++) {
        textures.push(gpu.texture(device, width, height, scalar));
      }
      if (!optimized) textures.push(gpu.texture(device, width, height));
      const pyramid = gpu.bloomPyramid(device, width, height);
      textures.push(...pyramid.down, ...pyramid.up);
      const declaredBytes = textures.reduce(
        (sum, value) => sum + value.bytes,
        0,
      );
      const bytes = counts.textureBytes - requestedBefore;
      assert(
        bytes === declaredBytes,
        "Texture.bytes disagrees with real GPU texture dimensions and formats",
      );
      for (const texture of textures) texture.destroy();
      assert(live.size === 0, "Footprint witness leaked textures");
      return {
        width,
        height,
        bytes,
        bytesPerPixel: bytes / width / height,
        mebibytes: bytes / 1024 / 1024,
      };
    };
    const baseline = footprint(false);
    const optimized = footprint(true);
    const reduction = 1 - optimized.bytes / baseline.bytes;
    assert(
      reduction >= 0.24 && reduction <= 0.26,
      `Unexpected frame memory reduction ${reduction}`,
    );
    const validation = await device.popErrorScope();
    if (validation) errors.push(validation.message);
    assert(errors.length === 0, errors.join("\n"));
    return {
      adapter: adapter.info.description,
      startup: {
        selected: { milliseconds: selectedMs, ...selectedCount },
        all: { milliseconds: allMs, ...allCount },
      },
      allocations: { cold, repeatedFrames: 10, retained, avoidedFraction: 1 },
      uniformStagingReused: true,
      resourceAudit: {
        cycles: 100,
        createdBuffers: counts.buffers,
        createdTextures: counts.textures,
        live: live.size,
      },
      footprint: { baseline, optimized, reduction },
    };
  } finally {
    for (const resource of live) resource.destroy();
    device.destroy();
  }
}

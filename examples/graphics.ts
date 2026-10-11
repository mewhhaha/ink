import * as gpu from "@ink/blot/gpu";

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const status = document.querySelector<HTMLElement>("#status")!;
const controls = ["shadows", "ao", "bloom", "taa", "motion", "exposure"];
const query = new URLSearchParams(location.search);
for (const id of controls) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
  if (query.has(id)) {
    if (input.type === "checkbox") input.checked = query.get(id) === "1";
    else input.value = query.get(id)!;
  }
  input.addEventListener("input", () => {
    if (input.type === "checkbox") query.set(id, String(Number(input.checked)));
    else query.set(id, input.value);
    history.replaceState(null, "", `?${query}`);
    document.querySelector<HTMLOutputElement>("#stops")!.value = `${
      value("exposure")
    } stops`;
    reset = true;
    requestDraw();
  });
}
function checked(id: string) {
  return document.querySelector<HTMLInputElement>(`#${id}`)!.checked;
}
function value(id: string) {
  return Number(document.querySelector<HTMLInputElement>(`#${id}`)!.value);
}
document.querySelector<HTMLOutputElement>("#stops")!.value = `${
  value("exposure")
} stops`;
let reset = true;
let requestDraw = () => {};
document.querySelector("#reset")!.addEventListener("click", () => {
  reset = true;
  requestDraw();
});

type V = [number, number, number];
function add(a: V, b: V): V {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: V, b: V): V {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function mul(a: V, s: number): V {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: V, b: V) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normal(a: V): V {
  return mul(a, 1 / Math.hypot(...a));
}
function cross(a: V, b: V): V {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function matrixMultiply(a: ArrayLike<number>, b: ArrayLike<number>) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) {
        result[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
      }
    }
  }
  return result;
}
function inverse(a: ArrayLike<number>) {
  const rows = Array.from({ length: 4 }, (_, i) => {
    const row = Array.from({ length: 8 }, () => 0);
    for (let j = 0; j < 4; j++) row[j] = a[j * 4 + i];
    row[i + 4] = 1;
    return row;
  });
  for (let i = 0; i < 4; i++) {
    let best = i;
    for (let j = i + 1; j < 4; j++) {
      if (Math.abs(rows[j][i]) > Math.abs(rows[best][i])) best = j;
    }
    [rows[i], rows[best]] = [rows[best], rows[i]];
    const scale = rows[i][i];
    for (let j = 0; j < 8; j++) rows[i][j] /= scale;
    for (let j = 0; j < 4; j++) {
      if (j !== i) {
        const factor = rows[j][i];
        for (let k = 0; k < 8; k++) rows[j][k] -= rows[i][k] * factor;
      }
    }
  }
  const result = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) result[j * 4 + i] = rows[i][j + 4];
  }
  return result;
}
function view(eye: V, target: V) {
  const z = normal(sub(eye, target));
  let up: V = [0, 1, 0];
  if (Math.abs(z[1]) > 0.99) up = [1, 0, 0];
  const x = normal(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
}
function perspective(aspect: number) {
  const y = 1 / Math.tan(0.65 * 0.5);
  return new Float32Array([
    y / aspect,
    0,
    0,
    0,
    0,
    y,
    0,
    0,
    0,
    0,
    40 / (0.1 - 40),
    -1,
    0,
    0,
    0.1 * 40 / (0.1 - 40),
    0,
  ]);
}
function model(position: V, scale: V = [1, 1, 1]) {
  return new Float32Array([
    scale[0],
    0,
    0,
    0,
    0,
    scale[1],
    0,
    0,
    0,
    0,
    scale[2],
    0,
    ...position,
    1,
  ]);
}
function sphereGeometry() {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= 24; y++) {
    for (let x = 0; x <= 48; x++) {
      const theta = y / 24 * Math.PI;
      const phi = x / 48 * 2 * Math.PI;
      const p = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ];
      vertices.push(...p, ...p);
      if (x < 48 && y < 24) {
        const i = y * 49 + x;
        indices.push(i, i + 1, i + 49, i + 1, i + 50, i + 49);
      }
    }
  }
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
  };
}
// IEEE half conversion for a small authored HDR equirectangular sky.
function half(value: number) {
  if (value <= 0) return 0;
  if (value >= 65504) return 0x7bff;
  const exponent = Math.floor(Math.log2(value));
  if (exponent < -14) return Math.round(value * 16777216);
  return (exponent + 15) * 1024 +
    Math.round((value / 2 ** exponent - 1) * 1024);
}
function skyData(width: number, height: number) {
  const pixels = new Uint16Array(width * height * 4);
  const sun = normal([-1, 2, 1]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const theta = (y + 0.5) / height * Math.PI;
      const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const direction: V = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ];
      let top = [0.17, 0.3, 0.23];
      if (direction[1] < 0) top = [0.05, 0.06, 0.035];
      const horizon = [0.6, 0.66, 0.45];
      const factor = Math.sqrt(Math.abs(direction[1]));
      const glow = 12 * Math.max(0, dot(direction, sun)) ** 200;
      const i = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) {
        pixels[i + k] = half(
          horizon[k] + (top[k] - horizon[k]) * factor + glow,
        );
      }
      pixels[i + 3] = half(1);
    }
  }
  return pixels;
}

async function main() {
  const api = navigator.gpu;
  if (!api) throw new Error("This example requires WebGPU.");
  const adapter = await api.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter is available.");
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.lost.then((info) => {
    errors.push(`Lost ${info.reason}: ${info.message}`);
    if (info.reason !== "destroyed") fail(`GPU device lost: ${info.message}`);
  });
  device.addEventListener("uncapturederror", (event) => {
    errors.push(event.error.message);
    document.querySelector("#error")!.textContent = event.error.message;
  });
  const context = canvas.getContext("webgpu") as unknown as GPUCanvasContext;
  const format = api.getPreferredCanvasFormat();
  status.textContent = "Compiling passes…";
  const passes = await gpu.createPasses(
    device,
    format,
    new URL("/shaders/", location.href),
  );
  status.textContent = "Preparing sky…";
  const sky = gpu.texture(device, 256, 128);
  device.queue.writeTexture({ texture: sky.texture }, skyData(256, 128), {
    bytesPerRow: 256 * 8,
  }, [256, 128]);
  const environment = gpu.environment(device, 32);
  const envParameters = gpu.environmentParameters(device, environment.mips, 64);
  const prepare = device.createCommandEncoder();
  passes.prefilter(
    prepare,
    sky.view,
    environment,
    envParameters.map((p) => p.buffer),
  );
  device.queue.submit([prepare.finish()]);
  await device.queue.onSubmittedWorkDone();
  status.textContent = "Preparing geometry…";
  const sphere = sphereGeometry();
  const sphereMesh = gpu.mesh(device, sphere.vertices, sphere.indices);
  const groundMesh = gpu.mesh(
    device,
    new Float32Array([
      -12,
      0,
      -12,
      0,
      1,
      0,
      12,
      0,
      -12,
      0,
      1,
      0,
      12,
      0,
      12,
      0,
      1,
      0,
      -12,
      0,
      12,
      0,
      1,
      0,
    ]),
    new Uint32Array([0, 2, 1, 0, 3, 2]),
  );
  const uniforms: gpu.Uniform[] = [];
  const draws: gpu.Draw[] = [];
  function object(mesh: gpu.Mesh, material: gpu.Material) {
    const uniform = gpu.uniform(device, gpu.materialData(material));
    uniforms.push(uniform);
    draws.push({ mesh, object: passes.object(uniform.buffer) });
    return uniform;
  }
  object(groundMesh, {
    model: gpu.identity,
    base: [0.13, 0.18, 0.09, 1],
    roughness: 0.85,
  });
  const colors = [[0.68, 0.37, 0.13], [0.09, 0.22, 0.12], [0.55, 0.59, 0.37]];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 5; column++) {
      const color = colors[row];
      object(sphereMesh, {
        model: model([(column - 2) * 1.65, 0.65, (row - 1) * 1.9], [
          0.65,
          0.65,
          0.65,
        ]),
        base: [color[0], color[1], color[2], 1],
        metallic: row / 2,
        roughness: 0.12 + column * 0.2,
      });
    }
  }
  const lamp = object(sphereMesh, {
    model: model([4.8, 1.5, -1], [0.12, 1.5, 0.12]),
    emission: [8, 3, 0.7],
    roughness: 0.5,
  });
  object(sphereMesh, {
    model: model([-4.6, 0.8, 0.4], [0.17, 0.8, 0.17]),
    emission: [0.7, 3, 5],
    roughness: 0.5,
  });
  const lights: gpu.Light[] = [
    { position: [4.8, 1.7, -1], range: 8, intensity: [20, 7, 1.5] },
    {
      position: [-4.6, 1.5, 0.4],
      range: 7,
      intensity: [1, 8, 15],
      direction: [1, -0.3, 0],
      innerCos: 0.85,
      outerCos: 0.2,
    },
  ];
  const lightBuffer = gpu.lightBuffer(device, lights);
  const shadowMap = gpu.texture(device, 512, 512, "depth32float", 4);
  const shadowCameras = Array.from(
    { length: 4 },
    () => gpu.uniform(device, gpu.identity),
  );
  const shadowBuffers = shadowCameras.map((camera) => camera.buffer);
  const shadowViews = shadowCameras.map((_, layer) =>
    shadowMap.texture.createView({
      dimension: "2d",
      baseArrayLayer: layer,
      arrayLayerCount: 1,
    })
  );
  const frameData = new Float32Array(gpu.layout.frame.length);
  const lampData = new Float32Array(gpu.layout.object.length);
  const lightData = gpu.lightData(lights);
  const frameUniform = gpu.uniform(device, frameData);
  const frameGroup = passes.frame(
    frameUniform.buffer,
    lightBuffer,
    shadowMap.view,
    environment,
  );
  const eye: V = [9, 8, 13];
  const target: V = [0, 0.3, 0];
  const viewMatrix = view(eye, target);
  const forward = normal(sub(target, eye));
  const right = normal(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const lightDirection = normal([1, -2, -1]);
  const splits = gpu.cascadeSplits(0.1, 35);
  function shadowMatrix(near: number, far: number, aspect: number) {
    const corners: V[] = [];
    for (const depth of [near, far]) {
      for (const x of [-1, 1]) {
        for (const y of [-1, 1]) {
          corners.push(
            add(
              add(
                add(eye, mul(forward, depth)),
                mul(right, depth * Math.tan(0.325) * aspect * x),
              ),
              mul(up, depth * Math.tan(0.325) * y),
            ),
          );
        }
      }
    }
    let centre: V = [0, 0, 0];
    for (const corner of corners) centre = add(centre, mul(corner, 1 / 8));
    let radius = 0;
    for (const corner of corners) {
      radius = Math.max(radius, Math.hypot(...sub(corner, centre)));
    }
    radius = Math.ceil(radius * 16) / 16 / (1 - 1 / 512);
    const lx = normal(cross([0, 1, 0], mul(lightDirection, -1)));
    const ly = cross(mul(lightDirection, -1), lx);
    const texel = radius * 2 / 512;
    centre = add(
      centre,
      add(
        mul(lx, Math.round(dot(lx, centre) / texel) * texel - dot(lx, centre)),
        mul(ly, Math.round(dot(ly, centre) / texel) * texel - dot(ly, centre)),
      ),
    );
    const depth = radius + 12;
    const lightView = view(sub(centre, mul(lightDirection, depth)), centre);
    const orthographic = new Float32Array([
      1 / radius,
      0,
      0,
      0,
      0,
      1 / radius,
      0,
      0,
      0,
      0,
      -1 / (depth * 2),
      0,
      0,
      0,
      0,
      1,
    ]);
    return matrixMultiply(orthographic, lightView);
  }
  let width = 0;
  let height = 0;
  let surface: gpu.Surface;
  let aoRaw: gpu.Texture;
  let ao: gpu.Texture;
  let history: gpu.Texture[] = [];
  let depths: gpu.Texture[] = [];
  let pyramid: ReturnType<typeof gpu.bloomPyramid>;
  let frameNumber = 0;
  let previousVP: Float32Array | undefined;
  let previousLamp = model([4.8, 1.5, -1], [0.12, 1.5, 0.12]);
  const aoData = gpu.postData({
    stage: "occlusion",
    inverseProjection: gpu.identity,
    radius: 1.4,
    visibility: 1.1,
  });
  const combineData = gpu.postData({ stage: "combine", strength: 1 });
  const bloomData = gpu.postData({
    stage: "bloom",
    threshold: 1,
    knee: 0.5,
    exposure: 0,
  });
  const temporalData = gpu.postData({
    stage: "temporal",
    blend: 0.9,
    reset: true,
    depthTolerance: 0.025,
  });
  const aoParams = gpu.uniform(device, aoData);
  const combineParams = gpu.uniform(device, combineData);
  const bloomParams = gpu.uniform(device, bloomData);
  const temporalParams = gpu.uniform(device, temporalData);
  const displayParams = gpu.uniform(device, [0, 0.1, 0, 0]);
  let scheduled = false;
  let drawing = false;
  let pendingDraw = false;
  let disposed = false;
  let framesToSettle = 16;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  if (reducedMotion.matches) {
    document.querySelector<HTMLInputElement>("#motion")!.checked = false;
  }
  let lastTime = 0;
  async function draw(now: number) {
    if (disposed) return;
    drawing = true;
    pendingDraw = false;
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width * 0.75));
    const nextHeight = Math.max(1, Math.round(rect.height * 0.75));
    if (width !== nextWidth || height !== nextHeight) {
      if (width) {
        await device.queue.onSubmittedWorkDone();
        if (disposed) return;
        surface.destroy();
        aoRaw.destroy();
        ao.destroy();
        pyramid.destroy();
        for (const item of [...history, ...depths]) item.destroy();
      }
      width = canvas.width = nextWidth;
      height = canvas.height = nextHeight;
      context.configure({ device, format, alphaMode: "opaque" });
      surface = gpu.surface(device, width, height);
      aoRaw = gpu.texture(device, width, height, "r32float");
      ao = gpu.texture(device, width, height, "r32float");
      history = [
        gpu.texture(device, width, height),
        gpu.texture(device, width, height),
      ];
      depths = [
        gpu.texture(device, width, height, "r32float"),
        gpu.texture(device, width, height, "r32float"),
      ];
      pyramid = gpu.bloomPyramid(device, width, height);
      reset = true;
    }
    if (reset) {
      framesToSettle = 1;
      if (checked("taa")) framesToSettle = 16;
    }
    const projection = perspective(width / height);
    if (checked("taa")) {
      const jitter = gpu.jitter(frameNumber, width, height);
      projection[8] -= jitter[0];
      projection[9] -= jitter[1];
    }
    const vp = matrixMultiply(projection, viewMatrix);
    const shadowMatrices = splits.map((far, i) => {
      let near = 0.1;
      if (i > 0) near = splits[i - 1];
      return shadowMatrix(near, far, width / height);
    });
    for (let i = 0; i < 4; i++) shadowCameras[i].update(shadowMatrices[i]);
    let motion = 0;
    if (checked("motion") && !reducedMotion.matches) {
      motion = Math.sin(now / 1000) * 1.5;
    }
    const currentLamp = model([4.8, 1.5, -1 + motion], [0.12, 1.5, 0.12]);
    lights[0].position = [4.8, 1.7, -1 + motion];
    device.queue.writeBuffer(lightBuffer, 0, gpu.lightData(lights, lightData));
    lamp.update(
      gpu.materialData({
        model: currentLamp,
        previousModel: previousLamp,
        emission: [8, 3, 0.7],
        roughness: 0.5,
      }, lampData),
    );
    frameUniform.update(gpu.frameData({
      viewProjection: vp,
      previousViewProjection: previousVP ?? vp,
      inverseViewProjection: inverse(vp),
      view: viewMatrix,
      eye,
      sunDirection: lightDirection,
      sunRadiance: [2.5, 2.15, 1.65],
      environmentMips: environment.mips,
      shadowMatrices,
      splits,
      shadowBias: 0.006,
      lights,
    }, frameData));
    const exposure = value("exposure");
    let noiseFrame = 0;
    if (checked("taa")) noiseFrame = frameNumber % 16;
    aoParams.update(
      gpu.postData({
        stage: "occlusion",
        inverseProjection: inverse(projection),
        radius: 1.4,
        visibility: 1.1,
        noise: noiseFrame,
      }, aoData),
    );
    combineParams.update(
      gpu.postData(
        { stage: "combine", strength: Number(checked("ao")) },
        combineData,
      ),
    );
    bloomParams.update(
      gpu.postData(
        { stage: "bloom", threshold: 1, knee: 0.5, exposure },
        bloomData,
      ),
    );
    temporalParams.update(
      gpu.postData({
        stage: "temporal",
        blend: 0.9,
        reset: reset || !checked("taa"),
        depthTolerance: 0.025,
      }, temporalData),
    );
    displayParams.update([exposure, Number(checked("bloom")) * 0.12, 0, 0]);
    const encoder = device.createCommandEncoder();
    if (checked("shadows")) {
      passes.shadows(
        encoder,
        shadowMap,
        shadowBuffers,
        draws,
      );
    } else {
      for (let i = 0; i < 4; i++) {
        encoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: shadowViews[i],
            depthLoadOp: "clear",
            depthStoreOp: "store",
            depthClearValue: 1,
          },
        }).end();
      }
    }
    passes.geometry(encoder, surface, frameGroup, draws);
    const index = frameNumber % 2;
    passes.post(encoder, {
      stage: "occlusion",
      parameters: aoParams.buffer,
      normalDepth: surface.normalDepth.view,
      output: aoRaw,
    });
    passes.post(encoder, {
      stage: "denoise",
      parameters: aoParams.buffer,
      occlusion: aoRaw.view,
      normalDepth: surface.normalDepth.view,
      output: ao,
    });
    passes.post(encoder, {
      stage: "combine",
      parameters: combineParams.buffer,
      direct: surface.direct.view,
      indirect: surface.indirect.view,
      occlusion: ao.view,
      output: history[index],
    });
    // Indirect lighting is consumed by combine, so its target can hold temporal output.
    passes.post(encoder, {
      stage: "temporal",
      parameters: temporalParams.buffer,
      current: history[index].view,
      motion: surface.motion.view,
      history: history[1 - index].view,
      normalDepth: surface.normalDepth.view,
      previousDepth: depths[1 - index].view,
      output: surface.indirect,
    });
    encoder.copyTextureToTexture({ texture: surface.indirect.texture }, {
      texture: history[index].texture,
    }, [width, height]);
    passes.post(encoder, {
      stage: "depth",
      parameters: temporalParams.buffer,
      normalDepth: surface.normalDepth.view,
      output: depths[index],
    });
    const bloom = passes.bloom(
      encoder,
      history[index].view,
      bloomParams.buffer,
      pyramid,
    );
    passes.display(
      encoder,
      history[index].view,
      bloom,
      displayParams.buffer,
      context.getCurrentTexture().createView(),
    );
    device.queue.submit([encoder.finish()]);
    reset = false;
    await device.queue.onSubmittedWorkDone();
    if (disposed) return;
    previousVP = vp;
    previousLamp = currentLamp;
    frameNumber++;
    framesToSettle--;
    (globalThis as typeof globalThis & { inkGraphics: unknown }).inkGraphics = {
      ready: true,
      errors,
      frames: frameNumber,
      width,
      height,
      memoryBytes: surface.direct.bytes + surface.indirect.bytes +
        surface.normalDepth.bytes + surface.motion.bytes + surface.depth.bytes +
        aoRaw.bytes + ao.bytes +
        [...history, ...depths, ...pyramid.down, ...pyramid.up].reduce(
          (sum, texture) => sum + texture.bytes,
          0,
        ),
    };
    if (now - lastTime > 500) {
      status.textContent =
        `${width} × ${height} · ${draws.length} draws · WebGPU`;
      lastTime = now;
    }
    drawing = false;
    scheduled = false;
    if (
      pendingDraw || framesToSettle > 0 ||
      (checked("motion") && !reducedMotion.matches)
    ) requestDraw();
  }
  requestDraw = () => {
    if (disposed) return;
    pendingDraw = true;
    if (!scheduled && !drawing) {
      scheduled = true;
      requestAnimationFrame((now) => {
        draw(now).catch(fail);
      });
    }
  };
  const resize = new ResizeObserver(requestDraw);
  resize.observe(canvas);
  addEventListener("pagehide", async (event) => {
    if (event.persisted) return;
    disposed = true;
    resize.disconnect();
    await device.queue.onSubmittedWorkDone();
    for (
      const item of [
        ...uniforms,
        ...envParameters,
        ...shadowCameras,
        frameUniform,
        aoParams,
        combineParams,
        bloomParams,
        temporalParams,
        displayParams,
      ]
    ) item.destroy();
    for (
      const item of [...history, ...depths, aoRaw, ao, shadowMap, sky]
    ) item?.destroy();
    surface?.destroy();
    pyramid?.destroy();
    environment.destroy();
    sphereMesh.destroy();
    groundMesh.destroy();
    lightBuffer.destroy();
    device.destroy();
  });
  addEventListener("pageshow", () => {
    if (!disposed) requestDraw();
  });
  requestDraw();
}
function fail(error: unknown) {
  document.querySelector("#error")!.textContent = String(error);
  status.textContent = "GPU unavailable";
}
main().catch(fail);

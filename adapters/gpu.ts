/** Optional WebGPU passes. The caller supplies the device, encoders, frame
 * state and history, and destroys resources when their last submission ends. */

export type Matrix = ArrayLike<number>;
export type Vector = readonly [number, number, number];
export type PostStage =
  | "occlusion"
  | "denoise"
  | "combine"
  | "threshold"
  | "downsample"
  | "upsample"
  | "temporal"
  | "depth";

export type PassName =
  | PostStage
  | "geometry"
  | "shadows"
  | "display"
  | "prefilter"
  | "debug"
  | "sprites"
  | "bloom";

/** Named fields follow the WGSL structs; offsets and lengths are F32 lanes. */
export const layout = {
  object: {
    length: 60,
    model: 0,
    previousModel: 16,
    normalMatrix: 32,
    base: 48,
    material: 52,
    emission: 56,
  },
  frame: {
    length: 164,
    viewProjection: 0,
    previousViewProjection: 16,
    inverseViewProjection: 32,
    view: 48,
    eye: 64,
    sunDirection: 68,
    sunRadiance: 72,
    options: 76,
    shadowMatrices: 80,
    splits: 144,
    previousView: 148,
  },
  post: { length: 24, inverseProjection: 0, settings: 16, extra: 20 },
  light: {
    length: 16,
    positionRange: 0,
    radiance: 4,
    directionOuter: 8,
    innerType: 12,
  },
  vertex: { mesh: 24, debug: 28, sprite: 36 },
} as const;

export type PostSettings =
  | {
    stage: "occlusion";
    inverseProjection: Matrix;
    radius: number;
    visibility?: number;
    noise?: number;
  }
  | { stage: "denoise" | "depth" }
  | { stage: "combine"; strength: number }
  | {
    stage: "threshold" | "bloom";
    threshold: number;
    knee: number;
    exposure: number;
  }
  | { stage: "downsample" | "upsample" }
  | {
    stage: "temporal";
    blend: number;
    reset: boolean;
    depthTolerance: number;
  };

type PostTarget = { parameters: GPUBuffer; output: Texture };
export type Post =
  & PostTarget
  & (
    | { stage: "occlusion" | "depth"; normalDepth: GPUTextureView }
    | {
      stage: "denoise";
      occlusion: GPUTextureView;
      normalDepth: GPUTextureView;
    }
    | {
      stage: "combine";
      direct: GPUTextureView;
      indirect: GPUTextureView;
      occlusion: GPUTextureView;
    }
    | { stage: "threshold" | "downsample"; source: GPUTextureView }
    | { stage: "upsample"; source: GPUTextureView; lower: GPUTextureView }
    | {
      stage: "temporal";
      current: GPUTextureView;
      motion: GPUTextureView;
      history: GPUTextureView;
      normalDepth: GPUTextureView;
      previousDepth: GPUTextureView;
    }
  );

export interface Uniform {
  buffer: GPUBuffer;
  update(values: ArrayLike<number>): void;
  destroy(): void;
}

export const identity: readonly number[] = [
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
  1,
  0,
  0,
  0,
  0,
  1,
];

/** Fixed-size uniform. Use separate buffers for different values in one
 * submission: queue writes are not interleaved with recorded commands. */
export function uniform(device: GPUDevice, values: ArrayLike<number>): Uniform {
  const length = Math.max(4, Math.ceil(values.length / 4) * 4);
  const buffer = device.createBuffer({
    size: length * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const data = new Float32Array(length);
  const result = {
    buffer,
    update(next: ArrayLike<number>) {
      if (next.length > length) throw new RangeError("Uniform size changed");
      data.fill(0);
      data.set(next);
      device.queue.writeBuffer(buffer, 0, data);
    },
    destroy() {
      buffer.destroy();
    },
  };
  result.update(values);
  return result;
}

/** Inverse transpose for affine transforms, including nonuniform scale. */
function finite(
  values: ArrayLike<number>,
  name: string,
  length = values.length,
) {
  if (values.length !== length) {
    throw new RangeError(`${name}: expected ${length} values`);
  }
  for (let i = 0; i < length; i++) {
    if (!Number.isFinite(Math.fround(values[i]))) {
      throw new RangeError(`${name}: expected finite F32 values`);
    }
  }
}

function packed(target: Float32Array, length: number) {
  if (target.length !== length) {
    throw new RangeError(`Expected ${length} F32 lanes`);
  }
  target.fill(0);
  return target;
}

function writeNormal(model: Matrix, result: Float32Array, offset: number) {
  finite(model, "matrix", 16);
  const a = model[0], b = model[1], c = model[2];
  const d = model[4], e = model[5], f = model[6];
  const g = model[8], h = model[9], i = model[10];
  const determinant = a * (e * i - f * h) - d * (b * i - c * h) +
    g * (b * f - c * e);
  if (!Number.isFinite(determinant) || determinant === 0) {
    throw new RangeError("Singular object transform");
  }
  result[offset] = (e * i - f * h) / determinant;
  result[offset + 1] = (f * g - d * i) / determinant;
  result[offset + 2] = (d * h - e * g) / determinant;
  result[offset + 4] = (c * h - b * i) / determinant;
  result[offset + 5] = (a * i - c * g) / determinant;
  result[offset + 6] = (b * g - a * h) / determinant;
  result[offset + 8] = (b * f - c * e) / determinant;
  result[offset + 9] = (c * d - a * f) / determinant;
  result[offset + 10] = (a * e - b * d) / determinant;
  result[offset + 15] = 1;
  for (let lane = offset; lane < offset + 16; lane++) {
    if (!Number.isFinite(result[lane])) {
      throw new RangeError("Non-finite normal transform");
    }
  }
}

export function normalMatrix(
  model: Matrix,
  result: Float32Array = new Float32Array(16),
): Float32Array {
  packed(result, 16);
  writeNormal(model, result, 0);
  return result;
}

export interface Material {
  model: Matrix;
  previousModel?: Matrix;
  base?: readonly [number, number, number, number];
  metallic?: number;
  roughness?: number;
  emission?: Vector;
}

export function materialData(
  value: Material,
  data: Float32Array = new Float32Array(layout.object.length),
): Float32Array {
  packed(data, layout.object.length);
  const offsets = layout.object;
  finite(value.model, "model", 16);
  const previous = value.previousModel ?? value.model;
  finite(previous, "previous model", 16);
  data.set(value.model, offsets.model);
  data.set(previous, offsets.previousModel);
  writeNormal(value.model, data, offsets.normalMatrix);
  data.set(value.base ?? [1, 1, 1, 1], offsets.base);
  data[offsets.material] = value.metallic ?? 0;
  data[offsets.material + 1] = value.roughness ?? 0.5;
  data.set(value.emission ?? [0, 0, 0], offsets.emission);
  finite(data, "material");
  return data;
}

export interface Light {
  position: Vector;
  range: number;
  intensity: Vector;
  direction?: Vector;
  innerCos?: number;
  outerCos?: number;
}

export interface Frame {
  viewProjection: Matrix;
  previousViewProjection?: Matrix;
  inverseViewProjection: Matrix;
  view: Matrix;
  previousView?: Matrix;
  eye: Vector;
  sunDirection?: Vector;
  sunRadiance?: Vector;
  shadowMatrices?: readonly Matrix[];
  splits?: readonly number[];
  shadowBias?: number;
  environmentIntensity?: number;
  environmentMips?: number;
  lights?: readonly Light[];
}

export function frameData(
  value: Frame,
  data: Float32Array = new Float32Array(layout.frame.length),
): Float32Array {
  if ((value.lights?.length ?? 0) > 64) {
    throw new RangeError("At most 64 local lights per draw");
  }
  packed(data, layout.frame.length);
  for (
    const matrix of [
      value.viewProjection,
      value.previousViewProjection ?? value.viewProjection,
      value.inverseViewProjection,
      value.view,
      value.previousView ?? value.view,
    ]
  ) finite(matrix, "camera matrix", 16);
  const offsets = layout.frame;
  data.set(value.viewProjection, offsets.viewProjection);
  data.set(
    value.previousViewProjection ?? value.viewProjection,
    offsets.previousViewProjection,
  );
  data.set(value.inverseViewProjection, offsets.inverseViewProjection);
  data.set(value.view, offsets.view);
  data.set(value.eye, offsets.eye);
  data.set(value.sunDirection ?? [0, -1, 0], offsets.sunDirection);
  data.set(value.sunRadiance ?? [0, 0, 0], offsets.sunRadiance);
  data[offsets.options] = value.shadowBias ?? 0.002;
  data[offsets.options + 1] = value.environmentIntensity ?? 1;
  data[offsets.options + 2] = Math.max(0, (value.environmentMips ?? 1) - 1);
  data[offsets.options + 3] = value.lights?.length ?? 0;
  for (let i = 0; i < 4; i++) {
    const matrix = value.shadowMatrices?.[i] ?? identity;
    finite(matrix, "shadow matrix", 16);
    data.set(matrix, offsets.shadowMatrices + i * 16);
  }
  data.set(value.splits ?? [1e9, 1e9, 1e9, 1e9], offsets.splits);
  data.set(value.previousView ?? value.view, offsets.previousView);
  finite(data, "frame");
  return data;
}

export function postData(
  value: PostSettings,
  data: Float32Array = new Float32Array(layout.post.length),
): Float32Array {
  packed(data, layout.post.length);
  data.set(identity);
  const settings = layout.post.settings;
  switch (value.stage) {
    case "occlusion":
      finite(value.inverseProjection, "inverse projection", 16);
      data.set(value.inverseProjection);
      data[settings] = value.radius;
      data[settings + 1] = value.visibility ?? 1;
      data[settings + 2] = value.noise ?? 0;
      break;
    case "combine":
      data[settings] = value.strength;
      break;
    case "threshold":
    case "bloom":
      data[settings] = value.threshold;
      data[settings + 1] = value.knee;
      data[settings + 2] = value.exposure;
      break;
    case "temporal":
      data[settings] = value.blend;
      data[settings + 1] = Number(value.reset);
      data[settings + 2] = value.depthTolerance;
      break;
  }
  finite(data, "post settings");
  return data;
}

export interface Mesh {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  count: number;
  destroy(): void;
}

/** Vertex stride is xyz normalXYZ, indices are U32. */
export function mesh(
  device: GPUDevice,
  vertices: Float32Array,
  indices: Uint32Array,
): Mesh {
  if (vertices.length % 6 !== 0) throw new RangeError("Expected xyz normalXYZ");
  const vertexBuffer = device.createBuffer({
    size: Math.max(4, vertices.byteLength),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const indexBuffer = device.createBuffer({
    size: Math.max(4, indices.byteLength),
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, new Float32Array(vertices));
  device.queue.writeBuffer(indexBuffer, 0, new Uint32Array(indices));
  return {
    vertices: vertexBuffer,
    indices: indexBuffer,
    count: indices.length,
    destroy() {
      vertexBuffer.destroy();
      indexBuffer.destroy();
    },
  };
}

export interface Draw {
  mesh: Mesh;
  object: GPUBindGroup;
}

export interface Texture {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  /** Logical allocation size, excluding implementation padding. */
  bytes: number;
  destroy(): void;
}

export type TextureFormat =
  | "rgba16float"
  | "rgba8unorm"
  | "rgba8unorm-srgb"
  | "r32float"
  | "depth32float";

export function texture(
  device: GPUDevice,
  width: number,
  height: number,
  format: TextureFormat = "rgba16float",
  layers = 1,
  mips = 1,
): Texture {
  if (
    ![width, height, layers, mips].every((value) =>
      Number.isInteger(value) && value > 0
    )
  ) throw new RangeError("Texture dimensions must be positive integers");
  if (mips > Math.floor(Math.log2(Math.max(width, height))) + 1) {
    throw new RangeError("Too many texture mip levels");
  }
  let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
  if (format === "rgba16float" || format === "r32float") {
    usage |= GPUTextureUsage.STORAGE_BINDING;
  }
  const value = device.createTexture({
    size: [width, height, layers],
    format,
    mipLevelCount: mips,
    usage,
  });
  let pixelBytes = 4;
  if (format === "rgba16float") pixelBytes = 8;
  let bytes = 0;
  for (let mip = 0; mip < mips; mip++) {
    bytes += Math.max(1, width >> mip) * Math.max(1, height >> mip) * layers *
      pixelBytes;
  }
  return {
    texture: value,
    view: value.createView(),
    width,
    height,
    bytes,
    destroy() {
      value.destroy();
    },
  };
}

export interface Surface {
  direct: Texture;
  indirect: Texture;
  normalDepth: Texture;
  motion: Texture;
  depth: Texture;
  destroy(): void;
}

export function surface(
  device: GPUDevice,
  width: number,
  height: number,
): Surface {
  const direct = texture(device, width, height);
  const indirect = texture(device, width, height);
  const normalDepth = texture(device, width, height);
  const motion = texture(device, width, height);
  const depth = texture(device, width, height, "depth32float");
  return {
    direct,
    indirect,
    normalDepth,
    motion,
    depth,
    destroy() {
      for (const value of [direct, indirect, normalDepth, motion, depth]) {
        value.destroy();
      }
    },
  };
}

export interface Environment {
  specular: Texture;
  diffuse: Texture;
  mips: number;
  destroy(): void;
}

export function environment(device: GPUDevice, size = 128): Environment {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("Invalid cube size");
  }
  const mips = Math.floor(Math.log2(size)) + 1;
  const specular = texture(device, size, size, "rgba16float", 6, mips);
  const diffuse = texture(device, 16, 16, "rgba16float", 6);
  return {
    specular,
    diffuse,
    mips,
    destroy() {
      specular.destroy();
      diffuse.destroy();
    },
  };
}

export interface BloomPyramid {
  down: Texture[];
  up: Texture[];
  destroy(): void;
}
export function bloomPyramid(
  device: GPUDevice,
  width: number,
  height: number,
): BloomPyramid {
  const down: Texture[] = [];
  const up: Texture[] = [];
  for (let i = 0; i < 6; i++) {
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    down.push(texture(device, width, height));
    if (width === 1 && height === 1) break;
  }
  for (let i = 0; i < down.length - 1; i++) {
    up.push(texture(device, down[i].width, down[i].height));
  }
  return {
    down,
    up,
    destroy() {
      for (const value of [...down, ...up]) value.destroy();
    },
  };
}

/** Hammersley jitter in NDC; apply to projection and reset history on cuts. */
export function jitter(
  frame: number,
  width: number,
  height: number,
): [number, number] {
  function radical(value: number, base: number) {
    let result = 0;
    let factor = 1 / base;
    while (value > 0) {
      result += (value % base) * factor;
      value = Math.floor(value / base);
      factor /= base;
    }
    return result;
  }
  const sample = frame % 1024 + 1;
  return [
    (radical(sample, 2) - 0.5) * 2 / width,
    (radical(sample, 3) - 0.5) * 2 / height,
  ];
}

export function cascadeSplits(
  near: number,
  far: number,
  count = 4,
  blend = 0.7,
): number[] {
  if (
    ![near, far, blend].every(Number.isFinite) ||
    near <= 0 || far <= near || count < 1 || !Number.isInteger(count)
  ) {
    throw new RangeError("Invalid cascade range");
  }
  return Array.from({ length: count }, (_, i) => {
    const t = (i + 1) / count;
    const linear = near + (far - near) * t;
    return linear +
      (near * (far / near) ** t - linear) * Math.max(0, Math.min(1, blend));
  });
}

export interface Passes {
  object: (buffer: GPUBuffer) => GPUBindGroup;
  frame: (
    buffer: GPUBuffer,
    lights: GPUBuffer,
    shadows: GPUTextureView,
    env: Environment,
  ) => GPUBindGroup;
  geometry: (
    encoder: GPUCommandEncoder,
    target: Surface,
    frame: GPUBindGroup,
    draws: readonly Draw[],
    sky?: boolean,
  ) => void;
  shadows: (
    encoder: GPUCommandEncoder,
    target: Texture,
    cameras: readonly GPUBuffer[],
    draws: readonly Draw[],
  ) => void;
  post: (encoder: GPUCommandEncoder, step: Post) => void;
  bloom: (
    encoder: GPUCommandEncoder,
    source: GPUTextureView,
    parameters: GPUBuffer,
    pyramid: ReturnType<typeof bloomPyramid>,
  ) => GPUTextureView;
  display: (
    encoder: GPUCommandEncoder,
    source: GPUTextureView,
    bloom: GPUTextureView,
    parameters: GPUBuffer,
    output: GPUTextureView,
  ) => void;
  prefilter: (
    encoder: GPUCommandEncoder,
    source: GPUTextureView,
    target: Environment,
    parameters: readonly GPUBuffer[],
  ) => void;
  debug: (
    encoder: GPUCommandEncoder,
    target: Surface,
    camera: GPUBuffer,
    vertices: GPUBuffer,
    count: number,
  ) => void;
  sprites: (
    encoder: GPUCommandEncoder,
    target: Texture,
    depth: Texture,
    camera: GPUBuffer,
    atlas: GPUTextureView,
    vertices: GPUBuffer,
    count: number,
  ) => void;
}

/** Load shipped WGSL. Override the URL when a bundler relocates static files. */
export async function createPasses(
  device: GPUDevice,
  format: GPUTextureFormat,
  shaderUrl: URL = new URL("../shaders/", import.meta.url),
  options: { reversedDepth?: boolean; passes?: readonly PassName[] } = {},
): Promise<Passes> {
  const postStages: PostStage[] = [
    "occlusion",
    "denoise",
    "combine",
    "threshold",
    "downsample",
    "upsample",
    "temporal",
    "depth",
  ];
  const selected = new Set<string>(
    options.passes ??
      [
        ...postStages,
        "geometry",
        "shadows",
        "display",
        "prefilter",
        "debug",
        "sprites",
      ],
  );
  if (selected.has("geometry")) selected.add("sky");
  if (selected.has("bloom")) {
    for (const name of ["threshold", "downsample", "upsample"]) {
      selected.add(name);
    }
  }
  const shaderNames = new Map<string, string>([
    ...postStages.map((name) => [name, "post"] as [string, string]),
    ["geometry", "geometry"],
    ["sky", "geometry"],
    ["shadows", "shadow"],
    ["display", "display"],
    ["prefilter", "environment"],
    ["debug", "debug"],
    ["sprites", "sprite"],
  ]);
  const required = new Set<string>();
  for (const name of selected) {
    if (name === "bloom") continue;
    const shader = shaderNames.get(name);
    if (!shader) throw new RangeError(`Unknown pass: ${name}`);
    required.add(shader);
  }
  const modules = new Map<string, GPUShaderModule>();
  await Promise.all(Array.from(required, async (name) => {
    const response = await fetch(new URL(`${name}.wgsl`, shaderUrl));
    if (!response.ok) {
      throw new Error(`Cannot load shader ${name}: ${response.status}`);
    }
    const module = device.createShaderModule({
      label: `ink/${name}`,
      code: await response.text(),
    });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === "error");
    if (errors.length) {
      throw new Error(
        errors.map((message) =>
          `${name}:${message.lineNum}:${message.linePos} ${message.message}`
        ).join("\n"),
      );
    }
    modules.set(name, module);
  }));
  const render = new Map<string, GPURenderPipeline>();
  const compute = new Map<string, GPUComputePipeline>();
  const jobs: Promise<void>[] = [];
  function renderPipeline(
    name: string,
    descriptor: () => GPURenderPipelineDescriptor,
  ) {
    if (selected.has(name)) {
      jobs.push(
        device.createRenderPipelineAsync({
          label: `ink/${name}`,
          ...descriptor(),
        }).then((pipeline) => {
          render.set(name, pipeline);
        }),
      );
    }
  }
  function computePipeline(
    name: string,
    descriptor: () => GPUComputePipelineDescriptor,
  ) {
    if (selected.has(name)) {
      jobs.push(
        device.createComputePipelineAsync({
          label: `ink/${name}`,
          ...descriptor(),
        }).then((pipeline) => {
          compute.set(name, pipeline);
        }),
      );
    }
  }
  function need<T>(values: Map<string, T>, name: string): T {
    const value = values.get(name);
    if (!value) throw new Error(`Pass ${name} was not requested`);
    return value;
  }
  const geometryShader = modules.get("geometry")!;
  const shadowShader = modules.get("shadow")!;
  const postShader = modules.get("post")!;
  const displayShader = modules.get("display")!;
  const envShader = modules.get("environment")!;
  const debugShader = modules.get("debug")!;
  const spriteShader = modules.get("sprite")!;
  const uniformEntry = (
    binding: number,
    visibility: number,
  ): GPUBindGroupLayoutEntry => ({
    binding,
    visibility,
    buffer: { type: "uniform" },
  });
  const vertexFragment = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const objectLayout = device.createBindGroupLayout({
    entries: [uniformEntry(0, vertexFragment)],
  });
  const cameraLayout = device.createBindGroupLayout({
    entries: [uniformEntry(0, GPUShaderStage.VERTEX)],
  });
  const frameLayout = device.createBindGroupLayout({
    entries: [
      uniformEntry(0, vertexFragment),
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "depth", viewDimension: "2d-array" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "comparison" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { viewDimension: "cube" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { viewDimension: "cube" },
      },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
    ],
  });
  const vertexBuffer: GPUVertexBufferLayout = {
    arrayStride: layout.vertex.mesh,
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, {
      shaderLocation: 1,
      offset: 12,
      format: "float32x3",
    }],
  };
  const targets: GPUColorTargetState[] = [
    { format: "rgba16float" },
    { format: "rgba16float" },
    { format: "rgba16float" },
    { format: "rgba16float" },
  ];
  let depthCompare: GPUCompareFunction = "less";
  let skyCompare: GPUCompareFunction = "less-equal";
  let clearDepth = 1;
  if (options.reversedDepth) {
    depthCompare = "greater";
    skyCompare = "greater-equal";
    clearDepth = 0;
  }
  renderPipeline("geometry", () => ({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [frameLayout, objectLayout],
    }),
    vertex: {
      module: geometryShader,
      entryPoint: "vertex",
      buffers: [vertexBuffer],
    },
    fragment: { module: geometryShader, entryPoint: "fragment", targets },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare,
    },
  }));
  renderPipeline("sky", () => ({
    layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout] }),
    vertex: {
      module: geometryShader,
      entryPoint: "skyVertex",
      constants: { skyDepth: clearDepth },
    },
    fragment: { module: geometryShader, entryPoint: "skyFragment", targets },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: false,
      depthCompare: skyCompare,
    },
  }));
  renderPipeline("shadows", () => ({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cameraLayout, objectLayout],
    }),
    vertex: {
      module: shadowShader,
      entryPoint: "vertex",
      buffers: [vertexBuffer],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      depthCompare: "less",
      depthBias: 2,
      depthBiasSlopeScale: 2,
    },
  }));
  const inputCounts: Record<PostStage, number> = {
    occlusion: 1,
    denoise: 2,
    combine: 3,
    threshold: 1,
    downsample: 1,
    upsample: 2,
    temporal: 5,
    depth: 1,
  };
  const inputLayouts = new Map<string, GPUBindGroupLayout>();
  const outputLayouts = new Map<string, GPUBindGroupLayout>();
  function scalarStage(stage: PostStage) {
    return stage === "occlusion" || stage === "denoise" || stage === "depth";
  }
  for (const stage of postStages) {
    if (!selected.has(stage)) continue;
    const entries: GPUBindGroupLayoutEntry[] = [
      uniformEntry(0, GPUShaderStage.COMPUTE),
    ];
    for (let input = 0; input < inputCounts[stage]; input++) {
      let sampleType: GPUTextureSampleType = "float";
      if (
        (stage === "denoise" && input === 0) ||
        (stage === "combine" && input === 2) ||
        (stage === "temporal" && input === 4)
      ) sampleType = "unfilterable-float";
      entries.push({
        binding: input + 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType },
      });
    }
    entries.push({
      binding: 6,
      visibility: GPUShaderStage.COMPUTE,
      sampler: {},
    });
    const inputs = device.createBindGroupLayout({ entries });
    let outputBinding = 0;
    let outputFormat: GPUTextureFormat = "rgba16float";
    if (scalarStage(stage)) {
      outputBinding = 1;
      outputFormat = "r32float";
    }
    const output = device.createBindGroupLayout({
      entries: [{
        binding: outputBinding,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: outputFormat },
      }],
    });
    inputLayouts.set(stage, inputs);
    outputLayouts.set(stage, output);
    computePipeline(
      stage,
      () => ({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [inputs, output],
        }),
        compute: { module: postShader, entryPoint: stage },
      }),
    );
  }
  let encodeSRGB = 1;
  if (format.endsWith("-srgb")) encodeSRGB = 0;
  renderPipeline("display", () => ({
    layout: "auto",
    vertex: { module: displayShader, entryPoint: "vertex" },
    fragment: {
      module: displayShader,
      entryPoint: "fragment",
      constants: { encodeSRGB },
      targets: [{ format }],
    },
  }));
  computePipeline("prefilter", () => ({
    layout: "auto",
    compute: { module: envShader, entryPoint: "prefilter" },
  }));
  renderPipeline("debug", () => ({
    layout: device.createPipelineLayout({ bindGroupLayouts: [cameraLayout] }),
    vertex: {
      module: debugShader,
      entryPoint: "vertex",
      buffers: [{
        arrayStride: layout.vertex.debug,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, {
          shaderLocation: 1,
          offset: 12,
          format: "float32x4",
        }],
      }],
    },
    fragment: {
      module: debugShader,
      entryPoint: "fragment",
      targets: [{
        format: "rgba16float",
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }],
    },
    primitive: { topology: "line-list" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: false,
      depthCompare: skyCompare,
    },
  }));
  renderPipeline("sprites", () => ({
    layout: "auto",
    vertex: {
      module: spriteShader,
      entryPoint: "vertex",
      buffers: [{
        arrayStride: layout.vertex.sprite,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, {
          shaderLocation: 1,
          offset: 12,
          format: "float32x2",
        }, { shaderLocation: 2, offset: 20, format: "float32x4" }],
      }],
    },
    fragment: {
      module: spriteShader,
      entryPoint: "fragment",
      targets: [{
        format: "rgba16float",
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: false,
      depthCompare: skyCompare,
    },
  }));
  const linear = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
  });
  const envSampler = device.createSampler({
    addressModeU: "repeat",
    magFilter: "linear",
    minFilter: "linear",
  });
  const comparison = device.createSampler({
    compare: "less-equal",
    magFilter: "linear",
    minFilter: "linear",
  });
  await Promise.all(jobs);
  const automaticLayouts = new Map<string, GPUBindGroupLayout>();
  for (const name of ["display", "sprites"]) {
    if (render.has(name)) {
      automaticLayouts.set(name, render.get(name)!.getBindGroupLayout(0));
    }
  }
  if (compute.has("prefilter")) {
    automaticLayouts.set(
      "prefilter",
      compute.get("prefilter")!.getBindGroupLayout(0),
    );
  }
  interface GroupNode {
    children: WeakMap<object, GroupNode>;
    value?: GPUBindGroup;
  }
  const groups = new WeakMap<GPUBindGroupLayout, GroupNode>();
  function group(
    layout: GPUBindGroupLayout,
    entries: GPUBindGroupEntry[],
  ): GPUBindGroup {
    let root = groups.get(layout);
    if (!root) {
      root = { children: new WeakMap() };
      groups.set(layout, root);
    }
    let node: GroupNode = root;
    for (const entry of entries) {
      let key: object = entry.resource;
      if ("buffer" in entry.resource) key = entry.resource.buffer;
      let next: GroupNode | undefined = node.children.get(key);
      if (!next) {
        next = { children: new WeakMap() };
        node.children.set(key, next);
      }
      node = next;
    }
    if (!node.value) node.value = device.createBindGroup({ layout, entries });
    return node.value;
  }
  const views = new WeakMap<GPUTexture, Map<string, GPUTextureView>>();
  function view(
    texture: GPUTexture,
    descriptor: GPUTextureViewDescriptor,
  ): GPUTextureView {
    let cache = views.get(texture);
    if (!cache) {
      cache = new Map();
      views.set(texture, cache);
    }
    const key = JSON.stringify(descriptor);
    let value = cache.get(key);
    if (!value) {
      value = texture.createView(descriptor);
      cache.set(key, value);
    }
    return value;
  }
  const cameraGroup = (buffer: GPUBuffer) =>
    group(cameraLayout, [{ binding: 0, resource: { buffer } }]);
  function draw(pass: GPURenderPassEncoder, draws: readonly Draw[]) {
    for (const item of draws) {
      pass.setBindGroup(1, item.object);
      pass.setVertexBuffer(0, item.mesh.vertices);
      pass.setIndexBuffer(item.mesh.indices, "uint32");
      pass.drawIndexed(item.mesh.count);
    }
  }
  const result: Passes = {
    object(buffer) {
      return group(objectLayout, [{ binding: 0, resource: { buffer } }]);
    },
    frame(buffer, lights, shadows, environment) {
      return group(frameLayout, [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: shadows },
        { binding: 2, resource: comparison },
        {
          binding: 3,
          resource: view(environment.specular.texture, {
            dimension: "cube",
          }),
        },
        {
          binding: 4,
          resource: view(environment.diffuse.texture, {
            dimension: "cube",
          }),
        },
        { binding: 5, resource: linear },
        { binding: 6, resource: { buffer: lights } },
      ]);
    },
    geometry(encoder, target, frame, draws, background = true) {
      const pass = encoder.beginRenderPass({
        label: "ink/geometry",
        colorAttachments: [
          target.direct,
          target.indirect,
          target.normalDepth,
          target.motion,
        ].map((texture) => ({
          view: texture.view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 0],
        })),
        depthStencilAttachment: {
          view: target.depth.view,
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: clearDepth,
        },
      });
      if (background) {
        pass.setPipeline(need(render, "sky"));
        pass.setBindGroup(0, frame);
        pass.draw(3);
      }
      pass.setPipeline(need(render, "geometry"));
      pass.setBindGroup(0, frame);
      draw(pass, draws);
      pass.end();
    },
    shadows(encoder, target, cameras, draws) {
      if (cameras.length !== 4) {
        throw new RangeError("Expected four cascade matrices");
      }
      for (let i = 0; i < 4; i++) {
        const pass = encoder.beginRenderPass({
          label: `ink/shadow-${i}`,
          colorAttachments: [],
          depthStencilAttachment: {
            view: view(target.texture, {
              dimension: "2d",
              baseArrayLayer: i,
              arrayLayerCount: 1,
            }),
            depthLoadOp: "clear",
            depthStoreOp: "store",
            depthClearValue: 1,
          },
        });
        pass.setPipeline(need(render, "shadows"));
        pass.setBindGroup(0, cameraGroup(cameras[i]));
        draw(pass, draws);
        pass.end();
      }
    },
    post(encoder, step) {
      const { stage, parameters, output } = step;
      const pipeline = need(compute, stage);
      let expected: GPUTextureFormat = "rgba16float";
      if (scalarStage(stage)) expected = "r32float";
      if (output.texture.format !== expected) {
        throw new RangeError(`${stage}: expected ${expected} output`);
      }
      let inputs: GPUTextureView[];
      switch (step.stage) {
        case "occlusion":
        case "depth":
          inputs = [step.normalDepth];
          break;
        case "denoise":
          inputs = [step.occlusion, step.normalDepth];
          break;
        case "combine":
          inputs = [step.direct, step.indirect, step.occlusion];
          break;
        case "threshold":
        case "downsample":
          inputs = [step.source];
          break;
        case "upsample":
          inputs = [step.source, step.lower];
          break;
        case "temporal":
          inputs = [
            step.current,
            step.motion,
            step.history,
            step.normalDepth,
            step.previousDepth,
          ];
          break;
      }
      const entries: GPUBindGroupEntry[] = [{
        binding: 0,
        resource: { buffer: parameters },
      }];
      for (let i = 0; i < inputs.length; i++) {
        entries.push({ binding: i + 1, resource: inputs[i] });
      }
      entries.push({ binding: 6, resource: linear });
      let binding = 0;
      if (scalarStage(stage)) binding = 1;
      const pass = encoder.beginComputePass({ label: `ink/${stage}` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group(need(inputLayouts, stage), entries));
      pass.setBindGroup(
        1,
        group(need(outputLayouts, stage), [{ binding, resource: output.view }]),
      );
      pass.dispatchWorkgroups(
        Math.ceil(output.width / 8),
        Math.ceil(output.height / 8),
      );
      pass.end();
    },
    bloom(encoder, source, parameters, pyramid) {
      const { down, up } = pyramid;
      result.post(encoder, {
        stage: "threshold",
        parameters,
        source,
        output: down[0],
      });
      for (let i = 1; i < down.length; i++) {
        result.post(encoder, {
          stage: "downsample",
          parameters,
          source: down[i - 1].view,
          output: down[i],
        });
      }
      let previous = down[down.length - 1];
      for (let i = down.length - 2; i >= 0; i--) {
        result.post(encoder, {
          stage: "upsample",
          parameters,
          source: down[i].view,
          lower: previous.view,
          output: up[i],
        });
        previous = up[i];
      }
      return previous.view;
    },
    display(encoder, source, bloom, parameters, output) {
      const bindings = group(need(automaticLayouts, "display"), [
        { binding: 0, resource: { buffer: parameters } },
        { binding: 1, resource: source },
        { binding: 2, resource: bloom },
        { binding: 3, resource: linear },
      ]);
      const pass = encoder.beginRenderPass({
        label: "ink/display",
        colorAttachments: [{ view: output, loadOp: "clear", storeOp: "store" }],
      });
      pass.setPipeline(need(render, "display"));
      pass.setBindGroup(0, bindings);
      pass.draw(3);
      pass.end();
    },
    prefilter(encoder, source, target, parameters) {
      if (parameters.length !== target.mips + 1) {
        throw new RangeError(
          "Expected one uniform per specular mip plus diffuse",
        );
      }
      for (let i = 0; i <= target.mips; i++) {
        let texture = target.specular;
        let mip = i;
        if (i === target.mips) {
          texture = target.diffuse;
          mip = 0;
        }
        const outputView = view(texture.texture, {
          dimension: "2d-array",
          baseMipLevel: mip,
          mipLevelCount: 1,
        });
        const bindings = group(need(automaticLayouts, "prefilter"), [
          { binding: 0, resource: { buffer: parameters[i] } },
          { binding: 1, resource: source },
          { binding: 2, resource: envSampler },
          { binding: 3, resource: outputView },
        ]);
        const pass = encoder.beginComputePass({
          label: `ink/environment-${i}`,
        });
        pass.setPipeline(need(compute, "prefilter"));
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(
          Math.ceil(Math.max(1, texture.width >> mip) / 8),
          Math.ceil(Math.max(1, texture.height >> mip) / 8),
          6,
        );
        pass.end();
      }
    },
    debug(encoder, target, camera, vertices, count) {
      const pass = encoder.beginRenderPass({
        label: "ink/debug",
        colorAttachments: [{
          view: target.direct.view,
          loadOp: "load",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: target.depth.view,
          depthLoadOp: "load",
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(need(render, "debug"));
      pass.setBindGroup(0, cameraGroup(camera));
      pass.setVertexBuffer(0, vertices);
      pass.draw(count);
      pass.end();
    },
    sprites(encoder, target, depth, camera, atlas, vertices, count) {
      const bindings = group(need(automaticLayouts, "sprites"), [{
        binding: 0,
        resource: { buffer: camera },
      }, {
        binding: 1,
        resource: atlas,
      }, { binding: 2, resource: linear }]);
      const pass = encoder.beginRenderPass({
        label: "ink/sprites",
        colorAttachments: [{
          view: target.view,
          loadOp: "load",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depth.view,
          depthLoadOp: "load",
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(need(render, "sprites"));
      pass.setBindGroup(0, bindings);
      pass.setVertexBuffer(0, vertices);
      pass.draw(count);
      pass.end();
    },
  };
  return result;
}

/** Environment uniform contains mixed float/u32 fields, unlike postData. */
export function environmentParameters(
  device: GPUDevice,
  mips: number,
  samples = 128,
): Uniform[] {
  const result: Uniform[] = [];
  for (let i = 0; i <= mips; i++) {
    const bits = new ArrayBuffer(16);
    const floats = new Float32Array(bits);
    const integers = new Uint32Array(bits);
    floats[0] = i / Math.max(1, mips - 1);
    integers[1] = Math.max(1, Math.min(4096, samples));
    if (i === mips) integers[2] = 1;
    result.push(uniform(device, floats));
  }
  return result;
}

/** Up to 64 point/spot lights. Intensity is linear RGB; range is metres. */
export function lightData(
  lights: readonly Light[],
  values: Float32Array<ArrayBuffer> = new Float32Array(
    Math.max(1, lights.length) * layout.light.length,
  ),
): Float32Array<ArrayBuffer> {
  if (lights.length > 64) {
    throw new RangeError("At most 64 local lights per draw");
  }
  packed(values, Math.max(1, lights.length) * layout.light.length);
  for (let i = 0; i < lights.length; i++) {
    const value = lights[i];
    const offset = i * layout.light.length;
    values.set(value.position, offset + layout.light.positionRange);
    values[offset + layout.light.positionRange + 3] = value.range;
    values.set(value.intensity, offset + layout.light.radiance);
    values.set(
      value.direction ?? [0, -1, 0],
      offset + layout.light.directionOuter,
    );
    values[offset + layout.light.directionOuter + 3] = value.outerCos ?? 0.7;
    values[offset + layout.light.innerType] = value.innerCos ?? 0.9;
    if (value.direction) values[offset + layout.light.innerType + 1] = 1;
  }
  finite(values, "lights");
  return values;
}

export function lightBuffer(
  device: GPUDevice,
  lights: readonly Light[],
): GPUBuffer {
  const values = lightData(lights);
  const buffer = device.createBuffer({
    size: values.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, values);
  return buffer;
}

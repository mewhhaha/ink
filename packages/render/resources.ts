/** Resources shared by all views: samplers, the blue-noise texture and the
 * dummy textures that fill the frame group's extension slots. */
import { blueNoise } from "@ink/geometry";
import { BufferUsage, DEPTH_FORMAT, TextureUsage } from "./gpu.ts";
import { BLUE_NOISE_SIZE } from "./shaders/noise.ts";

export interface Dummies {
  probes: GPUBuffer;
  probeCubes: GPUTextureView;
  /** One zeroed chart for views without static lightmaps. */
  lightmapCharts: GPUBuffer;
  /** Empty cluster list while the view uses the small-light direct loop. */
  clusters: GPUBuffer;
  /** 1x1x1 depth array (sun shadow cascades). */
  sunShadow: GPUTextureView;
  /** 1x1 depth (spot shadow atlas). */
  spotShadow: GPUTextureView;
  /** One 1x1 depth cube in a cube array (point shadows). */
  pointShadow: GPUTextureView;
  /** The same dummy as plain array layers (point shadow faces). */
  pointFaces: GPUTextureView;
  /** 1x1 white (no occlusion). */
  ao: GPUTextureView;
  /** 1x1 black cube (environment and prefiltered specular). */
  cube: GPUTextureView;
  /** 1x1 (scale 1, bias 0). */
  brdfLut: GPUTextureView;
  /** 64x64 blue noise, r8unorm, values in [0, 1). */
  blueNoise: GPUTextureView;
  /** 1x1 transparent overlay layer and 1x1 black HDR image/bloom. */
  transparent: GPUTextureView;
  black: GPUTextureView;
  /** Exposure multiplier 1 (r32float). */
  exposure: GPUTextureView;
  shadowSampler: GPUSampler;
  linearSampler: GPUSampler;
  /** Repeating, for sampling the blue noise as a texture. */
  noiseSampler: GPUSampler;
  destroy(): void;
}

let noiseBytes: Uint8Array | undefined;
/** The blue-noise tile as bytes; generated once per process (~0.2 s). */
export function blueNoiseBytes(): Uint8Array {
  if (!noiseBytes) {
    const ranks = blueNoise(BLUE_NOISE_SIZE, 1);
    noiseBytes = new Uint8Array(ranks.length);
    for (let i = 0; i < ranks.length; i++) {
      noiseBytes[i] = Math.min(255, Math.floor(ranks[i] * 256));
    }
  }
  return noiseBytes;
}

export function createDummies(device: GPUDevice): Dummies {
  const probes = device.createBuffer({
    label: "dummy reflection probes",
    size: 160,
    usage: BufferUsage.STORAGE,
  });
  const lightmapCharts = device.createBuffer({
    label: "dummy lightmap charts",
    size: 96,
    usage: BufferUsage.STORAGE,
  });
  const clusters = device.createBuffer({
    label: "dummy-light-clusters",
    size: 4,
    usage: BufferUsage.STORAGE,
  });
  const textures: GPUTexture[] = [];
  const make = (
    label: string,
    size: [number, number, number],
    format: GPUTextureFormat,
    bytes?: ArrayBufferView,
    bytesPerRow = 0,
    extra = 0,
  ) => {
    const texture = device.createTexture({
      label,
      size,
      format,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | extra,
    });
    textures.push(texture);
    if (bytes) {
      device.queue.writeTexture(
        { texture },
        bytes as BufferSource,
        { bytesPerRow, rowsPerImage: size[1] },
        size,
      );
    }
    return texture;
  };
  const rgba = (n: number, value: number[]) => {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) out.set(value, i * 4);
    return out;
  };
  const depth = (label: string, layers: number) =>
    device.createTexture({
      label,
      size: [1, 1, layers],
      format: DEPTH_FORMAT,
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT,
    });
  const sun = depth("dummy-sun-shadow", 1);
  const spot = depth("dummy-spot-shadow", 1);
  const point = depth("dummy-point-shadow", 6);
  textures.push(sun, spot, point);

  const noise = make(
    "blue-noise",
    [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE, 1],
    "r8unorm",
    blueNoiseBytes(),
    BLUE_NOISE_SIZE,
  );
  const ao = make("dummy-ao", [1, 1, 1], "r8unorm", new Uint8Array([255]), 1);
  const cube = make(
    "dummy-cube",
    [1, 1, 6],
    "rgba8unorm",
    rgba(6, [0, 0, 0, 255]),
    4,
  );
  const lut = make(
    "dummy-brdf",
    [1, 1, 1],
    "rgba8unorm",
    new Uint8Array([255, 0, 0, 255]),
    4,
  );
  const transparent = make(
    "dummy-overlay",
    [1, 1, 1],
    "rgba8unorm-srgb",
    new Uint8Array(4),
    4,
  );
  const black = make(
    "dummy-black",
    [1, 1, 1],
    "rgba8unorm",
    new Uint8Array([0, 0, 0, 255]),
    4,
  );
  const exposure = device.createTexture({
    label: "dummy-exposure",
    size: [1, 1],
    format: "r32float",
    usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
  });
  textures.push(exposure);
  device.queue.writeTexture(
    { texture: exposure },
    new Float32Array([1]),
    { bytesPerRow: 4 },
    [1, 1],
  );

  return {
    probes,
    probeCubes: cube.createView({ dimension: "cube-array" }),
    lightmapCharts,
    clusters,
    sunShadow: sun.createView({ dimension: "2d-array" }),
    spotShadow: spot.createView(),
    pointShadow: point.createView({ dimension: "cube-array" }),
    pointFaces: point.createView({ dimension: "2d-array" }),
    ao: ao.createView(),
    cube: cube.createView({ dimension: "cube" }),
    brdfLut: lut.createView(),
    blueNoise: noise.createView(),
    transparent: transparent.createView(),
    black: black.createView(),
    exposure: exposure.createView(),
    shadowSampler: device.createSampler({
      label: "shadow",
      compare: "less-equal",
      magFilter: "linear",
      minFilter: "linear",
    }),
    linearSampler: device.createSampler({
      label: "linear-clamp",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    }),
    noiseSampler: device.createSampler({
      label: "repeat",
      addressModeU: "repeat",
      addressModeV: "repeat",
      magFilter: "nearest",
      minFilter: "nearest",
    }),
    destroy() {
      probes.destroy();
      lightmapCharts.destroy();
      clusters.destroy();
      for (const t of textures) t.destroy();
    },
  };
}

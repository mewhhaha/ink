/**
 * Environment light: the sky as a light source.
 *
 * Whenever the sky or the sun changes (and only then; see `key`), compute
 * passes
 *   1. render the active sky (procedural, gradient or flat) into an
 *      environment cube (binding 7) and build its mip chain,
 *   2. convolve it into a GGX-prefiltered specular cube, one roughness per mip
 *      (binding 8), by filtered importance sampling,
 *   3. project it onto 9 spherical-harmonic coefficients (a GPU reduction)
 *      that every frame is copied into the frame uniform (`frame.sh`) for
 *      diffuse ambient light.
 * The split-sum BRDF lookup (binding 9) is made once per device. The cubes
 * leave out the sun disk and the stars: the direct light is the sun.
 *
 * For a procedural sky with a sun, the sun light's colour is also set here:
 * the author's colour times the atmosphere's transmittance at the sun's
 * elevation relative to the sun overhead, so a low sun is orange and dim and
 * the light vanishes after sunset, matching the sky (`sunLightFactor`).
 * Gradient and flat skies leave the light colour alone.
 *
 * Quality: high bakes a 256 environment cube and a 128 specular cube with 96
 * samples per texel, and updates on any change; low bakes 64 and 32 with 24
 * samples, and spaces updates at least 8 frames apart (a moving sun then
 * steps instead of costing every frame).
 *
 * The WGSL side is shaders/environment.ts (hooks) and shaders/sky.ts.
 */
import { SKY_INDEX, toLinear } from "../environment.ts";
import { BufferUsage, TextureUsage } from "../gpu.ts";
import { FRAME, LIGHT_FLOATS } from "../shaders/frame_layout.ts";
import {
  bakeShader,
  brdfShader,
  downsampleShader,
  prefilterShader,
  shShader,
} from "../shaders/ibl.ts";
import { sunExtinction, sunLightFactor } from "../sky_model.ts";
import type {
  FrameContext,
  PrepareContext,
  RenderSystem,
  SystemBindings,
} from "../systems.ts";
import type { Quality } from "../types.ts";

interface Settings {
  env: number;
  spec: number;
  samples: number;
  /** Mip of the environment cube the SH projection reads. */
  shLod: number;
  skySteps: number;
  /** Minimum frames between two bakes. */
  interval: number;
}

export const IBL_SETTINGS: Record<Quality, Settings> = {
  high: {
    env: 256,
    spec: 128,
    samples: 96,
    shLod: 4,
    skySteps: 16,
    interval: 1,
  },
  low: { env: 64, spec: 32, samples: 24, shLod: 2, skySteps: 10, interval: 8 },
};

const BRDF_SIZE = 128;
const SH_BYTES = 9 * 16;
/** Dynamic-offset-sized slots of per-mip prefilter parameters. */
const SLOT = 256;

const mips = (size: number) => Math.log2(size) + 1;

interface Shared {
  bake: GPUComputePipeline;
  downsample: GPUComputePipeline;
  prefilter: GPUComputePipeline;
  sh: GPUComputePipeline;
  sampler: GPUSampler;
  lut: GPUTexture;
  lutView: GPUTextureView;
}

const shared = new WeakMap<GPUDevice, Shared>();

/** Pipelines and the BRDF lookup, once per device. */
function sharedFor(device: GPUDevice): Shared {
  let s = shared.get(device);
  if (s) return s;
  const pipeline = (label: string, code: string) =>
    device.createComputePipeline({
      label,
      layout: "auto",
      compute: {
        module: device.createShaderModule({ label, code }),
        entryPoint: "main",
      },
    });
  const lut = device.createTexture({
    label: "brdf-lut",
    size: [BRDF_SIZE, BRDF_SIZE],
    format: "rgba16float",
    usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING,
  });
  s = {
    bake: pipeline("sky-bake", bakeShader),
    downsample: pipeline("sky-downsample", downsampleShader),
    prefilter: pipeline("sky-prefilter", prefilterShader),
    sh: pipeline("sky-sh", shShader),
    sampler: device.createSampler({
      label: "ibl",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    }),
    lut,
    lutView: lut.createView(),
  };
  const lutPipeline = pipeline("brdf-lut", brdfShader);
  const encoder = device.createCommandEncoder({ label: "brdf-lut" });
  const pass = encoder.beginComputePass();
  pass.setPipeline(lutPipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: lutPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: lut.createView() }],
    }),
  );
  pass.dispatchWorkgroups(BRDF_SIZE / 8, BRDF_SIZE / 8);
  pass.end();
  device.queue.submit([encoder.finish()]);
  shared.set(device, s);
  return s;
}

interface Cubes {
  quality: Quality;
  env: GPUTexture;
  spec: GPUTexture;
  envView: GPUTextureView;
  specView: GPUTextureView;
  bakeBuffer: GPUBuffer;
  buffers: GPUBuffer[];
  bakeGroup: GPUBindGroup;
  downGroups: GPUBindGroup[];
  preGroups: GPUBindGroup[];
  shGroup: GPUBindGroup;
  envMips: number;
  specMips: number;
  size: number;
}

export class EnvironmentLightSystem implements RenderSystem {
  readonly name = "environment-light";
  /** Bakes performed so far (the environment changed). */
  bakes = 0;
  private cubes?: Cubes;
  private shBuffer?: GPUBuffer;
  private key = "";
  private baked = false;
  private lastBake = 0;
  private needsBake = false;
  private bakeData = new Float32Array(32);
  private active = false;
  private device?: GPUDevice;

  prepare(ctx: PrepareContext) {
    this.active = false;
    this.needsBake = false;
    const { overlays, environment: env, frame, quality } = ctx;
    // Unlit and wireframe show no lighting; a hemisphere override replaces it.
    if (overlays.shading === "unlit" || overlays.shading === "wireframe") {
      return;
    }
    if (overlays.ambient) return;
    const device = ctx.core.device;
    this.device = device;
    const cubes = this.ensure(device, quality);
    const settings = IBL_SETTINGS[quality];

    const procedural = env.sky === "procedural";
    const sun = frame.ordered.find((l) => l.kind === "directional");
    const sunDir: [number, number, number] = sun
      ? [-sun.direction[0], -sun.direction[1], -sun.direction[2]]
      : [0, 1, 0];
    const sunLen = Math.hypot(...sunDir) || 1;
    for (let i = 0; i < 3; i++) sunDir[i] /= sunLen;
    const elevation = Math.asin(Math.min(Math.max(sunDir[1], -1), 1));
    const sunColor = sun ? toLinear(sun.color, sun.intensity) : [0, 0, 0];
    const trans = sun && procedural ? sunExtinction(elevation) : [1, 1, 1];
    const factor = sun && procedural ? sunLightFactor(elevation) : [1, 1, 1];

    // The sun light as lit: the author's colour matched to the sky.
    const lit = [
      sunColor[0] * factor[0],
      sunColor[1] * factor[1],
      sunColor[2] * factor[2],
    ];
    if (sun && procedural) {
      const o = frame.ordered.indexOf(sun) * LIGHT_FLOATS + 4;
      for (let i = 0; i < 3; i++) frame.lights[o + i] = lit[i];
    }

    const zenith = toLinear(env.skyColor, env.skyIntensity);
    const horizon = toLinear(env.horizonColor, env.skyIntensity);
    const ground = toLinear(env.groundColor, env.skyIntensity);
    const data = this.bakeData;
    data.set([...sunDir, sun ? 1 : 0], 0);
    data.set([...sunColor, 0], 4);
    data.set([...trans, 0], 8);
    data.set([...zenith, 0], 12);
    data.set([...horizon, 0], 16);
    data.set([...ground, 0], 20);
    data.set([SKY_INDEX[env.sky], env.skyIntensity, settings.skySteps, 0], 24);
    data[28] = cubes.size;

    // What the cubes depend on: the sky and the sun, nothing else (ambient
    // strength is applied when shading).
    const key = [
      quality,
      env.sky,
      ...Array.from(data.subarray(0, 29)).map((v) => v.toFixed(5)),
    ].join(",");
    if (key !== this.key) {
      if (!this.baked || ctx.core.frame - this.lastBake >= settings.interval) {
        this.needsBake = true;
        this.key = key;
      }
    }

    this.active = this.needsBake || this.baked;
    if (!this.active) return;
    ctx.write("sunDir", [...sunDir, sun ? 1 : 0]);
    ctx.write("sunColor", [...sunColor, 0]);
    ctx.write("sunTrans", [...trans, 0]);
    ctx.write("sunLight", [...(sun ? lit : [0, 0, 0]), 0]);
    ctx.write("skyInfo", [
      cubes.specMips,
      Math.max(cubes.envMips - 5, 0),
      settings.skySteps,
      0,
    ]);
    // A procedural sky tints the fog unless the author gave it a colour
    // (fog_color with alpha above 0).
    ctx.write("fogParams", [procedural && env.fogColor[3] < 0.5 ? 1 : 0], 3);
    ctx.write("systems", [1], 2);
  }

  bindings(): SystemBindings {
    const cubes = this.cubes;
    if (!this.active || !cubes) return {};
    return {
      environment: cubes.envView,
      specular: cubes.specView,
      brdfLut: sharedFor(this.device!).lutView,
    };
  }

  encode(ctx: FrameContext) {
    const cubes = this.cubes;
    if (!this.active || !cubes) return;
    const device = ctx.core.device;
    if (this.needsBake) {
      const s = sharedFor(device);
      device.queue.writeBuffer(cubes.bakeBuffer, 0, this.bakeData);
      const pass = ctx.encoder.beginComputePass({ label: "environment-bake" });
      const groups = (size: number) => Math.ceil(size / 8);
      pass.setPipeline(s.bake);
      pass.setBindGroup(0, cubes.bakeGroup);
      pass.dispatchWorkgroups(groups(cubes.size), groups(cubes.size), 6);
      pass.setPipeline(s.downsample);
      for (let m = 1; m < cubes.envMips; m++) {
        const size = Math.max(cubes.size >> m, 1);
        pass.setBindGroup(0, cubes.downGroups[m]);
        pass.dispatchWorkgroups(groups(size), groups(size), 6);
      }
      pass.setPipeline(s.prefilter);
      for (let m = 0; m < cubes.specMips; m++) {
        const size = Math.max(IBL_SETTINGS[cubes.quality].spec >> m, 1);
        pass.setBindGroup(0, cubes.preGroups[m]);
        pass.dispatchWorkgroups(groups(size), groups(size), 6);
      }
      pass.setPipeline(s.sh);
      pass.setBindGroup(0, cubes.shGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      this.bakes++;
      this.baked = true;
      this.lastBake = ctx.core.frame;
    }
    ctx.encoder.copyBufferToBuffer(
      this.shBuffer!,
      0,
      ctx.frameBuffer,
      FRAME.sh * 4,
      SH_BYTES,
    );
  }

  dispose() {
    this.release();
    this.shBuffer?.destroy();
    this.shBuffer = undefined;
  }

  private release() {
    const c = this.cubes;
    if (!c) return;
    c.env.destroy();
    c.spec.destroy();
    for (const b of c.buffers) b.destroy();
    this.cubes = undefined;
    this.baked = false;
    this.key = "";
  }

  private ensure(device: GPUDevice, quality: Quality): Cubes {
    if (this.cubes?.quality === quality) return this.cubes;
    this.release();
    const s = sharedFor(device);
    const settings = IBL_SETTINGS[quality];
    const envMips = mips(settings.env);
    const specMips = mips(settings.spec);
    const cube = (label: string, size: number, count: number) =>
      device.createTexture({
        label,
        size: [size, size, 6],
        mipLevelCount: count,
        format: "rgba16float",
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING,
      });
    const env = cube("environment-cube", settings.env, envMips);
    const spec = cube("specular-cube", settings.spec, specMips);
    const store = (t: GPUTexture, m: number) =>
      t.createView({
        dimension: "2d-array",
        baseMipLevel: m,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 6,
      });
    const cubeMip = (t: GPUTexture, m: number) =>
      t.createView({ dimension: "cube", baseMipLevel: m, mipLevelCount: 1 });
    const envView = env.createView({ dimension: "cube" });
    const specView = spec.createView({ dimension: "cube" });

    const uniform = (label: string, bytes: number) =>
      device.createBuffer({
        label,
        size: bytes,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
    const bakeBuffer = uniform("sky-bake", 32 * 4);
    const preBuffer = uniform("prefilter-params", SLOT * specMips);
    const shParams = uniform("sh-params", 16);
    if (!this.shBuffer) {
      this.shBuffer = device.createBuffer({
        label: "sky-sh",
        size: SH_BYTES,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC |
          BufferUsage.COPY_DST,
      });
    }

    for (let m = 0; m < specMips; m++) {
      device.queue.writeBuffer(
        preBuffer,
        m * SLOT,
        new Float32Array([
          m / Math.max(specMips - 1, 1),
          settings.samples,
          settings.env,
          envMips,
        ]),
      );
    }
    device.queue.writeBuffer(
      shParams,
      0,
      new Float32Array([settings.shLod, settings.env >> settings.shLod, 0, 0]),
    );

    const bakeGroup = device.createBindGroup({
      layout: s.bake.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: bakeBuffer } },
        { binding: 1, resource: store(env, 0) },
      ],
    });
    const downGroups: GPUBindGroup[] = [bakeGroup];
    for (let m = 1; m < envMips; m++) {
      downGroups.push(device.createBindGroup({
        layout: s.downsample.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: cubeMip(env, m - 1) },
          { binding: 1, resource: s.sampler },
          { binding: 2, resource: store(env, m) },
        ],
      }));
    }
    const preGroups: GPUBindGroup[] = [];
    for (let m = 0; m < specMips; m++) {
      preGroups.push(device.createBindGroup({
        layout: s.prefilter.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: envView },
          { binding: 1, resource: s.sampler },
          { binding: 2, resource: store(spec, m) },
          {
            binding: 3,
            resource: { buffer: preBuffer, offset: m * SLOT, size: 16 },
          },
        ],
      }));
    }
    const shGroup = device.createBindGroup({
      layout: s.sh.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: envView },
        { binding: 1, resource: s.sampler },
        { binding: 2, resource: { buffer: this.shBuffer } },
        { binding: 3, resource: { buffer: shParams } },
      ],
    });
    return this.cubes = {
      quality,
      env,
      spec,
      envView,
      specView,
      bakeBuffer,
      buffers: [bakeBuffer, preBuffer, shParams],
      bakeGroup,
      downGroups,
      preGroups,
      shGroup,
      envMips,
      specMips,
      size: settings.env,
    };
  }
}

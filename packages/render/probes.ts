import { mat4 } from "@ink/geometry";
import type { Core } from "./core.ts";
import { BufferUsage, srgbToLinear, TextureUsage } from "./gpu.ts";
import { downsampleShader, prefilterShader } from "./shaders/ibl.ts";
import { probeBakeShader } from "./shaders/probes.ts";
import type { Environment, ReflectionProbe } from "./types.ts";

const SIZE = 32;
export const PROBE_MIPS = Math.log2(SIZE) + 1;
const kits = new WeakMap<
  GPUDevice,
  {
    bake: GPUComputePipeline;
    down: GPUComputePipeline;
    filter: GPUComputePipeline;
  }
>();
function kitOf(device: GPUDevice) {
  let kit = kits.get(device);
  if (!kit) {
    const pipeline = (label: string, code: string) =>
      device.createComputePipeline({
        label,
        layout: "auto",
        compute: {
          module: device.createShaderModule({ label, code }),
          entryPoint: "main",
        },
      });
    kit = {
      bake: pipeline("reflection probe trace", probeBakeShader),
      down: pipeline("probe mips", downsampleShader),
      filter: pipeline("probe GGX", prefilterShader),
    };
    kits.set(device, kit);
  }
  return kit;
}

export class ReflectionBaker {
  readonly count: number;
  readonly data: GPUBuffer;
  readonly view: GPUTextureView;
  private buffers: GPUBuffer[] = [];
  private raw: GPUTexture;
  private filtered: GPUTexture;
  private settings: GPUBuffer;
  private bake: GPUBindGroup;
  private down: GPUBindGroup[] = [];
  private filters: GPUBindGroup[] = [];
  private sky: number[];
  constructor(
    private core: Core,
    triangles: GPUBuffer,
    nodes: GPUBuffer,
    lights: GPUBuffer,
    probes: ReflectionProbe[],
    environment: Environment,
  ) {
    const device = core.device, kit = kitOf(device);
    this.count = probes.length;
    if (this.count * 6 > device.limits.maxTextureArrayLayers) {
      throw new Error("too many reflection probes for this GPU");
    }
    const buffer = (
      label: string,
      data: Float32Array | number,
      usage: GPUBufferUsageFlags = BufferUsage.STORAGE,
    ) => {
      const b = device.createBuffer({
        label,
        size: typeof data === "number" ? data : data.byteLength,
        usage: usage | BufferUsage.COPY_DST,
      });
      this.buffers.push(b);
      if (typeof data !== "number") device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const data = new Float32Array(this.count * 40);
    probes.forEach((p, i) =>
      data.set([
        ...mat4.invert(p.matrix),
        ...p.matrix,
        ...p.size.map((v) => Math.max(0.01, Math.abs(v) / 2)),
        Math.max(0, p.blend),
        p.matrix[12],
        p.matrix[13],
        p.matrix[14],
        Math.max(0, p.intensity),
      ], i * 40)
    );
    this.data = buffer("reflection probe boxes", data);
    const accumulated = buffer(
      "reflection probe sums",
      SIZE * SIZE * this.count * 6 * 16,
    );
    this.settings = buffer("reflection bake settings", 32, BufferUsage.UNIFORM);
    this.sky = environment.skyColor.slice(0, 3).map((v) =>
      srgbToLinear(v) * environment.skyIntensity
    );
    const texture = (label: string) =>
      device.createTexture({
        label,
        size: [SIZE, SIZE, this.count * 6],
        mipLevelCount: PROBE_MIPS,
        format: "rgba16float",
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING,
      });
    this.raw = texture("probe radiance");
    this.filtered = texture("probe specular");
    this.view = this.filtered.createView({ dimension: "cube-array" });
    this.bake = device.createBindGroup({
      layout: kit.bake.getBindGroupLayout(0),
      entries: [
        ...[triangles, nodes, lights, this.data, accumulated].map((
          b,
          binding,
        ) => ({ binding, resource: { buffer: b } })),
        {
          binding: 5,
          resource: this.raw.createView({
            dimension: "2d-array",
            baseMipLevel: 0,
            mipLevelCount: 1,
          }),
        },
        { binding: 6, resource: { buffer: this.settings } },
      ],
    });
    for (let mip = 0; mip < PROBE_MIPS; mip++) {
      if (mip) {
        this.down.push(
          device.createBindGroup({
            layout: kit.down.getBindGroupLayout(0),
            entries: [
              {
                binding: 0,
                resource: this.raw.createView({
                  dimension: "2d-array",
                  baseMipLevel: mip - 1,
                  mipLevelCount: 1,
                }),
              },
              { binding: 1, resource: core.dummies.linearSampler },
              {
                binding: 2,
                resource: this.raw.createView({
                  dimension: "2d-array",
                  baseMipLevel: mip,
                  mipLevelCount: 1,
                }),
              },
            ],
          }),
        );
      }
      const params = buffer(
        `probe mip ${mip}`,
        new Float32Array([mip / (PROBE_MIPS - 1), 64, SIZE, PROBE_MIPS]),
        BufferUsage.UNIFORM,
      );
      this.filters.push(
        device.createBindGroup({
          layout: kit.filter.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: this.raw.createView({ dimension: "2d-array" }),
            },
            { binding: 1, resource: core.dummies.linearSampler },
            {
              binding: 2,
              resource: this.filtered.createView({
                dimension: "2d-array",
                baseMipLevel: mip,
                mipLevelCount: 1,
              }),
            },
            { binding: 3, resource: { buffer: params } },
          ],
        }),
      );
    }
  }

  encode(
    encoder: GPUCommandEncoder,
    first: number,
    count: number,
    lightCount: number,
  ) {
    const { device } = this.core, kit = kitOf(device);
    const settings = new Float32Array(8);
    new Uint32Array(settings.buffer).set([first, count, lightCount, 0]);
    settings.set(this.sky, 4);
    device.queue.writeBuffer(this.settings, 0, settings);
    const pass = encoder.beginComputePass({ label: "bake reflection probes" });
    pass.setPipeline(kit.bake);
    pass.setBindGroup(0, this.bake);
    pass.dispatchWorkgroups(SIZE / 8, SIZE / 8, this.count * 6);
    pass.setPipeline(kit.down);
    this.down.forEach((group, i) => {
      pass.setBindGroup(0, group);
      const size = Math.ceil((SIZE >> (i + 1)) / 8);
      pass.dispatchWorkgroups(size, size, this.count * 6);
    });
    pass.setPipeline(kit.filter);
    this.filters.forEach((group, i) => {
      pass.setBindGroup(0, group);
      const size = Math.ceil((SIZE >> i) / 8);
      pass.dispatchWorkgroups(size, size, this.count * 6);
    });
    pass.end();
  }
  dispose() {
    for (const b of this.buffers) b.destroy();
    this.raw.destroy();
    this.filtered.destroy();
  }
}

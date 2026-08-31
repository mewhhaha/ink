import type { Observer } from "@ink/observability/observer.ts";
import {
  create_effect_definition,
  type EffectDefinition,
} from "./definition.ts";
import type { EffectInstanceId, EmitterId } from "./identity.ts";
import {
  CpuEffectSimulation,
  type CpuSimulationOptions,
  type EffectLifecycle,
  type EffectSimulationFrame,
} from "./simulation.ts";

export interface GpuParticleBufferLayout {
  readonly capacity: number;
  readonly particle_stride_bytes: number;
  readonly particle_buffer_bytes: number;
  readonly alive_flags_bytes: number;
  readonly prefix_sums_bytes: number;
  readonly indirect_arguments_bytes: number;
}

export interface GpuSimulationKernel {
  readonly name:
    | "spawn"
    | "update"
    | "prefix_scan"
    | "compact"
    | "indirect_arguments";
  readonly workgroups: number;
  readonly workgroup_size: number;
  readonly source: string;
}

export interface GpuSimulationPlan {
  readonly definition: string;
  readonly layout: GpuParticleBufferLayout;
  readonly emitters: readonly GpuEmitterPartition[];
  readonly kernels: readonly GpuSimulationKernel[];
  readonly graph_passes: readonly GpuSimulationPass[];
  readonly diagnostic_readback_bytes: number;
}

export interface GpuSimulationPass {
  readonly id: string;
  readonly kind: "compute";
  readonly reads: readonly {
    readonly resource: string;
    readonly access: "storage_read";
  }[];
  readonly writes: readonly {
    readonly resource: string;
    readonly access: "storage_write";
    readonly load: "discard";
    readonly store: "store";
  }[];
  readonly after: readonly string[];
}

export interface GpuEmitterPartition {
  readonly emitter: EmitterId;
  readonly first_particle: number;
  readonly capacity: number;
  readonly indirect_offset_bytes: number;
}

export interface GpuEmitterDispatch {
  readonly emitter: EmitterId;
  readonly requested_particles: number;
  readonly active_particles: number;
  readonly dropped_particles: number;
}

export interface GpuSimulationDispatch {
  readonly instance: EffectInstanceId;
  readonly elapsed_seconds: number;
  readonly delta_seconds: number;
  readonly requested_particles: number;
  readonly active_particles: number;
  readonly emitters: readonly GpuEmitterDispatch[];
}

export interface GpuDispatchDiagnostics {
  readonly dispatched_workgroups: number;
  readonly active_particles: number;
  readonly dropped_particles: number;
}

export interface WebGpuSimulationPort {
  execute(
    plan: GpuSimulationPlan,
    dispatch: GpuSimulationDispatch,
  ): GpuDispatchDiagnostics;
}

export type GpuCapabilityFallback = "cpu" | "reduced" | "stopped";

export interface GpuEffectSimulationOptions extends CpuSimulationOptions {
  readonly executor?: WebGpuSimulationPort;
  readonly unavailable: GpuCapabilityFallback;
  readonly observer?: Observer;
}

export class GpuEffectSimulation {
  readonly #reference: CpuEffectSimulation;
  readonly #instance: EffectInstanceId;
  readonly #executor: WebGpuSimulationPort | undefined;
  readonly #fallback: GpuCapabilityFallback;
  readonly #observer: Observer | undefined;
  readonly #quality: number;
  #plan: GpuSimulationPlan;
  #device_lost = false;

  constructor(options: GpuEffectSimulationOptions) {
    if (
      !(["cpu", "reduced", "stopped"] as const).includes(options.unavailable)
    ) {
      throw new Error(
        `effect ${options.instance} GPU fallback ${
          JSON.stringify(options.unavailable)
        } is unsupported`,
      );
    }
    this.#quality =
      options.executor === undefined && options.unavailable === "reduced"
        ? options.quality * 0.5
        : options.quality;
    this.#reference = new CpuEffectSimulation({
      ...options,
      quality: this.#quality,
    });
    this.#instance = options.instance;
    this.#executor = options.executor;
    this.#fallback = options.unavailable;
    this.#observer = options.observer;
    this.#plan = gpu_simulation_plan(options.definition, this.#quality);
    if (options.executor === undefined && options.unavailable === "stopped") {
      this.#reference.finish();
    }
    if (options.executor === undefined) {
      this.#observer?.diagnostic(
        options.unavailable === "stopped" ? "warning" : "info",
        "visual_effect.gpu_unavailable",
        `effect ${options.instance} has no WebGPU simulation executor`,
        {
          instance_id: options.instance,
          fallback: options.unavailable,
          quality: this.#quality,
        },
      );
    }
  }

  lifecycle(): EffectLifecycle {
    return this.#reference.lifecycle();
  }

  plan(): GpuSimulationPlan {
    return this.#plan;
  }

  snapshot(): EffectSimulationFrame {
    return this.#reference.snapshot();
  }

  step(delta_seconds: number): EffectSimulationFrame {
    const frame = this.#reference.step(delta_seconds);
    if (
      this.#executor === undefined || this.#device_lost ||
      frame.lifecycle === "finished"
    ) return frame;
    const requested = frame.counts.reduce(
      (sum, count) => sum + count.spawned + count.dropped,
      0,
    );
    const diagnostics = this.#executor.execute(this.#plan, {
      instance: this.#instance,
      elapsed_seconds: frame.elapsed_seconds,
      delta_seconds,
      requested_particles: requested,
      active_particles: frame.particles.length,
      emitters: frame.counts.map((count) => ({
        emitter: count.emitter,
        requested_particles: count.spawned + count.dropped,
        active_particles: count.active,
        dropped_particles: count.dropped,
      })),
    });
    for (const [field, value] of Object.entries(diagnostics)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `effect ${this.#instance} GPU diagnostic ${field} ${
            JSON.stringify(value)
          } must be a nonnegative integer`,
        );
      }
    }
    if (diagnostics.active_particles > this.#plan.layout.capacity) {
      throw new Error(
        `effect ${this.#instance} GPU diagnostics report ${diagnostics.active_particles} active particles above capacity ${this.#plan.layout.capacity}`,
      );
    }
    this.#observer?.event("visual_effect.gpu_dispatched", {
      instance_id: this.#instance,
      workgroups: diagnostics.dispatched_workgroups,
      active_particles: diagnostics.active_particles,
      dropped_particles: diagnostics.dropped_particles,
      readback_bytes: this.#plan.diagnostic_readback_bytes,
    });
    return frame;
  }

  stop(): void {
    this.#reference.stop();
  }

  device_lost(reason: string): void {
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error(
        `effect ${this.#instance} device loss reason cannot be empty`,
      );
    }
    this.#device_lost = true;
    const definition = this.#reference.definition();
    if (definition.recovery === "restart" && this.#fallback !== "stopped") {
      this.#reference.restart();
    } else {
      this.#reference.finish();
    }
    this.#observer?.diagnostic("warning", "visual_effect.device_lost", reason, {
      instance_id: this.#instance,
      recovery: definition.recovery,
      fallback: this.#fallback,
    });
  }

  replace_definition(definition: EffectDefinition, quality: number): void {
    const effective_quality =
      this.#executor === undefined && this.#fallback === "reduced"
        ? quality * 0.5
        : quality;
    this.#plan = gpu_simulation_plan(definition, effective_quality);
    this.#reference.replace_definition(definition);
  }
}

export function gpu_simulation_plan(
  definition: EffectDefinition,
  quality: number,
): GpuSimulationPlan {
  const parsed = create_effect_definition(definition);
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new Error(
      `effect ${parsed.id} GPU quality ${quality} must be within [0, 1]`,
    );
  }
  const capacity = parsed.emitters.reduce(
    (sum, emitter) => sum + Math.floor(emitter.capacity * quality),
    0,
  );
  if (!Number.isSafeInteger(capacity) || capacity > 16_777_216) {
    throw new Error(
      `effect ${parsed.id} GPU capacity ${capacity} exceeds 16777216 particles`,
    );
  }
  const workgroup_size = 64;
  const workgroups = Math.ceil(capacity / workgroup_size);
  const layout = Object.freeze({
    capacity,
    particle_stride_bytes: 80,
    particle_buffer_bytes: capacity * 80,
    alive_flags_bytes: capacity * 4,
    prefix_sums_bytes: capacity * 4,
    indirect_arguments_bytes: parsed.emitters.length * 5 * 4,
  });
  let first_particle = 0;
  const emitters = parsed.emitters.map((emitter, index) => {
    const emitter_capacity = Math.floor(emitter.capacity * quality);
    const partition = Object.freeze({
      emitter: emitter.id,
      first_particle,
      capacity: emitter_capacity,
      indirect_offset_bytes: index * 5 * 4,
    });
    first_particle += emitter_capacity;
    return partition;
  });
  const names: GpuSimulationKernel["name"][] = [
    "spawn",
    "update",
    "prefix_scan",
    "compact",
    "indirect_arguments",
  ];
  const kernels = names.map((name) =>
    Object.freeze({
      name,
      workgroups: name === "indirect_arguments"
        ? (capacity === 0 ? 0 : 1)
        : workgroups,
      workgroup_size,
      source: kernel_source(name),
    })
  );
  const prefix = `vfx:${parsed.id}`;
  const write = (resource: string) => ({
    resource: `${prefix}:${resource}`,
    access: "storage_write" as const,
    load: "discard" as const,
    store: "store" as const,
  });
  const read = (resource: string) => ({
    resource: `${prefix}:${resource}`,
    access: "storage_read" as const,
  });
  const graph_passes = Object.freeze(
    [
      {
        id: `${prefix}:spawn`,
        kind: "compute",
        reads: [],
        writes: [write("particles_spawned"), write("counters")],
        after: [],
      },
      {
        id: `${prefix}:update`,
        kind: "compute",
        reads: [read("particles_spawned")],
        writes: [write("particles_updated"), write("alive_flags")],
        after: [`${prefix}:spawn`],
      },
      {
        id: `${prefix}:prefix_scan`,
        kind: "compute",
        reads: [read("alive_flags")],
        writes: [write("prefix_sums")],
        after: [`${prefix}:update`],
      },
      {
        id: `${prefix}:compact`,
        kind: "compute",
        reads: [
          read("particles_updated"),
          read("alive_flags"),
          read("prefix_sums"),
        ],
        writes: [write("particles_compacted")],
        after: [`${prefix}:prefix_scan`],
      },
      {
        id: `${prefix}:indirect_arguments`,
        kind: "compute",
        reads: [read("counters"), read("prefix_sums")],
        writes: [write("indirect_arguments")],
        after: [`${prefix}:compact`],
      },
    ] satisfies GpuSimulationPass[],
  );
  return Object.freeze({
    definition: parsed.id,
    layout,
    emitters: Object.freeze(emitters),
    kernels: Object.freeze(kernels),
    graph_passes: Object.freeze(graph_passes),
    diagnostic_readback_bytes: 16,
  });
}

function kernel_source(name: GpuSimulationKernel["name"]): string {
  const bodies: Record<GpuSimulationKernel["name"], string> = {
    spawn: `
  if (invocation.x >= parameters.requested) { return; }
  let slot = atomicAdd(&counters.active, 1u);
  if (slot >= parameters.capacity) {
    atomicSub(&counters.active, 1u);
    atomicAdd(&counters.dropped, 1u);
    return;
  }
  let random = f32(hash(parameters.seed ^ invocation.x)) / 4294967296.0;
  particles_out[slot].position = vec4f(0.0, 0.0, 0.0, 1.0);
  particles_out[slot].velocity = vec4f(0.0, random, 0.0, 0.0);
  particles_out[slot].appearance = vec4f(1.0);
  particles_out[slot].lifecycle = vec4f(0.0, 1.0, 0.0, 0.0);
  particles_out[slot].sequence = vec4u(invocation.x, 0u, 0u, 0u);`,
    update: `
  if (invocation.x >= parameters.capacity) { return; }
  var particle = particles_in[invocation.x];
  particle.lifecycle.x += parameters.delta_seconds;
  let alive = particle.lifecycle.x < particle.lifecycle.y;
  alive_flags[invocation.x] = select(0u, 1u, alive);
  if (!alive) { return; }
  particle.velocity.xyz += parameters.force * parameters.delta_seconds;
  particle.position.xyz += particle.velocity.xyz * parameters.delta_seconds;
  particles_out[invocation.x] = particle;`,
    prefix_scan: `
  if (invocation.x >= parameters.capacity) { return; }
  var sum = 0u;
  for (var index = 0u; index <= invocation.x; index += 1u) {
    sum += alive_flags[index];
  }
  prefix_sums[invocation.x] = sum;`,
    compact: `
  if (invocation.x >= parameters.capacity || alive_flags[invocation.x] == 0u) { return; }
  let destination = prefix_sums[invocation.x] - 1u;
  particles_out[destination] = particles_in[invocation.x];`,
    indirect_arguments: `
  if (invocation.x != 0u) { return; }
  indirect_arguments[0] = parameters.index_count;
  indirect_arguments[1] = min(prefix_sums[parameters.capacity - 1u], parameters.capacity);
  indirect_arguments[2] = 0u;
  indirect_arguments[3] = 0u;
  indirect_arguments[4] = 0u;`,
  };
  return `
struct Particle { position: vec4f, velocity: vec4f, appearance: vec4f, lifecycle: vec4f, sequence: vec4u };
struct Parameters { capacity: u32, requested: u32, seed: u32, index_count: u32, delta_seconds: f32, force: vec3f };
struct Counters { active: atomic<u32>, dropped: atomic<u32> };
@group(0) @binding(0) var<storage, read> particles_in: array<Particle>;
@group(0) @binding(1) var<storage, read_write> particles_out: array<Particle>;
@group(0) @binding(2) var<storage, read_write> alive_flags: array<u32>;
@group(0) @binding(3) var<storage, read_write> prefix_sums: array<u32>;
@group(0) @binding(4) var<storage, read_write> indirect_arguments: array<u32>;
@group(0) @binding(5) var<uniform> parameters: Parameters;
@group(0) @binding(6) var<storage, read_write> counters: Counters;
fn hash(input: u32) -> u32 {
  var value = input;
  value = (value ^ (value >> 16u)) * 0x7feb352du;
  value = (value ^ (value >> 15u)) * 0x846ca68bu;
  return value ^ (value >> 16u);
}
@compute @workgroup_size(64)
fn ${name}(@builtin(global_invocation_id) invocation: vec3u) {
${bodies[name]}
}
`.trim();
}

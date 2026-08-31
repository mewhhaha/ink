import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { asset_id } from "@ink/assets/identity.ts";
import { material_instance_id } from "@ink/materials/identity.ts";
import { vec3 } from "@ink/math/vector.ts";
import { extract_effect_rendering } from "./experimental/extraction.ts";
import { effect_fixture, emitter_fixture } from "./experimental/fixture.ts";
import {
  gpu_simulation_plan,
  GpuEffectSimulation,
  type GpuSimulationDispatch,
  type GpuSimulationPlan,
  type WebGpuSimulationPort,
} from "./experimental/gpu.ts";
import { effect_instance_id, emitter_id } from "./experimental/identity.ts";
import { CpuEffectSimulation } from "./experimental/simulation.ts";

class RecordingGpuPort implements WebGpuSimulationPort {
  readonly calls: {
    readonly plan: GpuSimulationPlan;
    readonly dispatch: GpuSimulationDispatch;
  }[] = [];

  execute(plan: GpuSimulationPlan, dispatch: GpuSimulationDispatch) {
    this.calls.push({ plan, dispatch });
    return {
      dispatched_workgroups: plan.kernels.reduce(
        (sum, kernel) => sum + kernel.workgroups,
        0,
      ),
      active_particles: dispatch.active_particles,
      dropped_particles: Math.max(
        0,
        dispatch.requested_particles - dispatch.active_particles,
      ),
    };
  }
}

Deno.test("WebGPU plan bounds buffers and orders compaction before indirect arguments", () => {
  const definition = effect_fixture({
    emitters: [
      emitter_fixture({ capacity: 100 }),
      emitter_fixture({ id: emitter_id("smoke"), capacity: 20 }),
    ],
  });
  const plan = gpu_simulation_plan(definition, 0.5);
  assertEquals(plan.layout.capacity, 60);
  assertEquals(plan.layout.particle_buffer_bytes, 4_800);
  assertEquals(plan.diagnostic_readback_bytes, 16);
  assertEquals(plan.kernels.map((kernel) => kernel.name), [
    "spawn",
    "update",
    "prefix_scan",
    "compact",
    "indirect_arguments",
  ]);
  assertStringIncludes(plan.kernels[0].source, "@compute @workgroup_size(64)");
  assertEquals(plan.graph_passes.at(-1)?.after, ["vfx:campfire:compact"]);
});

Deno.test("WebGPU planning parses definitions and fallback diagnostics", () => {
  const malformed = { ...effect_fixture(), emitters: "embers" };
  assertThrows(
    () => gpu_simulation_plan(malformed as never, 1),
    Error,
    "emitters must be an array",
  );
  assertThrows(
    () =>
      new GpuEffectSimulation({
        instance: effect_instance_id("fire/invalid"),
        definition: effect_fixture(),
        seed: 1,
        quality: 1,
        origin: vec3(0, 0, 0),
        unavailable: "fallback" as never,
      }),
    Error,
    'GPU fallback "fallback" is unsupported',
  );
});

Deno.test("CPU and GPU-facing backends agree on lifecycle and capacity", () => {
  const definition = effect_fixture({
    emitters: [
      emitter_fixture({
        capacity: 4,
        lifetime_seconds: { minimum: 1, maximum: 1 },
      }),
    ],
  });
  const options = {
    instance: effect_instance_id("fire/conformance"),
    definition,
    seed: 41,
    quality: 1,
    origin: vec3(0, 0, 0),
  };
  const cpu = new CpuEffectSimulation(options);
  const port = new RecordingGpuPort();
  const gpu = new GpuEffectSimulation({
    ...options,
    executor: port,
    unavailable: "cpu",
  });
  for (const delta of [0, 0.25, 0.75]) {
    const cpu_frame = cpu.step(delta);
    const gpu_frame = gpu.step(delta);
    assertEquals(gpu_frame.lifecycle, cpu_frame.lifecycle);
    assertEquals(gpu_frame.counts, cpu_frame.counts);
    assertEquals(gpu_frame.particles.length, cpu_frame.particles.length);
  }
  assertEquals(port.calls.length, 3);
  assertEquals(
    port.calls.every((call) => call.plan.diagnostic_readback_bytes === 16),
    true,
  );
});

Deno.test("render extraction publishes every primitive family and bounded particle lights", () => {
  const material = material_instance_id("vfx/shared");
  const definition = effect_fixture({
    emitters: [
      emitter_fixture({
        id: emitter_id("billboard"),
        rate_per_second: 0,
        bursts: [{ time_seconds: 0, count: 1 }],
        render: {
          type: "billboard",
          material,
          phase: "transparent",
          alignment: "velocity",
        },
      }),
      emitter_fixture({
        id: emitter_id("mesh"),
        rate_per_second: 0,
        bursts: [{ time_seconds: 0, count: 1 }],
        render: {
          type: "mesh",
          mesh: asset_id("meshes/spark"),
          primitive: 2,
          material,
          phase: "opaque",
        },
      }),
      emitter_fixture({
        id: emitter_id("ribbon"),
        rate_per_second: 0,
        bursts: [{ time_seconds: 0, count: 2 }],
        render: {
          type: "ribbon",
          material,
          phase: "transparent",
          maximum_points: 4,
        },
      }),
      emitter_fixture({
        id: emitter_id("trail"),
        rate_per_second: 0,
        bursts: [{ time_seconds: 0, count: 2 }],
        render: {
          type: "trail",
          material,
          phase: "transparent",
          maximum_points: 4,
        },
      }),
      emitter_fixture({
        id: emitter_id("decal"),
        rate_per_second: 0,
        bursts: [{ time_seconds: 0, count: 1 }],
        render: {
          type: "decal",
          material,
          phase: "alpha_mask",
          projection_depth: 0.5,
        },
        light: {
          color: { r: 1, g: 0.5, b: 0 },
          intensity_candela: 20,
          range: 3,
          maximum_lights: 1,
        },
      }),
    ],
  });
  const frame = new CpuEffectSimulation({
    instance: effect_instance_id("all/renderers"),
    definition,
    seed: 1,
    quality: 1,
    origin: vec3(0, 0, 0),
  }).step(0);
  const extraction = extract_effect_rendering(definition, frame);
  assertEquals(
    extraction.primitives.map((primitive) => primitive.type).sort(),
    [
      "billboard",
      "decal",
      "mesh",
      "ribbon",
      "trail",
    ],
  );
  assertEquals(extraction.lights.length, 1);
  assertEquals(extraction.active_particles, 7);
  assertEquals(extraction.estimated_overdraw_area > 0, true);
});

Deno.test("device loss follows declared restart and finish policies", () => {
  const restart = new GpuEffectSimulation({
    instance: effect_instance_id("restart"),
    definition: effect_fixture({ recovery: "restart" }),
    seed: 1,
    quality: 1,
    origin: vec3(0, 0, 0),
    executor: new RecordingGpuPort(),
    unavailable: "cpu",
  });
  restart.step(0.5);
  restart.device_lost("adapter reset");
  assertEquals(restart.lifecycle(), "playing");
  assertEquals(restart.step(0).elapsed_seconds, 0);

  const finish = new GpuEffectSimulation({
    instance: effect_instance_id("finish"),
    definition: effect_fixture({ recovery: "finish" }),
    seed: 1,
    quality: 1,
    origin: vec3(0, 0, 0),
    executor: new RecordingGpuPort(),
    unavailable: "cpu",
  });
  finish.device_lost("adapter reset");
  assertEquals(finish.lifecycle(), "finished");
});

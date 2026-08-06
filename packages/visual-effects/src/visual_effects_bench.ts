import { vec3 } from "@ink/math/vector.ts";
import { extract_effect_rendering } from "./extraction.ts";
import { effect_fixture, emitter_fixture } from "./fixture.ts";
import { gpu_simulation_plan } from "./gpu.ts";
import { effect_instance_id, emitter_id } from "./identity.ts";
import { CpuEffectSimulation } from "./simulation.ts";

const mixed_effect = effect_fixture({
  emitters: [
    emitter_fixture({
      id: emitter_id("embers"),
      rate_per_second: 2_000,
      capacity: 8_192,
    }),
    emitter_fixture({
      id: emitter_id("smoke"),
      rate_per_second: 1_000,
      capacity: 4_096,
    }),
    emitter_fixture({
      id: emitter_id("sparks"),
      rate_per_second: 4_000,
      capacity: 16_384,
    }),
    emitter_fixture({
      id: emitter_id("dust"),
      rate_per_second: 500,
      capacity: 2_048,
    }),
  ],
});

function populated_simulation(): CpuEffectSimulation {
  const simulation = new CpuEffectSimulation({
    instance: effect_instance_id("benchmark/mixed"),
    definition: mixed_effect,
    seed: 42,
    quality: 1,
    origin: vec3(0, 0, 0),
  });
  simulation.step(1);
  return simulation;
}

Deno.bench("mixed CPU simulation frame", () => {
  populated_simulation().step(1 / 60);
});

Deno.bench("particle compaction reference", () => {
  const particles = populated_simulation().snapshot().particles;
  particles.filter((particle) =>
    particle.age_seconds < particle.lifetime_seconds
  );
});

Deno.bench("particle upload packing", () => {
  const particles = populated_simulation().snapshot().particles;
  const upload = new Float32Array(particles.length * 20);
  for (const [index, particle] of particles.entries()) {
    upload.set([
      particle.position.x,
      particle.position.y,
      particle.position.z,
      particle.velocity.x,
      particle.velocity.y,
      particle.velocity.z,
      particle.color.r,
      particle.color.g,
      particle.color.b,
      particle.color.a,
      particle.size,
      particle.rotation_radians,
    ], index * 20);
  }
});

Deno.bench("render extraction and overdraw estimate", () => {
  const simulation = populated_simulation();
  extract_effect_rendering(mixed_effect, simulation.snapshot());
});

Deno.bench("bounded GPU memory plan", () => {
  gpu_simulation_plan(mixed_effect, 0.75);
});

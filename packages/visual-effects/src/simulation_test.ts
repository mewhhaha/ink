import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { linear_rgba } from "@ink/materials/color.ts";
import { vec3 } from "@ink/math/vector.ts";
import { create_effect_definition } from "./definition.ts";
import { effect_fixture, emitter_fixture } from "./fixture.ts";
import { effect_instance_id, emitter_id } from "./identity.ts";
import { CpuEffectSimulation } from "./simulation.ts";

function simulation(
  seed = 7,
  definition = effect_fixture(),
): CpuEffectSimulation {
  return new CpuEffectSimulation({
    instance: effect_instance_id("fire/one"),
    definition,
    seed,
    quality: 1,
    origin: vec3(2, 3, 4),
  });
}

Deno.test("the same seed replays identical particle state", () => {
  const randomized = effect_fixture({
    emitters: [emitter_fixture({
      shape: { type: "sphere", radius: 2 },
      speed: { minimum: 0.5, maximum: 2 },
    })],
  });
  const first = simulation(7, randomized);
  const second = simulation(7, randomized);
  assertEquals(first.step(0.5), second.step(0.5));
  assertEquals(first.step(0.25), second.step(0.25));
  assertNotEquals(
    simulation(8, randomized).step(0.5).particles,
    simulation(7, randomized).step(0.5).particles,
  );
});

Deno.test("rate and bursts obey drop-newest capacity", () => {
  const definition = effect_fixture({
    emitters: [
      emitter_fixture({
        capacity: 5,
        lifetime_seconds: { minimum: 10, maximum: 10 },
      }),
    ],
  });
  const reference = simulation(7, definition);
  const first = reference.step(0.5);
  assertEquals(first.counts, [{
    emitter: emitter_id("embers"),
    spawned: 5,
    dropped: 0,
    active: 5,
  }]);
  const second = reference.step(0.5);
  assertEquals(second.counts, [{
    emitter: emitter_id("embers"),
    spawned: 0,
    dropped: 2,
    active: 5,
  }]);
  assertEquals(
    second.particles.map((particle) => particle.stable_sequence),
    [0, 1, 2, 3, 4],
  );
});

Deno.test("drop-oldest retains the newest stable sequences", () => {
  const definition = effect_fixture({
    emitters: [emitter_fixture({
      rate_per_second: 0,
      bursts: [{ time_seconds: 0, count: 5 }, { time_seconds: 1, count: 2 }],
      capacity: 5,
      capacity_policy: "drop_oldest",
      lifetime_seconds: { minimum: 10, maximum: 10 },
    })],
  });
  const reference = simulation(7, definition);
  reference.step(0);
  const frame = reference.step(1);
  assertEquals(frame.particles.map((particle) => particle.stable_sequence), [
    2,
    3,
    4,
    5,
    6,
  ]);
  assertEquals(frame.counts[0].dropped, 2);
});

Deno.test("zero-lifetime particles never enter active storage", () => {
  const definition = effect_fixture({
    emitters: [
      emitter_fixture({ lifetime_seconds: { minimum: 0, maximum: 0 } }),
    ],
  });
  const frame = simulation(7, definition).step(0.5);
  assertEquals(frame.particles.length, 0);
  assertEquals(frame.counts[0].spawned, 0);
});

Deno.test("forces curves rotation and sprite animation advance observable state", () => {
  const reference = simulation();
  reference.step(0);
  const frame = reference.step(0.5);
  const particle = frame.particles[0];
  assertEquals(particle.position, vec3(2, 3.25, 4));
  assertEquals(particle.velocity, vec3(0, 0.5, 0));
  assertEquals(particle.size, 0.75);
  assertEquals(particle.color, linear_rgba(0.775, 0.375, 0, 0.75));
  assertEquals(particle.rotation_radians, 1);
  assertEquals(particle.sprite_frame, 2);
});

Deno.test("automatic bounds include particle size and configured padding", () => {
  const frame = simulation().step(0);
  assertEquals(frame.bounds.minimum, vec3(1.25, 2.25, 3.25));
  assertEquals(frame.bounds.maximum, vec3(2.75, 3.75, 4.75));
});

Deno.test("required collision input fails before simulation starts", () => {
  const definition = effect_fixture({
    missing_collision: "stop",
    emitters: [
      emitter_fixture({
        collision: { source: "terrain", restitution: 0.5, radius: 0.1 },
      }),
    ],
  });
  assertThrows(
    () => simulation(7, definition),
    Error,
    "requires unavailable terrain collision input",
  );
});

Deno.test("malformed emitter graphs report the offending emitter", () => {
  const base = effect_fixture();
  assertThrows(
    () =>
      create_effect_definition({
        ...base,
        emitters: [emitter_fixture(), emitter_fixture()],
      }),
    Error,
    "repeats emitter embers",
  );
  assertThrows(
    () =>
      create_effect_definition({
        ...base,
        emitters: [emitter_fixture({ direction: vec3(0, 0, 0) })],
      }),
    Error,
    "effect campfire emitter embers direction cannot be zero",
  );
});

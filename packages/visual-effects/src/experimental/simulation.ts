import {
  type Aabb,
  aabb,
  aabb_expand,
  aabb_from_points,
} from "@ink/geometry/shapes.ts";
import { linear_rgba, type LinearRgba } from "@ink/materials/color.ts";
import type { Observer } from "@ink/observability/observer.ts";
import {
  type Vec3,
  vec3,
  vec3_add,
  vec3_dot,
  vec3_normalize,
  vec3_scale,
  vec3_subtract,
} from "@ink/math/vector.ts";
import type {
  ColorCurvePoint,
  EffectDefinition,
  EmitterDefinition,
  NumberRange,
  ScalarCurvePoint,
} from "./definition.ts";
import { create_effect_definition } from "./definition.ts";
import {
  effect_instance_id,
  type EffectInstanceId,
  type EmitterId,
} from "./identity.ts";
import { collision_port, type CollisionPorts } from "./ports.ts";

export type EffectLifecycle = "playing" | "stopped" | "finished";

export interface ParticleState {
  readonly emitter: EmitterId;
  readonly stable_sequence: number;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly age_seconds: number;
  readonly lifetime_seconds: number;
  readonly size: number;
  readonly color: LinearRgba;
  readonly rotation_radians: number;
  readonly sprite_frame: number;
}

export interface EmitterFrameCounts {
  readonly emitter: EmitterId;
  readonly spawned: number;
  readonly dropped: number;
  readonly active: number;
}

export interface EffectSimulationFrame {
  readonly instance: EffectInstanceId;
  readonly elapsed_seconds: number;
  readonly lifecycle: EffectLifecycle;
  readonly particles: readonly ParticleState[];
  readonly counts: readonly EmitterFrameCounts[];
  readonly bounds: Aabb;
}

export interface CpuSimulationOptions {
  readonly instance: EffectInstanceId;
  readonly definition: EffectDefinition;
  readonly seed: number;
  readonly quality: number;
  readonly origin: Vec3;
  readonly collisions?: CollisionPorts;
  readonly observer?: Observer;
}

interface MutableParticle {
  emitter: EmitterId;
  stable_sequence: number;
  position: Vec3;
  velocity: Vec3;
  age_seconds: number;
  lifetime_seconds: number;
  size: number;
  color: LinearRgba;
  rotation_radians: number;
  angular_velocity_radians: number;
  sprite_frame: number;
}

interface EmitterSimulation {
  readonly definition: EmitterDefinition;
  readonly capacity: number;
  particles: MutableParticle[];
  next_sequence: number;
  emitted_rate_particles: number;
  next_burst: number;
}

export class CpuEffectSimulation {
  #instance!: EffectInstanceId;
  #definition: EffectDefinition;
  #seed!: number;
  #quality!: number;
  #origin!: Vec3;
  #collisions: CollisionPorts | undefined;
  #observer: Observer | undefined;
  #elapsed_seconds = 0;
  #lifecycle: EffectLifecycle = "playing";
  #emitters: EmitterSimulation[];

  constructor(options: CpuSimulationOptions) {
    this.#definition = options.definition;
    this.#emitters = [];
    this.reset(options);
  }

  reset(options: CpuSimulationOptions): void {
    const instance = effect_instance_id(options.instance);
    if (
      !Number.isSafeInteger(options.seed) || options.seed < 0 ||
      options.seed > 0xffff_ffff
    ) {
      throw new Error(
        `effect ${options.instance} seed ${options.seed} must be a uint32`,
      );
    }
    if (
      !Number.isFinite(options.quality) || options.quality < 0 ||
      options.quality > 1
    ) {
      throw new Error(
        `effect ${options.instance} quality ${options.quality} must be within [0, 1]`,
      );
    }
    this.#instance = instance;
    this.#definition = create_effect_definition(options.definition);
    this.#seed = options.seed;
    this.#quality = options.quality;
    this.#origin = vec3(options.origin.x, options.origin.y, options.origin.z);
    this.#collisions = options.collisions;
    this.#observer = options.observer;
    this.#elapsed_seconds = 0;
    this.#lifecycle = "playing";
    this.#emitters = this.#create_emitters(this.#definition, this.#emitters);
    this.#assert_required_collision_ports();
  }

  lifecycle(): EffectLifecycle {
    return this.#lifecycle;
  }

  definition(): EffectDefinition {
    return this.#definition;
  }

  elapsed_seconds(): number {
    return this.#elapsed_seconds;
  }

  stop(): void {
    if (this.#lifecycle === "playing") this.#lifecycle = "stopped";
    this.#finish_when_empty();
  }

  finish(): void {
    for (const emitter of this.#emitters) emitter.particles = [];
    this.#lifecycle = "finished";
  }

  restart(): void {
    this.#elapsed_seconds = 0;
    this.#lifecycle = "playing";
    this.#emitters = this.#create_emitters(this.#definition, this.#emitters);
  }

  replace_definition(definition: EffectDefinition): void {
    this.#definition = definition;
    this.restart();
  }

  snapshot(): EffectSimulationFrame {
    return this.#frame(this.#emitters.map((emitter) => ({
      emitter: emitter.definition.id,
      spawned: 0,
      dropped: 0,
      active: emitter.particles.length,
    })));
  }

  step(delta_seconds: number): EffectSimulationFrame {
    if (!Number.isFinite(delta_seconds) || delta_seconds < 0) {
      throw new Error(
        `effect ${this.#instance} step ${delta_seconds} must be finite and nonnegative`,
      );
    }
    if (this.#lifecycle === "finished") return this.snapshot();

    const span = this.#observer?.start_span("visual_effect.simulation", {
      instance_id: this.#instance,
      delta_seconds,
    });
    const previous_elapsed = this.#elapsed_seconds;
    this.#elapsed_seconds += delta_seconds;
    if (!Number.isFinite(this.#elapsed_seconds)) {
      this.#elapsed_seconds = previous_elapsed;
      throw new Error(
        `effect ${this.#instance} elapsed time ${previous_elapsed} + ${delta_seconds} is not finite`,
      );
    }
    const counts: EmitterFrameCounts[] = [];
    for (const emitter of this.#emitters) {
      this.#advance_particles(emitter, delta_seconds);
      let spawned = 0;
      let dropped = 0;
      if (this.#lifecycle === "playing") {
        const requested = this.#requested_particles(emitter, previous_elapsed);
        ({ spawned, dropped } = this.#spawn(emitter, requested));
      }
      counts.push({
        emitter: emitter.definition.id,
        spawned,
        dropped,
        active: emitter.particles.length,
      });
    }
    this.#finish_when_empty();
    const frame = this.#frame(counts);
    const total_spawned = counts.reduce((sum, count) => sum + count.spawned, 0);
    const total_dropped = counts.reduce((sum, count) => sum + count.dropped, 0);
    this.#observer?.event("visual_effect.simulated", {
      instance_id: this.#instance,
      elapsed_seconds: this.#elapsed_seconds,
      active_particles: frame.particles.length,
      spawned_particles: total_spawned,
      dropped_particles: total_dropped,
      bounds_minimum: [
        frame.bounds.minimum.x,
        frame.bounds.minimum.y,
        frame.bounds.minimum.z,
      ],
      bounds_maximum: [
        frame.bounds.maximum.x,
        frame.bounds.maximum.y,
        frame.bounds.maximum.z,
      ],
    });
    span?.end({
      active_particles: frame.particles.length,
      spawned_particles: total_spawned,
      dropped_particles: total_dropped,
    });
    return frame;
  }

  #create_emitters(
    definition: EffectDefinition,
    reusable: readonly EmitterSimulation[] = [],
  ): EmitterSimulation[] {
    return definition.emitters.map((emitter, index) => ({
      definition: emitter,
      capacity: Math.floor(emitter.capacity * this.#quality),
      particles: reusable[index]?.particles ?? [],
      next_sequence: 0,
      emitted_rate_particles: 0,
      next_burst: 0,
    })).map((emitter) => {
      emitter.particles.splice(0);
      return emitter;
    });
  }

  #assert_required_collision_ports(): void {
    if (this.#definition.missing_collision === "no_collision") return;
    for (const emitter of this.#definition.emitters) {
      if (
        emitter.collision !== undefined &&
        collision_port(this.#collisions, emitter.collision.source) === undefined
      ) {
        throw new Error(
          `effect ${this.#definition.id} emitter ${emitter.id} requires unavailable ${emitter.collision.source} collision input`,
        );
      }
    }
  }

  #requested_particles(
    emitter: EmitterSimulation,
    previous_elapsed: number,
  ): number {
    const target_rate_particles = Math.floor(
      this.#elapsed_seconds * emitter.definition.rate_per_second *
          this.#quality + 1e-9,
    );
    if (!Number.isSafeInteger(target_rate_particles)) {
      throw new Error(
        `effect ${this.#instance} emitter ${emitter.definition.id} requested particle count exceeds safe integer range`,
      );
    }
    let requested = target_rate_particles - emitter.emitted_rate_particles;
    emitter.emitted_rate_particles = target_rate_particles;
    while (emitter.next_burst < emitter.definition.bursts.length) {
      const burst = emitter.definition.bursts[emitter.next_burst];
      if (burst.time_seconds > this.#elapsed_seconds) break;
      const reached = burst.time_seconds > previous_elapsed ||
        (previous_elapsed === 0 && burst.time_seconds === 0);
      if (reached) requested += Math.floor(burst.count * this.#quality);
      emitter.next_burst += 1;
    }
    return requested;
  }

  #spawn(
    emitter: EmitterSimulation,
    requested: number,
  ): { spawned: number; dropped: number } {
    if (requested === 0) return { spawned: 0, dropped: 0 };
    let admitted = requested;
    let dropped = 0;
    if (emitter.definition.capacity_policy === "drop_newest") {
      admitted = Math.min(
        requested,
        Math.max(0, emitter.capacity - emitter.particles.length),
      );
      dropped = requested - admitted;
    } else {
      const overflow = Math.max(
        0,
        emitter.particles.length + requested - emitter.capacity,
      );
      const evicted = Math.min(overflow, emitter.particles.length);
      emitter.particles.splice(0, evicted);
      admitted = Math.min(requested, emitter.capacity);
      dropped = overflow;
    }
    let spawned = 0;
    const skipped = requested - admitted;
    if (emitter.definition.capacity_policy === "drop_oldest") {
      emitter.next_sequence += skipped;
    }
    for (let index = 0; index < admitted; index++) {
      if (emitter.next_sequence > 0xffff_ffff) {
        throw new Error(
          `effect ${this.#instance} emitter ${emitter.definition.id} stable sequence exceeds uint32 range`,
        );
      }
      const sequence = emitter.next_sequence++;
      const particle = this.#particle(emitter.definition, sequence);
      if (particle.lifetime_seconds === 0) continue;
      emitter.particles.push(particle);
      spawned += 1;
    }
    if (emitter.definition.capacity_policy === "drop_newest") {
      emitter.next_sequence += skipped;
    }
    return { spawned, dropped };
  }

  #particle(definition: EmitterDefinition, sequence: number): MutableParticle {
    const position = vec3_add(
      this.#origin,
      vec3_add(
        definition.offset,
        shape_offset(definition, this.#seed, sequence),
      ),
    );
    const speed = range_sample(
      definition.speed,
      random_unit(this.#seed, sequence, 4),
    );
    const direction = spawn_direction(definition, this.#seed, sequence);
    const lifetime = range_sample(
      definition.lifetime_seconds,
      random_unit(this.#seed, sequence, 5),
    );
    const rotation = range_sample(
      definition.rotation_radians,
      random_unit(this.#seed, sequence, 6),
    );
    return {
      emitter: definition.id,
      stable_sequence: sequence,
      position,
      velocity: vec3_scale(direction, speed),
      age_seconds: 0,
      lifetime_seconds: lifetime,
      size: scalar_curve(definition.size, 0),
      color: color_curve(definition.color, 0),
      rotation_radians: rotation,
      angular_velocity_radians: range_sample(
        definition.angular_velocity_radians,
        random_unit(this.#seed, sequence, 7),
      ),
      sprite_frame: 0,
    };
  }

  #advance_particles(emitter: EmitterSimulation, delta_seconds: number): void {
    const retained: MutableParticle[] = [];
    for (const particle of emitter.particles) {
      particle.age_seconds += delta_seconds;
      if (particle.age_seconds >= particle.lifetime_seconds) continue;
      const drag = Math.exp(
        -emitter.definition.drag_per_second * delta_seconds,
      );
      particle.velocity = vec3_scale(
        vec3_add(
          particle.velocity,
          vec3_scale(emitter.definition.force, delta_seconds),
        ),
        drag,
      );
      const previous_position = particle.position;
      particle.position = vec3_add(
        particle.position,
        vec3_scale(particle.velocity, delta_seconds),
      );
      const collision = emitter.definition.collision;
      const port = collision === undefined
        ? undefined
        : collision_port(this.#collisions, collision.source);
      const contact = collision === undefined || port === undefined
        ? undefined
        : port.query({
          start: previous_position,
          finish: particle.position,
          radius: collision.radius,
          stable_sequence: particle.stable_sequence,
        });
      if (contact !== undefined && collision !== undefined) {
        particle.position = contact.position;
        particle.velocity = vec3_subtract(
          particle.velocity,
          vec3_scale(
            contact.normal,
            (1 + collision.restitution) *
              vec3_dot(particle.velocity, contact.normal),
          ),
        );
      }
      const progress = particle.age_seconds / particle.lifetime_seconds;
      particle.size = scalar_curve(emitter.definition.size, progress);
      particle.color = color_curve(emitter.definition.color, progress);
      particle.rotation_radians += particle.angular_velocity_radians *
        delta_seconds;
      particle.sprite_frame = sprite_frame(
        emitter.definition,
        particle.age_seconds,
      );
      retained.push(particle);
    }
    emitter.particles = retained;
  }

  #finish_when_empty(): void {
    if (
      this.#lifecycle === "stopped" &&
      this.#emitters.every((emitter) => emitter.particles.length === 0)
    ) {
      this.#lifecycle = "finished";
    }
  }

  #frame(counts: readonly EmitterFrameCounts[]): EffectSimulationFrame {
    const particles = this.#emitters.flatMap((emitter) =>
      emitter.particles.map(immutable_particle)
    );
    return Object.freeze({
      instance: this.#instance,
      elapsed_seconds: this.#elapsed_seconds,
      lifecycle: this.#lifecycle,
      particles: Object.freeze(particles),
      counts: Object.freeze(counts.map((count) => Object.freeze({ ...count }))),
      bounds: this.#bounds(particles),
    });
  }

  #bounds(particles: readonly ParticleState[]): Aabb {
    if (this.#definition.bounds.type === "fixed") {
      return this.#definition.bounds.value;
    }
    if (particles.length === 0) return aabb(this.#origin, this.#origin);
    const maximum_size = particles.reduce(
      (maximum, particle) => Math.max(maximum, Math.abs(particle.size)),
      0,
    );
    return aabb_expand(
      aabb_from_points(particles.map((particle) => particle.position)),
      maximum_size * 0.5 + this.#definition.bounds.padding,
    );
  }
}

function immutable_particle(particle: MutableParticle): ParticleState {
  return Object.freeze({ ...particle });
}

function shape_offset(
  definition: EmitterDefinition,
  seed: number,
  sequence: number,
): Vec3 {
  const shape = definition.shape;
  if (shape.type === "point") return vec3(0, 0, 0);
  if (shape.type === "box") {
    return vec3(
      (random_unit(seed, sequence, 0) * 2 - 1) * shape.half_extents.x,
      (random_unit(seed, sequence, 1) * 2 - 1) * shape.half_extents.y,
      (random_unit(seed, sequence, 2) * 2 - 1) * shape.half_extents.z,
    );
  }
  const direction = random_direction(seed, sequence);
  const radius = shape.radius * Math.cbrt(random_unit(seed, sequence, 3));
  return vec3_scale(direction, radius);
}

function spawn_direction(
  definition: EmitterDefinition,
  seed: number,
  sequence: number,
): Vec3 {
  const base = vec3_normalize(definition.direction);
  if (
    definition.shape.type !== "cone" || definition.shape.angle_radians === 0
  ) return base;
  const random = random_direction(seed ^ 0x9e37_79b9, sequence);
  const amount = (definition.shape.angle_radians / Math.PI) *
    random_unit(seed, sequence, 8);
  return vec3_normalize(
    vec3_add(vec3_scale(base, 1 - amount), vec3_scale(random, amount)),
  );
}

function random_direction(seed: number, sequence: number): Vec3 {
  const z = random_unit(seed, sequence, 0) * 2 - 1;
  const angle = random_unit(seed, sequence, 1) * Math.PI * 2;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return vec3(radial * Math.cos(angle), radial * Math.sin(angle), z);
}

function random_unit(seed: number, sequence: number, lane: number): number {
  let value = (seed ^ Math.imul(sequence + 1, 0x9e37_79b1) ^
    Math.imul(lane + 1, 0x85eb_ca77)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb_352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846c_a68b) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function range_sample(range: NumberRange, amount: number): number {
  return range.minimum + (range.maximum - range.minimum) * amount;
}

function scalar_curve(
  curve: readonly ScalarCurvePoint[],
  time: number,
): number {
  if (time <= curve[0].time) return curve[0].value;
  for (let index = 1; index < curve.length; index++) {
    const finish = curve[index];
    if (time > finish.time) continue;
    const start = curve[index - 1];
    const amount = (time - start.time) / (finish.time - start.time);
    return start.value + (finish.value - start.value) * amount;
  }
  return curve.at(-1)!.value;
}

function color_curve(
  curve: readonly ColorCurvePoint[],
  time: number,
): LinearRgba {
  if (time <= curve[0].time) return curve[0].value;
  for (let index = 1; index < curve.length; index++) {
    const finish = curve[index];
    if (time > finish.time) continue;
    const start = curve[index - 1];
    const amount = (time - start.time) / (finish.time - start.time);
    return linear_rgba(
      start.value.r + (finish.value.r - start.value.r) * amount,
      start.value.g + (finish.value.g - start.value.g) * amount,
      start.value.b + (finish.value.b - start.value.b) * amount,
      start.value.a + (finish.value.a - start.value.a) * amount,
    );
  }
  return curve.at(-1)!.value;
}

function sprite_frame(
  definition: EmitterDefinition,
  age_seconds: number,
): number {
  const sprite = definition.sprite;
  if (sprite === undefined) return 0;
  const frame = Math.floor(age_seconds * sprite.frames_per_second);
  return sprite.playback === "loop"
    ? frame % sprite.frames
    : Math.min(frame, sprite.frames - 1);
}

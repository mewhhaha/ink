import type { AssetId } from "@ink/assets/identity.ts";
import { linear_rgb } from "@ink/materials/color.ts";
import type { MaterialInstanceId } from "@ink/materials/identity.ts";
import { light_id } from "@ink/lighting/identity.ts";
import type { LightDefinition } from "@ink/lighting/model.ts";
import type { Vec3 } from "@ink/math/vector.ts";
import type { Observer } from "@ink/observability/observer.ts";
import type {
  EffectDefinition,
  EffectRenderPhase,
  ParticleRenderModule,
} from "./definition.ts";
import type { EffectInstanceId, EmitterId } from "./identity.ts";
import type { EffectSimulationFrame, ParticleState } from "./simulation.ts";

interface EffectPrimitiveBase {
  readonly instance: EffectInstanceId;
  readonly emitter: EmitterId;
  readonly stable_sequence: number;
  readonly material: MaterialInstanceId;
  readonly phase: EffectRenderPhase;
  readonly position: Vec3;
  readonly color: ParticleState["color"];
  readonly size: number;
  readonly rotation_radians: number;
}

export type EffectRenderPrimitive =
  | (EffectPrimitiveBase & {
    readonly type: "billboard";
    readonly alignment: "camera" | "velocity" | "world_up";
    readonly velocity: Vec3;
    readonly sprite_frame: number;
  })
  | (EffectPrimitiveBase & {
    readonly type: "mesh";
    readonly mesh: AssetId<"mesh">;
    readonly primitive: number;
  })
  | (EffectPrimitiveBase & {
    readonly type: "ribbon" | "trail";
    readonly points: readonly Vec3[];
  })
  | (EffectPrimitiveBase & {
    readonly type: "decal";
    readonly projection_depth: number;
  });

export interface EffectRenderExtraction {
  readonly instance: EffectInstanceId;
  readonly primitives: readonly EffectRenderPrimitive[];
  readonly lights: readonly LightDefinition[];
  readonly active_particles: number;
  readonly estimated_overdraw_area: number;
}

export function extract_effect_rendering(
  definition: EffectDefinition,
  frame: EffectSimulationFrame,
  observer?: Observer,
): EffectRenderExtraction {
  const emitters = new Map(
    definition.emitters.map((emitter) => [emitter.id, emitter]),
  );
  const trails = new Map<EmitterId, Vec3[]>();
  const primitives: EffectRenderPrimitive[] = [];
  const lights: LightDefinition[] = [];
  for (const particle of frame.particles) {
    const emitter = emitters.get(particle.emitter);
    if (emitter === undefined) {
      throw new Error(
        `effect ${frame.instance} particle ${particle.stable_sequence} references missing emitter ${particle.emitter}`,
      );
    }
    const render = emitter.render;
    if (render.type === "ribbon" || render.type === "trail") {
      const points = trails.get(emitter.id) ?? [];
      points.push(particle.position);
      trails.set(emitter.id, points);
      continue;
    }
    primitives.push(primitive(frame.instance, particle, render));
  }
  for (const emitter of definition.emitters) {
    if (emitter.render.type !== "ribbon" && emitter.render.type !== "trail") {
      continue;
    }
    const points = (trails.get(emitter.id) ?? []).slice(
      -emitter.render.maximum_points,
    );
    if (points.length === 0) continue;
    const particle = frame.particles.find((candidate) =>
      candidate.emitter === emitter.id
    )!;
    primitives.push({
      ...base(
        frame.instance,
        particle,
        emitter.render.material,
        emitter.render.phase,
      ),
      type: emitter.render.type,
      points: Object.freeze(points),
    });
  }
  for (const emitter of definition.emitters) {
    const light = emitter.light;
    if (light === undefined) continue;
    const particles = frame.particles.filter((particle) =>
      particle.emitter === emitter.id
    ).slice(0, light.maximum_lights);
    for (const particle of particles) {
      lights.push({
        id: light_id(
          `${frame.instance}/${emitter.id}/${particle.stable_sequence}`,
        ),
        revision: 0,
        type: "point",
        color: linear_rgb(light.color.r, light.color.g, light.color.b),
        layers: 0xffff_ffff,
        importance: particle.color.a,
        shadow: { type: "off" },
        position: particle.position,
        intensity_candela: light.intensity_candela * particle.color.a,
        range: light.range,
        source_radius: 0,
      });
    }
  }
  const estimated_overdraw_area = primitives.reduce(
    (sum, current) => sum + Math.PI * (current.size * 0.5) ** 2,
    0,
  );
  observer?.gauge(
    "visual_effect.estimated_overdraw_area",
    estimated_overdraw_area,
    "count",
  );
  observer?.gauge(
    "visual_effect.extracted_primitives",
    primitives.length,
    "count",
  );
  return Object.freeze({
    instance: frame.instance,
    primitives: Object.freeze(primitives),
    lights: Object.freeze(lights),
    active_particles: frame.particles.length,
    estimated_overdraw_area,
  });
}

function primitive(
  instance: EffectInstanceId,
  particle: ParticleState,
  render: ParticleRenderModule,
): EffectRenderPrimitive {
  const common = base(instance, particle, render.material, render.phase);
  if (render.type === "billboard") {
    return {
      ...common,
      type: "billboard",
      alignment: render.alignment,
      velocity: particle.velocity,
      sprite_frame: particle.sprite_frame,
    };
  }
  if (render.type === "mesh") {
    return {
      ...common,
      type: "mesh",
      mesh: render.mesh,
      primitive: render.primitive,
    };
  }
  if (render.type === "ribbon" || render.type === "trail") {
    throw new Error(
      `effect ${instance} emitter ${particle.emitter} ribbon extraction requires grouped particles`,
    );
  }
  return {
    ...common,
    type: "decal",
    projection_depth: render.projection_depth,
  };
}

function base(
  instance: EffectInstanceId,
  particle: ParticleState,
  material: MaterialInstanceId,
  phase: EffectRenderPhase,
): EffectPrimitiveBase {
  return {
    instance,
    emitter: particle.emitter,
    stable_sequence: particle.stable_sequence,
    material,
    phase,
    position: particle.position,
    color: particle.color,
    size: particle.size,
    rotation_radians: particle.rotation_radians,
  };
}

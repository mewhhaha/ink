import {
  type Mat4,
  mat4,
  type Vec2,
  type Vec3,
  type Vec4,
} from "@ink/geometry";
import {
  assetPath,
  type Catalog,
  type EventModel,
  type RecordValue,
  type WorldModel,
} from "@ink/schema";
import type { ParticleDraw } from "./types.ts";

export interface Presentation {
  dt?: number;
  events?: readonly { tick: number; events: readonly EventModel[] }[];
}

const bounded = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(min, Math.min(max, v))
    : fallback;

function emitter(
  entity: number,
  c: RecordValue,
  matrix: Mat4,
  catalog: Catalog,
): ParticleDraw {
  return {
    entity,
    matrix,
    seed: bounded(c.seed, 1, 0, 0xffffff),
    time: 0,
    rate: bounded(c.rate, 40, 0, 1000),
    count: 0,
    lifetime: bounded(c.lifetime, 2, 0.05, 10),
    velocity: (c.velocity ?? [0, 2, 0]) as Vec3,
    spread: (c.spread ?? [0.6, 0.6, 0.6]) as Vec3,
    gravity: (c.gravity ?? [0, -0.5, 0]) as Vec3,
    radius: bounded(c.radius, 0.15, 0, 100),
    size: (c.size ?? [0.2, 0.6]) as Vec2,
    color: (c.color ?? [1, 0.5, 0.08, 0.8]) as Vec4,
    endColor: (c.end_color ?? [0.5, 0.1, 0.01, 0]) as Vec4,
    intensity: bounded(c.intensity, 1, 0, 100),
    blend: c.additive === true ? "additive" : "blend",
    shape: c.shape === "spark" ? "spark" : "soft",
    texture: assetPath(catalog, "texture", Number(c.texture)) || undefined,
  };
}

export function extractParticles(
  world: WorldModel,
  matrices: Map<number, Mat4>,
  catalog: Catalog,
  presentation: Presentation,
): ParticleDraw[] {
  const dt = bounded(presentation.dt, 1 / 60, 0.001, 1);
  const templates = new Map<number, ParticleDraw>();
  const result: ParticleDraw[] = [];
  for (const e of world.entities) {
    const c = e.components.emitter;
    if (!c || c.active === false) continue;
    const p = emitter(e.id, c, matrices.get(e.id)!, catalog);
    templates.set(e.id, p);
    p.time = (world.tick - bounded(c.start_tick, 0, 0, 0xffffff)) * dt;
    if (p.rate > 0 && p.time >= 0) {
      p.count = Math.min(2048, Math.ceil(p.rate * p.lifetime));
      result.push(p);
    }
  }
  for (const frame of presentation.events ?? []) {
    const time = (world.tick - frame.tick) * dt;
    if (time < 0 || time > 10) continue;
    for (const event of frame.events) {
      if (event.name !== "particles") continue;
      const v = event.value;
      const p = templates.get(Number(v.emitter));
      if (!p || time >= p.lifetime) continue;
      const count = Math.floor(bounded(v.count, 0, 0, 2048));
      if (!count) continue;
      result.push({
        ...p,
        matrix: mat4.compose((v.position ?? [0, 0, 0]) as Vec3, [0, 0, 0, 1], [
          1,
          1,
          1,
        ]),
        time,
        rate: 0,
        count,
        seed: (p.seed ^ Number(v.seed) ^ frame.tick) >>> 0,
      });
    }
  }
  return result;
}

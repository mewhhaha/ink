/**
 * The scene environment: sky, ambient light, exposure, post-processing and
 * fog. `readEnvironment` resolves the standard `environment` component,
 * `resolveEnvironment` layers per-view overrides on top, and `skyLinear`,
 * `ambientColors` and friends derive the linear-light values shaders use.
 * Defaults mirror the schema's (a test keeps them in sync).
 */
import type { Vec3, Vec4 } from "@ink/geometry";
import type { RecordValue } from "@ink/schema";
import { srgbToLinear } from "./gpu.ts";
import type { Environment, SkyKind, TonemapKind } from "./types.ts";

export function defaultEnvironment(): Environment {
  return {
    sky: "procedural",
    skyColor: [0.32, 0.5, 0.78, 1],
    horizonColor: [0.72, 0.8, 0.9, 1],
    groundColor: [0.24, 0.22, 0.2, 1],
    skyIntensity: 1,
    skyAltitude: 100,
    cloudCoverage: 0,
    cloudHeight: 2000,
    cloudScale: 1000,
    cloudOffset: 0,
    ambient: 1,
    ambientOcclusion: 1,
    aoRadius: 0.6,
    shadowDistance: 80,
    exposure: 0,
    autoExposure: false,
    tonemap: "aces",
    bloom: 0.04,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    vignette: 0.15,
    grain: 0,
    fogDensity: 0,
    fogColor: [0.7, 0.77, 0.85, 0],
    fogHeight: 0,
    fogFalloff: 0.15,
  };
}

const SKY_KINDS: readonly SkyKind[] = ["procedural", "gradient", "flat"];
const TONEMAPS: readonly TonemapKind[] = [
  "aces",
  "agx",
  "neutral",
  "reinhard",
  "linear",
];

const num = (v: unknown, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : d;
const flag = (v: unknown, d: boolean) => typeof v === "boolean" ? v : d;
const color = (v: unknown, d: Vec4): Vec4 =>
  Array.isArray(v) && v.length >= 3
    ? [v[0], v[1], v[2], v.length > 3 ? v[3] : 1] as Vec4
    : d;
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T =>
  list.includes(v as T) ? v as T : d;

/** Resolve an `environment` component record; missing fields take defaults. */
export function readEnvironment(c: RecordValue): Environment {
  const d = defaultEnvironment();
  return {
    sky: oneOf(c.sky, SKY_KINDS, d.sky),
    skyColor: color(c.sky_color, d.skyColor),
    horizonColor: color(c.horizon_color, d.horizonColor),
    groundColor: color(c.ground_color, d.groundColor),
    skyIntensity: num(c.sky_intensity, d.skyIntensity),
    skyAltitude: num(c.sky_altitude, d.skyAltitude),
    cloudCoverage: num(c.cloud_coverage, d.cloudCoverage),
    cloudHeight: num(c.cloud_height, d.cloudHeight),
    cloudScale: num(c.cloud_scale, d.cloudScale),
    cloudOffset: num(c.cloud_offset, d.cloudOffset),
    ambient: num(c.ambient, d.ambient),
    ambientOcclusion: num(c.ambient_occlusion, d.ambientOcclusion),
    aoRadius: num(c.ao_radius, d.aoRadius),
    shadowDistance: num(c.shadow_distance, d.shadowDistance),
    exposure: num(c.exposure, d.exposure),
    autoExposure: flag(c.auto_exposure, d.autoExposure),
    tonemap: oneOf(c.tonemap, TONEMAPS, d.tonemap),
    bloom: num(c.bloom, d.bloom),
    contrast: num(c.contrast, d.contrast),
    saturation: num(c.saturation, d.saturation),
    temperature: num(c.temperature, d.temperature),
    vignette: num(c.vignette, d.vignette),
    grain: num(c.grain, d.grain),
    fogDensity: num(c.fog_density, d.fogDensity),
    fogColor: color(c.fog_color, d.fogColor),
    fogHeight: num(c.fog_height, d.fogHeight),
    fogFalloff: num(c.fog_falloff, d.fogFalloff),
  };
}

/** The scene's environment with a view's overrides applied. */
export function resolveEnvironment(
  base: Environment,
  override?: Partial<Environment>,
): Environment {
  if (!override) return base;
  const out = { ...base };
  for (const key of Object.keys(override) as (keyof Environment)[]) {
    const value = override[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export const TONEMAP_INDEX: Record<TonemapKind, number> = {
  aces: 0,
  agx: 1,
  neutral: 2,
  reinhard: 3,
  linear: 4,
};
export const SKY_INDEX: Record<SkyKind, number> = {
  procedural: 0,
  gradient: 1,
  flat: 2,
};

/** sRGB colour to linear light, times `scale`. */
export function toLinear(c: ArrayLike<number>, scale = 1): Vec3 {
  return [
    srgbToLinear(c[0]) * scale,
    srgbToLinear(c[1]) * scale,
    srgbToLinear(c[2]) * scale,
  ];
}

/** Tuned so the default environment lights a scene like the old fixed
 * hemisphere did: sky ambient ≈ (0.2, 0.26, 0.36) linear. */
const SKY_AMBIENT = 0.62;
const GROUND_AMBIENT = 1.9;

/** Hemisphere ambient light colours (linear radiance), before the
 * `Overlays.ambient` override. Sky side blends zenith and horizon. */
export function ambientColors(
  env: Environment,
  override?: Vec4,
): { sky: Vec3; ground: Vec3 } {
  if (override) {
    const sky = toLinear(override, override[3]);
    return { sky, ground: [sky[0] * 0.4, sky[1] * 0.38, sky[2] * 0.34] };
  }
  const k = env.ambient * env.skyIntensity;
  const zenith = toLinear(env.skyColor), horizon = toLinear(env.horizonColor);
  const ground = toLinear(env.groundColor);
  const flat = env.sky === "flat";
  return {
    sky: [0, 1, 2].map((i) =>
      (flat ? zenith[i] : (zenith[i] * 0.4 + horizon[i] * 0.6)) *
      SKY_AMBIENT * k
    ) as Vec3,
    ground: ground.map((v) => v * GROUND_AMBIENT * k) as Vec3,
  };
}

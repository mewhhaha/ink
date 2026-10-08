/**
 * Constants of the procedural atmosphere and its CPU-side sun model. The WGSL
 * (shaders/sky.ts) is generated from these numbers, and `sunExtinction`
 * integrates the same densities so the colour of the sun *light* matches the
 * transmittance the sky shader uses for the sun disk.
 *
 * Single scattering with Rayleigh (air), Mie (haze) and ozone absorption,
 * after Hillaire (2020). Lengths are kilometres.
 */
import type { Vec3 } from "@ink/geometry";

export const PLANET_RADIUS = 6360;
export const ATMOSPHERE_RADIUS = 6420;
/** Height of the eye above the ground, km (the sky is seen from here). */
export const OBSERVER_ALTITUDE = 0.1;
export const RAYLEIGH: Vec3 = [5.802e-3, 13.558e-3, 33.1e-3];
export const RAYLEIGH_SCALE = 8;
export const MIE_SCATTERING = 3.996e-3;
export const MIE_EXTINCTION = 4.44e-3;
export const MIE_SCALE = 1.2;
export const MIE_G = 0.8;
export const OZONE: Vec3 = [0.65e-3, 1.881e-3, 0.085e-3];
/** Ozone layer: a tent centred at 25 km, 15 km either side. */
export const OZONE_CENTER = 25;
export const OZONE_WIDTH = 15;
/** The sun's disk as drawn, radians (about twice the real 0.27 degrees: a
 * stylised sun reads better at game field of view). */
export const SUN_ANGULAR_RADIUS = 0.0093;
/** Elevation window (radians) over which the sun fades in at the horizon. */
export const SUN_FADE: [number, number] = [-0.035, 0.015];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Transmittance of the atmosphere from the eye towards the sun at
 * `elevation` (radians above the horizon), per RGB channel. The sun below the
 * horizon is faded out smoothly (`SUN_FADE`) instead of being cut. */
export function sunExtinction(elevation: number): Vec3 {
  const fade = smoothstep(SUN_FADE[0], SUN_FADE[1], elevation);
  if (fade <= 0) return [0, 0, 0];
  const e = Math.max(elevation, -0.01);
  const dir = [Math.cos(e), Math.sin(e)];
  const origin = [0, PLANET_RADIUS + OBSERVER_ALTITUDE];
  const b = origin[0] * dir[0] + origin[1] * dir[1];
  const c = origin[0] ** 2 + origin[1] ** 2 - ATMOSPHERE_RADIUS ** 2;
  const length = -b + Math.sqrt(Math.max(b * b - c, 0));
  const steps = 96;
  const tau: Vec3 = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const x0 = i / steps, x1 = (i + 1) / steps;
    const t0 = length * x0 * x0, t1 = length * x1 * x1;
    const t = (t0 + t1) / 2;
    const px = origin[0] + dir[0] * t, py = origin[1] + dir[1] * t;
    const h = Math.hypot(px, py) - PLANET_RADIUS;
    const rayleigh = Math.exp(-h / RAYLEIGH_SCALE);
    const mie = Math.exp(-h / MIE_SCALE);
    const ozone = Math.max(0, 1 - Math.abs(h - OZONE_CENTER) / OZONE_WIDTH);
    for (let k = 0; k < 3; k++) {
      tau[k] += (RAYLEIGH[k] * rayleigh + MIE_EXTINCTION * mie +
        OZONE[k] * ozone) * (t1 - t0);
    }
  }
  return [
    Math.exp(-tau[0]) * fade,
    Math.exp(-tau[1]) * fade,
    Math.exp(-tau[2]) * fade,
  ];
}

/** The colour factor applied to a sun light of elevation `elevation` so that
 * it matches the sky: extinction relative to the sun overhead (a sun at the
 * zenith keeps the author's colour), fading to nothing below the horizon. */
export function sunLightFactor(elevation: number): Vec3 {
  const t = sunExtinction(elevation);
  const zenith = sunExtinction(Math.PI / 2);
  return [t[0] / zenith[0], t[1] / zenith[1], t[2] / zenith[2]];
}

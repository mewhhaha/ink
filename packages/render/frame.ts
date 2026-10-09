/**
 * The per-frame GPU data of a view: the frame uniform (camera, environment,
 * counts; layout in shaders/frame_layout.ts) and the light storage buffer.
 * `packFrame` fills everything the core knows; render systems then add their
 * own parts in `prepare` (see systems.ts).
 */
import { type Aabb, mat4, vec3 } from "@ink/geometry";
import { ambientColors, SKY_INDEX, toLinear } from "./environment.ts";
import {
  FRAME,
  FRAME_FLOATS,
  LIGHT_FLOATS,
  MAX_LIGHTS,
} from "./shaders/frame_layout.ts";
import type {
  Camera,
  Environment,
  LightDraw,
  Overlays,
  Quality,
} from "./types.ts";

/** Sun used when a scene has no lights of its own. */
const FALLBACK_SUN: LightDraw = {
  entity: 0,
  kind: "directional",
  color: [1, 0.96, 0.9],
  intensity: 1.5,
  range: 0,
  angle: 0,
  shadows: true,
  softness: 1,
  position: [0, 0, 0],
  direction: vec3.normalize([0.45, -0.8, -0.4]),
};

/** Distance used to fog the sky, as if it were geometry this far away. */
const SKY_FOG_DISTANCE = 2000;

export interface FrameData {
  /** The frame uniform, FRAME_FLOATS long. */
  data: Float32Array;
  /** The light storage buffer contents, MAX_LIGHTS * LIGHT_FLOATS long. */
  lights: Float32Array;
  /** Lights as uploaded: the sun (shadow caster) first, then the other
   * directional lights, then point and spot lights. */
  ordered: LightDraw[];
  /** The light that casts the sun shadow (`ordered[0]`), if any. */
  sun?: LightDraw;
  /** Bounds of everything that casts shadows (may be empty). */
  casterBounds: Aabb;
  quality: Quality;
}

/** Lights ordered so the shadow caster (if any) is first. */
export function orderLights(lights: readonly LightDraw[]): LightDraw[] {
  const list = lights.length ? lights : [FALLBACK_SUN];
  const caster = list.find((l) => l.kind === "directional" && l.shadows);
  const others = list.filter((l) => l !== caster);
  return [
    ...(caster ? [caster] : []),
    ...others.filter((l) => l.kind === "directional"),
    ...others.filter((l) => l.kind !== "directional"),
  ].slice(0, MAX_LIGHTS);
}

export function packFrame(
  camera: Camera,
  overlays: Overlays,
  env: Environment,
  sceneLights: readonly LightDraw[],
  casterBounds: Aabb,
  size: { width: number; height: number; dpr: number },
  quality: Quality,
  frameIndex: number,
  seconds: number,
): FrameData {
  const data = new Float32Array(FRAME_FLOATS);
  const set = (name: string, values: ArrayLike<number>) =>
    data.set(values, FRAME[name]);
  const viewProj = mat4.multiply(camera.projection, camera.view);
  set("viewProj", viewProj);
  set("invViewProj", mat4.invert(viewProj));
  set("view", camera.view);
  const near = Math.max(0.0001, camera.near);
  const far = Math.max(near + 0.0001, camera.far);
  set("clusterDepth", [near, far, Math.log(far / near), 0]);
  set("temporal", [overlays.temporal ? 1 : 0, 0, 0, 0]);

  const ordered = orderLights(sceneLights);
  const sun = ordered[0]?.kind === "directional" && ordered[0].shadows
    ? ordered[0]
    : undefined;

  set("cameraPos", [...camera.position, camera.orthographic ? 1 : 0]);
  const v = camera.view;
  set("cameraDir", [-v[2], -v[6], -v[10], 0]);

  const ambient = ambientColors(env, overlays.ambient);
  set("sky", [...ambient.sky, 0]);
  set("ground", [...ambient.ground, 0]);
  set("params", [overlays.shading === "unlit" ? 1 : 0, ordered.length, 0, 0]);
  set("viewport", [
    size.width,
    size.height,
    size.dpr,
    quality === "high" ? 1 : 0,
  ]);
  set("shadow", [0, 1, quality === "high" ? 16 : 8, 2.4]);
  set("envInfo", [
    env.ambient,
    env.ambientOcclusion,
    SKY_INDEX[env.sky],
    env.skyIntensity,
  ]);
  set("skyZenith", [...toLinear(env.skyColor, env.skyIntensity), 0]);
  set("skyHorizon", [...toLinear(env.horizonColor, env.skyIntensity), 0]);
  set("skyGround", [...toLinear(env.groundColor, env.skyIntensity), 0]);
  set("fog", [...toLinear(env.fogColor), Math.max(0, env.fogDensity)]);
  set("fogParams", [env.fogHeight, env.fogFalloff, SKY_FOG_DISTANCE, 0]);
  set("time", [seconds, frameIndex, env.aoRadius, env.shadowDistance]);
  set("gi", [env.indirect, 0, 0, env.reflections]);

  const lights = new Float32Array(Math.max(1, ordered.length) * LIGHT_FLOATS);
  ordered.forEach((light, i) => {
    const o = i * LIGHT_FLOATS;
    const kind = light.kind === "directional"
      ? 0
      : light.kind === "point"
      ? 1
      : 2;
    lights.set([...light.position, kind], o);
    lights.set([
      ...toLinear(light.color, light.intensity),
      light.range,
    ], o + 4);
    const half = (Math.max(light.angle, 1) * Math.PI) / 360;
    lights.set([...light.direction, Math.cos(half)], o + 8);
    lights.set(
      [Math.cos(half * 0.75), Math.max(light.softness, 0), -1, 0],
      o + 12,
    );
  });
  return { data, lights, ordered, sun, casterBounds, quality };
}

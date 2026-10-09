/**
 * Components and events every Ink renderer, editor and tool understands.
 * Spread them into a schema; leave out the ones a game does not need.
 *
 *   defineSchema({
 *     components: { ...standard.components, coin: { value: u32() } },
 *     events: { ...standard.events },
 *   })
 */
import {
  asset,
  bool,
  color,
  entity,
  enumOf,
  f32,
  type Field,
  list,
  message,
  quat,
  struct,
  u32,
  vec2,
  vec3,
  vec4,
} from "./fields.ts";
import { component, type RecordDef } from "./schema.ts";

export const transform: RecordDef = component({
  position: vec3({ step: 0.1, unit: "m" }),
  rotation: quat(),
  scale: vec3({ default: [1, 1, 1], step: 0.1 }),
}, {
  icon: "move",
  category: "Spatial",
  description: "Position, rotation and scale relative to the parent.",
});

export const mesh: RecordDef = component({
  shape: asset("mesh", { description: "Mesh asset, or a builtin primitive." }),
  color: color(),
  texture: asset("texture", {
    description: "Base colour (sRGB), multiplied by color.",
  }),
  roughness: f32({ default: 0.6, min: 0, max: 1, step: 0.01 }),
  metallic: f32({ default: 0, min: 0, max: 1, step: 0.01 }),
  emissive: color({ default: [0, 0, 0, 1] }),
  emissive_strength: f32({
    default: 1,
    min: 0,
    max: 100,
    step: 0.1,
    description: "HDR multiplier: above 1 glows into bloom.",
  }),
  normal_map: asset("texture", {
    group: "Maps",
    description: "Tangent-space normal map (OpenGL convention, +Y up).",
  }),
  normal_strength: f32({
    default: 1,
    min: 0,
    max: 4,
    step: 0.05,
    group: "Maps",
  }),
  orm_map: asset("texture", {
    group: "Maps",
    description:
      "Packed occlusion (R), roughness (G) and metallic (B); multiplies the values above.",
  }),
  uv_scale: vec2({ default: [1, 1], step: 0.1, group: "Maps" }),
  alpha_mode: enumOf(["opaque", "mask", "blend", "additive"], {
    name: "AlphaMode",
    group: "Surface",
  }),
  alpha_cutoff: f32({
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
    group: "Surface",
  }),
  double_sided: bool({ group: "Surface" }),
  use_materials: bool({
    default: true,
    group: "Surface",
    description:
      "Use the glTF asset's materials; color still tints the result.",
  }),
  cast_shadows: bool({ default: true }),
  bake_lighting: bool({
    default: false,
    description: "Static geometry used by lightmap and reflection baking.",
  }),
}, {
  icon: "cube",
  category: "Rendering",
  description: "Draws a mesh with a simple physically based material.",
});

export const camera: RecordDef = component({
  fov: f32({ default: 60, min: 1, max: 170, step: 1, unit: "°" }),
  near: f32({ default: 0.1, min: 0.001, step: 0.01 }),
  far: f32({ default: 500, min: 1, step: 1 }),
  orthographic: bool(),
  size: f32({ default: 10, min: 0.01, description: "Orthographic height" }),
  active: bool({
    default: true,
    description: "The first active camera is the game view.",
  }),
}, {
  icon: "camera",
  category: "Rendering",
  description: "A view into the world. It looks down its local -Z axis.",
});

export const light: RecordDef = component({
  kind: enumOf(["directional", "point", "spot"], { name: "LightKind" }),
  color: color(),
  intensity: f32({ default: 1, min: 0, step: 0.1 }),
  range: f32({ default: 10, min: 0, step: 0.5, unit: "m" }),
  angle: f32({ default: 45, min: 1, max: 179, unit: "°" }),
  shadows: bool(),
  softness: f32({
    default: 1,
    min: 0,
    max: 10,
    step: 0.1,
    description: "Size of the light for soft shadows: 0 is a hard edge.",
  }),
}, {
  icon: "sun",
  category: "Rendering",
  description: "Directional lights shine down local -Z; point lights radiate.",
});

/** Box-projected reflections of static geometry around this entity. */
export const reflection_probe: RecordDef = component({
  size: vec3({ default: [10, 10, 10], min: 0.1, unit: "m" }),
  blend: f32({
    default: 1,
    min: 0,
    unit: "m",
    description: "Blend distance inside the probe box.",
  }),
  intensity: f32({ default: 1, min: 0, max: 8 }),
}, {
  icon: "sphere",
  category: "Rendering",
  description: "A box-projected reflection of static scene geometry.",
});

/** A convex solid bounded by planes `n · p <= d`, stored as `[nx, ny, nz, d]`
 * in the entity's local space. Each face carries its own surface. */
export const brush: RecordDef = component({
  bake_lighting: bool({
    default: true,
    description:
      "Bake static bounce light. Disable for moving doors and platforms.",
  }),
  visible: bool({
    default: true,
    description:
      "Draw the brush surface. Disable for collision or trigger volumes.",
  }),
  faces: list(
    struct({
      plane: vec4(),
      texture: asset("texture"),
      color: color(),
      offset: vec2(),
      scale: vec2({ default: [1, 1] }),
      rotation: f32({ unit: "°" }),
      uv_u: vec4({ hidden: true }),
      uv_v: vec4({ hidden: true }),
    }, { name: "Face" }),
    { max: 64 },
  ),
}, {
  icon: "box",
  category: "Level",
  description: "A convex solid for level geometry, edited with brush tools.",
});

/** How the world is lit and presented: sky, ambient light, exposure,
 * post-processing and fog. The first active one in the world applies. Games
 * can change it at runtime (a day/night cycle is just a system). */
export const environment: RecordDef = component({
  active: bool({ default: true }),
  sky: enumOf(["procedural", "gradient", "flat"], {
    name: "SkyKind",
    group: "Sky",
  }),
  sky_color: color({
    default: [0.32, 0.5, 0.78, 1],
    group: "Sky",
    description: "Zenith (gradient) or the whole sky (flat).",
  }),
  horizon_color: color({ default: [0.72, 0.8, 0.9, 1], group: "Sky" }),
  ground_color: color({ default: [0.24, 0.22, 0.2, 1], group: "Sky" }),
  sky_intensity: f32({ default: 1, min: 0, max: 16, step: 0.05, group: "Sky" }),
  sky_altitude: f32({
    default: 100,
    min: 0,
    max: 59000,
    unit: "m",
    group: "Sky",
    description:
      "Altitude of world zero above sea level. The camera height is added.",
  }),
  cloud_coverage: f32({ default: 0, min: 0, max: 1, step: 0.01, group: "Sky" }),
  cloud_height: f32({
    default: 2000,
    min: 1,
    max: 59000,
    unit: "m",
    group: "Sky",
  }),
  cloud_scale: f32({
    default: 1000,
    min: 1,
    max: 10000,
    unit: "m",
    group: "Sky",
  }),
  cloud_offset: f32({
    default: 0,
    unit: "m",
    group: "Sky",
    description:
      "Wind displacement. Animate this value in the game for replayable clouds.",
  }),
  ambient: f32({
    default: 1,
    min: 0,
    max: 4,
    step: 0.05,
    group: "Light",
    description: "Image-based light from the sky on every surface.",
  }),
  ambient_occlusion: f32({
    default: 1,
    min: 0,
    max: 2,
    step: 0.05,
    group: "Light",
  }),
  reflections: f32({
    default: 0,
    min: 0,
    max: 1,
    step: 0.05,
    group: "Light",
    description:
      "Screen-space reflections on smooth surfaces, with probes as fallback.",
  }),
  indirect: f32({
    default: 0,
    min: 0,
    max: 4,
    step: 0.05,
    group: "Light",
    description:
      "Path-traced bounce light on static brushes. Changes rebake progressively.",
  }),
  ao_radius: f32({
    default: 0.6,
    min: 0.05,
    max: 4,
    step: 0.05,
    unit: "m",
    group: "Light",
  }),
  shadow_distance: f32({
    default: 80,
    min: 5,
    max: 1000,
    step: 1,
    unit: "m",
    group: "Light",
  }),
  exposure: f32({
    default: 0,
    min: -10,
    max: 10,
    step: 0.1,
    unit: "EV",
    group: "Camera",
  }),
  auto_exposure: bool({
    group: "Camera",
    description: "Adapt exposure to the average brightness.",
  }),
  tonemap: enumOf(["aces", "agx", "neutral", "reinhard", "linear"], {
    name: "Tonemap",
    group: "Camera",
  }),
  bloom: f32({ default: 0.04, min: 0, max: 1, step: 0.01, group: "Camera" }),
  contrast: f32({ default: 1, min: 0.5, max: 1.5, step: 0.01, group: "Grade" }),
  saturation: f32({ default: 1, min: 0, max: 2, step: 0.01, group: "Grade" }),
  temperature: f32({ default: 0, min: -1, max: 1, step: 0.01, group: "Grade" }),
  vignette: f32({ default: 0.15, min: 0, max: 1, step: 0.01, group: "Grade" }),
  grain: f32({ default: 0, min: 0, max: 1, step: 0.01, group: "Grade" }),
  fog_density: f32({ default: 0, min: 0, max: 1, step: 0.001, group: "Fog" }),
  fog_color: color({
    default: [0.7, 0.77, 0.85, 0],
    group: "Fog",
    description:
      "Fog colour. Alpha 0 = automatic: a procedural sky tints the fog, other skies use this colour.",
  }),
  fog_height: f32({
    default: 0,
    step: 0.5,
    unit: "m",
    group: "Fog",
    description: "Fog thins out above this height.",
  }),
  fog_falloff: f32({ default: 0.15, min: 0, max: 4, step: 0.01, group: "Fog" }),
}, {
  icon: "sun",
  category: "Rendering",
  description:
    "Sky, ambient light, exposure, post-processing and fog. The first active one applies.",
});

/** Particles are reconstructed from tick/seed in compute, never game state. */
export const emitter: RecordDef = component({
  active: bool({ default: true }),
  seed: u32({ default: 1 }),
  start_tick: u32({ description: "Tick at which continuous emission begins." }),
  rate: f32({ default: 40, min: 0, max: 1000, unit: "/s" }),
  lifetime: f32({ default: 2, min: 0.05, max: 10, unit: "s" }),
  velocity: vec3({ default: [0, 2, 0], unit: "m/s" }),
  spread: vec3({ default: [0.6, 0.6, 0.6], unit: "m/s" }),
  gravity: vec3({ default: [0, -0.5, 0], unit: "m/s²" }),
  radius: f32({ default: 0.15, min: 0, max: 100, unit: "m" }),
  size: vec2({
    default: [0.2, 0.6],
    description: "Billboard width at birth and death (metres).",
  }),
  color: color({ default: [1, 0.5, 0.08, 0.8] }),
  end_color: color({ default: [0.5, 0.1, 0.01, 0] }),
  intensity: f32({ default: 1, min: 0, max: 100 }),
  additive: bool({
    description:
      "Add emitted light; leave off for smoke and other translucent particles.",
  }),
  shape: enumOf(["soft", "spark"], { name: "ParticleShape" }),
  texture: asset("texture"),
}, {
  icon: "sparkle",
  category: "Rendering",
  description:
    "Deterministic GPU particles. Rate 0 makes a burst-only emitter. Continuous particles follow its transform; bursts use world positions.",
});

/** Animation is driven by the game's pure step, so its pose rewinds exactly. */
export const animation: RecordDef = component({
  clip: u32({
    description: "One-based imported clip index; 0 is the bind pose.",
  }),
  time: f32({ unit: "s" }),
  loop: bool({ default: true }),
  previous_clip: u32({ group: "Blend" }),
  previous_time: f32({ unit: "s", group: "Blend" }),
  previous_loop: bool({ default: true, group: "Blend" }),
  blend: f32({
    default: 1,
    min: 0,
    max: 1,
    step: 0.05,
    group: "Blend",
    description: "0 is the previous clip; 1 is the current clip.",
  }),
}, {
  icon: "play",
  category: "Rendering",
  description:
    "Imported animation clips and crossfades. The game owns clip time and transitions.",
});

export const attachment: RecordDef = component({
  target: entity(),
  node: u32({
    description: "Zero-based node index in the target's glTF asset.",
  }),
}, {
  icon: "link",
  category: "Spatial",
  description:
    "Attaches the local transform to a posed node in another entity's model.",
});

export const components: Record<string, RecordDef> = {
  reflection_probe,
  transform,
  mesh,
  camera,
  light,
  environment,
  brush,
  emitter,
  animation,
  attachment,
};

export const events: Record<string, Record<string, Field>> = {
  particles: {
    emitter: entity(),
    position: vec3(),
    count: u32({ default: 32 }),
    seed: u32(),
  },
  log: {
    message: message(),
    a: f32(),
    b: f32(),
  },
  /** A debug line drawn in editor views for the step that emitted it. */
  line: {
    start: vec3(),
    end: vec3(),
    color: color({ default: [1, 0.85, 0.2, 1] }),
  },
  sound: {
    clip: asset("sound"),
    volume: f32({ default: 1 }),
    pitch: f32({ default: 1 }),
    position: vec3(),
    spatial: bool(),
  },
};

/** Textures every renderer provides, generated on the GPU side's host: a
 * prototype checker and grid, and tileable noise for detail and masks. */
export const builtinTextures = [
  "builtin:checker",
  "builtin:grid",
  "builtin:noise/value",
  "builtin:noise/perlin",
  "builtin:noise/simplex",
  "builtin:noise/worley",
  "builtin:noise/fbm",
  "builtin:noise/ridged",
  "builtin:noise/blue",
] as const;

/** Primitive meshes every renderer provides, in catalog order. */
export const builtinMeshes = [
  "builtin:cube",
  "builtin:sphere",
  "builtin:plane",
  "builtin:cylinder",
  "builtin:capsule",
  "builtin:cone",
] as const;

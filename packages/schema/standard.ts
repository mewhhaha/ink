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
import {
  body,
  character,
  collider,
  resources as physicsResources,
} from "./physics.ts";

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

/** 2D drawing. Sprites, tile maps and text live on the entity's transform
 * plane and draw in a display-referred layer above the 3D scene, ordered by
 * `layer`. They do not need an orthographic camera, but 2D games use one. */
export const sprite: RecordDef = component({
  atlas: asset("atlas", {
    description: "Atlas file with named frames and animations.",
  }),
  frame: u32({
    description: "One-based atlas frame; 0 shows the whole image.",
  }),
  anim: u32({
    description: "One-based atlas animation; 0 shows `frame`.",
    group: "Animation",
  }),
  anim_time: f32({
    unit: "s",
    group: "Animation",
    description: "The game advances this; the renderer has no clock.",
  }),
  texture: asset("texture", {
    description: "A single image, when there is no atlas.",
  }),
  color: color({ description: "Tint, multiplied with the image." }),
  flip_x: bool({ group: "Placement" }),
  flip_y: bool({ group: "Placement" }),
  pivot: vec2({
    default: [0.5, 0.5],
    step: 0.05,
    group: "Placement",
    description: "The point of the frame at the transform (0,0 = bottom left).",
  }),
  pixels_per_unit: f32({
    default: 16,
    min: 1,
    step: 1,
    group: "Placement",
    description: "Image pixels per world unit.",
  }),
  layer: f32({
    step: 1,
    group: "Order",
    description: "Higher layers draw on top.",
  }),
  y_sort: bool({
    group: "Order",
    description: "Within a layer, lower sprites draw in front.",
  }),
  lit: bool({
    default: true,
    group: "Surface",
    description: "Lit by light2d entities, using the atlas normal map.",
  }),
  smooth: bool({
    group: "Surface",
    description: "Linear filtering; off keeps pixels crisp.",
  }),
  snap: bool({
    group: "Surface",
    description: "Snap the position to the image's pixel grid.",
  }),
}, {
  icon: "image",
  category: "2D",
  description: "A frame of an atlas (or an image) drawn on the XY plane.",
});

/** Tile ids are atlas frame ids; 0 is empty. Rows run bottom to top, so cell
 * (x, y) is `cells[y * width + x]` with +y up like the world. */
export const tilemap: RecordDef = component({
  tileset: asset("atlas", { description: "Atlas whose frames are the tiles." }),
  width: u32({ default: 16, min: 1, max: 1024 }),
  height: u32({ default: 16, min: 1, max: 1024 }),
  cell: vec2({
    default: [1, 1],
    min: 0.01,
    step: 0.25,
    unit: "m",
    description: "World size of one tile.",
  }),
  color: color(),
  layer: f32({ step: 1, group: "Order", description: "Higher layers on top." }),
  lit: bool({ default: true, group: "Surface" }),
  occluder: bool({
    group: "Surface",
    description:
      "Solid tiles block light2d shadows. One shadow-casting map per view.",
  }),
  cells: list(u32(), {
    max: 32768,
    hidden: true,
    description:
      "width x height tile ids, row by row from the bottom. Edit it with the tile tools.",
  }),
}, {
  icon: "grid",
  category: "2D",
  description:
    "A grid of tiles from an atlas. Its origin is the bottom left corner of cell (0, 0).",
});

export const light2d: RecordDef = component({
  kind: enumOf(["lamp", "spotlight", "sun", "ambient"], {
    name: "Light2dKind",
    description:
      "Lamps radiate, spotlights shine along local +X, the sun shines along local -Y everywhere, ambient lights everything.",
  }),
  color: color(),
  intensity: f32({ default: 1, min: 0, step: 0.1 }),
  radius: f32({ default: 6, min: 0, step: 0.5, unit: "m" }),
  falloff: f32({
    default: 2,
    min: 0.1,
    max: 8,
    step: 0.1,
    description: "How quickly light fades toward the radius.",
  }),
  height: f32({
    default: 1.5,
    min: 0,
    step: 0.1,
    unit: "m",
    description: "Distance in front of the sprites, for normal maps.",
  }),
  angle: f32({ default: 60, min: 1, max: 179, unit: "°" }),
  shadows: bool({
    description: "Solid tiles of the occluder map block this light.",
  }),
}, {
  icon: "sun",
  category: "2D",
  description:
    "Lights sprites and tiles. Without any light2d entity, 2D content is drawn unlit.",
});

export const text: RecordDef = component({
  message: message({
    description: "Message to show; 0 shows the entity's name.",
  }),
  a: f32({ description: "Fills {0} in the message." }),
  b: f32({ description: "Fills {1} in the message." }),
  size: f32({
    default: 1,
    min: 0.05,
    step: 0.25,
    unit: "m",
    description: "Height of a line.",
  }),
  color: color(),
  align: enumOf(["left", "center", "right"], { name: "TextAlign" }),
  outline: f32({
    min: 0,
    max: 0.9,
    step: 0.05,
    unit: "px",
    group: "Outline",
    description: "Width in font pixels (one is an eighth of the size).",
  }),
  outline_color: color({ default: [0, 0, 0, 1], group: "Outline" }),
  layer: f32({ default: 100, step: 1, group: "Order" }),
}, {
  icon: "comment",
  category: "2D",
  description:
    "Crisp scalable text from a distance field font, centred vertically on the entity.",
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
  collider,
  body,
  character,
};

/** Heightfield ground with splat-mapped layers. The terrain is a square of
 * `size` metres centred on the entity (translation only). The heights and
 * splat weights live in the `heightmap` asset (`*.terrain`); only a coarse
 * collision grid is part of the world, for game code (`ink/terrain`). */
export const terrain: RecordDef = component({
  heightmap: asset("terrain", {
    description: "Heights and splat weights, edited with the terrain tools.",
  }),
  size: f32({ default: 2048, min: 1, step: 16, unit: "m" }),
  height_scale: f32({
    default: 1,
    min: 0.01,
    step: 0.05,
    description: "Multiplies the stored heights.",
  }),
  layers: list(
    struct({
      albedo: asset("texture", { description: "Colour (sRGB)." }),
      normal: asset("texture", {
        description: "Tangent-space normal; alpha is the blend height.",
      }),
      orm: asset("texture", {
        description: "Occlusion (R), roughness (G), metallic (B).",
      }),
      tiling: f32({
        default: 6,
        min: 0.1,
        step: 0.5,
        unit: "m",
        description: "World size of one texture repeat.",
      }),
      color: color(),
    }, { name: "TerrainLayer" }),
    { max: 8, group: "Layers" },
  ),
  blend_height: f32({
    default: 0.35,
    min: 0,
    max: 1,
    step: 0.05,
    group: "Layers",
    description: "How much layer height shapes the blend between layers.",
  }),
  detail_amplitude: f32({
    default: 0.35,
    min: 0,
    step: 0.05,
    unit: "m",
    group: "Detail",
    description: "Procedural height added on top of the heightmap.",
  }),
  detail_wavelength: f32({
    default: 6,
    min: 0.25,
    step: 0.25,
    unit: "m",
    group: "Detail",
  }),
  detail_octaves: u32({ default: 3, min: 0, max: 6, group: "Detail" }),
  detail_seed: u32({ default: 1, group: "Detail" }),
  lod_distance: f32({
    default: 96,
    min: 8,
    step: 8,
    unit: "m",
    group: "Quality",
    description: "Distance at which the finest patches give way to coarser.",
  }),
  cast_shadows: bool({ default: true, group: "Quality" }),
  collision_cells: u32({
    default: 128,
    min: 8,
    max: 256,
    group: "Collision",
    description: "Cells per side of the grid game code sees.",
  }),
  grid: list(f32(), {
    max: 66049,
    hidden: true,
    description:
      "(collision_cells + 1)² ground heights for ink/terrain. Kept in step with the heightmap by the terrain tools.",
  }),
  revision: u32({
    hidden: true,
    description: "Edit counter: ties the scene to the heightmap's contents.",
  }),
}, {
  icon: "mountain",
  category: "World",
  description:
    "A heightfield ground, up to several kilometres wide, with noise detail and painted layers.",
});

/** Thousands of instances of one mesh placed by a `*.scatter` asset. They are
 * culled and level-of-detail selected on the GPU and never become entities. */
export const scatter: RecordDef = component({
  shape: asset("mesh", { description: "Mesh asset to repeat." }),
  placements: asset("scatter", {
    description: "Positions, rotations and scales, painted with the tools.",
  }),
  color: color(),
  texture: asset("texture", { description: "Base colour (sRGB)." }),
  normal_map: asset("texture", { group: "Maps" }),
  orm_map: asset("texture", { group: "Maps" }),
  roughness: f32({ default: 0.7, min: 0, max: 1, step: 0.01 }),
  metallic: f32({ default: 0, min: 0, max: 1, step: 0.01 }),
  tint_variation: f32({
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.01,
    description:
      "How much each instance's tint darkens or lightens the colour.",
  }),
  follow_terrain: bool({
    default: true,
    description: "Place on the first terrain; y becomes an offset above it.",
  }),
  align_to_ground: f32({
    default: 0,
    min: 0,
    max: 1,
    step: 0.05,
    description: "Tilt toward the ground normal (needs follow_terrain).",
  }),
  max_distance: f32({
    default: 600,
    min: 1,
    step: 10,
    unit: "m",
    group: "Culling",
  }),
  lod_bias: f32({
    default: 1,
    min: 0.1,
    max: 8,
    step: 0.1,
    group: "Culling",
    description: "Above 1 keeps detail further away.",
  }),
  cast_shadows: bool({ default: true, group: "Culling" }),
  alpha_cutout: bool({
    group: "Surface",
    description: "Discard texels whose alpha is under the cutoff (foliage).",
  }),
  alpha_cutoff: f32({
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
    group: "Surface",
  }),
  double_sided: bool({ group: "Surface" }),
  revision: u32({
    hidden: true,
    description: "Edit counter: ties the scene to the placements' contents.",
  }),
}, {
  icon: "tree",
  category: "World",
  description:
    "Instances of one mesh at placements from an asset, with GPU culling and detail levels.",
});

/** The large-world set, kept apart like the 2D set: `{ ...standard.componentsWorld }`. */
export const componentsWorld: Record<string, RecordDef> = { terrain, scatter };

/** The 2D set, kept apart so 3D schemas that spread `components` do not carry
 * it: `{ ...standard.components2d }` or pick `standard.sprite` and friends. */
export const components2d: Record<string, RecordDef> = {
  sprite,
  tilemap,
  light2d,
  text,
};

/** Resources of the standard components: spread into `resources` to use
 * physics. */
export const resources: Record<string, RecordDef> = { ...physicsResources };

export { body, character, collider };

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

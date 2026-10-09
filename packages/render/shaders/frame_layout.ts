/**
 * The per-frame uniform block, declared once: the WGSL `Frame` struct and the
 * float offsets TypeScript writes at are generated from the same list. Add a
 * field here (keep vec4 granularity) and both sides see it.
 */
export const MAX_LIGHTS = 4096;
export const CLUSTER_CAPACITY = 64;
export const CLUSTER_SLICES = 24;
export const CLUSTER_TILE = 64;
export const CLUSTER_MAX_AXIS = 32;
/** Cascades of the sun shadow. */
export const MAX_CASCADES = 4;
export const MAX_SUN_SHADOWS = 4;
/** Local-light shadow matrices the view reserves room for. */
export const MAX_SHADOW_MATRICES = 256;
export const LIGHT_FLOATS = 16;

type Field = [name: string, wgsl: string, floats: number, doc: string];

const FIELDS: Field[] = [
  ["viewProj", "mat4x4f", 16, ""],
  ["invViewProj", "mat4x4f", 16, ""],
  ["view", "mat4x4f", 16, "world to view space, for clustered light culling"],
  ["clusterGrid", "vec4f", 4, "x/y/z cluster counts; w 1 when enabled"],
  ["clusterDepth", "vec4f", 4, "near, far, log(far/near), reserved"],
  ["temporal", "vec4f", 4, "x temporal sampling enabled"],
  [
    "cascades",
    `array<mat4x4f, ${MAX_CASCADES * MAX_SUN_SHADOWS}>`,
    16 * MAX_CASCADES * MAX_SUN_SHADOWS,
    "world to sun-shadow clip space per cascade (orthographic)",
  ],
  [
    "cascadeSplits",
    "vec4f",
    4,
    "far view depth of each cascade",
  ],
  [
    "debug",
    "vec4f",
    4,
    "x debug view: 0 none, 1 cascades, 2 ao, 3 shadow atlas",
  ],
  ["cameraPos", "vec4f", 4, "w: 1 for orthographic"],
  ["cameraDir", "vec4f", 4, "xyz: the direction the camera looks"],
  ["gi", "vec4f", 4, "x baked indirect strength"],
  ["sky", "vec4f", 4, "rgb hemisphere ambient, sky side (linear radiance)"],
  ["ground", "vec4f", 4, "rgb hemisphere ambient, ground side"],
  [
    "params",
    "vec4f",
    4,
    "x unlit (0 lit, 1 unlit), y light count, z sun shadow on, w sun shadow texel (world units)",
  ],
  [
    "viewport",
    "vec4f",
    4,
    "width, height (device px), dpr, quality (0 low, 1 high)",
  ],
  [
    "shadow",
    "vec4f",
    4,
    "x sun map size (px), y cascade count, z filter taps, w blocker search taps",
  ],
  [
    "envInfo",
    "vec4f",
    4,
    "x ambient strength, y ao strength, z sky kind (0 procedural, 1 gradient, 2 flat), w sky intensity",
  ],
  ["skyZenith", "vec4f", 4, "linear radiance, intensity applied"],
  ["skyHorizon", "vec4f", 4, ""],
  ["skyGround", "vec4f", 4, ""],
  ["clouds", "vec4f", 4, "coverage, height km, scale km, wind offset km"],
  ["fog", "vec4f", 4, "rgb linear colour, w density"],
  [
    "fogParams",
    "vec4f",
    4,
    "x height, y falloff, z distance used for sky fog, w 1 when the colour follows the sky",
  ],
  [
    "time",
    "vec4f",
    4,
    "x seconds, y frame index, z ao radius (m), w shadow distance (m)",
  ],
  [
    "systems",
    "vec4f",
    4,
    "set by systems: x sun shadow bound, y ao texture bound, z environment cubes bound, w spot/point shadows bound",
  ],
  [
    "sunDir",
    "vec4f",
    4,
    "environment light: xyz towards the sun (first directional light), w 1 when there is one",
  ],
  [
    "sunColor",
    "vec4f",
    4,
    "environment light: sun radiance before the atmosphere (colour x intensity)",
  ],
  [
    "sunTrans",
    "vec4f",
    4,
    "environment light: atmospheric transmittance from the eye to the sun",
  ],
  [
    "sunLight",
    "vec4f",
    4,
    "environment light: the sun as it lights the scene (after extinction), for fog in-scattering",
  ],
  [
    "skyInfo",
    "vec4f",
    4,
    "environment light: x specular cube mips, y fog lod of the environment cube, z sky view steps",
  ],
  [
    "sh",
    "array<vec4f, 9>",
    36,
    "environment light: diffuse irradiance / pi as L2 SH, copied in by the GPU",
  ],
];

/** Float offset of every field of the frame uniform. */
export const FRAME: Record<string, number> = {};
let offset = 0;
for (const [name, , floats] of FIELDS) {
  FRAME[name] = offset;
  offset += floats;
}
export const FRAME_FLOATS = offset;

export const frameStruct = `struct Frame {
${
  FIELDS.map(([name, type, , doc]) =>
    `  ${name}: ${type},${doc ? ` // ${doc}` : ""}`
  ).join("\n")
}
}`;

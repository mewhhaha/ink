/**
 * Generates the example's procedural textures (assets/textures/*.png) and its
 * level (scenes/main.scene.json). Run from the repository root:
 *
 *   deno run -A examples/hammer/scripts/generate.ts
 */
import { encodePng } from "@ink/render";

const root = new URL("..", import.meta.url).pathname;

// ---- textures ----------------------------------------------------------------

const SIZE = 128;
type Rgb = [number, number, number];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Value noise on a wrapping lattice, so textures tile. */
function noise(seed: number, cells: number) {
  const random = rng(seed);
  const lattice = Array.from({ length: cells * cells }, () => random());
  return (x: number, y: number) => {
    const fx = (x / SIZE) * cells, fy = (y / SIZE) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const at = (i: number, j: number) =>
      lattice[
        (((j % cells) + cells) % cells) * cells +
        (((i % cells) + cells) % cells)
      ];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) +
      (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
  };
}

const mix = (
  a: Rgb,
  b: Rgb,
  t: number,
): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const shade = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

async function texture(name: string, pixel: (x: number, y: number) => Rgb) {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * SIZE + x) * 4;
      rgba[i] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[i + 3] = 255;
    }
  }
  await Deno.writeFile(
    `${root}assets/textures/${name}.png`,
    await encodePng(SIZE, SIZE, rgba),
  );
}

await Deno.mkdir(`${root}assets/textures`, { recursive: true });

{
  const grain = noise(11, 16), blotch = noise(12, 4);
  const rows = 8, brickW = 32;
  const rowH = SIZE / rows;
  await texture("brick", (x, y) => {
    const row = Math.floor(y / rowH);
    const shift = row % 2 ? brickW / 2 : 0;
    const bx = (x + shift) % brickW, by = y % rowH;
    const brick = Math.floor((x + shift) / brickW) + row * 7;
    const mortar = bx < 2 || by < 2;
    if (mortar) return shade([150, 142, 130], 0.85 + grain(x, y) * 0.3);
    const tint = rng(brick * 2654435761)();
    const base = mix([140, 62, 44], [172, 84, 58], tint);
    return shade(base, 0.8 + grain(x, y) * 0.3 + (blotch(x, y) - 0.5) * 0.25);
  });
}
{
  const grain = noise(21, 32);
  await texture("tile", (x, y) => {
    const tile = 32;
    const edge = x % tile < 1.5 || y % tile < 1.5;
    const checker = (Math.floor(x / tile) + Math.floor(y / tile)) % 2;
    const base: Rgb = checker ? [92, 98, 108] : [112, 118, 128];
    return shade(edge ? [48, 52, 58] : base, 0.9 + grain(x, y) * 0.2);
  });
}
{
  const grain = noise(31, 32), blotch = noise(32, 6);
  await texture(
    "concrete",
    (x, y) =>
      shade(
        [128, 128, 124],
        0.78 + grain(x, y) * 0.22 + (blotch(x, y) - 0.5) * 0.3,
      ),
  );
}
{
  const grain = noise(41, 64);
  await texture("metal", (x, y) => {
    const stripe = (x + y) % 32 < 16;
    const hazard = y > SIZE - 24 || y < 10;
    const plate = shade([70, 94, 112], 0.85 + grain(x, y) * 0.25);
    const rivet = (x % 32 - 16) ** 2 + (y % 64 - 32) ** 2 < 9;
    if (hazard) return stripe ? [232, 184, 40] : [38, 38, 40];
    if (rivet) return [150, 165, 175];
    return x % 32 < 1 ? shade(plate, 0.6) : plate;
  });
}
{
  const grain = noise(51, 32);
  await texture("panel", (x, y) => {
    const inset = x > 8 && x < SIZE - 8 && y > 8 && y < SIZE - 8;
    return shade(inset ? [70, 72, 80] : [48, 50, 56], 0.9 + grain(x, y) * 0.2);
  });
}

// ---- level ---------------------------------------------------------------------

type Vec3 = [number, number, number];
type Rgba = [number, number, number, number];
const T = (name: string) => `textures/${name}.png`;

interface Entity {
  id: number;
  name: string;
  components: Record<string, unknown>;
}
const entities: Entity[] = [];
const ids = new Map<string, number>();
let nextId = 1;
function add(name: string, components: Record<string, unknown>): number {
  const id = nextId++;
  entities.push({ id, name, components });
  ids.set(name, id);
  return id;
}

const transform = (
  position: Vec3,
  scale: Vec3 = [1, 1, 1],
  rotation = [0, 0, 0, 1],
) => ({ position, rotation, scale });

/** The six faces of a box centred on the origin. The planes are local. */
function boxFaces(
  size: Vec3,
  textures: { side: string; top?: string; bottom?: string },
) {
  const [hx, hy, hz] = size.map((v) => v / 2);
  const face = (plane: Rgba, texture: string) => ({
    plane,
    texture,
    color: [1, 1, 1, 1],
    offset: [0, 0],
    scale: [1, 1],
    rotation: 0,
  });
  return [
    face([1, 0, 0, hx], textures.side),
    face([-1, 0, 0, hx], textures.side),
    face([0, 1, 0, hy], textures.top ?? textures.side),
    face([0, -1, 0, hy], textures.bottom ?? textures.side),
    face([0, 0, 1, hz], textures.side),
    face([0, 0, -1, hz], textures.side),
  ];
}

/** A brush entity spanning min..max, centred on its transform. */
function block(
  name: string,
  min: Vec3,
  max: Vec3,
  textures: { side: string; top?: string; bottom?: string },
  extra: Record<string, unknown> = {},
) {
  const size = [0, 1, 2].map((i) => max[i] - min[i]) as Vec3;
  const center = [0, 1, 2].map((i) => (min[i] + max[i]) / 2) as Vec3;
  return add(name, {
    transform: transform(center),
    brush: { faces: boxFaces(size, textures) },
    ...extra,
  });
}

const brick = { side: T("brick") };
const concrete = { side: T("concrete") };
const tile = { side: T("tile") };

// Three rooms along -Z, each 10 wide. Wall slabs are 1 thick.
const W = 5; // half-width of a room
// Floors and ceilings.
block("floor1", [-6, -0.5, -6], [6, 0, 6], tile);
block("floor2", [-6, -0.5, -16], [6, 0, -6], tile);
block("floor3", [-6, -0.5, -27], [6, 0, -16], tile);
block("ceiling1", [-6, 4, -6], [6, 4.5, 6], concrete);
block("ceiling2", [-6, 4, -16], [6, 4.5, -6], concrete);
block("ceiling3", [-6, 4, -27], [6, 4.5, -16], concrete);
// Outer walls.
block("wall_west", [-6, 0, -27], [-W, 4, 6], brick);
block("wall_east", [W, 0, -27], [6, 4, 6], brick);
block("wall_south", [-W, 0, 5], [W, 4, 6], brick);
block("wall_north", [-W, 0, -27], [W, 4, -26], brick);
// Dividing walls with a 3 m doorway (x -1.5..1.5, up to 3 m).
for (const [label, z0, z1] of [["12", -6, -5], ["23", -16, -15]] as const) {
  block(`wall${label}_left`, [-W, 0, z0], [-1.5, 4, z1], brick);
  block(`wall${label}_right`, [1.5, 0, z0], [W, 4, z1], brick);
  block(`lintel${label}`, [-1.5, 3, z0], [1.5, 4, z1], concrete);
}
// Pillars in room 2, to walk around.
block("pillar_a", [-3.5, 0, -11.5], [-2.5, 4, -10.5], concrete);
block("pillar_b", [2.5, 0, -11.5], [3.5, 4, -10.5], concrete);

// Doors slide into the wall beside them.
const door = (name: string, z: number, slide: number) =>
  block(name, [-1.5, 0, z - 0.25], [1.5, 3, z + 0.25], { side: T("metal") }, {
    door: { offset: [slide, 0, 0], speed: 2.5 },
    outputs: { connections: [] },
  });
door("door1", -5.5, 3.2);
door("door2", -15.5, -3.2);

const lamp = (name: string, position: Vec3, on: boolean, range = 12) =>
  add(name, {
    transform: transform(position, [0.35, 0.12, 0.35]),
    mesh: {
      shape: "builtin:cylinder",
      color: [1, 0.95, 0.8, 1],
      emissive: [1, 0.9, 0.65, 1],
      emissive_strength: 6,
      cast_shadows: false,
    },
    light: {
      kind: "point",
      color: [1, 0.9, 0.72, 1],
      intensity: 6,
      range,
      shadows: true,
      softness: 1,
    },
    lamp: { on, brightness: 6 },
    outputs: { connections: [] },
  });
lamp("lamp1", [0, 3.8, 0], true, 14);
lamp("lamp2", [-2.5, 3.8, -9], false);
lamp("lamp3", [2.5, 3.8, -13], false);
lamp("lamp4", [0, 3.8, -21], false, 14);

const pushButton = (name: string, position: Vec3, scale: Vec3) =>
  add(name, {
    transform: transform(position, scale),
    mesh: {
      shape: "builtin:cube",
      texture: T("panel"),
      color: [1, 1, 1, 1],
      emissive: [0.9, 0.15, 0.1, 1],
    },
    push_button: {},
    outputs: { connections: [] },
  });
pushButton("button1", [3.5, 1.4, -4.9], [0.5, 0.5, 0.2]);
pushButton("button2", [4.9, 1.4, -9], [0.2, 0.5, 0.5]);

const zone = (name: string, position: Vec3, size: Vec3) =>
  add(name, {
    transform: transform(position),
    brush: { faces: boxFaces(size, { side: "" }), visible: false },
    trigger_zone: {},
    outputs: { connections: [] },
  });
zone("plate", [0, 1.5, -7.5], [8, 3, 2]);
zone("exit", [0, 1.5, -22], [6, 3, 6]);

add("relay1", {
  transform: transform([2, 1.0, -9], [0.3, 0.3, 0.3]),
  mesh: {
    shape: "builtin:cube",
    color: [0.5, 0.7, 1, 1],
    emissive: [0.2, 0.4, 0.9, 1],
    cast_shadows: false,
  },
  relay: {},
  outputs: { connections: [] },
  marker: {},
});
add("counter1", {
  transform: transform([2, 1.0, -13], [0.3, 0.3, 0.3]),
  mesh: {
    shape: "builtin:cube",
    color: [0.9, 0.6, 1, 1],
    emissive: [0.6, 0.3, 0.9, 1],
    cast_shadows: false,
  },
  counter: { max: 2 },
  outputs: { connections: [] },
  marker: {},
});

add("player_start", {
  transform: transform([0, 1.6, 3.5], [0.4, 0.4, 0.4]),
  mesh: {
    shape: "builtin:cone",
    color: [0.3, 0.7, 1, 1],
    emissive: [0.1, 0.3, 0.6, 1],
    cast_shadows: false,
  },
  camera: { fov: 75, near: 0.05, far: 200, active: true },
  player: {},
  marker: {},
});

// ---- wiring -----------------------------------------------------------------------

type Event =
  | "on_pressed"
  | "on_start_touch"
  | "on_end_touch"
  | "on_opened"
  | "on_closed"
  | "on_trigger"
  | "on_hit_max";
type Input =
  | "open"
  | "close"
  | "toggle"
  | "turn_on"
  | "turn_off"
  | "trigger"
  | "increment"
  | "reset"
  | "enable"
  | "disable"
  | "end_level";

function wire(
  source: string,
  event: Event,
  target: string,
  input: Input,
  delay = 0,
  once = false,
) {
  const entity = entities.find((e) => e.name === source)!;
  const outputs = entity.components.outputs as { connections: unknown[] };
  outputs.connections.push({
    event,
    target: ids.get(target)!,
    input,
    delay,
    once,
    fired: false,
  });
}

// Press the first button, then the way on opens half a second later.
wire("button1", "on_pressed", "door1", "open", 0.5);
wire("button1", "on_pressed", "lamp2", "turn_on", 1);
// Stepping onto the plate lights the pillar room and counts once.
wire("plate", "on_start_touch", "lamp2", "turn_on", 0, true);
wire("plate", "on_start_touch", "lamp3", "turn_on", 0.4, true);
wire("plate", "on_start_touch", "counter1", "increment", 0, true);
// The second button goes through a relay that counts and lights the exit.
wire("button2", "on_pressed", "relay1", "trigger");
wire("relay1", "on_trigger", "counter1", "increment");
wire("relay1", "on_trigger", "lamp4", "turn_on", 1);
// When both have happened the exit door opens.
wire("counter1", "on_hit_max", "door2", "open", 0.5);
// Reaching the exit ends the level.
wire("exit", "on_start_touch", "exit", "end_level");

// Interiors with no sky: a dim flat ambient so unlit rooms read as dark,
// occlusion in the corners, and bloom so the lamps glow when they come on.
add("environment", {
  environment: {
    sky: "flat",
    sky_color: [0.07, 0.08, 0.1, 1],
    ambient: 0.35,
    ambient_occlusion: 1.3,
    ao_radius: 0.8,
    bloom: 0.08,
    tonemap: "agx",
    exposure: 0.4,
    vignette: 0.3,
  },
});

const scene = {
  ink: 1,
  seed: 20260,
  nextEntity: nextId,
  entities: entities.map((e) => ({
    id: e.id,
    name: e.name,
    components: e.components,
  })),
  resources: {},
};
await Deno.writeTextFile(
  `${root}scenes/main.scene.json`,
  JSON.stringify(scene, null, 2) + "\n",
);
console.log(`wrote ${entities.length} entities and textures`);

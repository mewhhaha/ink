/**
 * Generates scenes/main.scene.json: a small starter level made of brushes.
 *   deno run -A examples/trenchbroom/scripts/level.ts
 * Edit the generated scene in the editor; rerun this only to start over.
 */
import { newBrushComponents } from "../../../packages/brushes/edit.ts";

type V = [number, number, number];
type Texture = string | { top?: string; bottom?: string; side?: string };

interface Entity {
  id: number;
  name: string;
  components: Record<string, unknown>;
}

const entities: Entity[] = [];
const add = (name: string, components: Record<string, unknown>) => {
  entities.push({ id: entities.length + 1, name, components });
};

const BRICK = "textures/brick.png";
const CONCRETE = "textures/concrete.png";
const METAL = "textures/metal.png";
const TILES = "textures/tiles.png";
const WOOD = "textures/wood.png";
const DOOR = "textures/door.png";

// Faces of a box brush: +X, -X, +Y, -Y, +Z, -Z.
function box(
  name: string,
  min: V,
  max: V,
  texture: Texture,
  extra: Record<string, unknown> = {},
  color?: [number, number, number, number],
) {
  const t = typeof texture === "string"
    ? { top: texture, bottom: texture, side: texture }
    : texture;
  const side = t.side ?? t.top ?? t.bottom;
  const components = newBrushComponents(min, max, { extra, color }) as {
    brush: { faces: { texture: string }[] };
  };
  const faces = components.brush.faces;
  faces[0].texture =
    faces[1].texture =
    faces[4].texture =
    faces[5].texture =
      side!;
  faces[2].texture = (t.top ?? side)!;
  faces[3].texture = (t.bottom ?? side)!;
  add(name, components);
}

interface Opening {
  from: number;
  to: number;
  height: number;
}

/** A wall along X (fixed z..z+thickness) with openings, as solid pieces and lintels. */
function wallX(
  name: string,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  height: number,
  texture: Texture,
  openings: Opening[] = [],
) {
  const sorted = [...openings].sort((a, b) => a.from - b.from);
  let cursor = x0;
  let n = 0;
  for (const o of sorted) {
    if (o.from > cursor) {
      box(`${name} ${++n}`, [cursor, 0, z0], [o.from, height, z1], texture);
    }
    if (o.height < height) {
      box(
        `${name} lintel ${++n}`,
        [o.from, o.height, z0],
        [o.to, height, z1],
        texture,
      );
    }
    cursor = o.to;
  }
  if (cursor < x1) {
    box(`${name} ${++n}`, [cursor, 0, z0], [x1, height, z1], texture);
  }
}

/** A wall along Z. */
function wallZ(
  name: string,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  height: number,
  texture: Texture,
  openings: Opening[] = [],
) {
  const sorted = [...openings].sort((a, b) => a.from - b.from);
  let cursor = z0;
  let n = 0;
  for (const o of sorted) {
    if (o.from > cursor) {
      box(`${name} ${++n}`, [x0, 0, cursor], [x1, height, o.from], texture);
    }
    if (o.height < height) {
      box(
        `${name} lintel ${++n}`,
        [x0, o.height, o.from],
        [x1, height, o.to],
        texture,
      );
    }
    cursor = o.to;
  }
  if (cursor < z1) {
    box(`${name} ${++n}`, [x0, 0, cursor], [x1, height, z1], texture);
  }
}

// ---- Room A: the start room -------------------------------------------------
box("Floor A", [-6.5, -0.5, -6.5], [6.5, 0, 6.5], {
  top: TILES,
  side: CONCRETE,
  bottom: CONCRETE,
});
wallX("Wall A north", -6.5, 6.5, -6.5, -6, 4, BRICK, [{
  from: -1.5,
  to: 1.5,
  height: 3.5,
}]);
wallX("Wall A south", -6.5, 6.5, 6, 6.5, 4, BRICK);
wallZ("Wall A west", -6.5, -6, -6, 6, 4, BRICK);
wallZ("Wall A east", 6, 6.5, -6, 6, 4, BRICK);
box("Pillar A", [3, 0, -3.5], [4, 4, -2.5], CONCRETE);
box("Bench A", [-5.5, 0, 0.5], [-4, 0.6, 3], WOOD);

// ---- Corridor ----------------------------------------------------------------
box("Floor corridor", [-2, -0.5, -14.5], [2, 0, -6], METAL);
box("Ceiling corridor", [-2, 3.5, -14.5], [2, 4, -6], CONCRETE);
wallZ("Wall corridor west", -2, -1.5, -14.5, -6, 3.5, METAL);
wallZ("Wall corridor east", 1.5, 2, -14.5, -6, 3.5, METAL);
box("Door", [-1.5, 0, -10.25], [1.5, 3.5, -9.75], DOOR, {
  door: { slide: [0, 3.4, 0], reach: 4, speed: 2.5 },
});

// ---- Hall ---------------------------------------------------------------------
const HALL_H = 6;
box("Floor hall", [-9.5, -0.5, -28.5], [9.5, 0, -14], {
  top: TILES,
  side: CONCRETE,
  bottom: CONCRETE,
});
wallX("Wall hall south", -9.5, 9.5, -14.5, -14, HALL_H, BRICK, [{
  from: -1.5,
  to: 1.5,
  height: 3.5,
}]);
wallX("Wall hall north", -9.5, 9.5, -28.5, -28, HALL_H, BRICK);
wallZ("Wall hall west", -9.5, -9, -28, -14.5, HALL_H, BRICK);
wallZ("Wall hall east", 9, 9.5, -28, -14.5, HALL_H, BRICK, [{
  from: -27,
  to: -24.5,
  height: 3.5,
}]);
box("Pillar hall west", [-3.5, 0, -21.5], [-2.5, HALL_H, -20.5], CONCRETE);
box("Pillar hall east", [2.5, 0, -21.5], [3.5, HALL_H, -20.5], CONCRETE);
box("Acid", [-2, 0, -26], [2, 0.6, -23], CONCRETE, { hazard: { dps: 18 } }, [
  0.35,
  1,
  0.3,
  1,
]);

// West balcony reached by a ramp.
box("Balcony", [-9, 0, -28], [-4, 2.5, -20], {
  top: WOOD,
  side: BRICK,
  bottom: BRICK,
});
{
  const rise = 2.5, zs = -15, ze = -20, x0 = -9, x1 = -6;
  const length = Math.hypot(zs - ze, rise);
  const n: V = [0, (zs - ze) / length, rise / length];
  const components = newBrushComponents([x0, 0, ze], [x1, rise, zs], {
    texture: METAL,
  }) as {
    transform: { position: V };
    brush: { faces: { plane: number[] }[] };
  };
  const c = components.transform.position;
  const d = (rise * zs) / length - (n[1] * c[1] + n[2] * c[2]);
  components.brush.faces[2].plane = [n[0], n[1], n[2], d];
  add("Ramp", components);
}
box("Balcony rail", [-9, 2.5, -20.25], [-6, 3.2, -20], METAL);

// East stairs up to a landing.
for (let i = 0; i < 8; i++) {
  box(`Stair ${i + 1}`, [5, 0, -16.5 - 0.5 * i], [
    9,
    0.3 * (i + 1),
    -16 - 0.5 * i,
  ], { top: WOOD, side: CONCRETE });
}
box("Landing", [5, 0, -24], [9, 2.4, -19.5], { top: WOOD, side: BRICK });

// ---- Side room ------------------------------------------------------------------
box("Floor side room", [9, -0.5, -28], [19.5, 0, -16.5], {
  top: METAL,
  side: CONCRETE,
  bottom: CONCRETE,
});
wallX("Wall side room north", 9.5, 19.5, -28, -27.5, 4, BRICK);
wallX("Wall side room south", 9.5, 19.5, -17, -16.5, 4, BRICK);
wallZ("Wall side room east", 19, 19.5, -27.5, -17, 4, BRICK);
for (
  const [x, y, z] of [[12.5, 0, -22.5], [12.5, 0, -21.5], [12.5, 0, -20.5], [
    12.5,
    1,
    -21.5,
  ], [13.5, 0, -22]] as V[]
) {
  box("Crate", [x - 0.5, y, z - 0.5], [x + 0.5, y + 1, z + 0.5], WOOD, {
    breakable: { health: 2 },
  });
}

// ---- Lights ----------------------------------------------------------------------
const q = [-0.408218, 0.23457, 0.109382, 0.875426];
add("Sun", {
  transform: { position: [0, 12, 0], rotation: q, scale: [1, 1, 1] },
  light: {
    kind: "directional",
    color: [0.8, 0.88, 1, 1],
    intensity: 0.9,
    shadows: true,
  },
});
const lamp = (
  name: string,
  at: V,
  color: [number, number, number, number],
  intensity: number,
  range: number,
  shadows = false,
) =>
  add(name, {
    transform: { position: at, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    light: { kind: "point", color, intensity, range, shadows, softness: 1.5 },
  });
lamp("Light start room", [0, 3.4, 0], [1, 0.82, 0.6, 1], 7, 12, true);
lamp("Light corridor", [0, 3.1, -8.5], [0.7, 0.85, 1, 1], 5, 8);
lamp("Light hall west", [-4, 5, -19], [1, 0.85, 0.65, 1], 9, 15, true);
lamp("Light hall east", [5, 5, -24], [1, 0.85, 0.65, 1], 9, 15, true);
lamp("Light acid", [0, 2, -24.5], [0.4, 1, 0.4, 1], 4, 6);
lamp("Light side room", [14.5, 3.4, -22], [1, 0.7, 0.45, 1], 8, 11, true);

// Indoors: a dim sky, ambient occlusion, a little bloom on the acid glow.
add("Environment", {
  environment: {
    sky: "procedural",
    ambient: 0.45,
    ambient_occlusion: 1.2,
    ao_radius: 0.7,
    bloom: 0.06,
    tonemap: "agx",
    exposure: 0.3,
    vignette: 0.25,
    shadow_distance: 50,
  },
});

// ---- Points ----------------------------------------------------------------------
const pickup = (
  name: string,
  kind: "health" | "ammo",
  at: V,
  amount: number,
) => {
  const health = kind === "health";
  add(name, {
    transform: {
      position: at,
      rotation: [0, 0, 0, 1],
      scale: health ? [0.45, 0.45, 0.45] : [0.35, 0.5, 0.35],
    },
    mesh: {
      shape: health ? "builtin:cube" : "builtin:cylinder",
      color: health ? [0.95, 0.2, 0.2, 1] : [0.95, 0.78, 0.2, 1],
      emissive: health ? [0.45, 0.04, 0.04, 1] : [0.4, 0.3, 0.02, 1],
      roughness: 0.4,
      metallic: health ? 0 : 0.8,
      cast_shadows: false,
    },
    pickup: { kind, amount, radius: 1 },
  });
};
pickup("Ammo start room", "ammo", [-4.8, 1, -5], 8);
pickup("Health hall", "health", [0, 1, -18], 25);
pickup("Ammo landing", "ammo", [7, 3.4, -22], 12);
pickup("Health balcony", "health", [-6.5, 3.5, -25], 50);
pickup("Ammo behind acid", "ammo", [0, 1, -27.2], 8);
pickup("Health side room", "health", [17.5, 1, -26], 25);
pickup("Ammo side room", "ammo", [17.5, 1, -18.5], 10);

add("info_player_start", {
  transform: {
    position: [0, 0.45, 3.5],
    rotation: [0, 0, 0, 1],
    scale: [0.6, 1, 0.6],
  },
  mesh: {
    shape: "builtin:cone",
    color: [0.3, 0.9, 0.45, 1],
    roughness: 0.5,
    cast_shadows: false,
  },
  player: { speed: 7, jump: 7.5, gravity: 24, yaw: 0 },
});
add("fps_camera", {
  transform: {
    position: [0, 1.65, 3.5],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  },
  camera: { fov: 78, near: 0.05, far: 200, active: true },
  first_person: { eye: 1.2, bob: 0.035 },
});

const scene = {
  ink: 1,
  seed: 4242,
  entities,
  resources: {
    stats: { health: 100, ammo: 12, found: 0, total: 0, broken: 0 },
  },
};
await Deno.writeTextFile(
  new URL("../scenes/main.scene.json", import.meta.url),
  JSON.stringify(scene, null, 2) + "\n",
);
console.log(`${entities.length} entities`);

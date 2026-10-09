/**
 * Draws the game's original pixel art: a ground tileset with sixteen
 * auto-tiling variants, scenery, a hero, coins, slimes, a flag and torches,
 * plus matching normal maps for 2D lighting. Nothing here is borrowed; the
 * images and atlas files are plain outputs.
 *
 *   deno run -A examples/tiles/scripts/art.ts
 */
import { encodePng } from "@ink/render";

type Rgba = [number, number, number, number];

class Canvas {
  data: Uint8Array;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8Array(width * height * 4);
  }
  set(x: number, y: number, c: Rgba) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data.set(c, (y * this.width + x) * 4);
  }
  get(x: number, y: number): Rgba {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return [0, 0, 0, 0];
    }
    const o = (y * this.width + x) * 4;
    return [this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3]];
  }
  rect(x: number, y: number, w: number, h: number, c: Rgba) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
    }
  }
  /** Copy `source` into this canvas at (x, y). */
  blit(source: Canvas, x: number, y: number) {
    for (let j = 0; j < source.height; j++) {
      for (let i = 0; i < source.width; i++) {
        this.set(x + i, y + j, source.get(i, j));
      }
    }
  }
}

const rgb = (r: number, g: number, b: number, a = 255): Rgba => [r, g, b, a];
const clear: Rgba = [0, 0, 0, 0];

/** Deterministic noise in 0..1. */
function hash(x: number, y: number, seed = 0): number {
  let h = Math.imul(x + 374761393, 668265263) ^
    Math.imul(y + 1274126177, 2246822519) ^
    Math.imul(seed + 1, 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const shade = (c: Rgba, k: number): Rgba => [
  Math.max(0, Math.min(255, Math.round(c[0] * k))),
  Math.max(0, Math.min(255, Math.round(c[1] * k))),
  Math.max(0, Math.min(255, Math.round(c[2] * k))),
  c[3],
];

// Tiles -------------------------------------------------------------------------

const DIRT = rgb(121, 82, 52);
const DIRT_DARK = rgb(88, 58, 40);
const DIRT_LIGHT = rgb(150, 104, 66);
const GRASS = rgb(92, 170, 66);
const GRASS_LIGHT = rgb(148, 214, 88);
const GRASS_DARK = rgb(56, 124, 56);
const OUTLINE = rgb(52, 34, 30);

/** One ground tile. `mask` bits say which neighbours are ground: N=1, E=2,
 * S=4, W=8. Open sides get a rim, an open top gets grass, and two open
 * sides that meet round off their corner. */
function groundTile(
  mask: number,
  seed: number,
): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const open = {
    n: !(mask & 1),
    e: !(mask & 2),
    s: !(mask & 4),
    w: !(mask & 8),
  };
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const n = hash(x, y, seed);
      let c = n < 0.12 ? DIRT_DARK : n > 0.9 ? DIRT_LIGHT : DIRT;
      // Pebbles.
      if (hash(x >> 1, y >> 1, seed + 9) > 0.93) c = shade(DIRT_LIGHT, 1.1);
      let h = 0.4 + (n - 0.5) * 0.25;
      const rim = 2;
      if (open.w && x < rim) {
        c = x === 0 ? OUTLINE : shade(DIRT_DARK, 0.9);
        h = 0.15 + x * 0.1;
      }
      if (open.e && x >= 16 - rim) {
        c = x === 15 ? OUTLINE : shade(DIRT_DARK, 0.9);
        h = 0.15 + (15 - x) * 0.1;
      }
      if (open.s && y >= 16 - rim) {
        c = y === 15 ? OUTLINE : shade(DIRT_DARK, 0.85);
        h = 0.15 + (15 - y) * 0.1;
      }
      if (open.n) {
        const lip = 4 + Math.floor(hash(x, 0, seed + 3) * 3);
        if (y < lip) {
          c = y === 0
            ? GRASS_LIGHT
            : y < 2
            ? GRASS
            : hash(x, y, seed + 5) > 0.7
            ? GRASS_DARK
            : GRASS;
          h = 0.55 + (y < 2 ? 0.1 : 0);
        } else if (y === lip) {
          c = GRASS_DARK;
        }
        if (y === 0 && !open.w && !open.e) c = GRASS_LIGHT;
      }
      t.set(x, y, c);
      height[y * 16 + x] = h;
    }
  }
  // Round off corners where two open sides meet.
  const corner = (cx: number, cy: number, sx: number, sy: number) => {
    const cut = [[0, 0], [1, 0], [0, 1]];
    for (const [dx, dy] of cut) {
      t.set(cx + dx * sx, cy + dy * sy, clear);
    }
    t.set(cx + 2 * sx, cy, t.get(cx + 2 * sx, cy)[3] ? OUTLINE : clear);
    t.set(cx, cy + 2 * sy, t.get(cx, cy + 2 * sy)[3] ? OUTLINE : clear);
    t.set(cx + sx, cy + sy, t.get(cx + sx, cy + sy)[3] ? OUTLINE : clear);
  };
  if (open.n && open.w) corner(0, 0, 1, 1);
  if (open.n && open.e) corner(15, 0, -1, 1);
  if (open.s && open.w) corner(0, 15, 1, -1);
  if (open.s && open.e) corner(15, 15, -1, -1);
  return { art: t, height };
}

function plankTile(): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const wood = rgb(176, 124, 62),
    light = rgb(214, 160, 84),
    dark = rgb(112, 74, 40);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 16; x++) {
      let c = y === 0 ? light : y === 5 ? dark : wood;
      if (y > 0 && y < 5 && hash(x, y, 77) > 0.86) c = shade(wood, 0.88);
      if (y === 5 || x === 0 || x === 15) c = OUTLINE;
      if (y === 0 && (x === 0 || x === 15)) c = OUTLINE;
      t.set(x, y, c);
      height[y * 16 + x] = y === 0 ? 0.8 : y < 5 ? 0.6 : 0.3;
    }
  }
  for (const x of [3, 12]) t.set(x, 2, dark);
  for (const x of [3, 12]) t.set(x, 3, light);
  return { art: t, height };
}

function ladderTile(): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const rail = rgb(150, 104, 58), rung = rgb(196, 144, 76);
  for (let y = 0; y < 16; y++) {
    for (const x of [3, 12]) {
      t.set(x, y, OUTLINE);
      t.set(x + 1, y, rail);
      t.set(x - 1, y, rail);
      height[y * 16 + x] = 0.7;
    }
    if (y % 5 === 2) {
      for (let x = 4; x < 12; x++) {
        t.set(x, y, rung);
        t.set(x, y + 1, OUTLINE);
        height[y * 16 + x] = 0.6;
      }
    }
  }
  return { art: t, height };
}

function spikeTile(): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const steel = rgb(190, 196, 214),
    shine = rgb(240, 244, 255),
    dark = rgb(96, 100, 126);
  for (let k = 0; k < 4; k++) {
    const x0 = k * 4;
    for (let y = 6; y < 16; y++) {
      const half = Math.floor((y - 6) / 3) + 1;
      const cx = x0 + 2;
      for (
        let x = cx - Math.ceil(half / 2);
        x < cx + Math.ceil(half / 2);
        x++
      ) {
        t.set(
          x,
          y,
          x === cx - Math.ceil(half / 2)
            ? shine
            : x === cx + Math.ceil(half / 2) - 1
            ? dark
            : steel,
        );
        height[y * 16 + x] = 0.3 + (y - 6) * 0.05;
      }
    }
    t.set(x0 + 1, 6, shine);
    t.set(x0 + 2, 5, shine);
  }
  t.rect(0, 15, 16, 1, OUTLINE);
  return { art: t, height };
}

function brickTile(): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const brick = rgb(184, 84, 66),
    mortar = rgb(120, 70, 66),
    light = rgb(214, 116, 88);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const row = Math.floor(y / 4);
      const offset = row % 2 ? 4 : 0;
      const seam = y % 4 === 3 || (x + offset) % 8 === 7;
      let c = seam ? mortar : (y % 4 === 0 ? light : brick);
      if (!seam && hash(x, y, 31) > 0.9) c = shade(brick, 0.9);
      t.set(x, y, c);
      height[y * 16 + x] = seam ? 0.2 : 0.65;
    }
  }
  return { art: t, height };
}

function stoneTile(): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const n = hash(x >> 1, y >> 1, 5);
      let c = n > 0.66
        ? rgb(166, 170, 184)
        : n > 0.33
        ? rgb(138, 142, 160)
        : rgb(118, 122, 142);
      if (x === 0 || y === 0) c = rgb(190, 194, 208);
      if (x === 15 || y === 15) c = rgb(84, 88, 108);
      t.set(x, y, c);
      height[y * 16 + x] = 0.4 + n * 0.3 - (x === 15 || y === 15 ? 0.2 : 0);
    }
  }
  for (let i = 0; i < 6; i++) {
    t.set(5 + i, 5 + Math.floor(i / 2), rgb(84, 88, 108));
  }
  return { art: t, height };
}

function crateTile(): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const wood = rgb(190, 138, 70),
    dark = rgb(116, 76, 42),
    light = rgb(224, 174, 98);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const border = x < 2 || y < 2 || x > 13 || y > 13;
      const diagonal = Math.abs(x - y) < 2 || Math.abs(x + y - 15) < 2;
      let c = border ? dark : diagonal ? shade(wood, 0.92) : wood;
      if (border && (x === 0 || y === 0)) c = OUTLINE;
      if (border && (x === 15 || y === 15)) c = OUTLINE;
      if (!border && !diagonal && hash(x, y, 8) > 0.85) c = light;
      t.set(x, y, c);
      height[y * 16 + x] = border ? 0.75 : diagonal ? 0.6 : 0.45;
    }
  }
  return { art: t, height };
}

function bushTile(): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const dist = (x: number, y: number, cx: number, cy: number) =>
    Math.hypot(x - cx, (y - cy) * 1.1);
  for (let y = 6; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const inside = Math.min(
        dist(x, y, 4, 11) - 5,
        dist(x, y, 10, 10) - 6,
        dist(x, y, 13, 12.5) - 3.5,
      );
      if (inside < 0) {
        const edge = inside > -1.2;
        const c = edge ? GRASS_DARK : hash(x, y, 4) > 0.8 ? GRASS_LIGHT : GRASS;
        t.set(x, y, y < 8 && !edge ? GRASS_LIGHT : c);
        height[y * 16 + x] = 0.5 - inside * 0.05;
      }
    }
  }
  return { art: t, height };
}

function flowerTile(): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const stems: [number, number, Rgba][] = [
    [3, 9, rgb(240, 90, 120)],
    [8, 7, rgb(255, 214, 80)],
    [12, 10, rgb(150, 130, 255)],
  ];
  for (const [x, top, petal] of stems) {
    for (let y = top + 1; y < 16; y++) {
      t.set(x, y, GRASS);
      height[y * 16 + x] = 0.4;
    }
    t.set(x - 1, 13, GRASS_DARK);
    t.set(x + 1, 12, GRASS_DARK);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      t.set(x + dx, top + dy, petal);
      height[(top + dy) * 16 + x + dx] = 0.6;
    }
    t.set(x, top, rgb(255, 244, 200));
    height[top * 16 + x] = 0.7;
  }
  return { art: t, height };
}

function cloudTile(
  part: "l" | "m" | "r",
): { art: Canvas; height: Float32Array } {
  const t = new Canvas(16, 16);
  const height = new Float32Array(256);
  const white = rgb(250, 252, 255), shadow = rgb(206, 224, 244);
  for (let y = 4; y < 14; y++) {
    for (let x = 0; x < 16; x++) {
      const gx = part === "l" ? x : part === "m" ? x + 16 : x + 32;
      const top = 8 -
        Math.round(3 * Math.sin((gx / 47) * Math.PI) + 2 * Math.sin(gx * 0.55));
      const bottom = 13 -
        (part === "l"
          ? Math.max(0, 3 - x)
          : part === "r"
          ? Math.max(0, x - 12)
          : 0);
      if (y >= top && y <= bottom) {
        t.set(x, y, y >= bottom - 1 ? shadow : white);
        height[y * 16 + x] = 0.5;
      }
    }
  }
  return { art: t, height };
}

// Sprites -----------------------------------------------------------------------

const SKIN = rgb(247, 206, 160);

const PALETTE: Record<string, Rgba> = {
  ".": clear,
  K: rgb(34, 28, 44),
  R: rgb(222, 64, 64),
  r: rgb(150, 40, 50),
  S: SKIN,
  s: rgb(214, 160, 120),
  B: rgb(64, 120, 226),
  b: rgb(40, 76, 170),
  W: rgb(240, 244, 250),
  P: rgb(86, 72, 130),
  G: rgb(132, 80, 44),
  Y: rgb(252, 214, 64),
  y: rgb(214, 150, 30),
  O: rgb(255, 150, 40),
  L: rgb(110, 218, 92),
  l: rgb(58, 160, 70),
  D: rgb(36, 108, 56),
  E: rgb(30, 26, 40),
  M: rgb(200, 204, 220),
  m: rgb(130, 134, 156),
  T: rgb(142, 96, 58),
};

/** Paint rows of palette letters into a 16x16 canvas, `dy` rows down. */
function sprite(rows: string[], dy = 0): Canvas {
  const c = new Canvas(16, 16);
  rows.forEach((row, y) => {
    if (row.length !== 16) {
      throw new Error(`row ${y} is ${row.length} wide: ${row}`);
    }
    [...row].forEach((letter, x) => {
      const colour = PALETTE[letter];
      if (!colour) throw new Error(`unknown colour ${letter}`);
      c.set(x, y + dy, colour);
    });
  });
  return c;
}

const HEAD = [
  "................",
  "................",
  "......KKKKK.....",
  ".....KRRRRRK....",
  "....KRRRRRRRK...",
  "....KRRRRRrrK...",
  "....KKKSSSSSK...",
  "....KSSSESESK...",
  "....KSSSSSSSK...",
  ".....KSSsSSK....",
];

const BODY_STAND = [
  "....KKBBBBBKK...",
  "...KSKBBWBBKSK..",
  "...KSKBBBBBKSK..",
  "....KKPPKPPKK...",
  ".....KPPKPPK....",
  ".....KGGKGGK....",
];

const BODY_RUN: string[][] = [
  [
    "....KKBBBBBKK...",
    "...KSKBBWBBKSK..",
    "...KSKBBBBBKSK..",
    "....KKPPPPKK....",
    "...KPPKKKKPPK...",
    "...KGGK..KGGK...",
  ],
  [
    "...KKKBBBBBKK...",
    "....KBBBWBBKK...",
    "....KBBBBBBK....",
    ".....KPPPPK.....",
    ".....KPPPPK.....",
    ".....KGGGGK.....",
  ],
  [
    "....KKBBBBBKK...",
    "...KSKBBWBBKSK..",
    "...KSKBBBBBKSK..",
    "....KKPPPPKK....",
    "...KPPK..KPPK...",
    "..KGGK....KGGK..",
  ],
  [
    "...KKKBBBBBKK...",
    "....KBBBWBBKK...",
    "....KBBBBBBK....",
    ".....KPPPPK.....",
    "....KPPKKPPK....",
    "....KGGK.KGGK...",
  ],
];

const BODY_JUMP = [
  "..KSKKBBBBBKKSK.",
  "..KSKBBBWBBBKSK.",
  "...KKBBBBBBBKK..",
  "....KKPPPPKK....",
  "...KPPKKKKPPK...",
  "...KGGK..KGGK...",
];

const BODY_FALL = [
  "...KKKBBBBBKKK..",
  "..KSSKBBWBBKSSK.",
  "..KKKKBBBBBKKKK.",
  "....KKPPKPPKK...",
  "....KPPK.KPPK...",
  "....KGGK.KGGK...",
];

function hero(body: string[], bob = 0): Canvas {
  const rows = [...HEAD, ...body];
  // Bobbing drops the whole figure by a pixel; the feet stay on the ground.
  return sprite(rows.slice(0, 16), bob);
}

function coin(width: number): Canvas {
  const c = new Canvas(16, 16);
  const gold = rgb(252, 214, 64),
    rim = rgb(184, 118, 24),
    shine = rgb(255, 246, 170);
  const half = width / 2;
  for (let y = 3; y < 13; y++) {
    const dy = (y - 7.5) / 5;
    const span = Math.sqrt(Math.max(0, 1 - dy * dy)) * half;
    for (let x = 0; x < 16; x++) {
      const dx = Math.abs(x + 0.5 - 8);
      if (dx > span) continue;
      const edge = dx > span - 1;
      c.set(x, y, edge ? rim : y < 6 && dx < span * 0.6 ? shine : gold);
    }
  }
  if (width >= 7) {
    c.rect(8, 6, 1, 4, rim);
  }
  return c;
}

function slime(frame: number): Canvas {
  const c = new Canvas(16, 16);
  const heights = [8, 7, 6, 7];
  const widths = [12, 13, 14, 13];
  const h = heights[frame], w = widths[frame];
  const body = PALETTE.L, dark = PALETTE.l, rim = PALETTE.D;
  for (let y = 0; y < h; y++) {
    const yy = 15 - y;
    const t = y / h;
    const span = Math.round(
      (w / 2) *
        Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, t - 0.25) / 0.75, 2.2))),
    );
    for (let x = 8 - span; x < 8 + span; x++) {
      const edge = x === 8 - span || x === 8 + span - 1 || y === h - 1;
      c.set(
        x,
        yy,
        edge ? rim : y < 2 ? dark : y > h - 4 && x < 9 ? PALETTE.L : body,
      );
    }
  }
  const eyeY = 15 - Math.max(3, h - 4);
  for (const x of [5, 9]) {
    c.rect(x, eyeY, 2, 3, PALETTE.W);
    c.set(x + 1, eyeY + 1, PALETTE.E);
    c.set(x + 1, eyeY + 2, PALETTE.E);
  }
  c.rect(7, eyeY + 4, 2, 1, rim);
  return c;
}

function flag(frame: number): Canvas {
  const c = new Canvas(16, 16);
  for (let y = 1; y < 16; y++) c.set(4, y, PALETTE.M);
  c.set(4, 1, PALETTE.Y);
  c.set(3, 1, PALETTE.y);
  c.set(5, 1, PALETTE.y);
  c.rect(2, 14, 6, 2, PALETTE.m);
  const wave = frame ? [0, 1, 1, 0, -1, -1] : [0, 0, 1, 1, 0, -1];
  for (let x = 0; x < 9; x++) {
    const taper = Math.floor((x * 2) / 4);
    for (let y = 2 + taper; y < 8 - taper; y++) {
      const yy = y +
        (wave[Math.min(5, Math.floor(x / 2) + (x > 5 ? 1 : 0))] ?? 0);
      c.set(
        5 + x,
        yy,
        y === 2 + taper || y === 7 - taper ? PALETTE.r : PALETTE.R,
      );
    }
  }
  return c;
}

function torch(frame: number): Canvas {
  const c = new Canvas(16, 16);
  c.rect(7, 8, 2, 7, PALETTE.T);
  c.rect(6, 7, 4, 2, PALETTE.G);
  c.rect(6, 14, 4, 1, PALETTE.K);
  const flame: string[][] = [
    [
      "...O...",
      "..OYO..",
      ".OYYYO.",
      ".OYWYO.",
      "..OYO..",
    ],
    [
      "..O.O..",
      "..OYO..",
      ".OYYYO.",
      ".OYWYO.",
      "..OYO..",
    ],
  ];
  flame[frame].forEach((row, y) => {
    [...row].forEach((letter, x) => {
      if (letter !== ".") c.set(4 + x, 2 + y, PALETTE[letter]);
    });
  });
  return c;
}

function checkpointHeart(): Canvas {
  return sprite([
    "................",
    "................",
    "................",
    "...KKK...KKK....",
    "..KRRRK.KRRRK...",
    ".KRWRRRKRRRRRK..",
    ".KRRRRRRRRRRRK..",
    ".KRRRRRRRRRRRK..",
    "..KRRRRRRRRRK...",
    "...KRRRRRRRK....",
    "....KRRRRRK.....",
    ".....KRRRK......",
    "......KRK.......",
    ".......K........",
    "................",
    "................",
  ]);
}

// Normal maps ---------------------------------------------------------------------

/** Tangent-space normals (OpenGL, +Y up) from a height field in 0..1; fully
 * transparent pixels are flat. Returns RGBA with alpha 255. */
function normals(height: Float32Array, art: Canvas, strength: number): Canvas {
  const w = art.width, h = art.height;
  const n = new Canvas(w, h);
  const at = (x: number, y: number) =>
    height[
      Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))
    ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Image y points down, so the height slope toward +y is toward -up.
      const nx = -dx, ny = dy, nz = 1;
      const length = Math.hypot(nx, ny, nz);
      n.set(x, y, [
        Math.round((nx / length * 0.5 + 0.5) * 255),
        Math.round((ny / length * 0.5 + 0.5) * 255),
        Math.round((nz / length * 0.5 + 0.5) * 255),
        255,
      ]);
    }
  }
  return n;
}

/** A soft height from the sprite's silhouette, so characters read as round. */
function roundHeight(art: Canvas): Float32Array {
  let field = new Float32Array(art.width * art.height);
  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      field[y * art.width + x] = art.get(x, y)[3] ? 1 : 0;
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(field.length);
    for (let y = 0; y < art.height; y++) {
      for (let x = 0; x < art.width; x++) {
        let sum = 0, count = 0;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const xx = x + i, yy = y + j;
            if (xx < 0 || yy < 0 || xx >= art.width || yy >= art.height) {
              continue;
            }
            sum += field[yy * art.width + xx];
            count++;
          }
        }
        next[y * art.width + x] = sum / count;
      }
    }
    field = next;
  }
  return field;
}

// Sheets and atlas files -----------------------------------------------------------

interface Cell {
  name: string;
  art: Canvas;
  height?: Float32Array;
}

function sheet(cells: Cell[], columns: number, rows: number, strength: number) {
  const art = new Canvas(columns * 16, rows * 16);
  const heights = new Canvas(columns * 16, rows * 16);
  const normalSheet = new Canvas(columns * 16, rows * 16);
  cells.forEach((cell, i) => {
    const x = (i % columns) * 16, y = Math.floor(i / columns) * 16;
    art.blit(cell.art, x, y);
    const h = cell.height ?? roundHeight(cell.art);
    heights.blit(normals(h, cell.art, strength), x, y);
  });
  normalSheet.blit(heights, 0, 0);
  return { art, normals: normalSheet };
}

async function write(path: string, canvas: Canvas) {
  await Deno.writeFile(
    path,
    (await encodePng(canvas.width, canvas.height, canvas.data)) as Uint8Array,
  );
  console.log(`wrote ${path}`);
}

const root = new URL("../assets/", import.meta.url).pathname;
await Deno.mkdir(root, { recursive: true });

// The tileset: sixteen ground variants by neighbour mask, then the rest.
const tileCells: Cell[] = [];
for (let mask = 0; mask < 16; mask++) {
  const { art, height } = groundTile(mask, 3 + (mask & 3));
  tileCells.push({ name: `ground_${mask}`, art, height });
}
const extras: [string, { art: Canvas; height: Float32Array }][] = [
  ["platform", plankTile()],
  ["ladder", ladderTile()],
  ["spikes", spikeTile()],
  ["brick", brickTile()],
  ["stone", stoneTile()],
  ["crate", crateTile()],
  ["bush", bushTile()],
  ["flowers", flowerTile()],
  ["cloud_left", cloudTile("l")],
  ["cloud_mid", cloudTile("m")],
  ["cloud_right", cloudTile("r")],
];
for (const [name, tile] of extras) tileCells.push({ name, ...tile });
const tiles = sheet(tileCells, 8, 4, 2.2);
await write(`${root}tiles.png`, tiles.art);
await write(`${root}tiles_n.png`, tiles.normals);
const names: Record<string, number> = {};
tileCells.forEach((cell, i) => (names[cell.name] = i));
await Deno.writeTextFile(
  `${root}tiles.atlas.json`,
  JSON.stringify(
    {
      ink: 1,
      image: "tiles.png",
      normals: "tiles_n.png",
      grid: { cell: [16, 16], columns: 8, rows: 4 },
      names,
      tiles: {
        ...Object.fromEntries(
          Array.from({ length: 16 }, (_, m) => [`ground_${m}`, ["solid"]]),
        ),
        platform: ["oneway"],
        ladder: ["ladder"],
        spikes: ["hazard"],
        brick: ["solid"],
        stone: ["solid"],
        crate: ["solid"],
      },
      autotile: {
        ground: {
          connects: Array.from({ length: 16 }, (_, m) => `ground_${m}`),
          tiles: Array.from({ length: 16 }, (_, m) => `ground_${m}`),
        },
      },
    },
    null,
    2,
  ) + "\n",
);

// Sprites.
const spriteCells: Cell[] = [
  { name: "hero_idle_0", art: hero(BODY_STAND) },
  { name: "hero_idle_1", art: hero(BODY_STAND, 0) },
  ...BODY_RUN.map((body, i) => ({
    name: `hero_run_${i}`,
    art: hero(body, 0),
  })),
  { name: "hero_jump", art: hero(BODY_JUMP) },
  { name: "hero_fall", art: hero(BODY_FALL) },
  ...[10, 7, 3, 7].map((w, i) => ({ name: `coin_${i}`, art: coin(w) })),
  ...[0, 1, 2, 3].map((i) => ({ name: `slime_${i}`, art: slime(i) })),
  { name: "flag_0", art: flag(0) },
  { name: "flag_1", art: flag(1) },
  { name: "torch_0", art: torch(0) },
  { name: "torch_1", art: torch(1) },
  { name: "heart", art: checkpointHeart() },
];
// The second idle frame breathes: everything above the legs sinks a pixel.
{
  const idle1 = new Canvas(16, 16);
  const base = spriteCells[0].art;
  for (let y = 0; y < 13; y++) {
    for (let x = 0; x < 16; x++) idle1.set(x, y + 1, base.get(x, y));
  }
  for (let y = 14; y < 16; y++) {
    for (let x = 0; x < 16; x++) idle1.set(x, y, base.get(x, y));
  }
  spriteCells[1].art = idle1;
}
const sprites = sheet(spriteCells, 8, 3, 3);
await write(`${root}sprites.png`, sprites.art);
await write(`${root}sprites_n.png`, sprites.normals);
const spriteNames: Record<string, number> = {};
spriteCells.forEach((cell, i) => (spriteNames[cell.name] = i));
await Deno.writeTextFile(
  `${root}sprites.atlas.json`,
  JSON.stringify(
    {
      ink: 1,
      image: "sprites.png",
      normals: "sprites_n.png",
      grid: { cell: [16, 16], columns: 8, rows: 3 },
      names: spriteNames,
      animations: {
        hero_idle: { frames: ["hero_idle_0", "hero_idle_1"], fps: 2 },
        hero_run: {
          frames: ["hero_run_0", "hero_run_1", "hero_run_2", "hero_run_3"],
          fps: 11,
        },
        hero_jump: { frames: ["hero_jump"], fps: 1 },
        hero_fall: { frames: ["hero_fall"], fps: 1 },
        coin_spin: {
          frames: ["coin_0", "coin_1", "coin_2", "coin_3"],
          fps: 8,
        },
        slime_walk: {
          frames: ["slime_0", "slime_1", "slime_2", "slime_3"],
          fps: 6,
        },
        flag_wave: { frames: ["flag_0", "flag_1"], fps: 3 },
        torch_flicker: { frames: ["torch_0", "torch_1"], fps: 7 },
      },
    },
    null,
    2,
  ) + "\n",
);

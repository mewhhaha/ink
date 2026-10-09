/**
 * Tileable ground textures for the four terrain layers: grass, rock, dirt and
 * sand. Each layer writes
 *
 *   <name>.png      albedo (sRGB)
 *   <name>_n.png    tangent-space normal, +Y up; alpha is the blend height
 *   <name>_orm.png  occlusion (R), roughness (G), metallic = 0 (B)
 *
 * into assets/terrain/. Everything wraps at the tile edge and derives from
 * fixed seeds, so a run reproduces the same bytes.
 *
 *   deno run -A examples/terrain/scripts/textures.ts [--size 512]
 */
import { noise } from "@ink/geometry";
import { encode } from "fast-png";
import { clamp, mix, rng, smoothstep } from "./world.ts";

export const TEXTURE_SIZE = 512;
export const TEXTURE_NAMES = ["grass", "rock", "dirt", "sand"] as const;

type Rgb = [number, number, number];

/** A square tile of float planes with wrapping access. */
class Tile {
  readonly height: Float32Array;
  readonly color: Float32Array;
  /** Cavity occlusion, 1 = open. */
  readonly ao: Float32Array;
  readonly roughness: Float32Array;

  constructor(readonly size: number) {
    this.height = new Float32Array(size * size);
    this.color = new Float32Array(size * size * 3);
    this.ao = new Float32Array(size * size).fill(1);
    this.roughness = new Float32Array(size * size).fill(0.8);
  }

  /** Visit every pixel with its position in [0, 1). */
  each(fn: (i: number, u: number, v: number) => void) {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) fn(y * n + x, x / n, y / n);
    }
  }

  wrap(x: number, y: number): number {
    const n = this.size;
    return (((y % n) + n) % n) * n + (((x % n) + n) % n);
  }

  setColor(i: number, c: Rgb) {
    this.color[i * 3] = c[0];
    this.color[i * 3 + 1] = c[1];
    this.color[i * 3 + 2] = c[2];
  }

  /** Blend `c` over pixel `i` with weight `a`. */
  paint(i: number, c: Rgb, a: number) {
    const k = this.color;
    k[i * 3] = mix(k[i * 3], c[0], a);
    k[i * 3 + 1] = mix(k[i * 3 + 1], c[1], a);
    k[i * 3 + 2] = mix(k[i * 3 + 2], c[2], a);
  }
}

// Seamless noise ------------------------------------------------------------------

/** Fractal gradient noise that wraps over `cells` lattice cells per tile. */
const fbmTile = (
  u: number,
  v: number,
  cells: number,
  octaves: number,
  seed: number,
) =>
  noise.fbm2(noise.perlin2, u * cells, v * cells, {
    seed,
    period: cells,
    octaves,
  });

const rigeTile = (
  u: number,
  v: number,
  cells: number,
  octaves: number,
  seed: number,
) => noise.ridged2(u * cells, v * cells, { seed, period: cells, octaves });

const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];

const rgb = (r: number, g: number, b: number): Rgb => [r, g, b];

/** A soft disc: 1 in the middle, 0 at `radius`. */
const dome = (d: number, radius: number) => {
  const t = clamp(1 - d / radius);
  return Math.sqrt(1 - (1 - t) * (1 - t));
};

// Grass ----------------------------------------------------------------------------

function grass(n: number): Tile {
  const tile = new Tile(n);
  const random = rng(101);
  // Soil and thatch between the blades.
  tile.each((i, u, v) => {
    const a = fbmTile(u, v, 6, 4, 11) * 0.5 + 0.5;
    const b = fbmTile(u, v, 24, 3, 12) * 0.5 + 0.5;
    tile.setColor(
      i,
      lerpRgb(rgb(38, 44, 22), rgb(74, 70, 34), a * 0.7 + b * 0.3),
    );
    tile.height[i] = 0.12 + 0.08 * b;
    tile.ao[i] = 0.5;
  });
  const dark = rgb(34, 78, 22),
    mid = rgb(70, 124, 36),
    light = rgb(138, 174, 58);
  const dry = rgb(158, 150, 70);
  // Blades, shortest first so the tall ones lie on top.
  const blades = Math.round(n * n * 0.23);
  const list = Array.from({ length: blades }, () => ({
    x: random() * n,
    y: random() * n,
    angle: random() * Math.PI * 2,
    length: 7 + random() * random() * 30 * (n / 512),
    bend: (random() - 0.5) * 0.7,
    tall: random(),
    tone: random(),
    dry: random() < 0.12,
    width: 0.7 + random() * 0.8,
  })).sort((a, b) => a.tall - b.tall);
  for (const blade of list) {
    const steps = Math.ceil(blade.length * 2);
    const dx = Math.cos(blade.angle), dy = Math.sin(blade.angle);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const along = blade.length * t;
      const sideways = blade.bend * blade.length * t * t;
      const px = blade.x + dx * along - dy * sideways;
      const py = blade.y + dy * along + dx * sideways;
      // Rooted dark, lighter at the tip, with a per-blade tone.
      const base = lerpRgb(
        lerpRgb(dark, mid, blade.tone),
        blade.dry ? dry : light,
        t * (0.55 + 0.4 * blade.tone),
      );
      const taper = blade.width * (1 - 0.7 * t);
      const reach = Math.ceil(taper + 1);
      for (let oy = -reach; oy <= reach; oy++) {
        for (let ox = -reach; ox <= reach; ox++) {
          const cx = Math.round(px) + ox, cy = Math.round(py) + oy;
          const d = Math.hypot(cx - px, cy - py);
          const cover = clamp(taper - d + 0.6);
          if (cover <= 0) continue;
          const i = tile.wrap(cx, cy);
          const h = 0.25 + 0.75 * blade.tall * (0.4 + 0.6 * t);
          if (h + 0.02 < tile.height[i]) continue;
          tile.paint(i, base, cover * 0.95);
          tile.height[i] = Math.max(tile.height[i], h * cover);
          tile.ao[i] = mix(tile.ao[i], 0.55 + 0.45 * t, cover);
        }
      }
    }
  }
  // Large soft patches of colour so the tile does not read as a lattice.
  tile.each((i, u, v) => {
    const patch = fbmTile(u, v, 3, 3, 13);
    const tone = 1 + 0.16 * patch;
    for (let c = 0; c < 3; c++) tile.color[i * 3 + c] *= tone;
    tile.roughness[i] = 0.82 + 0.12 * fbmTile(u, v, 16, 2, 14);
  });
  return tile;
}

// Rock -----------------------------------------------------------------------------

function rock(n: number): Tile {
  const tile = new Tile(n);
  const dark = rgb(54, 50, 48), stone = rgb(118, 113, 106);
  const warm = rgb(150, 122, 92), pale = rgb(176, 172, 162);
  const cold = rgb(96, 102, 108);
  const bands = 9;
  tile.each((i, u, v) => {
    // Strata: ledges bent by low noise, each layer with its own tint.
    const bend = 0.04 * fbmTile(u, v, 3, 3, 21);
    const y = (v + bend) * bands;
    const index = ((Math.floor(y) % bands) + bands) % bands;
    const along = y - Math.floor(y);
    const tint = noise.hash2(index, 3, 5) / 4294967296;
    const tint2 = noise.hash2(index, 9, 6) / 4294967296;
    const grain = fbmTile(u, v, 64, 3, 23) * 0.5 + 0.5;
    const body = fbmTile(u, v, 8, 4, 24) * 0.5 + 0.5;
    const blotch = fbmTile(u, v, 5, 3, 28) * 0.5 + 0.5;
    // A ledge catches light on top and shades under its lip.
    const ledge = 0.72 + 0.5 * Math.pow(1 - along, 1.6) -
      0.16 * smoothstep(0.8, 1, along);
    // Joints and fissures; chipped blocks between them.
    const wob = fbmTile(u, v, 5, 3, 22);
    const w = noise.worley2(u * 5 + 0.02 * wob, v * 5, { seed: 25, period: 5 });
    const joint = 1 - smoothstep(0.0, 0.05 + 0.04 * (wob + 1), w.f2 - w.f1);
    const fissure = smoothstep(0.88, 0.97, rigeTile(u, v, 4, 3, 27));
    const crack = clamp(joint * 0.55 + fissure * 0.9);
    let c = lerpRgb(
      lerpRgb(stone, warm, tint),
      lerpRgb(cold, pale, tint2),
      0.5,
    );
    c = lerpRgb(c, warm, smoothstep(0.55, 0.8, blotch) * 0.45);
    c = lerpRgb(c, pale, smoothstep(0.55, 0.9, body) * 0.35);
    c = lerpRgb(c, dark, clamp(0.55 * (0.5 - body) + 0.3 * (0.5 - grain)));
    c = lerpRgb(c, dark, crack * 0.8);
    const k = ledge * (0.88 + 0.24 * grain);
    tile.setColor(i, [c[0] * k, c[1] * k, c[2] * k]);
    // Height: stepped ledges, blocky bulges, grain; cracks cut deep.
    tile.height[i] = clamp(
      0.5 + 0.22 * (1 - along) + 0.2 * (body - 0.5) + 0.1 * (grain - 0.5) +
        0.12 * (tint - 0.5) - 0.45 * crack,
    );
    tile.ao[i] = clamp(1 - 0.7 * crack - 0.35 * smoothstep(0.75, 1, along));
    tile.roughness[i] = 0.78 + 0.16 * grain - 0.1 * crack;
  });
  return tile;
}

// Dirt and gravel -------------------------------------------------------------------

function dirt(n: number): Tile {
  const tile = new Tile(n);
  const random = rng(303);
  const soilDark = rgb(72, 54, 38), soilLight = rgb(140, 108, 76);
  const soilPale = rgb(166, 140, 106);
  tile.each((i, u, v) => {
    // Crumbs of soil: cells with domed centres, over broad dry and damp areas.
    const crumb = noise.worley2(u * 26, v * 26, { seed: 31, period: 26 });
    const lump = 1 - smoothstep(0, 0.75, crumb.f1);
    const clod = fbmTile(u, v, 7, 4, 32) * 0.5 + 0.5;
    const fine = fbmTile(u, v, 90, 2, 33) * 0.5 + 0.5;
    const t = clamp(0.2 + 0.6 * clod + 0.22 * (fine - 0.5) + 0.2 * lump);
    tile.setColor(
      i,
      lerpRgb(
        lerpRgb(soilDark, soilLight, t),
        soilPale,
        smoothstep(0.7, 1, t) * 0.5,
      ),
    );
    tile.height[i] = 0.3 + 0.12 * clod + 0.14 * lump + 0.06 * (fine - 0.5);
    tile.ao[i] = 0.7 + 0.3 * lump;
    tile.roughness[i] = 0.92;
  });
  // Gravel: small wrapped stones, muted so they sit in the soil, each domed
  // and darker towards its rim.
  const tones: Rgb[] = [
    rgb(138, 130, 118),
    rgb(160, 144, 118),
    rgb(112, 106, 100),
    rgb(150, 112, 88),
    rgb(176, 170, 156),
  ];
  const pebbles = Array.from({ length: Math.round(n * n / 110) }, () => ({
    x: random() * n,
    y: random() * n,
    radius: 1.6 + Math.pow(random(), 2.4) * 6.5 * (n / 512),
    squash: 0.65 + random() * 0.35,
    turn: random() * Math.PI,
    tone: tones[Math.floor(random() * tones.length)],
    shade: 0.8 + random() * 0.3,
  })).sort((a, b) => b.radius - a.radius);
  for (const p of pebbles) {
    const reach = Math.ceil(p.radius + 1);
    const cs = Math.cos(p.turn), sn = Math.sin(p.turn);
    for (let oy = -reach; oy <= reach; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        const cx = Math.round(p.x) + ox, cy = Math.round(p.y) + oy;
        const rx = cx - p.x, ry = cy - p.y;
        const lx = rx * cs + ry * sn, ly = (-rx * sn + ry * cs) / p.squash;
        const d = Math.hypot(lx, ly);
        if (d >= p.radius) continue;
        const i = tile.wrap(cx, cy);
        const round = dome(d, p.radius);
        const h = 0.55 + 0.4 * round * Math.min(1, p.radius / 5 + 0.3);
        const edge = smoothstep(p.radius, p.radius * 0.75, d);
        const lit = 0.78 + 0.3 * round +
          0.08 * clamp(0.5 - (lx + ly) / (2 * p.radius));
        const speckle = 0.9 + 0.2 * (noise.hash2(cx, cy, 9) / 4294967296);
        const k = p.shade * lit * speckle;
        tile.paint(
          i,
          [p.tone[0] * k, p.tone[1] * k, p.tone[2] * k],
          edge * 0.96,
        );
        tile.height[i] = mix(tile.height[i], h, edge);
        tile.ao[i] = mix(tile.ao[i], 0.5 + 0.5 * round, edge);
        tile.roughness[i] = mix(tile.roughness[i], 0.74, edge);
      }
    }
  }
  return tile;
}

// Sand -----------------------------------------------------------------------------

function sand(n: number): Tile {
  const tile = new Tile(n);
  const damp = rgb(168, 146, 104), dry = rgb(222, 200, 152);
  const shade = rgb(188, 160, 112);
  tile.each((i, u, v) => {
    // Wind ripples: wavy bands, merging and splitting with a slow warp.
    const warp = 0.05 * fbmTile(u, v, 4, 3, 41);
    const drift = fbmTile(u, v, 8, 3, 42);
    const phase = 2 * Math.PI * (22 * (v + warp + 0.012 * drift) + 6 * u);
    // An asymmetric profile: a gentle windward slope, a sharper lee.
    const s = Math.sin(phase);
    const ripple = 0.5 + 0.5 * (s + 0.25 * Math.sin(2 * phase + 1));
    const grain = noise.hash2(i % n, (i / n) | 0, 51) / 4294967296;
    const clump = fbmTile(u, v, 12, 3, 43) * 0.5 + 0.5;
    const wet = clamp(0.5 + 0.9 * fbmTile(u, v, 3, 3, 44));
    let c = lerpRgb(dry, shade, clamp(1 - ripple) * 0.45 + 0.2 * (1 - clump));
    c = lerpRgb(c, damp, wet * 0.5);
    const speck = 0.93 + 0.14 * grain;
    tile.setColor(i, [c[0] * speck, c[1] * speck, c[2] * speck]);
    tile.height[i] = clamp(0.28 + 0.14 * ripple + 0.05 * (clump - 0.5));
    tile.ao[i] = 0.82 + 0.18 * ripple;
    tile.roughness[i] = 0.9 - 0.18 * wet + 0.05 * grain;
  });
  return tile;
}

// Encoding ---------------------------------------------------------------------------

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Strength of the normal map: slope per unit of normalised height. */
const BUMP = { grass: 3, rock: 5, dirt: 4, sand: 3 };

export function encodeTile(
  name: (typeof TEXTURE_NAMES)[number],
  tile: Tile,
): Record<string, Uint8Array> {
  const n = tile.size;
  const albedo = new Uint8Array(n * n * 4);
  const normal = new Uint8Array(n * n * 4);
  const orm = new Uint8Array(n * n * 4);
  const h = tile.height;
  const strength = BUMP[name] * (n / 512);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x, o = i * 4;
      albedo[o] = byte(tile.color[i * 3]);
      albedo[o + 1] = byte(tile.color[i * 3 + 1]);
      albedo[o + 2] = byte(tile.color[i * 3 + 2]);
      albedo[o + 3] = 255;
      // Central differences with wrap; image rows run down, +Y runs up.
      const l = h[y * n + (x + n - 1) % n], r = h[y * n + (x + 1) % n];
      const up = h[((y + n - 1) % n) * n + x], down = h[((y + 1) % n) * n + x];
      let nx = -(r - l) * strength, ny = (down - up) * strength;
      const length = Math.hypot(nx, ny, 1);
      nx /= length;
      ny /= length;
      normal[o] = byte((nx * 0.5 + 0.5) * 255);
      normal[o + 1] = byte((ny * 0.5 + 0.5) * 255);
      normal[o + 2] = byte((1 / length * 0.5 + 0.5) * 255);
      normal[o + 3] = byte(clamp(h[i]) * 255);
      orm[o] = byte(tile.ao[i] * 255);
      orm[o + 1] = byte(tile.roughness[i] * 255);
      orm[o + 2] = 0;
      orm[o + 3] = 255;
    }
  }
  const png = (data: Uint8Array) =>
    encode({ width: n, height: n, data, channels: 4, depth: 8 });
  return {
    [`${name}.png`]: png(albedo),
    [`${name}_n.png`]: png(normal),
    [`${name}_orm.png`]: png(orm),
  };
}

const makers = { grass, rock, dirt, sand };

/** Every texture file by name, at `size` pixels per side. */
export function generateTextures(
  size = TEXTURE_SIZE,
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const name of TEXTURE_NAMES) {
    Object.assign(files, encodeTile(name, makers[name](size)));
  }
  return files;
}

export async function writeTextures(size = TEXTURE_SIZE) {
  const started = performance.now();
  const dir = new URL("../assets/terrain/", import.meta.url);
  await Deno.mkdir(dir, { recursive: true });
  let bytes = 0;
  const files = generateTextures(size);
  for (const [file, data] of Object.entries(files)) {
    await Deno.writeFile(new URL(file, dir), data);
    bytes += data.length;
  }
  console.log(
    `textures: ${Object.keys(files).length} files at ${size}px, ${
      (bytes / 1e6).toFixed(1)
    } MB, ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
}

if (import.meta.main) {
  const at = Deno.args.indexOf("--size");
  await writeTextures(at >= 0 ? Number(Deno.args[at + 1]) : TEXTURE_SIZE);
}

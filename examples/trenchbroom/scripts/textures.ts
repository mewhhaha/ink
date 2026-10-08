/**
 * Generates the seamless textures in assets/textures/*.png.
 *   deno run -A examples/trenchbroom/scripts/textures.ts
 * Every pattern wraps on both axes, so brush faces tile without seams.
 */
import { encodePng } from "@ink/render";

type Rgb = [number, number, number];
type Shader = (x: number, y: number, size: number) => Rgb;

const hash = (x: number, y: number, seed: number) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) +
    Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Value noise that wraps every `period` cells. */
const noise = (x: number, y: number, period: number, seed: number) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const w = (v: number) => ((v % period) + period) % period;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash(w(xi), w(yi), seed), b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed), d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * s(fx) + (c - a) * s(fy) +
    (a - b - c + d) * s(fx) * s(fy);
};

const fbm = (u: number, v: number, base: number, seed: number) =>
  noise(u * base, v * base, base, seed) * 0.5 +
  noise(u * base * 2, v * base * 2, base * 2, seed + 1) * 0.3 +
  noise(u * base * 4, v * base * 4, base * 4, seed + 2) * 0.2;

const mix = (
  a: Rgb,
  b: Rgb,
  t: number,
): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const mul = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];

const brick: Shader = (px, py, size) => {
  const u = px / size, v = py / size;
  const rows = 8, cols = 4;
  const row = Math.floor(v * rows);
  const shifted = u * cols + (row % 2 ? 0.5 : 0);
  const col = Math.floor(shifted);
  const fx = shifted - col, fy = v * rows - row;
  const mortar = fx < 0.06 || fx > 0.94 || fy < 0.1 || fy > 0.9;
  const w = ((col % cols) + cols) % cols;
  const tint = hash(w, row, 7);
  const grain = fbm(u, v, 8, 3);
  if (mortar) return mul([0.52, 0.5, 0.47], 0.75 + grain * 0.5);
  const base = mix([0.55, 0.22, 0.15], [0.7, 0.34, 0.22], tint);
  const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
  return mul(base, 0.8 + grain * 0.5 + Math.min(0.15, edge * 0.8));
};

const concrete: Shader = (px, py, size) => {
  const u = px / size, v = py / size;
  const n = fbm(u, v, 6, 11);
  const speck = hash(px, py, 5) > 0.97 ? 0.75 : 1;
  const base = mul([0.62, 0.63, 0.65], 0.7 + n * 0.55);
  return mul(base, speck);
};

const metal: Shader = (px, py, size) => {
  const u = px / size, v = py / size;
  const plate = 2;
  const fx = (u * plate) % 1, fy = (v * plate) % 1;
  const seam = Math.min(fx, 1 - fx, fy, 1 - fy);
  const brushed = noise(u * 2, v * 64, 64, 21) * 0.12;
  let c = mul([0.42, 0.46, 0.52], 0.85 + brushed + fbm(u, v, 4, 9) * 0.15);
  if (seam < 0.025) c = mul(c, 0.45);
  else if (seam < 0.05) c = mul(c, 1.25);
  const rivet = (cx: number, cy: number) =>
    Math.hypot(((fx - cx + 0.5) % 1) - 0.5, ((fy - cy + 0.5) % 1) - 0.5) <
      0.022;
  if (
    rivet(0.1, 0.1) || rivet(0.9, 0.1) || rivet(0.1, 0.9) || rivet(0.9, 0.9)
  ) c = mul(c, 1.5);
  return c;
};

const tiles: Shader = (px, py, size) => {
  const u = px / size, v = py / size;
  const n = 4;
  const fx = (u * n) % 1, fy = (v * n) % 1;
  const ix = Math.floor(u * n), iy = Math.floor(v * n);
  const grout = fx < 0.04 || fx > 0.96 || fy < 0.04 || fy > 0.96;
  if (grout) return [0.18, 0.19, 0.2];
  const checker = (ix + iy) % 2 === 0;
  const base: Rgb = checker ? [0.72, 0.7, 0.64] : [0.46, 0.5, 0.52];
  return mul(base, 0.88 + hash(ix, iy, 2) * 0.16 + fbm(u, v, 8, 4) * 0.12);
};

const wood: Shader = (px, py, size) => {
  const u = px / size, v = py / size;
  const planks = 4;
  const index = Math.floor(v * planks);
  const fy = (v * planks) % 1;
  const along = noise(
    u * 3 + hash(index, 0, 1) * 10,
    index * 2.3,
    3,
    5 + index,
  );
  const ring = Math.sin((fy * 5 + along * 6) * Math.PI) * 0.5 + 0.5;
  const base = mix([0.42, 0.26, 0.13], [0.6, 0.4, 0.22], hash(index, 3, 9));
  let c = mul(base, 0.75 + ring * 0.25 + fbm(u, v, 6, 17) * 0.2);
  if (fy < 0.04 || fy > 0.96) c = mul(c, 0.5);
  return c;
};

const door: Shader = (px, py, size) => {
  const u = px / size, v = py / size;
  const edge = Math.min(u, 1 - u, v, 1 - v);
  let c = mul([0.2, 0.34, 0.46], 0.85 + fbm(u, v, 4, 31) * 0.3);
  if (edge < 0.06) c = mul(c, 0.55);
  else if (edge < 0.1) c = mul(c, 1.3);
  const stripe = ((u + v) * 8) % 1;
  if (edge > 0.22 && edge < 0.4 && stripe < 0.5) {
    c = mix(c, [0.95, 0.75, 0.15], 0.85);
  }
  return c;
};

const srgb = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

const out = new URL("../assets/textures/", import.meta.url);
await Deno.mkdir(out, { recursive: true });
const list: [string, number, Shader][] = [
  ["brick", 128, brick],
  ["concrete", 64, concrete],
  ["metal", 128, metal],
  ["tiles", 128, tiles],
  ["wood", 128, wood],
  ["door", 128, door],
];
for (const [name, size, shader] of list) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = shader(x, y, size);
      const i = (y * size + x) * 4;
      data[i] = srgb(r);
      data[i + 1] = srgb(g);
      data[i + 2] = srgb(b);
      data[i + 3] = 255;
    }
  }
  const png = await encodePng(size, size, data);
  await Deno.writeFile(new URL(`${name}.png`, out), png);
  console.log(`${name}.png ${size}x${size} ${png.length} bytes`);
}

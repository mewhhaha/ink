/**
 * The built-in text font: a public 5x7 pixel font, smoothed (two EPX passes)
 * and turned into a signed distance field atlas on the CPU, so scalable,
 * outlined text needs no canvas, no font file and no native dependency, and
 * renders identically everywhere.
 *
 * Glyph rows run 0 (top) to 6 (baseline). One font pixel is 1/8 of a line.
 */

/** Five columns per character from space (32) to tilde (126); bit 0 of a
 * column is the top row. */
const COLUMNS = [
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x5f,
  0x00,
  0x00,
  0x00,
  0x07,
  0x00,
  0x07,
  0x00,
  0x14,
  0x7f,
  0x14,
  0x7f,
  0x14,
  0x24,
  0x2a,
  0x7f,
  0x2a,
  0x12,
  0x23,
  0x13,
  0x08,
  0x64,
  0x62,
  0x36,
  0x49,
  0x55,
  0x22,
  0x50,
  0x00,
  0x05,
  0x03,
  0x00,
  0x00,
  0x00,
  0x1c,
  0x22,
  0x41,
  0x00,
  0x00,
  0x41,
  0x22,
  0x1c,
  0x00,
  0x14,
  0x08,
  0x3e,
  0x08,
  0x14,
  0x08,
  0x08,
  0x3e,
  0x08,
  0x08,
  0x00,
  0x50,
  0x30,
  0x00,
  0x00,
  0x08,
  0x08,
  0x08,
  0x08,
  0x08,
  0x00,
  0x60,
  0x60,
  0x00,
  0x00,
  0x20,
  0x10,
  0x08,
  0x04,
  0x02,
  0x3e,
  0x51,
  0x49,
  0x45,
  0x3e,
  0x00,
  0x42,
  0x7f,
  0x40,
  0x00,
  0x42,
  0x61,
  0x51,
  0x49,
  0x46,
  0x21,
  0x41,
  0x45,
  0x4b,
  0x31,
  0x18,
  0x14,
  0x12,
  0x7f,
  0x10,
  0x27,
  0x45,
  0x45,
  0x45,
  0x39,
  0x3c,
  0x4a,
  0x49,
  0x49,
  0x30,
  0x01,
  0x71,
  0x09,
  0x05,
  0x03,
  0x36,
  0x49,
  0x49,
  0x49,
  0x36,
  0x06,
  0x49,
  0x49,
  0x29,
  0x1e,
  0x00,
  0x36,
  0x36,
  0x00,
  0x00,
  0x00,
  0x56,
  0x36,
  0x00,
  0x00,
  0x08,
  0x14,
  0x22,
  0x41,
  0x00,
  0x14,
  0x14,
  0x14,
  0x14,
  0x14,
  0x00,
  0x41,
  0x22,
  0x14,
  0x08,
  0x02,
  0x01,
  0x51,
  0x09,
  0x06,
  0x32,
  0x49,
  0x79,
  0x41,
  0x3e,
  0x7e,
  0x11,
  0x11,
  0x11,
  0x7e,
  0x7f,
  0x49,
  0x49,
  0x49,
  0x36,
  0x3e,
  0x41,
  0x41,
  0x41,
  0x22,
  0x7f,
  0x41,
  0x41,
  0x22,
  0x1c,
  0x7f,
  0x49,
  0x49,
  0x49,
  0x41,
  0x7f,
  0x09,
  0x09,
  0x09,
  0x01,
  0x3e,
  0x41,
  0x49,
  0x49,
  0x7a,
  0x7f,
  0x08,
  0x08,
  0x08,
  0x7f,
  0x00,
  0x41,
  0x7f,
  0x41,
  0x00,
  0x20,
  0x40,
  0x41,
  0x3f,
  0x01,
  0x7f,
  0x08,
  0x14,
  0x22,
  0x41,
  0x7f,
  0x40,
  0x40,
  0x40,
  0x40,
  0x7f,
  0x02,
  0x0c,
  0x02,
  0x7f,
  0x7f,
  0x04,
  0x08,
  0x10,
  0x7f,
  0x3e,
  0x41,
  0x41,
  0x41,
  0x3e,
  0x7f,
  0x09,
  0x09,
  0x09,
  0x06,
  0x3e,
  0x41,
  0x51,
  0x21,
  0x5e,
  0x7f,
  0x09,
  0x19,
  0x29,
  0x46,
  0x46,
  0x49,
  0x49,
  0x49,
  0x31,
  0x01,
  0x01,
  0x7f,
  0x01,
  0x01,
  0x3f,
  0x40,
  0x40,
  0x40,
  0x3f,
  0x1f,
  0x20,
  0x40,
  0x20,
  0x1f,
  0x3f,
  0x40,
  0x38,
  0x40,
  0x3f,
  0x63,
  0x14,
  0x08,
  0x14,
  0x63,
  0x07,
  0x08,
  0x70,
  0x08,
  0x07,
  0x61,
  0x51,
  0x49,
  0x45,
  0x43,
  0x00,
  0x7f,
  0x41,
  0x41,
  0x00,
  0x02,
  0x04,
  0x08,
  0x10,
  0x20,
  0x00,
  0x41,
  0x41,
  0x7f,
  0x00,
  0x04,
  0x02,
  0x01,
  0x02,
  0x04,
  0x40,
  0x40,
  0x40,
  0x40,
  0x40,
  0x00,
  0x01,
  0x02,
  0x04,
  0x00,
  0x20,
  0x54,
  0x54,
  0x54,
  0x78,
  0x7f,
  0x48,
  0x44,
  0x44,
  0x38,
  0x38,
  0x44,
  0x44,
  0x44,
  0x20,
  0x38,
  0x44,
  0x44,
  0x48,
  0x7f,
  0x38,
  0x54,
  0x54,
  0x54,
  0x18,
  0x08,
  0x7e,
  0x09,
  0x01,
  0x02,
  0x0c,
  0x52,
  0x52,
  0x52,
  0x3e,
  0x7f,
  0x08,
  0x04,
  0x04,
  0x78,
  0x00,
  0x44,
  0x7d,
  0x40,
  0x00,
  0x20,
  0x40,
  0x44,
  0x3d,
  0x00,
  0x7f,
  0x10,
  0x28,
  0x44,
  0x00,
  0x00,
  0x41,
  0x7f,
  0x40,
  0x00,
  0x7c,
  0x04,
  0x18,
  0x04,
  0x78,
  0x7c,
  0x08,
  0x04,
  0x04,
  0x78,
  0x38,
  0x44,
  0x44,
  0x44,
  0x38,
  0x7c,
  0x14,
  0x14,
  0x14,
  0x08,
  0x08,
  0x14,
  0x14,
  0x18,
  0x7c,
  0x7c,
  0x08,
  0x04,
  0x04,
  0x08,
  0x48,
  0x54,
  0x54,
  0x54,
  0x20,
  0x04,
  0x3f,
  0x44,
  0x40,
  0x20,
  0x3c,
  0x40,
  0x40,
  0x20,
  0x7c,
  0x1c,
  0x20,
  0x40,
  0x20,
  0x1c,
  0x3c,
  0x40,
  0x30,
  0x40,
  0x3c,
  0x44,
  0x28,
  0x10,
  0x28,
  0x44,
  0x0c,
  0x50,
  0x50,
  0x50,
  0x3c,
  0x44,
  0x64,
  0x54,
  0x4c,
  0x44,
  0x00,
  0x08,
  0x36,
  0x41,
  0x00,
  0x00,
  0x00,
  0x7f,
  0x00,
  0x00,
  0x00,
  0x41,
  0x36,
  0x08,
  0x00,
  0x10,
  0x08,
  0x08,
  0x10,
  0x08,
];

export const FIRST_GLYPH = 32;
export const GLYPH_COUNT = 95;
/** Font pixels per line, and per glyph advance. */
export const LINE_PIXELS = 8;
export const ADVANCE_PIXELS = 6;
const GLYPH_W = 5, GLYPH_H = 7;
/** SDF texels per font pixel, and the distance range in texels. */
const SCALE = 8;
const SPREAD = 8;
const CELL_W = (GLYPH_W + 2) * SCALE; // a font pixel of margin each side
const CELL_H = (GLYPH_H + 2) * SCALE;
const COLUMNS_PER_ROW = 10;

/** How far an outline of one font pixel reaches, in distance field units. */
export const OUTLINE_PER_PIXEL = SCALE / (2 * SPREAD);

export interface GlyphRect {
  /** Normalised rectangle in the atlas (v down). */
  u: number;
  v: number;
  w: number;
  h: number;
}

export interface FontAtlas {
  width: number;
  height: number;
  /** RGBA8; the distance is in every channel, 128 at the edge. */
  data: Uint8Array;
  glyph(char: string): GlyphRect;
  /** The glyph quad in font pixels, relative to the pen at the baseline
   * origin (x right, y down from the line top). */
  quad: { x: number; y: number; w: number; h: number };
}

function bitmapOf(code: number): Uint8Array {
  const out = new Uint8Array(GLYPH_W * GLYPH_H);
  const base = (code - FIRST_GLYPH) * 5;
  for (let x = 0; x < GLYPH_W; x++) {
    const column = COLUMNS[base + x] ?? 0;
    for (let y = 0; y < GLYPH_H; y++) {
      if (column & (1 << y)) out[y * GLYPH_W + x] = 1;
    }
  }
  return out;
}

/** EPX/Scale2x: doubles a bitmap and rounds off its diagonal steps. */
function epx(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * 2 * h * 2);
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : src[y * w + x];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = at(x, y), a = at(x, y - 1), b = at(x + 1, y);
      const c = at(x - 1, y), d = at(x, y + 1);
      let e0 = p, e1 = p, e2 = p, e3 = p;
      if (c === a && c !== d && a !== b) e0 = a;
      if (a === b && a !== c && b !== d) e1 = b;
      if (d === c && d !== b && c !== a) e2 = c;
      if (b === d && b !== a && d !== c) e3 = d;
      const o = y * 2 * w * 2 + x * 2;
      out[o] = e0;
      out[o + 1] = e1;
      out[o + w * 2] = e2;
      out[o + w * 2 + 1] = e3;
    }
  }
  return out;
}

const INF = 1e20;

/** Felzenszwalb & Huttenlocher squared distance transform of one row. */
function distance1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const slope = (p: number) =>
      (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
    let s = slope(v[k]);
    while (s <= z[k]) {
      k--;
      s = slope(v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

/** Squared distance to the nearest zero of `grid` (INF where there is none). */
function distanceField(grid: Float64Array, w: number, h: number): Float64Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  const out = new Float64Array(grid);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    distance1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    distance1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

/** Signed distance (positive inside) in texels, edge at the pixel boundary. */
export function signedDistance(
  inside: Uint8Array,
  w: number,
  h: number,
): Float64Array {
  const toInside = new Float64Array(w * h), toOutside = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    toInside[i] = inside[i] ? 0 : INF;
    toOutside[i] = inside[i] ? INF : 0;
  }
  const dIn = distanceField(toInside, w, h);
  const dOut = distanceField(toOutside, w, h);
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = inside[i]
      ? Math.sqrt(Math.min(dOut[i], INF)) - 0.5
      : -(Math.sqrt(Math.min(dIn[i], INF)) - 0.5);
  }
  return out;
}

let cached: FontAtlas | undefined;

/** The shared atlas, built on first use (a few milliseconds). */
export function fontAtlas(): FontAtlas {
  if (cached) return cached;
  const rows = Math.ceil(GLYPH_COUNT / COLUMNS_PER_ROW);
  const width = COLUMNS_PER_ROW * CELL_W, height = rows * CELL_H;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < GLYPH_COUNT; i++) {
    // Pad by one font pixel, smooth twice, then magnify to SDF resolution.
    let bits: Uint8Array = new Uint8Array((GLYPH_W + 2) * (GLYPH_H + 2));
    const src = bitmapOf(FIRST_GLYPH + i);
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        bits[(y + 1) * (GLYPH_W + 2) + x + 1] = src[y * GLYPH_W + x];
      }
    }
    let w = GLYPH_W + 2, h = GLYPH_H + 2;
    bits = epx(epx(bits, w, h), w * 2, h * 2);
    w *= 4;
    h *= 4;
    const grid = new Uint8Array(CELL_W * CELL_H);
    const zoom = CELL_W / w;
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        grid[y * CELL_W + x] = bits[
          Math.floor(y / zoom) * w +
          Math.floor(x / zoom)
        ];
      }
    }
    const sd = signedDistance(grid, CELL_W, CELL_H);
    const ox = (i % COLUMNS_PER_ROW) * CELL_W;
    const oy = Math.floor(i / COLUMNS_PER_ROW) * CELL_H;
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        const value = Math.max(
          0,
          Math.min(
            255,
            Math.round(255 * (0.5 + sd[y * CELL_W + x] / (2 * SPREAD))),
          ),
        );
        const at = ((oy + y) * width + ox + x) * 4;
        data[at] = data[at + 1] = data[at + 2] = value;
        data[at + 3] = 255;
      }
    }
  }
  cached = {
    width,
    height,
    data,
    glyph(char: string) {
      const code = char.charCodeAt(0);
      const i = code >= FIRST_GLYPH && code < FIRST_GLYPH + GLYPH_COUNT
        ? code - FIRST_GLYPH
        : "?".charCodeAt(0) - FIRST_GLYPH;
      return {
        u: ((i % COLUMNS_PER_ROW) * CELL_W) / width,
        v: (Math.floor(i / COLUMNS_PER_ROW) * CELL_H) / height,
        w: CELL_W / width,
        h: CELL_H / height,
      };
    },
    // One font pixel of margin around the 5x7 glyph, which sits one pixel
    // below the line top.
    quad: { x: -1, y: -0.5, w: GLYPH_W + 2, h: GLYPH_H + 2 },
  };
  return cached;
}

export interface TextLayout {
  /** One quad per visible character, in world units relative to the entity:
   * x right, y up, centred vertically on the line. */
  glyphs: { x: number; y: number; w: number; h: number; rect: GlyphRect }[];
  width: number;
  height: number;
}

/** Lay out text lines of the given height. `\n` starts a new line. */
export function layoutText(
  text: string,
  size: number,
  align: "left" | "center" | "right",
): TextLayout {
  const atlas = fontAtlas();
  const pixel = size / LINE_PIXELS;
  const lines = text.split("\n");
  const glyphs: TextLayout["glyphs"] = [];
  let widest = 0;
  const total = lines.length;
  lines.forEach((line, row) => {
    const width = Math.max(0, line.length * ADVANCE_PIXELS - 1) * pixel;
    widest = Math.max(widest, width);
    const left = align === "left"
      ? 0
      : align === "center"
      ? -width / 2
      : -width;
    // Line `row` from the top; the whole block is centred on y = 0.
    const top = (total / 2 - row) * size;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === " ") continue;
      const q = atlas.quad;
      glyphs.push({
        x: left + (i * ADVANCE_PIXELS + q.x) * pixel,
        y: top - (q.y + q.h) * pixel,
        w: q.w * pixel,
        h: q.h * pixel,
        rect: atlas.glyph(line[i]),
      });
    }
  });
  return { glyphs, width: widest, height: total * size };
}

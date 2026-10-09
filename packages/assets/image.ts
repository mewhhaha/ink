/** RGBA8 images: decoding, resizing and mip chains. Pure TypeScript. */
import { convertIndexedToRgb, decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";

export interface Rgba {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA8, rows top to bottom. */
  data: Uint8Array;
}

export type ImageKind = "png" | "jpeg" | "ktx2" | "webp" | "unknown";

export function sniffImage(bytes: Uint8Array): ImageKind {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54) {
    return "ktx2";
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) return "webp";
  return "unknown";
}

/** Decode a PNG or JPEG (8 or 16 bit, any channel layout, palettes). */
export function decodeImage(bytes: Uint8Array): Rgba {
  const kind = sniffImage(bytes);
  if (kind === "jpeg") {
    const out = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: 2048,
    });
    return { width: out.width, height: out.height, data: out.data };
  }
  if (kind !== "png") throw new Error(`unsupported image format (${kind})`);
  const png = decodePng(bytes);
  const indexed = png.palette;
  const { width, height } = png;
  const channels = indexed ? indexed[0].length : png.channels;
  const depth = indexed ? 8 : png.depth;
  const src = indexed ? convertIndexedToRgb(png) : png.data;
  const data = new Uint8Array(width * height * 4);
  const shift = depth === 16 ? 8 : 0;
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  const sample = (i: number) =>
    depth === 16
      ? src[i] >> shift
      : depth < 8
      ? Math.round(src[i] * scale)
      : src[i];
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels, o = i * 4;
    if (channels === 4) {
      data[o] = sample(s);
      data[o + 1] = sample(s + 1);
      data[o + 2] = sample(s + 2);
      data[o + 3] = sample(s + 3);
    } else if (channels === 3) {
      data[o] = sample(s);
      data[o + 1] = sample(s + 1);
      data[o + 2] = sample(s + 2);
      data[o + 3] = 255;
    } else if (channels === 2) {
      data[o] = data[o + 1] = data[o + 2] = sample(s);
      data[o + 3] = sample(s + 1);
    } else {
      data[o] = data[o + 1] = data[o + 2] = sample(s);
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();
const LINEAR_TO_SRGB = (() => {
  const t = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) {
    const c = i / 4095;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    t[i] = Math.round(Math.min(1, s) * 255);
  }
  return t;
})();

/** Area-average resize. Colour is averaged in linear light when `srgb`. */
export function resize(
  image: Rgba,
  width: number,
  height: number,
  srgb: boolean,
): Rgba {
  if (width === image.width && height === image.height) return image;
  const { data: src } = image;
  // Horizontal pass into float rows, then vertical accumulation.
  const sw = image.width, sh = image.height;
  const out = new Uint8Array(width * height * 4);
  const xStart = new Int32Array(width), xEnd = new Int32Array(width);
  const xs = sw / width, ys = sh / height;
  for (let x = 0; x < width; x++) {
    xStart[x] = Math.floor(x * xs);
    xEnd[x] = Math.max(xStart[x] + 1, Math.min(sw, Math.ceil((x + 1) * xs)));
  }
  const row = new Float32Array(width * 4);
  const acc = new Float32Array(width * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * ys);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * ys)));
    acc.fill(0);
    for (let sy = y0; sy < y1; sy++) {
      const base = sy * sw * 4;
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        const x0 = xStart[x], x1 = xEnd[x];
        for (let sx = x0; sx < x1; sx++) {
          const i = base + sx * 4;
          if (srgb) {
            r += SRGB_TO_LINEAR[src[i]];
            g += SRGB_TO_LINEAR[src[i + 1]];
            b += SRGB_TO_LINEAR[src[i + 2]];
          } else {
            r += src[i];
            g += src[i + 1];
            b += src[i + 2];
          }
          a += src[i + 3];
        }
        const inv = 1 / (x1 - x0);
        row[x * 4] = r * inv;
        row[x * 4 + 1] = g * inv;
        row[x * 4 + 2] = b * inv;
        row[x * 4 + 3] = a * inv;
      }
      for (let i = 0; i < acc.length; i++) acc[i] += row[i];
    }
    const inv = 1 / (y1 - y0);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = acc[x * 4 + k] * inv;
        out[o + k] = srgb
          ? LINEAR_TO_SRGB[Math.min(4095, Math.max(0, Math.round(v * 4095)))]
          : Math.round(v);
      }
      out[o + 3] = Math.round(acc[x * 4 + 3] * inv);
    }
  }
  return { width, height, data: out };
}

/** Level 0 plus every smaller level down to 1x1 (2x2 box filter). */
export function mipChain(image: Rgba, srgb: boolean): Rgba[] {
  const levels = [image];
  let current = image;
  while (current.width > 1 || current.height > 1) {
    current = resize(
      current,
      Math.max(1, current.width >> 1),
      Math.max(1, current.height >> 1),
      srgb,
    );
    levels.push(current);
  }
  return levels;
}

/** Whether every pixel is opaque. */
export function isOpaque(image: Rgba): boolean {
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 255) return false;
  }
  return true;
}

/** Fit inside `maxSide`, keeping aspect, with both sides multiples of `round`
 * (block compression needs multiples of four). */
export function fitSize(
  width: number,
  height: number,
  maxSide: number,
  maxTexels = Infinity,
  round = 1,
): [number, number] {
  let scale = Math.min(1, maxSide / Math.max(width, height));
  if (width * height * scale * scale > maxTexels) {
    scale = Math.sqrt(maxTexels / (width * height));
  }
  const fit = (n: number) => {
    const scaled = Math.max(1, Math.round(n * scale));
    return round > 1
      ? Math.max(round, Math.round(scaled / round) * round)
      : scaled;
  };
  return [fit(width), fit(height)];
}

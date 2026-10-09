/** Texture import: a quick uncompressed preview with precomputed mips, and the
 * final Basis Universal (ETC1S or UASTC) KTX2 file. Runs inside workers. */
import { encodeToKTX2 } from "ktx2-encoder";
import type { ImportSettings } from "./format.ts";
import { decodeImage, fitSize, mipChain, resize } from "./image.ts";
import type { Rgba } from "./image.ts";
import { writeRawKtx2 } from "./ktx2.ts";

/** How a texture is sampled: colour is sRGB, the rest is linear data. */
export type TextureRole = "color" | "normal" | "data";

/** The basis encoder rejects sources over 12 Mtexels in total. */
const MAX_TEXELS = 12 * 1024 * 1024 - 1024;

export interface TextureResult {
  ktx2: Uint8Array;
  /** Size of the stored top level. */
  width: number;
  height: number;
  /** Size of the decoded source. */
  sourceWidth: number;
  sourceHeight: number;
  codec: "raw" | "etc1s" | "uastc";
}

export function previewTexture(
  bytes: Uint8Array,
  role: TextureRole,
  size: number,
): TextureResult {
  const source = decodeImage(bytes);
  const [w, h] = fitSize(source.width, source.height, size);
  const base = resize(source, w, h, role === "color");
  const ktx2 = writeRawKtx2(mipChain(base, role === "color"), role === "color");
  return {
    ktx2,
    width: w,
    height: h,
    sourceWidth: source.width,
    sourceHeight: source.height,
    codec: "raw",
  };
}

export function codecFor(
  role: TextureRole,
  mode: ImportSettings["textures"]["mode"],
): "etc1s" | "uastc" {
  if (mode === "quality") return "uastc";
  if (mode === "size") return "etc1s";
  return role === "color" ? "etc1s" : "uastc";
}

export async function encodeTexture(
  bytes: Uint8Array,
  role: TextureRole,
  settings: ImportSettings["textures"],
): Promise<TextureResult> {
  const source = decodeImage(bytes);
  // Block compression needs multiples of four at the top level.
  const [w, h] = fitSize(
    source.width,
    source.height,
    settings.maxSize,
    MAX_TEXELS,
    4,
  );
  const image: Rgba = resize(source, w, h, role === "color");
  const codec = codecFor(role, settings.mode);
  const color = role === "color";
  const ktx2 = await encodeToKTX2(new Uint8Array(1), {
    enableDebug: false,
    isUASTC: codec === "uastc",
    generateMipmap: true,
    isPerceptual: color,
    isSetKTX2SRGBTransferFunc: color,
    isNormalMap: role === "normal",
    ...(codec === "uastc"
      ? { uastcLDRQualityLevel: 1 }
      : { qualityLevel: 128, compressionLevel: 1 }),
    imageDecoder: () => Promise.resolve(image),
  });
  return {
    ktx2,
    width: w,
    height: h,
    sourceWidth: source.width,
    sourceHeight: source.height,
    codec,
  };
}

/** A small PNG thumbnail (longest side `size`) with its alpha flattened onto
 * a checker so transparency stays visible. */
export async function thumbnailTexture(
  bytes: Uint8Array,
  size: number,
): Promise<Uint8Array> {
  const { encode } = await import("fast-png");
  const source = decodeImage(bytes);
  const [w, h] = fitSize(source.width, source.height, size);
  const image = resize(source, w, h, true);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = image.data[i + 3] / 255;
      const checker = ((x >> 3) + (y >> 3)) & 1 ? 200 : 140;
      for (let k = 0; k < 3; k++) {
        out[i + k] = Math.round(image.data[i + k] * a + checker * (1 - a));
      }
      out[i + 3] = 255;
    }
  }
  return encode({ width: w, height: h, data: out, channels: 4, depth: 8 });
}

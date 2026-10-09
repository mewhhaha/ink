/** Basis Universal transcoding of KTX2 files into GPU block formats. Runs in a
 * worker (`ktx2_worker.ts`) or inline where workers are missing. */
import { srgbMean } from "./ktx2_mean.ts";
// @ts-ignore vendored emscripten module, see vendor/basis/NOTICE.md
import BASIS from "./vendor/basis/basis_transcoder.js";

/** Basis transcoder target ids. */
export const TARGET = { etc2: 1, bc7: 6, astc: 10, rgba8: 13 } as const;
export type Family = keyof typeof TARGET;

export interface TranscodedLevel {
  data: Uint8Array;
  /** Size of this mip level in texels (before block rounding). */
  width: number;
  height: number;
}
export interface Transcoded {
  family: Family;
  width: number;
  height: number;
  levels: TranscodedLevel[];
  /** Mean colour in linear light, from a small level. */
  average: [number, number, number];
  hasAlpha: boolean;
}

// deno-lint-ignore no-explicit-any
let module: Promise<any> | undefined;

function load() {
  return module ??= (async () => {
    const url = new URL(
      "./vendor/basis/basis_transcoder.wasm",
      import.meta.url,
    );
    const wasmBinary = await (await fetch(url)).arrayBuffer();
    const basis = await BASIS({ wasmBinary });
    basis.initializeBasis();
    return basis;
  })();
}

export async function transcode(
  bytes: Uint8Array,
  family: Family,
): Promise<Transcoded> {
  const basis = await load();
  const file = new basis.KTX2File(bytes);
  try {
    if (!file.isValid()) throw new Error("invalid KTX2 file");
    const width: number = file.getWidth(), height: number = file.getHeight();
    const count: number = file.getLevels();
    const hasAlpha: boolean = file.getHasAlpha();
    if (!file.startTranscoding()) throw new Error("KTX2 transcoding failed");
    const target = TARGET[family];
    const levels: TranscodedLevel[] = [];
    for (let level = 0; level < count; level++) {
      const size: number = file.getImageTranscodedSizeInBytes(
        level,
        0,
        0,
        target,
      );
      const data = new Uint8Array(size);
      if (!file.transcodeImage(data, level, 0, 0, target, 0, -1, -1)) {
        throw new Error(`KTX2 level ${level} failed to transcode`);
      }
      levels.push({
        data,
        width: Math.max(1, width >> level),
        height: Math.max(1, height >> level),
      });
    }
    // A small level, decoded to pixels, gives the average colour.
    let small = count - 1;
    for (let l = 0; l < count; l++) {
      if (Math.max(width >> l, height >> l) <= 32) {
        small = l;
        break;
      }
    }
    const pixels = new Uint8Array(
      file.getImageTranscodedSizeInBytes(small, 0, 0, TARGET.rgba8),
    );
    file.transcodeImage(pixels, small, 0, 0, TARGET.rgba8, 0, -1, -1);
    return {
      family,
      width,
      height,
      levels,
      average: srgbMean(pixels),
      hasAlpha,
    };
  } finally {
    file.close();
    file.delete();
  }
}

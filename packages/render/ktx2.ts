/**
 * KTX2 textures. Basis Universal files (ETC1S/UASTC) are transcoded in a
 * worker to whichever block format the device supports (BC7, ASTC, ETC2) or to
 * RGBA8; uncompressed RGBA8 files from the importer's preview stage upload as
 * they are. Mip chains are precomputed by the importer.
 */
import type { Family, Transcoded } from "./ktx2_transcode.ts";
import { srgbMean } from "./ktx2_mean.ts";

export type { Family, Transcoded };

const MAGIC = [
  0xab,
  0x4b,
  0x54,
  0x58,
  0x20,
  0x32,
  0x30,
  0xbb,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
];

export function isKtx2(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && MAGIC.every((b, i) => bytes[i] === b);
}

/** Block families the device can sample, best first. */
export function supportedFamilies(device: GPUDevice): Family[] {
  const has = (f: string) => device.features?.has(f as GPUFeatureName) ?? false;
  const out: Family[] = [];
  if (has("texture-compression-bc")) out.push("bc7");
  if (has("texture-compression-astc")) out.push("astc");
  if (has("texture-compression-etc2")) out.push("etc2");
  return out;
}

export const FORMAT: Record<
  Family,
  { linear: GPUTextureFormat; srgb: GPUTextureFormat }
> = {
  bc7: { linear: "bc7-rgba-unorm", srgb: "bc7-rgba-unorm-srgb" },
  astc: { linear: "astc-4x4-unorm", srgb: "astc-4x4-unorm-srgb" },
  etc2: { linear: "etc2-rgba8unorm", srgb: "etc2-rgba8unorm-srgb" },
  rgba8: { linear: "rgba8unorm", srgb: "rgba8unorm-srgb" },
};

const VK_RGBA8_UNORM = 37, VK_RGBA8_SRGB = 43;

function rawKtx2(bytes: Uint8Array): Transcoded | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vk = view.getUint32(12, true);
  if (vk !== VK_RGBA8_UNORM && vk !== VK_RGBA8_SRGB) return undefined;
  if (view.getUint32(44, true) !== 0) return undefined; // supercompressed
  const width = view.getUint32(20, true), height = view.getUint32(24, true);
  const count = Math.max(1, view.getUint32(40, true));
  const levels = [];
  for (let l = 0; l < count; l++) {
    const offset = Number(view.getBigUint64(80 + l * 24, true));
    const length = Number(view.getBigUint64(88 + l * 24, true));
    levels.push({
      data: bytes.subarray(offset, offset + length),
      width: Math.max(1, width >> l),
      height: Math.max(1, height >> l),
    });
  }
  const last = levels[levels.length - 1].data;
  return {
    family: "rgba8",
    width,
    height,
    levels,
    average: srgbMean(last.subarray(0, 4)),
    hasAlpha: true,
  };
}

interface Pending {
  resolve: (value: Transcoded) => void;
  reject: (error: Error) => void;
}
let workers: { worker: Worker; busy: number }[] | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function pool() {
  if (workers) return workers;
  workers = [];
  const count = Math.max(
    1,
    Math.min(
      3,
      Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 4),
    ),
  );
  for (let i = 0; i < count; i++) {
    const worker = new Worker(new URL("./ktx2_worker.ts", import.meta.url), {
      type: "module",
    });
    const slot = { worker, busy: 0 };
    worker.onmessage = (event: MessageEvent) => {
      const { id, result, error } = event.data;
      const job = pending.get(id);
      pending.delete(id);
      slot.busy--;
      if (!job) return;
      if (error) job.reject(new Error(error));
      else job.resolve(result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      for (const [id, job] of pending) {
        job.reject(new Error(event.message || "KTX2 worker failed"));
        pending.delete(id);
      }
      slot.busy = 0;
    };
    workers.push(slot);
  }
  return workers;
}

/** Decode a KTX2 file to levels the GPU can take. */
export async function readKtx2(
  bytes: Uint8Array,
  families: Family[],
): Promise<Transcoded> {
  const raw = rawKtx2(bytes);
  if (raw) return raw;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(20, true), height = view.getUint32(24, true);
  // Block formats need multiples of four at the top level.
  const family: Family = width % 4 || height % 4
    ? "rgba8"
    : families[0] ?? "rgba8";
  if (typeof Worker === "undefined") {
    const { transcode } = await import("./ktx2_transcode.ts");
    return await transcode(bytes, family);
  }
  const slots = pool();
  const slot = slots.reduce((a, b) => (b.busy < a.busy ? b : a));
  slot.busy++;
  const id = nextId++;
  const copy = bytes.slice();
  return await new Promise<Transcoded>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    slot.worker.postMessage({ id, bytes: copy, family }, [copy.buffer]);
  });
}

/** Stop the transcoding workers (the renderer was disposed). */
export function disposeKtx2Workers(): void {
  for (const slot of workers ?? []) slot.worker.terminate();
  workers = undefined;
  for (const [id, job] of pending) {
    job.reject(new Error("renderer disposed"));
    pending.delete(id);
  }
}

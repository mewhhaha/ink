/** Import worker: executes one job per message. */
import type { ImportSettings } from "./format.ts";

// The Basis encoder prints progress through console.log.
console.log = () => {};

const ops: Record<string, (payload: never) => unknown | Promise<unknown>> = {
  "texture.preview": async (
    p: {
      bytes: Uint8Array;
      role: "color" | "normal" | "data";
      settings: ImportSettings["textures"];
    },
  ) => {
    const { previewTexture } = await import("./texture.ts");
    return previewTexture(p.bytes, p.role, p.settings.previewSize);
  },
  "texture.full": async (
    p: {
      bytes: Uint8Array;
      role: "color" | "normal" | "data";
      settings: ImportSettings["textures"];
    },
  ) => {
    const { encodeTexture } = await import("./texture.ts");
    return await encodeTexture(p.bytes, p.role, p.settings);
  },
  "texture.thumbnail": async (p: { bytes: Uint8Array; size: number }) => {
    const { thumbnailTexture } = await import("./texture.ts");
    return await thumbnailTexture(p.bytes, p.size);
  },
  "audio": async (p: { bytes: Uint8Array; path: string }) => {
    const { transcodeAudio } = await import("./audio.ts");
    const out = await transcodeAudio(p.bytes, p.path);
    return { bytes: out.bytes, ext: out.ext, mime: out.mime, codec: out.codec };
  },
  "mesh": async (
    p: {
      input: import("./mesh.ts").PrimitiveInput;
      settings: ImportSettings["meshes"];
    },
  ) => {
    const { processPrimitive } = await import("./mesh.ts");
    return await processPrimitive(p.input, p.settings);
  },
};

function transferables(value: unknown, out = new Set<ArrayBuffer>()) {
  if (ArrayBuffer.isView(value)) out.add(value.buffer as ArrayBuffer);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value)) transferables(v, out);
  }
  return out;
}

const scope = self as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = async (event: MessageEvent) => {
  const { op, payload } = event.data;
  try {
    const handler = ops[op];
    if (!handler) throw new Error(`unknown import job ${op}`);
    const result = await handler(payload as never);
    scope.postMessage({ result }, [...transferables(result)]);
  } catch (error) {
    scope.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

import { transcode } from "./ktx2_transcode.ts";
import type { Family } from "./ktx2_transcode.ts";

const scope = self as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage(message: unknown, options?: { transfer: Transferable[] }): void;
};
scope.onmessage = async (event: MessageEvent) => {
  const { id, bytes, family } = event.data as {
    id: number;
    bytes: Uint8Array;
    family: Family;
  };
  try {
    const result = await transcode(bytes, family);
    scope.postMessage({ id, result }, {
      transfer: result.levels.map((l) => l.data.buffer),
    });
  } catch (error) {
    scope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

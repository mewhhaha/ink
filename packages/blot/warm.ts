/**
 * Editor-only: compiles a freshly built module's functions off the page's main
 * thread. Kept apart from `@ink/blot` so players do not bundle the worker.
 */
import {
  encodeInput,
  type InputModel,
  type Schema,
  stepPacket,
} from "@ink/schema";

let warmer: Worker | null | undefined;
let warmId = 0;
const warming = new Map<number, (ms: number) => void>();

/** Start the warm-up worker now, so the first rebuild does not wait for it. */
export function prepareWarmup(): Worker | null {
  if (warmer === undefined) {
    try {
      warmer = typeof Worker === "undefined"
        ? null
        : new Worker(new URL("./warm_worker.ts", import.meta.url), {
          type: "module",
        });
      warmer?.addEventListener("message", (event) => {
        const { id, ms } = event.data as { id: number; ms?: number };
        warming.get(id)?.(ms ?? 0);
        warming.delete(id);
      });
      warmer?.addEventListener("error", () => {
        for (const done of warming.values()) done(0);
        warming.clear();
        warmer = null;
      });
    } catch {
      warmer = null;
    }
  }
  return warmer ?? null;
}

/**
 * Run one throwaway step of a freshly compiled module in a worker, so V8's
 * lazy compilation (a few hundred milliseconds for a large game) happens off
 * the page's main thread and the first real step is fast. Resolves with the
 * milliseconds it took, or 0 where workers are unavailable.
 */
export function warmGame(
  module: WebAssembly.Module,
  schema: Schema,
  state: Float32Array,
  input: InputModel,
): Promise<number> {
  const worker = prepareWarmup();
  if (!worker) return Promise.resolve(0);
  return new Promise((resolve) => {
    const id = ++warmId;
    warming.set(id, resolve);
    // The worker must not keep the page's live state: send a copy.
    worker.postMessage({
      id,
      module,
      packet: stepPacket(encodeInput(schema, input), state),
    });
  });
}

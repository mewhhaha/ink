/**
 * Warms a freshly built game module off the page's main thread. V8 compiles
 * Wasm functions lazily, on their first call, and a game module takes a few
 * hundred milliseconds to run its first step. A `WebAssembly.Module` posted to
 * a worker shares its compiled code with the page, so running one throwaway
 * step here leaves the page's first real step with nothing to compile.
 */
import { instantiateGuest } from "@mewhhaha/blot/guest";

interface Request {
  id: number;
  module: WebAssembly.Module;
  /** A complete step packet (input then state) to run once. */
  packet: Float32Array;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = async ({ data }) => {
  const started = performance.now();
  try {
    const guest = await instantiateGuest(data.module);
    try {
      guest.call("step", data.packet);
    } finally {
      guest.dispose();
    }
    scope.postMessage({ id: data.id, ms: performance.now() - started });
  } catch (error) {
    scope.postMessage({ id: data.id, error: String(error) });
  }
};

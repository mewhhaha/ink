import type { PreparedLightingReference } from "./scene.ts";
import type {
  LoadedReference,
  ReferenceLoadRequest,
  ReferenceLoadResponse,
} from "./reference_worker_protocol.ts";

interface PendingReferenceLoad {
  readonly reject: (reason: Error) => void;
  readonly resolve: (loaded: LoadedReference) => void;
}

export class LightingReferenceLoader {
  readonly #pending = new Map<number, PendingReferenceLoad>();
  readonly #worker = new Worker(
    new URL("./reference_worker.ts", import.meta.url),
    { type: "module" },
  );
  #disposed = false;
  #request_sequence = 0;

  constructor() {
    this.#worker.addEventListener("message", this.#receive_response);
    this.#worker.addEventListener("error", this.#receive_worker_error);
    this.#worker.addEventListener("messageerror", this.#receive_message_error);
  }

  load(reference: PreparedLightingReference): Promise<LoadedReference> {
    if (this.#disposed) {
      return Promise.reject(new Error("lighting reference loader is disposed"));
    }
    const request_id = ++this.#request_sequence;
    const request: ReferenceLoadRequest = { reference, request_id };
    return new Promise((resolve, reject) => {
      this.#pending.set(request_id, { reject, resolve });
      try {
        this.#worker.postMessage(request);
      } catch (cause) {
        this.#pending.delete(request_id);
        reject(
          new Error(
            `could not request ${reference} lighting reference from worker`,
            { cause },
          ),
        );
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.terminate();
    this.#reject_pending("lighting reference loader was disposed");
  }

  readonly #receive_response = (
    event: MessageEvent<ReferenceLoadResponse>,
  ): void => {
    const response = event.data;
    const pending = this.#pending.get(response.request_id);
    if (pending === undefined) return;
    this.#pending.delete(response.request_id);
    if (response.type === "loaded") pending.resolve(response.loaded);
    else pending.reject(new Error(response.reason));
  };

  readonly #receive_worker_error = (event: ErrorEvent): void => {
    this.#reject_pending(
      `lighting reference worker failed at ${event.filename}:${event.lineno}:${event.colno}: ${event.message}`,
    );
  };

  readonly #receive_message_error = (): void => {
    this.#reject_pending(
      "lighting reference worker returned an unreadable message",
    );
  };

  #reject_pending(reason: string): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}

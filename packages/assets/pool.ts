/** A small pool of Deno workers running import jobs by name. */
import type { Runner } from "./gltf.ts";

interface Job {
  id: number;
  op: string;
  payload: unknown;
  transfer: Transferable[];
  priority: number;
  skip?: () => boolean;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

export function defaultWorkerCount(): number {
  const cores = navigator.hardwareConcurrency ?? 4;
  return Math.max(2, Math.min(8, cores - 2));
}

export class WorkerPool implements Runner {
  #workers: { worker: Worker; job?: Job }[] = [];
  #queue: Job[] = [];
  #next = 1;
  #closed = false;

  constructor(readonly size = defaultWorkerCount()) {}

  run<T>(
    op: string,
    payload: unknown,
    options: {
      transfer?: Transferable[];
      priority?: number;
      /** Checked when the job reaches the front; true drops it unrun. */
      skip?: () => boolean;
    } = {},
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("worker pool closed"));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: this.#next++,
        op,
        payload,
        transfer: options.transfer ?? [],
        priority: options.priority ?? 0,
        skip: options.skip,
        resolve: resolve as (value: never) => void,
        reject,
      };
      // Stable: later jobs of equal priority go after earlier ones.
      let at = this.#queue.length;
      while (at > 0 && this.#queue[at - 1].priority > job.priority) at--;
      this.#queue.splice(at, 0, job);
      this.#pump();
    });
  }

  #spawn() {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    const slot: { worker: Worker; job?: Job } = { worker };
    worker.onmessage = (event: MessageEvent) => {
      const job = slot.job;
      slot.job = undefined;
      if (job) {
        if (event.data.error) job.reject(new Error(event.data.error));
        else job.resolve(event.data.result as never);
      }
      this.#pump();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const job = slot.job;
      slot.job = undefined;
      job?.reject(new Error(event.message));
      this.#pump();
    };
    this.#workers.push(slot);
    return slot;
  }

  #pump() {
    while (this.#queue.length && !this.#closed) {
      let slot = this.#workers.find((w) => !w.job);
      if (!slot && this.#workers.length < this.size) slot = this.#spawn();
      if (!slot) return;
      const job = this.#queue.shift()!;
      if (job.skip?.()) {
        job.reject(new Error("superseded"));
        continue;
      }
      slot.job = job;
      slot.worker.postMessage(
        { op: job.op, payload: job.payload },
        job.transfer,
      );
    }
  }

  get busy(): number {
    return this.#workers.filter((w) => w.job).length + this.#queue.length;
  }

  terminate() {
    this.#closed = true;
    for (const { worker, job } of this.#workers) {
      job?.reject(new Error("worker pool closed"));
      worker.terminate();
    }
    for (const job of this.#queue) job.reject(new Error("worker pool closed"));
    this.#workers = [];
    this.#queue = [];
  }
}

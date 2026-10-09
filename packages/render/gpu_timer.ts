/**
 * GPU time of a frame from WebGPU `timestamp-query`, when the adapter has it.
 *
 * Every render and compute pass of the frame's command encoder gets a pair of
 * timestamps; their durations add up to the GPU time the frame spent in
 * passes (copies and the gaps between passes are not counted). The results are
 * read back a few frames later so measuring never stalls the queue, so
 * `gpuMs` describes a frame that finished recently, not the one just
 * submitted. Chromium quantizes timestamps to 100 microseconds unless its
 * developer features are on.
 */

import { BufferUsage, MAP_READ } from "./gpu.ts";

/** Passes timed per frame; later ones run untimed. */
const MAX_PASSES = 128;
const BUFFERS = 3;

interface Readback {
  buffer: GPUBuffer;
  /** Timestamps written for the frame in this buffer. */
  count: number;
  busy: boolean;
}

export class GpuTimer {
  /** Milliseconds of GPU pass time in the most recent frame read back. */
  gpuMs: number | null = null;
  #passes = 0;
  #timing = false;
  #current: Readback | null = null;
  readonly #querySet: GPUQuerySet;
  readonly #resolve: GPUBuffer;
  readonly #readbacks: Readback[];
  #disposed = false;

  private constructor(readonly device: GPUDevice) {
    this.#querySet = device.createQuerySet({
      type: "timestamp",
      count: MAX_PASSES * 2,
    });
    const size = MAX_PASSES * 2 * 8;
    this.#resolve = device.createBuffer({
      label: "gpu-timer-resolve",
      size,
      usage: BufferUsage.QUERY_RESOLVE | BufferUsage.COPY_SRC,
    });
    this.#readbacks = Array.from({ length: BUFFERS }, () => ({
      buffer: device.createBuffer({
        label: "gpu-timer-readback",
        size,
        usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
      }),
      count: 0,
      busy: false,
    }));
  }

  /** A timer for `device`, or null when it lacks `timestamp-query`. */
  static create(device: GPUDevice): GpuTimer | null {
    if (!device.features?.has("timestamp-query")) return null;
    try {
      return new GpuTimer(device);
    } catch {
      return null;
    }
  }

  /** Start timing the passes recorded into `encoder`. */
  begin(encoder: GPUCommandEncoder) {
    this.#current = this.#readbacks.find((r) => !r.busy) ?? null;
    this.#timing = this.#current !== null;
    this.#passes = 0;
    if (!this.#timing) return;
    const render = encoder.beginRenderPass.bind(encoder);
    const compute = encoder.beginComputePass.bind(encoder);
    const slot = (): GPUComputePassTimestampWrites | undefined => {
      if (!this.#timing || this.#passes >= MAX_PASSES) return undefined;
      const i = this.#passes++;
      return {
        querySet: this.#querySet,
        beginningOfPassWriteIndex: i * 2,
        endOfPassWriteIndex: i * 2 + 1,
      };
    };
    encoder.beginRenderPass = (descriptor) =>
      render(
        descriptor.timestampWrites
          ? descriptor
          : { ...descriptor, timestampWrites: slot() },
      );
    encoder.beginComputePass = (descriptor) =>
      compute(
        descriptor?.timestampWrites
          ? descriptor
          : { ...descriptor, timestampWrites: slot() },
      );
  }

  /** Resolve the frame's timestamps; call before `encoder.finish()`. */
  end(encoder: GPUCommandEncoder) {
    const target = this.#current;
    this.#timing = false;
    if (!target || this.#passes === 0) {
      this.#current = null;
      return;
    }
    const count = this.#passes * 2;
    encoder.resolveQuerySet(this.#querySet, 0, count, this.#resolve, 0);
    encoder.copyBufferToBuffer(this.#resolve, 0, target.buffer, 0, count * 8);
    target.count = count;
    target.busy = true;
  }

  /** Call after `queue.submit`: read the results back when they are ready. */
  submitted() {
    const target = this.#current;
    this.#current = null;
    if (!target?.busy) return;
    target.buffer.mapAsync(MAP_READ).then(() => {
      if (this.#disposed) return;
      const times = new BigUint64Array(
        target.buffer.getMappedRange(0, target.count * 8),
      );
      let nanoseconds = 0n;
      for (let i = 0; i < target.count; i += 2) {
        if (times[i + 1] > times[i]) nanoseconds += times[i + 1] - times[i];
      }
      this.gpuMs = Number(nanoseconds) / 1e6;
      target.buffer.unmap();
      target.busy = false;
    }, () => {
      target.busy = false;
    });
  }

  dispose() {
    this.#disposed = true;
    this.#querySet.destroy();
    this.#resolve.destroy();
    for (const r of this.#readbacks) r.buffer.destroy();
  }
}

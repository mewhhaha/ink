/// <reference lib="deno.worker" />

import { instantiateGuest } from "@mewhhaha/blot";
import { checkWitness, type Workload } from "./library-bench.ts";
import { summary } from "./report.ts";

declare const self: DedicatedWorkerGlobalScope;

const memoryLimit = 256 * 1024 * 1024;

self.onmessage = async (event) => {
  const { workload, bytes }: { workload: Workload; bytes: Uint8Array } = event
    .data;
  let rounds = 9;
  let tierWarmupRounds = 20;
  let replayRounds = 16;
  if (workload.expensive) {
    rounds = 5;
    tierWarmupRounds = 3;
    replayRounds = 4;
  }
  const guest = await instantiateGuest(bytes);
  const initialMemory = guest.memoryBytes();
  let peakMemory = initialMemory;
  const expected = new Map<number, number[]>();
  const samples = new Map<number, number[]>();
  const cold = [];
  const call = (size: number) => {
    const started = performance.now();
    const value = guest.call(workload.entry, size);
    const elapsed = performance.now() - started;
    peakMemory = Math.max(peakMemory, guest.memoryBytes());
    if (peakMemory > memoryLimit) {
      throw new Error(`${workload.name} exceeded 256MiB committed Wasm memory`);
    }
    let witness: number[];
    if (typeof value === "number") witness = [value];
    else if (value instanceof Float32Array || value instanceof Uint32Array) {
      witness = Array.from(value);
    } else throw new Error(`${workload.name} returned an unsupported witness`);
    checkWitness(workload, size, witness);
    const previous = expected.get(size);
    if (previous) {
      if (
        previous.length !== witness.length ||
        previous.some((value, i) => value !== witness[i])
      ) {
        throw new Error(
          `${workload.name}(${size}) deterministic replay failed`,
        );
      }
    } else expected.set(size, witness);
    return elapsed;
  };
  try {
    for (const size of workload.sizes) {
      const row = {
        size,
        milliseconds: call(size),
        committedBytes: guest.memoryBytes(),
      };
      cold.push(row);
      self.postMessage({ progress: row });
      samples.set(size, []);
    }
    for (let round = 0; round < tierWarmupRounds; round++) {
      for (const size of workload.sizes) call(size);
    }
    const afterWarmupMemory = guest.memoryBytes();
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < workload.sizes.length; i++) {
        const size = workload.sizes[(round + i) % workload.sizes.length];
        samples.get(size)!.push(call(size));
      }
    }
    const beforeReplayMemory = guest.memoryBytes();
    const largest = workload.sizes.at(-1)!;
    for (let round = 0; round < replayRounds; round++) call(largest);
    const afterReplayMemory = guest.memoryBytes();
    if (afterReplayMemory !== beforeReplayMemory) {
      throw new Error(
        `${workload.name} repeated calls keep growing Wasm memory`,
      );
    }
    const sizes = workload.sizes.map((size) => {
      const units = size ** (workload.dimension ?? 1);
      const milliseconds = summary(samples.get(size)!);
      return {
        size,
        units,
        milliseconds,
        nanosecondsPerUnit: milliseconds.median * 1e6 / units,
        witness: expected.get(size),
      };
    });
    const scaling = sizes.slice(1).map((item, i) => {
      const previous = sizes[i];
      const inputRatio = item.units / previous.units;
      const timeRatio = item.milliseconds.median / previous.milliseconds.median;
      const exponent = Math.log(timeRatio) / Math.log(inputRatio);
      let observation = "within expected workload scaling";
      if (
        (workload.complexity === "linear" ||
          workload.complexity.startsWith("n log n")) &&
        exponent > 1.75
      ) observation = "investigate superlinear scaling";
      if (item.milliseconds.median < 0.02) {
        observation = "too short for a reliable scaling diagnosis";
      }
      return {
        from: previous.size,
        to: item.size,
        inputRatio,
        timeRatio,
        exponent,
        observation,
      };
    });
    self.postMessage({
      ...workload,
      sizes,
      coldCalls: cold,
      tierWarmupRounds,
      rounds,
      replayRounds,
      memory: {
        initialBytes: initialMemory,
        afterWarmupBytes: afterWarmupMemory,
        peakCommittedBytes: peakMemory,
        beforeReplayBytes: beforeReplayMemory,
        afterReplayBytes: afterReplayMemory,
      },
      scaling,
    });
  } catch (error) {
    self.postMessage({ error: `${workload.name}: ${String(error)}` });
  } finally {
    guest.dispose();
  }
};

// Imports have asynchronous setup; acknowledge readiness before receiving data.
self.postMessage({ ready: true });

import { assertEquals, assertThrows } from "@std/assert";
import { AudioStreamBuffer } from "./stream.ts";

Deno.test("stream buffer reports latency and retained memory", () => {
  const buffer = new AudioStreamBuffer(2, 10, 20);
  assertEquals(buffer.append(0, new Float32Array(20)).latency_seconds, 1);
  assertEquals(buffer.snapshot().retained_bytes, 80);
});

Deno.test("stream buffer discards the oldest frames at its bound", () => {
  const buffer = new AudioStreamBuffer(1, 10, 3);
  buffer.append(0, new Float32Array([1, 2]));
  buffer.append(1, new Float32Array([3, 4]));
  assertEquals(buffer.consume(3), new Float32Array([2, 3, 4]));
});

Deno.test("stream buffer zero-fills and counts an underrun", () => {
  const buffer = new AudioStreamBuffer(1, 10, 4);
  buffer.append(0, new Float32Array([1, 2]));
  assertEquals(buffer.consume(4), new Float32Array([1, 2, 0, 0]));
  assertEquals(buffer.snapshot().underruns, 1);
});

Deno.test("stream buffer rejects repeated chunk sequences", () => {
  const buffer = new AudioStreamBuffer(1, 10, 4);
  buffer.append(2, new Float32Array([1]));
  assertThrows(
    () => buffer.append(2, new Float32Array([2])),
    Error,
    "must exceed 2",
  );
  assertThrows(
    () => buffer.append(3, new Float32Array([Number.NaN])),
    Error,
    "chunk 3 sample 0 must be finite",
  );
});

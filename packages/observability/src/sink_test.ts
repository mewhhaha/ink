import { assertEquals, assertThrows } from "@std/assert";
import type { Event } from "./model.ts";
import {
  create_fan_out_sink,
  create_ring_buffer_sink,
  create_test_sink,
  export_observations,
} from "./sink.ts";

const event = (name: string): Event => ({
  type: "event",
  name,
  source: { subsystem: "test" },
  timestamp_seconds: 0,
  context: {},
  evidence: {},
});

Deno.test("bounded observation buffers retain the newest records and count overflow", () => {
  const sink = create_ring_buffer_sink(2);
  sink.record(event("first"));
  sink.record(event("second"));
  sink.record(event("third"));
  assertEquals(
    sink.observations().map((entry) => entry.type === "event" && entry.name),
    ["second", "third"],
  );
  assertEquals(sink.dropped(), 1);
});

Deno.test("fan-out observation sinks isolate a failing consumer", () => {
  const recorded = create_test_sink();
  const sink = create_fan_out_sink([
    {
      record() {
        throw new Error("export unavailable");
      },
    },
    recorded,
  ]);
  sink.record(event("ready"));
  assertEquals(recorded.observations(), [event("ready")]);
  assertEquals(sink.failures(), [{
    sink_index: 0,
    reason: "export unavailable",
  }]);
  assertEquals(sink.dropped_failures(), 0);
});

Deno.test("fan-out observation sinks count discarded failure evidence", () => {
  const sink = create_fan_out_sink([{
    record() {
      throw new Error("offline");
    },
  }], 1);
  sink.record(event("first"));
  sink.record(event("second"));
  assertEquals(sink.failures(), [{ sink_index: 0, reason: "offline" }]);
  assertEquals(sink.dropped_failures(), 1);
});

Deno.test("observation sink capacities reject invalid configuration", () => {
  assertThrows(() => create_ring_buffer_sink(0), Error, "capacity 0");
});

Deno.test("asynchronous observation export reports failure without throwing", async () => {
  const result = await export_observations([event("ready")], {
    export() {
      return Promise.reject(new Error("network offline"));
    },
  });
  assertEquals(result, { type: "failed", count: 1, reason: "network offline" });
});

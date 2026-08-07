import { assertEquals, assertThrows } from "@std/assert";
import { Observer } from "./observer.ts";
import { create_test_sink } from "./sink.ts";

Deno.test("nested spans preserve correlation and parent identity", () => {
  const times = [1, 2, 4, 7];
  const sink = create_test_sink();
  const observer = new Observer({
    source: { subsystem: "runtime", instance: "main" },
    sink,
    correlation_id: "frame-9",
    clock: { now_seconds: () => times.shift() ?? 7 },
  });
  const outer = observer.start_span("frame");
  const inner = observer.start_span("step");
  inner.end({ steps: 1 });
  outer.end();
  assertEquals(sink.observations(), [
    {
      type: "span",
      id: "runtime:1",
      name: "step",
      source: { subsystem: "runtime", instance: "main" },
      timestamp_seconds: 2,
      duration_seconds: 2,
      context: { correlation_id: "frame-9", parent_span_id: "runtime:0" },
      evidence: { steps: 1 },
    },
    {
      type: "span",
      id: "runtime:0",
      name: "frame",
      source: { subsystem: "runtime", instance: "main" },
      timestamp_seconds: 1,
      duration_seconds: 6,
      context: { correlation_id: "frame-9" },
      evidence: {},
    },
  ]);
});

Deno.test("spans reject out-of-order and repeated completion", () => {
  const sink = create_test_sink();
  const observer = new Observer({
    source: { subsystem: "runtime" },
    sink,
    clock: { now_seconds: () => 1 },
  });
  const outer = observer.start_span("outer");
  const inner = observer.start_span("inner");
  assertThrows(() => outer.end(), Error, "ended out of order");
  inner.end();
  outer.end();
  assertThrows(() => outer.end(), Error, "ended more than once");
});

Deno.test("clock regression leaves a span open for a later valid completion", () => {
  const times = [2, 1, 3];
  const sink = create_test_sink();
  const observer = new Observer({
    source: { subsystem: "runtime" },
    sink,
    clock: { now_seconds: () => times.shift() ?? 3 },
  });
  const span = observer.start_span("frame");

  assertThrows(() => span.end(), Error, "clock moved backwards from 2 to 1");
  span.end();
  assertEquals(
    sink.observations().map((observation) => ({
      type: observation.type,
      ...("duration_seconds" in observation
        ? { duration_seconds: observation.duration_seconds }
        : {}),
    })),
    [{ type: "span", duration_seconds: 1 }],
  );
});

Deno.test("metrics and frame profiles validate and record meaningful values", () => {
  const sink = create_test_sink();
  const observer = new Observer({
    source: { subsystem: "rendering" },
    sink,
    clock: { now_seconds: () => 3 },
  });
  observer.counter("draws", 4);
  observer.gauge("occupancy", 0.5, "ratio");
  observer.histogram("frame", [0.01, 0.02], "seconds");
  observer.frame_profile(2, [{ name: "extract", duration_seconds: 0.001 }], []);
  assertEquals(sink.observations().map((entry) => entry.type), [
    "metric",
    "metric",
    "metric",
    "frame_profile",
  ]);
  assertThrows(
    () => observer.histogram("empty", [], "count"),
    Error,
    "at least one sample",
  );
  assertThrows(
    () =>
      observer.histogram(
        "overflow",
        [Number.MAX_VALUE, Number.MAX_VALUE],
        "count",
      ),
    Error,
    'histogram "overflow" sum Infinity must be finite',
  );
});

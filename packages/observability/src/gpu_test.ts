import { assertEquals, assertThrows } from "@std/assert";
import { ingest_gpu_timestamps } from "./experimental/gpu.ts";

Deno.test("unsupported GPU timestamps remain an explicit capability result", () => {
  assertEquals(
    ingest_gpu_timestamps(
      { type: "unsupported", reason: "timestamp-query unavailable" },
      { submitted_frame_id: 1, available_frame_id: 2, timestamps: [] },
    ),
    { type: "unsupported", reason: "timestamp-query unavailable" },
  );
});

Deno.test("GPU timestamps retain submitted and delayed available frames", () => {
  assertEquals(
    ingest_gpu_timestamps(
      { type: "supported", timestamp_period_nanoseconds: 2 },
      {
        submitted_frame_id: 4,
        available_frame_id: 6,
        timestamps: [{ name: "opaque", start_tick: 10n, end_tick: 30n }],
      },
    ),
    {
      type: "profile",
      submitted_frame_id: 4,
      available_frame_id: 6,
      spans: [{ name: "opaque", duration_seconds: 0.00000004 }],
    },
  );
});

Deno.test("GPU timestamps reject reversed ranges", () => {
  assertThrows(
    () =>
      ingest_gpu_timestamps(
        { type: "supported", timestamp_period_nanoseconds: 1 },
        {
          submitted_frame_id: 1,
          available_frame_id: 2,
          timestamps: [{ name: "opaque", start_tick: 3n, end_tick: 2n }],
        },
      ),
    Error,
    "ends before it starts",
  );
});

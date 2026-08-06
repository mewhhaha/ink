import { Observer } from "./observer.ts";
import { create_ring_buffer_sink, no_observations } from "./sink.ts";

const clock = { now_seconds: () => 1 };
const disabled = new Observer({
  source: { subsystem: "benchmark" },
  sink: no_observations,
  clock,
});
const enabled = new Observer({
  source: { subsystem: "benchmark" },
  sink: create_ring_buffer_sink(1_000),
  clock,
});

Deno.bench("disabled observation event", () => {
  disabled.event("tick");
});

Deno.bench("bounded observation event", () => {
  enabled.event("tick", { frame: 1 });
});

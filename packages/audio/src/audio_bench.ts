import { AudioGraph } from "./graph.ts";
import { AudioMixer } from "./mixer.ts";
import { bus_id, clip_id, command_batch } from "./model.ts";
import { AudioStreamBuffer } from "./experimental/stream.ts";

const master = bus_id("master");
const clip = clip_id("tone");

Deno.bench("audio mixer schedules 128 active voices", () => {
  const mixer = new AudioMixer({ maximum_voices: 128, concurrency: [] });
  mixer.register_clip({
    id: clip,
    revision: 0,
    decoded: {
      sample_rate: 48_000,
      frame_count: 48_000,
      channels: [new Float32Array(48_000)],
    },
  });
  mixer.apply(
    command_batch(Array.from({ length: 128 }, (_, sequence) => ({
      type: "play" as const,
      sequence,
      presentation_time_seconds: 0,
      source: { type: "clip" as const, id: clip },
      bus: master,
      gain: 1,
      pitch: 1,
      priority: sequence,
      fade_seconds: 0,
    }))),
    0,
    0,
  );
});

Deno.bench("audio graph replaces 64 buses", () => {
  const buses = Array.from({ length: 64 }, (_, index) => ({
    id: bus_id(index === 0 ? "master" : `bus-${index}`),
    ...(index === 0 ? {} : { output: master }),
    gain: 1,
    effects: [],
    sends: [],
  }));
  const graph = new AudioGraph({ master, buses });
  graph.replace({
    master,
    buses: buses.map((bus, index) => ({
      ...bus,
      gain: index % 2 === 0 ? 0.8 : 1,
    })),
  });
});

Deno.bench("audio retains a 256-command stream buffer", () => {
  const buffer = new AudioStreamBuffer(2, 48_000, 48_000);
  for (let sequence = 0; sequence < 256; sequence += 1) {
    buffer.append(sequence, new Float32Array(256));
  }
  buffer.consume(16_384);
});

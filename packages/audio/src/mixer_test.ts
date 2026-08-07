import { assertEquals, assertThrows } from "@std/assert";
import { AudioMixer } from "./mixer.ts";
import { bus_id, clip_id, command_batch, voice_id } from "./model.ts";

const clip = clip_id("impact");
const bus = bus_id("effects");

function mixer(maximum_voices = 4): AudioMixer {
  const result = new AudioMixer({
    maximum_voices,
    concurrency: [{ group: "impacts", maximum_voices: 1 }],
  });
  result.register_clip({
    id: clip,
    revision: 0,
    decoded: {
      sample_rate: 10,
      frame_count: 20,
      channels: [new Float32Array(20)],
    },
  });
  return result;
}

function play(sequence: number, priority = 0, presentation_time_seconds = 1) {
  return {
    type: "play" as const,
    sequence,
    presentation_time_seconds,
    source: { type: "clip" as const, id: clip },
    bus,
    gain: 1,
    pitch: 1,
    priority,
    fade_seconds: 0,
    concurrency_group: "impacts",
  };
}

Deno.test("mixer maps presentation time to the audio clock once", () => {
  const result = mixer();
  const first = result.apply(command_batch([play(0, 0, 4)]), 3, 10);
  const second = result.apply(command_batch([play(1, 1, 14)]), 100, 20);
  if (first.type !== "ready" || second.type !== "ready") {
    throw new Error("expected ready mix plans");
  }
  const first_start = first.plan.commands.find((command) =>
    command.type === "start"
  );
  assertEquals(
    first_start?.type === "start"
      ? first_start.voice.started_audio_time
      : undefined,
    11,
  );
  assertEquals(second.snapshot.voices[0].started_audio_time, 21);
});

Deno.test("late loop playback retains loop phase", () => {
  const result = mixer();
  const command = {
    ...play(0, 0, 1),
    loop: { start_seconds: 0.5, end_seconds: 1.5 },
  };
  const applied = result.apply(command_batch([command]), 2, 10);
  if (applied.type !== "ready") throw new Error(applied.reason);
  assertEquals(applied.snapshot.voices[0].source_offset_seconds, 0.5);
});

Deno.test("expired late one-shots are dropped", () => {
  const result = mixer();
  const applied = result.apply(command_batch([play(0, 0, 0)]), 5, 10);
  if (applied.type !== "ready") throw new Error(applied.reason);
  assertEquals(applied.plan.dropped_sequences, [0]);
  assertEquals(applied.snapshot.voices, []);
});

Deno.test("voice stealing is stable by priority then sequence", () => {
  const result = mixer(1);
  const first = result.apply(command_batch([play(0, 2)]), 1, 1);
  const second = result.apply(command_batch([play(1, 2)]), 1, 1);
  if (first.type !== "ready" || second.type !== "ready") {
    throw new Error("expected ready mix plans");
  }
  assertEquals(second.plan.stolen, [voice_id("voice:0")]);
  assertEquals(second.snapshot.voices.map((voice) => voice.id), [
    voice_id("voice:1"),
  ]);
});

Deno.test("lower priority playback loses a concurrency contest", () => {
  const result = mixer();
  result.apply(command_batch([play(0, 4)]), 1, 1);
  const second = result.apply(command_batch([play(1, 3)]), 1, 1);
  if (second.type !== "ready") throw new Error(second.reason);
  assertEquals(second.plan.dropped_sequences, [1]);
  assertEquals(second.snapshot.voices.map((voice) => voice.id), [
    voice_id("voice:0"),
  ]);
});

Deno.test("replacements require a newer revision", () => {
  const result = mixer();
  assertEquals(
    result.replace_clip({
      id: clip,
      revision: 0,
      decoded: {
        sample_rate: 10,
        frame_count: 1,
        channels: [new Float32Array(1)],
      },
    }).type,
    "failed",
  );
  assertEquals(
    result.replace_clip({
      id: clip,
      revision: 1,
      decoded: {
        sample_rate: 10,
        frame_count: 1,
        channels: [new Float32Array(1)],
      },
    }),
    { type: "replaced" },
  );
});

Deno.test("command batches and registered clips detach caller-owned values", () => {
  const result = new AudioMixer({ maximum_voices: 1, concurrency: [] });
  const decoded = {
    sample_rate: 10,
    frame_count: 20,
    channels: [new Float32Array(20)],
  };
  result.register_clip({ id: clip, revision: 0, decoded });
  const authored = { ...play(0, 0, 0), gain: 1 };
  const batch = command_batch([authored]);
  authored.gain = 0;
  decoded.frame_count = 0;
  decoded.channels[0][0] = Number.NaN;
  const applied = result.apply(batch, 1, 1);
  if (applied.type !== "ready") throw new Error(applied.reason);
  assertEquals(applied.snapshot.voices[0].gain, 1);
  assertEquals(Object.isFrozen(applied.snapshot.voices[0]), true);

  assertThrows(
    () => command_batch([{ ...play(1), type: "explode" } as never]),
    Error,
    'type "explode" is unsupported',
  );
});

Deno.test("resolved spatial playback reaches immutable voice plans", () => {
  const command = {
    ...play(0),
    spatial: { gain: 0.5, pan: -0.25, doppler_pitch: 1.2 },
  };
  const batch = command_batch([command]);
  command.spatial.gain = 1;
  const applied = mixer().apply(batch, 1, 1);
  if (applied.type !== "ready") throw new Error(applied.reason);
  assertEquals(applied.snapshot.voices[0].spatial, {
    gain: 0.5,
    pan: -0.25,
    doppler_pitch: 1.2,
  });
  assertEquals(Object.isFrozen(applied.snapshot.voices[0].spatial), true);
  assertThrows(
    () =>
      command_batch([{ ...play(1), spatial: { ...command.spatial, pan: 2 } }]),
    Error,
    "must be within [-1, 1]",
  );
});

Deno.test("mixer construction rejects malformed concurrency groups", () => {
  assertThrows(
    () => new AudioMixer({ maximum_voices: 1, concurrency: null } as never),
    Error,
    "audio concurrency limits must be an array",
  );
  assertThrows(
    () =>
      new AudioMixer({
        maximum_voices: 1,
        concurrency: [{ group: 42, maximum_voices: 1 }],
      } as never),
    Error,
    "audio concurrency group 42 must be a string",
  );
});

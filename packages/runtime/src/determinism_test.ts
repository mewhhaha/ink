import { assertEquals, assertRejects } from "@std/assert";
import {
  type DeterministicChannel,
  DeterministicChannels,
  DeterministicRandomStreams,
} from "./determinism.ts";

Deno.test("random stream values do not depend on stream access order", () => {
  const left = new DeterministicRandomStreams(42n);
  const left_world = left.stream("world");
  const left_audio = left.stream("audio");
  const expected = [
    left_world.next_u64(),
    left_audio.next_u64(),
    left_world.next_u64(),
  ];

  const right = new DeterministicRandomStreams(42n);
  const right_audio = right.stream("audio");
  const right_world = right.stream("world");
  assertEquals(
    [right_world.next_u64(), right_audio.next_u64(), right_world.next_u64()],
    expected,
  );
});

Deno.test("random stream snapshots restore the exact next value", () => {
  const random = new DeterministicRandomStreams(7n);
  const stream = random.stream("simulation");
  stream.next_u64();
  const snapshot = random.snapshot();
  const expected = stream.next_u64();
  random.restore(snapshot);
  assertEquals(random.stream("simulation").next_u64(), expected);
});

Deno.test("channel restore rolls back channels completed before a failure", async () => {
  let first = 1;
  let second = 2;
  const channels: DeterministicChannel[] = [
    {
      id: "first",
      snapshot: () => new Uint8Array([first]),
      restore: (payload) => {
        first = payload[0];
      },
    },
    {
      id: "second",
      snapshot: () => new Uint8Array([second]),
      restore: (payload) => {
        if (payload[0] === 9) throw new Error("second rejected 9");
        second = payload[0];
      },
    },
  ];
  const registry = new DeterministicChannels(channels);
  await assertRejects(
    () =>
      registry.restore([
        { id: "first", payload: new Uint8Array([8]) },
        { id: "second", payload: new Uint8Array([9]) },
      ]),
    Error,
    "second rejected 9",
  );
  assertEquals({ first, second }, { first: 1, second: 2 });
});

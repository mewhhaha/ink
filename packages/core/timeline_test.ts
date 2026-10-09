import { assert, assertEquals } from "@std/assert";
import { defineSchema, idleInput } from "@ink/schema";
import { Timeline } from "./timeline.ts";

const schema = defineSchema({});
const catalog = { assets: {} };

function keyframe(tick: number, lanes: number) {
  const state = new Float32Array(lanes);
  state[1] = tick;
  return { tick, state, schema, catalog };
}

Deno.test("a large world keeps fewer keyframes, always the newest and a valid start", () => {
  // One megabyte per keyframe, room for about three.
  const lanes = 250_000;
  const timeline = new Timeline(10, 10_000, 3.5 * lanes * 4);
  for (let tick = 0; tick < 200; tick++) {
    timeline.record(tick, () => keyframe(tick, lanes), idleInput(schema, tick));
  }
  assert(timeline.keyframes.length <= 5, `kept ${timeline.keyframes.length}`);
  assert(timeline.keyframes.length >= 2);
  assertEquals(timeline.first, timeline.keyframes[0].tick);
  assertEquals(timeline.inputs.length, timeline.last - timeline.first);
  assertEquals(timeline.last, 200);
  for (const tick of [timeline.first, timeline.first + 7, 195, 199]) {
    const near = timeline.nearest(tick);
    assert(near && near.tick <= tick && tick - near.tick < 10);
    assertEquals(timeline.input(tick)?.tick, tick);
  }
  assert(timeline.bytes <= 5 * lanes * 4);
});

Deno.test("a small world keeps everything within capacity", () => {
  const timeline = new Timeline(10, 100);
  for (let tick = 0; tick < 250; tick++) {
    timeline.record(tick, () => keyframe(tick, 16), idleInput(schema, tick));
  }
  assertEquals(timeline.last, 250);
  assert(timeline.inputs.length <= 110);
  assertEquals(timeline.first % 10, 0);
  assertEquals(timeline.nearest(timeline.first)?.tick, timeline.first);
});

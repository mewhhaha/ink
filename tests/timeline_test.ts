import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./timeline.blot", import.meta.url));
const { guest } = fixture;

const f32 = Math.fround;
const Once = 0, Loop = 1, PingPong = 2;
const advance = (seconds: number): [number, number] => [0, seconds];
const seek = (time: number): [number, number] => [1, time];
const pause: [number, number] = [2, 0];
const resume: [number, number] = [3, 0];
const speed = (value: number): [number, number] => [4, value];

interface Step {
  code: number;
  position: number;
  returning: boolean;
  finished: boolean;
  dropped: number;
  passes: [number, number, boolean][];
  fired: number[];
}

// Plays a timeline of `duration` with cue values 0, 1, ... at `cues`, then
// applies the operations. A refusal ends the list with null.
function run(
  duration: number,
  mode: number,
  cues: number[],
  operations: [number, number][],
): (Step | null)[] {
  const lanes = [duration, mode, cues.length, ...cues, ...operations.flat()];
  const output = Array.from(
    guest.call("run", new Float32Array(lanes)) as Float32Array,
  );
  const steps: (Step | null)[] = [];
  let at = 0;
  while (at < output.length) {
    const code = output[at++];
    if (code === -1) {
      steps.push(null);
      break;
    }
    const [position, returning, finished, dropped, count] = output.slice(
      at,
      at + 5,
    );
    at += 5;
    const passes: [number, number, boolean][] = [];
    for (let i = 0; i < count; i++) {
      passes.push([output[at], output[at + 1], output[at + 2] === 1]);
      at += 3;
    }
    const fired = output.slice(at + 1, at + 1 + output[at]);
    at += 1 + output[at];
    steps.push({
      code,
      position,
      returning: returning === 1,
      finished: finished === 1,
      dropped,
      passes,
      fired,
    });
  }
  return steps;
}

const played = (steps: (Step | null)[]) => steps.map((step) => step!);
const fired = (steps: (Step | null)[]) =>
  played(steps).map((step) => step.fired);

Deno.test("tracks hold their ends and ease each segment by its arriving key", () => {
  const expected: [number, number][] = [
    [-Infinity, 10],
    [0.5, 10],
    [1, 10],
    [1.5, 15],
    [2, 20],
    [3, 10],
    [4, 50],
    [4.9, 50],
    [5, 55],
    [5.99, 55],
    [6, 60],
    [7.99, 60],
    [8, 80],
    [9, 80],
    [Infinity, 80],
  ];
  for (const [time, value] of expected) {
    assertEquals(guest.call("level", time), value, `time ${time}`);
  }
  // Smooth arrives at 0 without reaching it before the duplicate key.
  assert((guest.call("level", f32(3.999)) as number) > 0);
  assertEquals(Array.from(guest.call("span", 0) as Float32Array), [1, 8]);
});

Deno.test("discrete tracks switch exactly at their keys", () => {
  for (const [time, count] of [[-1, 1], [0.999, 1], [1, 2], [1.9999, 2]]) {
    assertEquals(guest.call("held", time), count);
  }
  assertEquals(guest.call("held", 2), 3);
  assertEquals(guest.call("held", 5), 3);
});

Deno.test("rotation tracks slerp between keys", () => {
  const q = Array.from(guest.call("turned", 0.5) as Float32Array);
  [0, Math.sin(0.5), 0, Math.cos(0.5)].forEach((x, i) =>
    assertAlmostEquals(q[i], x, 1e-6)
  );
});

Deno.test("a type declared outside Ink samples through its own lerp", () => {
  const gauge = (time: number) =>
    Array.from(guest.call("gauge", time) as Float32Array);
  assertEquals(gauge(-1), [0, 0.25]);
  assertEquals(gauge(1), [4, 1]);
  assertEquals(gauge(2.5), [5, 1]);
  assertEquals(gauge(4), [2, 0.5]);
});

Deno.test("tracks need finite nondecreasing keys; cue lists may be empty", () => {
  for (const times of [[5], [0, 0, 1], [-1, 2, 2, 2, 3]]) {
    assertEquals(guest.call("keyed", new Float32Array(times)), 1);
  }
  for (
    const times of [[], [NaN], [Infinity], [1, 0], [0, 2, 1], [-3e38, 3e38]]
  ) {
    assertEquals(guest.call("keyed", new Float32Array(times)), 0, `${times}`);
  }
  for (const times of [[], [0, 0], [-1, 5, 5]]) {
    assertEquals(guest.call("listed", new Float32Array(times)), 1);
  }
  for (const times of [[NaN], [1, 0], [0, -Infinity]]) {
    assertEquals(guest.call("listed", new Float32Array(times)), 0);
  }
});

Deno.test("play needs a positive finite duration", () => {
  for (const duration of [0, -1, NaN, Infinity]) {
    assertEquals(guest.call("started", duration), 0);
  }
  assertEquals(guest.call("started", 1e-6), 1);
});

Deno.test("a loop fires each cue once per cycle: the start on restarts, the end on arrival", () => {
  const steps = played(
    run(1, Loop, [0, 0.25, 0.5, 0.5, 1], new Array(4).fill(advance(0.3))),
  );
  assertEquals(fired(steps), [[0, 1], [2, 3], [], [4, 0]]);
  assertEquals(steps[0].passes, [[0, f32(0.3), true]]);
  assertEquals(steps[1].passes, [[f32(0.3), f32(0.6), false]]);
  assertEquals(steps[3].passes[1][0], 0);
  assertEquals(steps[3].passes[1][2], true);
  assertAlmostEquals(steps[3].position, 0.2, 1e-6);
  assert(steps.every((step) => step.dropped === 0 && !step.finished));
});

Deno.test("landing exactly on a loop's end restarts on the next advance, never twice", () => {
  const steps = played(
    run(1, Loop, [0, 1], new Array(17).fill(advance(0.25))),
  );
  const all = steps.flatMap((step) => step.fired);
  assertEquals(all, [0, 1, 0, 1, 0, 1, 0, 1, 0]);
  assertEquals(steps[3].position, 1);
  assertEquals(steps[3].passes, [[0.75, 1, false]]);
  assertEquals(steps[4].passes, [[0, 0.25, true]]);
});

Deno.test("a backward loop fires in reverse, the end on restarts and the start on arrival", () => {
  const steps = played(
    run(1, Loop, [0, 0.25, 0.5, 0.5, 1], [
      speed(-1),
      ...new Array(4).fill(advance(0.3)),
    ]),
  );
  assertEquals(fired(steps), [[], [0, 4], [3, 2], [1], [0, 4]]);
  assertEquals(steps[1].passes, [[0, 0, true], [1, f32(0.7), true]]);
  assertEquals(steps[2].passes, [[f32(0.7), f32(f32(0.7) - f32(0.3)), false]]);
  assertAlmostEquals(steps[4].position, 0.8, 1e-6);
});

Deno.test("a ping-pong passes each end once per turn", () => {
  const steps = played(
    run(1, PingPong, [0, 0.5, 1], [
      advance(0.75),
      advance(0.5),
      advance(1),
      advance(1),
    ]),
  );
  assertEquals(fired(steps), [[0, 1], [2], [1, 0], [1, 2]]);
  assertEquals(steps[1].passes, [[0.75, 1, false], [1, 0.75, false]]);
  assertEquals(steps.map((step) => step.returning), [
    false,
    true,
    false,
    true,
  ]);
  assertEquals(steps.map((step) => step.position), [0.75, 0.75, 0.25, 0.75]);
});

Deno.test("a once playback finishes at its end, stops, and replays after a seek", () => {
  const steps = played(
    run(1, Once, [0, 1], [
      advance(0.6),
      advance(0.6),
      advance(0.6),
      resume,
      advance(0.1),
      seek(0),
      resume,
      advance(1.5),
    ]),
  );
  assertEquals(fired(steps), [[0], [1], [], [], [], [], [], [0, 1]]);
  assertEquals(steps.map((step) => step.finished), [
    false,
    true,
    false,
    false,
    true,
    false,
    false,
    true,
  ]);
  assertEquals(steps[1].position, 1);
  assertEquals(steps[2].passes, []);
  assertEquals(steps[4].passes, []);
  assertEquals(steps[7].passes, [[0, 1, true]]);
});

Deno.test("a backward once playback finishes at the start", () => {
  const steps = played(
    run(2, Once, [0, 1, 2], [speed(-1), seek(2), advance(0.5), advance(5)]),
  );
  assertEquals(fired(steps), [[], [], [2], [1, 0]]);
  assertEquals(steps[3].finished, true);
  assertEquals(steps[3].position, 0);
});

Deno.test("seeking fires nothing and the next pass includes the new time", () => {
  const steps = played(
    run(1, Loop, [0.25, 0.5, 0.75], [
      advance(0.1),
      seek(0.75),
      advance(0.1),
      seek(-3),
      seek(0.5),
      pause,
      advance(1),
      resume,
      advance(0.1),
    ]),
  );
  assertEquals(fired(steps), [[], [], [2], [], [], [], [], [], [1]]);
  assertEquals(steps[3].position, 0);
  assertEquals(steps[6].position, 0.5);
  assertEquals(steps[6].passes, []);
  assertEquals(steps[8].passes, [[0.5, f32(0.6), true]]);
});

Deno.test("zero travel moves nowhere and fires nothing", () => {
  const steps = played(
    run(1, Loop, [0], [advance(0), speed(0), advance(5), speed(1)]),
  );
  assert(steps.every((step) => step.passes.length === 0));
  // The start is still fresh once playback moves.
  const later = played(
    run(1, Loop, [0], [advance(0), advance(0.5)]),
  );
  assertEquals(fired(later), [[], [0]]);
});

Deno.test("a long advance keeps at most 64 passes and reports dropped cycles", () => {
  const [loop] = played(run(1, Loop, [0.5], [advance(1000.25)]));
  assertEquals(loop.passes.length, 64);
  assertEquals(loop.dropped, 937);
  assertEquals(loop.position, 0.25);
  assertEquals(loop.fired.length, 63);
  assertEquals(loop.passes[0], [0, 1, true]);
  assertEquals(loop.passes[63], [0, 0.25, true]);
  // A ping-pong drops whole round trips, so its passes stay continuous.
  const [bounce] = played(run(1, PingPong, [0.5], [advance(100.5)]));
  assertEquals(bounce.passes.length, 63);
  assertEquals(bounce.dropped, 38);
  assertEquals(bounce.position, 0.5);
  assertEquals(bounce.returning, false);
  for (let i = 1; i < bounce.passes.length; i++) {
    assertEquals(bounce.passes[i][0], bounce.passes[i - 1][1]);
  }
  const [back] = played(run(1, PingPong, [], [advance(101.5)]));
  assertEquals([back.position, back.returning], [0.5, true]);
  assertEquals([back.passes.length, back.dropped], [64, 38]);
});

Deno.test("cue counts and order match exact traversal over many random steps", () => {
  const cues = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k / 8);
  let seed = 12345;
  const operations: [number, number][] = [];
  let total = 0;
  for (let i = 0; i < 300; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const seconds = (1 + (seed >>> 16) % 40) / 64;
    operations.push(advance(seconds));
    total += seconds;
  }
  const loop = played(run(1, Loop, cues, operations));
  const order = loop.flatMap((step) => step.fired);
  for (let k = 0; k < 8; k++) {
    const expected = k === 0
      ? Math.ceil(total)
      : Math.floor(total - cues[k]) + 1;
    assertEquals(order.filter((value) => value === k).length, expected);
  }
  order.forEach((value, i) => assertEquals(value, i % 8));
  assertAlmostEquals(loop[loop.length - 1].position, total % 1 || 1, 1e-6);
  // A ping-pong sweeps up and down, passing the start once per turn.
  const bounce = played(run(1, PingPong, cues, operations));
  const sweep = [1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0];
  const sweeps = bounce.flatMap((step) => step.fired);
  assertEquals(sweeps[0], 0);
  sweeps.slice(1).forEach((value, i) => assertEquals(value, sweep[i % 15]));
  // Cues lie every eighth of travel, but none at the turn at 1.
  let crossings = 1;
  for (let j = 1; j <= total * 8; j++) if (j % 16 !== 8) crossings++;
  assertEquals(sweeps.length, crossings);
});

Deno.test("advance refuses negative or non-finite seconds and overflowing travel", () => {
  for (const seconds of [-1, NaN, Infinity]) {
    assertEquals(run(1, Loop, [], [advance(seconds)]), [null]);
  }
  assertEquals(run(1, Loop, [], [speed(NaN)]), [null]);
  assertEquals(run(1, Loop, [], [seek(NaN)]), [null]);
  assertEquals(run(1, Loop, [], [speed(3e38), advance(10)]).at(-1), null);
  assertEquals(run(1e-30, Loop, [], [advance(1e10)]), [null]);
});

Deno.test("the playback codec round-trips and rejects invalid lanes", () => {
  const saved = Array.from(guest.call("saved", 0) as Float32Array);
  assertEquals(saved, [1.25, 2.5, -1.5, 2, 0, 0, 1]);
  assertEquals(
    Array.from(guest.call("restored", new Float32Array(saved)) as Float32Array),
    saved,
  );
  assertEquals(Array.from(guest.call("codec_key", 0) as Uint32Array), [17, 1]);
  for (
    const lanes of [
      saved.slice(0, 6),
      [...saved, 0],
      [3, 2.5, 1, 0, 1, 0, 0],
      [-0.5, 2.5, 1, 0, 1, 0, 0],
      [0, 0, 1, 0, 1, 0, 0],
      [0, 1, NaN, 0, 1, 0, 0],
      [0, 1, 1, 3, 1, 0, 0],
      [0, 1, 1, 0.5, 1, 0, 0],
      [0, 1, 1, 0, 2, 0, 0],
    ]
  ) {
    assertThrows(() => guest.call("restored", new Float32Array(lanes)));
  }
});

Deno.test.afterAll(() => fixture.dispose());

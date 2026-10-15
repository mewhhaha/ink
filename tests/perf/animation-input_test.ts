import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { compile } from "../support.ts";

const fixture = await compile(
  new URL("./animation-input.blot", import.meta.url),
);
const { guest } = fixture;
function call(entry: string, values: number[]) {
  return Array.from(
    guest.call(entry, new Float32Array(values)) as Float32Array,
  );
}

function position(times: number[], time: number) {
  if (times.length === 0) return 0;
  if (time < times[0]) return 0;
  for (let i = 1; i < times.length; i++) {
    if (time < times[i]) {
      return i - 1 + (time - times[i - 1]) / (times[i] - times[i - 1]);
    }
  }
  return times.length - 1;
}

Deno.test("animation key lookup matches a linear oracle at duplicates and boundaries", () => {
  for (const count of [0, 1, 2, 16, 128, 1024, 8192]) {
    const times = Array.from({ length: count }, (_, i) => Math.floor(i / 3));
    for (
      const time of [
        -Infinity,
        -1,
        0,
        0.25,
        1,
        1.75,
        count / 3 - 0.25,
        count,
        ...times.slice(0, 3),
        ...times.slice(-3),
        Infinity,
        NaN,
      ]
    ) {
      const result = call("sample", [time, ...times]);
      assertAlmostEquals(result[0], position(times, Math.fround(time)), 0.001);
      assertEquals(result.slice(1), [0, 0, 0, 0, 0, 1, 1, 1, 1]);
    }
  }
  for (const times of [[2], [2, 2, 2], [2, 2, 4, 4, 5], [2, 3, 3, 3, 8]]) {
    for (const time of [-1, 2, 2.5, 3, 4, 4.5, 5, 8, NaN]) {
      assertAlmostEquals(
        call("sample", [time, ...times])[0],
        position(times, time),
        0.001,
      );
    }
  }
});

Deno.test("animation late lookup workloads replay their numerical witnesses", () => {
  for (const count of [16, 128, 1024, 8192]) {
    let expected = 0;
    for (let i = 0; i < 1024; i++) {
      expected = Math.fround(expected + count - 2 + (i % 4) * 0.25);
    }
    assertEquals(guest.call("late_queries", count), expected);
    assertEquals(guest.call("late_queries", count), expected);
  }
});

function lanes(keys: number[], fresh = [9, 9, 3], buttons = [7, 0, 2]) {
  return [
    1,
    -2,
    3,
    -4,
    1,
    fresh.length,
    ...fresh,
    keys.length,
    ...keys,
    ...buttons,
  ];
}
Deno.test("input restore keeps authored ordering across bounded unique key sets", () => {
  for (const count of [0, 1, 64, 128, 256, 512]) {
    const keys = Array.from({ length: count }, (_, i) => 16777215 - i * 11);
    const values = lanes(keys);
    assertEquals(call("restore", values), values);
    assertEquals(
      guest.call("input_codec", count),
      new Uint32Array([
        count,
        count * (count + 1) * (count + 2) / 6,
      ]),
    );
    assertEquals(call("restore", values), values);
  }
  const values = lanes(
    Array.from({ length: 512 }, (_, i) => i),
    Array(512).fill(1),
    [7, 6, 5, 4, 3, 2, 1, 0],
  );
  assertEquals(call("restore", values), values);
});

Deno.test("input restore rejects early and late duplicates, invalid lanes and oversized buttons", () => {
  const keys = Array.from({ length: 512 }, (_, i) => i);
  const early = keys.slice();
  early[1] = 0;
  const late = keys.slice();
  late[511] = 0;
  const invalid = [
    [],
    [0, 0, 0, 0, 0, 0],
    lanes(early),
    lanes(late),
    lanes([1, 1]),
    lanes([1], [], [7, 7]),
    lanes([1], [], [8]),
    lanes([NaN]),
    lanes([Infinity]),
    lanes([-1]),
    lanes([0.5]),
    lanes([16777216]),
    lanes(Array(513).fill(1)),
    lanes([], Array(513).fill(1)),
    lanes([], [], Array(9).fill(0)),
    lanes([], [], Array(2048).fill(0)),
    [0, 0, 0, 0, 0, 512, 0],
    [0, 0, 0, 0, 0, 0, 512],
    [0, 0, 0, 0, 2, 0, 0],
  ];
  for (const values of invalid) {
    assertThrows(() => call("restore", values));
  }
});

Deno.test.afterAll(() => fixture.dispose());

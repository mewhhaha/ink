import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./support.ts";
const entry = new URL("./persist.blot", import.meta.url);
const fixture = await compile(entry);
const { guest } = fixture;
for (
  const match of (await Deno.readTextFile(entry)).matchAll(
    /entry const (test_\w+)/g,
  )
) {
  Deno.test(match[1].replaceAll("_", " "), () => {
    const result = guest.call(match[1], null) as Float32Array;
    assertEquals(result[1], 0, JSON.stringify(Array.from(result)));
  });
}
Deno.test("persistence migrates records, resets missing values and reports dropped sections", () => {
  assertEquals(Array.from(guest.call("migrated", null) as Float32Array), [
    6,
    4,
    7,
    5680,
    4,
    0,
    0,
    1,
    1,
    100,
    3,
    0,
    1,
    101,
    1,
    1,
    2,
    999,
    4,
    1,
    0,
  ]);
});
Deno.test("persistence rejects malformed section framing before walking or allocating payloads", () => {
  const invalid = [
    [],
    [5678, 1],
    [5678, 2, 0],
    [5678, 1, 16777215],
    [5678, 1, 1],
    [5678, 1, 1, 0, 1, 0, 4294967296],
    [5678, 1, 1, 0, 1, 0, 1],
    [5678, 1, 0, 7],
    [5678, 1, 1, 0, 1, 0, 1, NaN],
    [5678, 1, 2, 0, 1, 0, 0, 0, 1, 0, 0],
    // Duplicate keys are found wherever they lie, here first and last.
    [5678, 1, 3, 3, 1, 0, 0, 9, 1, 0, 0, 3, 1, 0, 0],
  ];
  for (const values of invalid) {
    assertThrows(() => guest.call("split", new Float32Array(values)));
  }
  const distinct = [5678, 1, 3, 9, 1, 0, 0, 3, 1, 0, 0, 5, 1, 0, 0];
  assertEquals(guest.call("split", new Float32Array(distinct)), 3);
});
Deno.test("persistence rejects bad alive flags, dead components and nonzero absent padding", () => {
  const badAlive = [5678, 1, 1, 0, 1, 0, 1, 2];
  assertThrows(() => guest.call("restore", new Float32Array(badAlive)));
  for (const record of [[1, 4, 1, 3], [0, 4, 0, 0]]) {
    const values = [5678, 1, 2, 0, 1, 0, 1, 0, 101, 2, 1, 4, ...record];
    assertThrows(() => guest.call("restore", new Float32Array(values)));
  }
});
Deno.test("numeric codecs reject overflowing ranges and retain every U32 seed bit", () => {
  assertEquals(
    guest.call("whole", new Float32Array([65535, 65535])),
    0xffffffff,
  );
  for (const values of [[-1, 0], [0, 65536], [0.5, 0], [Infinity, 0], [0]]) {
    assertThrows(() => guest.call("whole", new Float32Array(values)));
  }
  for (const start of [1, 2, 0xffffffff]) {
    assertThrows(() => guest.call("bounds", start));
  }
});
Deno.test.afterAll(() => fixture.dispose());

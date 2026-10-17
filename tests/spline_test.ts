import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./spline.blot", import.meta.url));
const { guest } = fixture;

type Point = [number, number, number];

const call = (entry: string, values: number[]) =>
  Array.from(guest.call(entry, new Float32Array(values)) as Float32Array);
const query = (closed: boolean, distances: number[], points: Point[]) =>
  call("query", [
    closed ? 1 : 0,
    distances.length,
    ...distances,
    ...points.flat(),
  ]);
const walk = (closed: boolean, steps: number, points: Point[]) => {
  const result = call("walk", [closed ? 1 : 0, steps, ...points.flat()]);
  const samples: Point[] = [];
  for (let i = 1; i < result.length; i += 3) {
    samples.push([result[i], result[i + 1], result[i + 2]]);
  }
  return { length: result[0], samples };
};
const gap = (a: Point, b: Point) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const circle = (count: number, radius: number): Point[] =>
  Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return [radius * Math.cos(angle), 2, radius * Math.sin(angle)];
  });
// A winding path with uneven spacing, close points and a sharp turn.
const winding: Point[] = [
  [0, 0, 0],
  [4, 1, 0],
  [4.3, 1, 0.2],
  [9, 0, 3],
  [9, 2, -6],
  [2, 0, -5],
];

Deno.test("a straight line's length is exact and its points run evenly along it", () => {
  const line: Point[] = [[1, 2, 3], [2, 2, 3], [4.5, 2, 3], [5, 2, 3]];
  const { length, samples } = walk(false, 40, line);
  assertAlmostEquals(length, 4, 1e-5);
  for (const [i, [x, y, z]] of samples.entries()) {
    assertAlmostEquals(x, 1 + i * 0.1, 1e-5);
    assertEquals([y, z], [2, 3]);
  }
  // Two points make the chord itself, with its direction as the tangent.
  const [two, px, py, pz, tx, ty, tz] = query(false, [1.5], [
    [0, 0, 0],
    [0, 3, 4],
  ]);
  assertAlmostEquals(two, 5, 1e-6);
  assertAlmostEquals(px, 0, 1e-6);
  assertAlmostEquals(py, 0.9, 1e-6);
  assertAlmostEquals(pz, 1.2, 1e-6);
  assertAlmostEquals(tx, 0, 1e-6);
  assertAlmostEquals(ty, 0.6, 1e-6);
  assertAlmostEquals(tz, 0.8, 1e-6);
});

Deno.test("the curve passes through every point at its mark", () => {
  for (const [closed, points] of [[false, winding], [true, winding]] as const) {
    const result = call("marks", [closed ? 1 : 0, ...points.flat()]);
    const marks = result.slice(0, points.length);
    assertEquals(result.length, points.length * 4);
    assertEquals(marks[0], 0);
    for (let i = 1; i < marks.length; i++) {
      // Each mark is at least the chord from the one before.
      assert(marks[i] - marks[i - 1] >= gap(points[i], points[i - 1]) - 1e-4);
    }
    for (const [i, point] of points.entries()) {
      const at = result.slice(points.length + i * 3, points.length + i * 3 + 3);
      assert(gap(at as Point, point) < 1e-5, `point ${i}: ${at}`);
    }
  }
  const open = call("marks", [0, ...winding.flat()]);
  const [length] = query(false, [], winding);
  assertEquals(open[winding.length - 1], length);
});

Deno.test("a loop around a circle is close to its circumference and closes smoothly", () => {
  for (const [count, tolerance] of [[8, 0.005], [16, 0.0005]]) {
    const points = circle(count, 10);
    const [length] = query(true, [], points);
    assert(
      Math.abs(length - 20 * Math.PI) < 20 * Math.PI * tolerance,
      `${count} points: ${length}`,
    );
    const { samples } = walk(true, 64, points);
    for (const [x, y, z] of samples) {
      assertAlmostEquals(Math.hypot(x, z), 10, 10 * tolerance * 4);
      assertEquals(y, 2);
    }
    // The walk ends where it began.
    assert(gap(samples[0], samples[64]) < 1e-4);
  }
  // Wrapped distances: a lap on, a lap back and the end of a lap.
  const points = circle(12, 5);
  const [length, ...start] = query(true, [0.75], points);
  for (const distance of [0.75 + length, 0.75 - length, 0.75 + 3 * length]) {
    const [, ...again] = query(true, [distance], points);
    for (let i = 0; i < 6; i++) assertAlmostEquals(again[i], start[i], 1e-3);
  }
  const [, ...end] = query(true, [length], points);
  for (let i = 0; i < 3; i++) assertAlmostEquals(end[i], points[0][i], 1e-4);
});

Deno.test("equal distance steps give nearly equal chords", () => {
  for (
    const [closed, points] of [
      [false, winding],
      [true, winding],
      [true, circle(5, 3)],
    ] as const
  ) {
    const steps = 400;
    const { length, samples } = walk(closed, steps, points);
    const chords = samples.slice(1).map((p, i) => gap(p, samples[i]));
    const step = length / steps;
    for (const chord of chords) {
      // Chords fall short of the arc only by the curve's bending.
      assert(
        chord <= step * 1.0002 && chord >= step * 0.99,
        `${chord} vs ${step}`,
      );
    }
    const spread = Math.max(...chords) - Math.min(...chords);
    assert(spread < step * 0.01, `spread ${spread} of ${step}`);
  }
});

Deno.test("tangents are unit, follow the curve and continue across points", () => {
  const distances = Array.from({ length: 200 }, (_, i) => i * 0.15);
  const result = query(false, distances, winding);
  const at = (i: number) => result.slice(1 + i * 6, 7 + i * 6);
  for (let i = 0; i < distances.length; i++) {
    const [x, y, z, tx, ty, tz] = at(i);
    assertAlmostEquals(Math.hypot(tx, ty, tz), 1, 1e-5);
    if (i + 1 < distances.length && distances[i + 1] < result[0]) {
      const [nx, ny, nz] = at(i + 1);
      const chord = gap([nx, ny, nz], [x, y, z]);
      const along = ((nx - x) * tx + (ny - y) * ty + (nz - z) * tz) / chord;
      assert(along > 0.95, `heading ${along} at ${distances[i]}`);
    }
  }
  // Either side of a point the direction barely changes.
  const marks = call("marks", [0, ...winding.flat()]).slice(0, winding.length);
  for (const mark of marks.slice(1, -1)) {
    const [, , , , ax, ay, az, , , , bx, by, bz] = query(false, [
      mark - 1e-3,
      mark + 1e-3,
    ], winding);
    assert(ax * bx + ay * by + az * bz > 0.999, `kink at ${mark}`);
  }
});

Deno.test("distances hold to an open curve's ends", () => {
  const [length, ...result] = query(false, [-5, 1e9, NaN, Infinity], winding);
  const end = winding[winding.length - 1];
  assertEquals(result.slice(0, 3), [0, 0, 0]);
  for (let i = 0; i < 3; i++) assertAlmostEquals(result[6 + i], end[i], 1e-5);
  assertEquals(result.slice(12, 15), [0, 0, 0]);
  assert(length > 0);
  // The end tangent is the last chord's direction: the mirrored end.
  const before = winding[winding.length - 2];
  const last = [end[0] - before[0], end[1] - before[1], end[2] - before[2]];
  for (let i = 0; i < 3; i++) {
    assertAlmostEquals(result[9 + i], last[i] / Math.hypot(...last), 1e-5);
  }
  // Any non-finite distance is the start, as NaN is.
  assertEquals(result.slice(18, 21), [0, 0, 0]);
  const [, ...looped] = query(true, [NaN, -Infinity], winding);
  assertEquals(looped.slice(0, 3), [0, 0, 0]);
  assertEquals(looped.slice(6, 9), [0, 0, 0]);
});

Deno.test("repeated points are skipped; too few distinct or non-finite points are refused", () => {
  const doubled: Point[] = [
    [0, 0, 0],
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
    [3, 0, 0],
  ];
  const [length] = query(false, [], doubled);
  assertAlmostEquals(length, 3, 1e-5);
  assertEquals(call("marks", [0, ...doubled.flat()]).length, 3 * 4);
  // A loop's repeated first point closes it rather than adding a segment.
  const square: Point[] = [[0, 0, 0], [2, 0, 0], [2, 0, 2], [0, 0, 2]];
  const closed = query(true, [], square);
  assertEquals(query(true, [], [...square, [0, 0, 0]]), closed);
  for (
    const [loop, points] of [
      [false, []],
      [false, [[1, 2, 3]]],
      [false, [[1, 2, 3], [1, 2, 3]]],
      [false, [[0, 0, 0], [NaN, 0, 0]]],
      [false, [[0, 0, 0], [Infinity, 0, 0], [1, 0, 0]]],
      [false, [[0, 0, 0], [3e38, 0, 0], [-3e38, 0, 0]]],
      [true, [[0, 0, 0], [1, 0, 0]]],
      [true, [[0, 0, 0], [1, 0, 0], [0, 0, 0]]],
    ] as [boolean, Point[]][]
  ) {
    assertEquals(query(loop, [], points), [], JSON.stringify(points));
  }
});

Deno.test.afterAll(() => fixture.dispose());

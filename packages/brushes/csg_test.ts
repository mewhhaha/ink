import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { boxBrush, mat4, pointInBrush, quat } from "@ink/geometry";
import { brushVolume, mergeBrushes, subtractBrush } from "./csg.ts";
import { brushVertices } from "./edit.ts";

Deno.test("subtraction carves an interior cavity into disjoint convex pieces", () => {
  const source = {
    matrix: mat4.identity(),
    faces: boxBrush([-2, -2, -2], [2, 2, 2]),
  };
  const cutter = {
    matrix: mat4.identity(),
    faces: boxBrush([-1, -1, -1], [1, 1, 1]),
  };
  const pieces = subtractBrush(source, cutter);
  assertEquals(pieces.length, 6);
  assertAlmostEquals(
    pieces.reduce((v, p) => v + brushVolume(p.faces), 0),
    56,
    1e-5,
  );
  for (let x = -1.9; x < 2; x += 0.4) {
    for (let y = -1.9; y < 2; y += 0.4) {
      for (let z = -1.9; z < 2; z += 0.4) {
        const insideCut = pointInBrush(cutter.faces.map((f) => f.plane), [
          x,
          y,
          z,
        ]);
        assertEquals(
          pieces.filter((p) =>
            pointInBrush(p.faces.map((f) => f.plane), [x, y, z])
          ).length,
          insideCut ? 0 : 1,
        );
      }
    }
  }
  assertEquals(subtractBrush(source, source), []);
  const touching = {
    ...cutter,
    matrix: mat4.compose([3, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
  };
  assertAlmostEquals(
    subtractBrush(source, touching).reduce(
      (v, p) => v + brushVolume(p.faces),
      0,
    ),
    64,
    1e-5,
  );
});

Deno.test("CSG handles rotated, mirrored, nonuniform parent transforms", () => {
  const parent = mat4.compose([4, -2, 7], quat.fromEuler([20, 30, 40]), [
    -2,
    1,
    0.5,
  ]);
  const source = { matrix: parent, faces: boxBrush([-2, -2, -2], [2, 2, 2]) };
  const cutter = {
    matrix: mat4.multiply(
      parent,
      mat4.compose([0.5, 0, 0], quat.fromEuler([0, 30, 0]), [1, 1, 1]),
    ),
    faces: boxBrush([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]),
  };
  const pieces = subtractBrush(source, cutter);
  assertAlmostEquals(
    pieces.reduce((v, p) => v + brushVolume(p.faces), 0),
    63,
    1e-4,
  );
  assert(pieces.every((p) => p.matrix === parent));
  const merged = mergeBrushes([source, cutter])!;
  assertAlmostEquals(brushVolume(merged.faces), 64, 1e-4);
  const second = {
    ...source,
    matrix: mat4.multiply(
      parent,
      mat4.compose([4, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
    ),
  };
  const union = mergeBrushes([source, second])!;
  assertAlmostEquals(brushVolume(union.faces), 128, 1e-4);
  assertEquals(brushVertices(union.faces).length, 8);
});

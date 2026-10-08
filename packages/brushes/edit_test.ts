import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  brushBounds,
  type BrushFace,
  brushPolygons,
  brushUv,
  mat4,
  quat,
  type Vec3,
} from "@ink/geometry";
import {
  alignFace,
  type BrushEntityData,
  brushVertices,
  brushWorldBounds,
  clipBrushEntity,
  clipPlaneThrough,
  dragBox,
  fitFace,
  moveBrushVertices,
  newBrushComponents,
  nextClipKeep,
  resizeBrush,
} from "./edit.ts";

const entityOf = (min: Vec3, max: Vec3): BrushEntityData => {
  const c = newBrushComponents(min, max, { texture: 3 }) as {
    transform: { position: Vec3 };
    brush: { faces: BrushFace[] };
  };
  return {
    matrix: mat4.compose(c.transform.position, [0, 0, 0, 1], [1, 1, 1]),
    faces: c.brush.faces,
  };
};

Deno.test("new brush is centred with local planes", () => {
  const c = newBrushComponents([0, 0, 0], [4, 2, 6], { texture: "t.png" }) as {
    transform: { position: Vec3; rotation: number[]; scale: number[] };
    brush: { faces: BrushFace[] };
  };
  assertEquals(c.transform.position, [2, 1, 3]);
  assertEquals(c.transform.rotation, [0, 0, 0, 1]);
  assertEquals(c.transform.scale, [1, 1, 1]);
  assertEquals(c.brush.faces.length, 6);
  assertEquals(c.brush.faces[0].plane, [1, 0, 0, 2]);
  assertEquals(c.brush.faces[1].plane, [-1, 0, 0, 2]);
  assertEquals(c.brush.faces[0].texture as unknown, "t.png");
  assertEquals(brushBounds(c.brush.faces), {
    min: [-2, -1, -3],
    max: [2, 1, 3],
  });
});

Deno.test("dragBox fills the view axis from the third extent", () => {
  const box = dragBox([0, 2], [4, 99, 3], [1, -5, -1], [0, 2.5]);
  assertEquals(box, { min: [1, 0, -1], max: [4, 2.5, 3] });
});

Deno.test("resize moves one side without moving the opposite side or pivot", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  const r = resizeBrush(e, [{ axis: 0, side: 1, value: 8 }])!;
  assertEquals(brushWorldBounds(r), { min: [0, 0, 0], max: [8, 2, 4] });
  assertEquals(r.matrix, e.matrix);
  const l = resizeBrush(e, [{ axis: 2, side: -1, value: -2 }, {
    axis: 1,
    side: 1,
    value: 3,
  }])!;
  assertEquals(brushWorldBounds(l), { min: [0, 0, -2], max: [4, 3, 4] });
});

Deno.test("resize refuses to collapse", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  assertEquals(resizeBrush(e, [{ axis: 0, side: 1, value: -1 }], 0.25), null);
  assert(resizeBrush(e, [{ axis: 0, side: 1, value: 0.5 }], 0.25));
});

Deno.test("resize keeps textures pinned to the world", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  e.faces[2] = { ...e.faces[2], offset: [5, 7], rotation: 30, scale: [2, 1] };
  const world = (en: BrushEntityData, p: Vec3) =>
    brushUv(en.faces[2], mat4.transformPoint(mat4.invert(en.matrix), p));
  const r = resizeBrush(e, [{ axis: 0, side: -1, value: -6 }])!;
  const p: Vec3 = [1.5, 2, 1];
  const a = world(e, p), b = world(r, p);
  assertAlmostEquals(a[0], b[0], 1e-6);
  assertAlmostEquals(a[1], b[1], 1e-6);
});

Deno.test("clip plane through two points faces left of the line", () => {
  // Top view: the viewer is at +Y; a line along +X has +Z-up... normal is -Z.
  const plane = clipPlaneThrough([0, 0, 1], [4, 0, 1], [0, 1, 0])!;
  assertAlmostEquals(plane[2], -1);
  assertAlmostEquals(plane[3], -1);
  assertEquals(clipPlaneThrough([1, 0, 1], [1, 0, 1], [0, 1, 0]), null);
});

Deno.test("clip splits a brush while retaining its pivot", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  const plane = clipPlaneThrough([2, 0, 0], [2, 0, 4], [0, 1, 0])!;
  const result = clipBrushEntity(e, plane)!;
  const a = brushWorldBounds(result.front)!, b = brushWorldBounds(result.back)!;
  const xs = [[a.min[0], a.max[0]], [b.min[0], b.max[0]]].sort((p, q) =>
    p[0] - q[0]
  );
  assertEquals(xs, [[0, 2], [2, 4]]);
  assertEquals(result.front.faces.length, 6);
  assertEquals(result.front.matrix, e.matrix);
  assertEquals(result.back.matrix, e.matrix);
});

Deno.test("clip along a diagonal keeps a wedge", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  const plane = clipPlaneThrough([0, 0, 0], [4, 0, 4], [0, 1, 0])!;
  const result = clipBrushEntity(e, plane)!;
  assertEquals(result.front.faces.length, 5);
  assertEquals(result.back.faces.length, 5);
});

Deno.test("clip that misses the brush returns null", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  const plane = clipPlaneThrough([10, 0, 0], [10, 0, 4], [0, 1, 0])!;
  assertEquals(clipBrushEntity(e, plane), null);
});

Deno.test("fit and align use the face polygon", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  const polygons = brushPolygons(e.faces.map((f) => f.plane));
  const top = fitFace(e.faces[2], polygons[2], [64, 64]);
  // 4 m wide at 64 texels per metre is 256 texels: the 64 px texture is
  // stretched four times.
  assertAlmostEquals(Math.abs(top.scale[0]), 4, 1e-6);
  assertAlmostEquals(Math.abs(top.scale[1]), 4, 1e-6);
  const corner = brushUv(top, polygons[2][0], [1, 1]);
  assert(Math.abs(corner[0]) < 1e-6 || Math.abs(corner[0] - 64) < 1e-6);
  const aligned = alignFace(e.faces[2], polygons[2]);
  assert(Number.isFinite(aligned.offset[0]));
});

Deno.test("resize and clip work through a rotated, mirrored, scaled parent", () => {
  const e = entityOf([-1, -1, -1], [1, 1, 1]);
  e.matrix = mat4.multiply(
    mat4.compose([6, 3, -2], quat.fromAxisAngle([0, 1, 0], 0.6), [2, 1, -3]),
    mat4.compose([1, 0, 0], quat.fromAxisAngle([0, 0, 1], 0.3), [1, 2, 1]),
  );
  const original = structuredClone(e);
  const before = brushWorldBounds(e)!;
  const resized = resizeBrush(e, [{
    axis: 0,
    side: 1,
    value: before.max[0] + 3,
  }])!;
  const after = brushWorldBounds(resized)!;
  for (let k = 0; k < 3; k++) {
    assertAlmostEquals(after.min[k], before.min[k], 1e-4);
    assertAlmostEquals(after.max[k], before.max[k] + (k === 0 ? 3 : 0), 1e-4);
  }
  const x = (before.min[0] + before.max[0]) / 2;
  const pieces = clipBrushEntity(e, [1, 0, 0, x])!;
  assert(pieces);
  for (const [piece, sign] of [[pieces.front, 1], [pieces.back, -1]] as const) {
    assertEquals(piece.matrix, original.matrix);
    for (const p of brushPolygons(piece.faces.map((f) => f.plane)).flat()) {
      const world = mat4.transformPoint(piece.matrix, p);
      assert((world[0] - x) * sign > -1e-4);
    }
  }
  assertEquals(e, original, "edits do not mutate the snapshot");
});

Deno.test("collapsed brush transforms cannot be edited", () => {
  const e = entityOf([-1, -1, -1], [1, 1, 1]);
  e.matrix = mat4.compose([0, 0, 0], [0, 0, 0, 1], [0, 1, 1]);
  assertEquals(resizeBrush(e, [{ axis: 0, side: 1, value: 3 }]), null);
  assertEquals(clipBrushEntity(e, [0, 1, 0, 0]), null);
});

Deno.test("clip keep cycles", () => {
  assertEquals(nextClipKeep("front"), "back");
  assertEquals(nextClipKeep("both"), "front");
});

Deno.test("vertex and edge edits rebuild a convex solid and reject flat results", () => {
  const e = entityOf([-1, -1, -1], [1, 1, 1]);
  const vertices = brushVertices(e.faces);
  const top = vertices.flatMap((p, i) => p[1] > 0 ? [i] : []);
  const raised = moveBrushVertices(e, top, [0, 2, 0])!;
  assertEquals(brushWorldBounds(raised), { min: [-1, -1, -1], max: [1, 3, 1] });
  assertEquals(moveBrushVertices(e, top, [0, -2, 0]), null);
  const edge = vertices.flatMap((p, i) => p[1] > 0 && p[0] > 0 ? [i] : []);
  const sloped = moveBrushVertices(e, edge, [0, 1, 0])!;
  assert(
    sloped.faces.some((f) =>
      Math.abs(f.plane[0]) > 0.1 && Math.abs(f.plane[1]) > 0.1
    ),
  );
  assertEquals(sloped.matrix, e.matrix);
  const moved = moveBrushVertices(e, [7], [0.5, 0.5, 0.5])!;
  assert(
    moved.faces.length > 6,
    "moving one corner triangulates the changed faces",
  );
  assertEquals(brushWorldBounds(e), { min: [-1, -1, -1], max: [1, 1, 1] });
});

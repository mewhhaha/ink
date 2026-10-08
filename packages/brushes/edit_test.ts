import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  brushBounds,
  type BrushFace,
  brushPolygons,
  brushUv,
  type Vec3,
} from "@ink/geometry";
import {
  alignFace,
  type BrushEntityData,
  brushWorldBounds,
  clipBrushEntity,
  clipPlaneThrough,
  dragBox,
  fitFace,
  isTranslationOnly,
  newBrushComponents,
  nextClipKeep,
  rebaseBrush,
  resizeBrush,
} from "./edit.ts";

const entityOf = (min: Vec3, max: Vec3): BrushEntityData => {
  const c = newBrushComponents(min, max, { texture: 3 }) as {
    transform: { position: Vec3 };
    brush: { faces: BrushFace[] };
  };
  return { position: c.transform.position, faces: c.brush.faces };
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

Deno.test("resize moves one side and recentres without moving the rest", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  const r = resizeBrush(e, [{ axis: 0, side: 1, value: 8 }])!;
  assertEquals(brushWorldBounds(r), { min: [0, 0, 0], max: [8, 2, 4] });
  assertEquals(r.position, [4, 1, 2]);
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
    brushUv(en.faces[2], [
      p[0] - en.position[0],
      p[1] - en.position[1],
      p[2] - en.position[2],
    ]);
  const r = resizeBrush(e, [{ axis: 0, side: -1, value: -6 }])!;
  const p: Vec3 = [1.5, 2, 1];
  const a = world(e, p), b = world(r, p);
  assertAlmostEquals(a[0], b[0], 1e-6);
  assertAlmostEquals(a[1], b[1], 1e-6);
});

Deno.test("rebase of a centred brush is a no-op", () => {
  const e = entityOf([-1, -1, -1], [1, 1, 1]);
  assertEquals(rebaseBrush(e).position, e.position);
});

Deno.test("clip plane through two points faces left of the line", () => {
  // Top view: the viewer is at +Y; a line along +X has +Z-up... normal is -Z.
  const plane = clipPlaneThrough([0, 0, 1], [4, 0, 1], [0, 1, 0])!;
  assertAlmostEquals(plane[2], -1);
  assertAlmostEquals(plane[3], -1);
  assertEquals(clipPlaneThrough([1, 0, 1], [1, 0, 1], [0, 1, 0]), null);
});

Deno.test("clip splits a brush into two rebased halves", () => {
  const e = entityOf([0, 0, 0], [4, 2, 4]);
  const plane = clipPlaneThrough([2, 0, 0], [2, 0, 4], [0, 1, 0])!;
  const result = clipBrushEntity(e, plane)!;
  const a = brushWorldBounds(result.front)!, b = brushWorldBounds(result.back)!;
  const xs = [[a.min[0], a.max[0]], [b.min[0], b.max[0]]].sort((p, q) =>
    p[0] - q[0]
  );
  assertEquals(xs, [[0, 2], [2, 4]]);
  assertEquals(result.front.faces.length, 6);
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

Deno.test("translation-only transforms", () => {
  assert(isTranslationOnly({ rotation: [0, 0, 0, 1], scale: [1, 1, 1] }));
  assert(
    !isTranslationOnly({ rotation: [0, 0.7071, 0, 0.7071], scale: [1, 1, 1] }),
  );
  assert(!isTranslationOnly({ rotation: [0, 0, 0, 1], scale: [2, 1, 1] }));
});

Deno.test("clip keep cycles", () => {
  assertEquals(nextClipKeep("front"), "back");
  assertEquals(nextClipKeep("both"), "front");
});

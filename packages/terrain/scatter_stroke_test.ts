import { assert, assertEquals } from "@std/assert";
import { type Placement, ScatterSet } from "@ink/geometry";
import { ScatterResource } from "@ink/render";
import { ScatterStroke } from "./scatter_stroke.ts";
import { planAdd, planErase, scatterCandidates } from "./scatter_brush.ts";
import type { Falloff } from "./sculpt.ts";

const flat: Falloff = { shape: "constant", hardness: 0 };
const brush = {
  seed: 5,
  density: 0.08,
  minSpacing: 2,
  scale: [0.9, 1.2] as [number, number],
  tint: [0, 1] as [number, number],
};

const contents = (set: ScatterSet) =>
  [...Array(set.count).keys()].map((i) => set.get(i))
    .map((p) => [p.x, p.y, p.z, p.yaw, p.scale, p.tint].join(","))
    .sort();

function paintDrag(resource: ScatterResource, from: number, to: number) {
  const stroke = new ScatterStroke(resource);
  for (let x = from; x <= to; x += 6) {
    stroke.add(planAdd(
      resource.set!,
      scatterCandidates(brush, x, 0, 12, flat),
      brush.minSpacing,
    ));
  }
  return stroke;
}

Deno.test("a scatter drag is one revision that seek undoes and redoes", () => {
  const initial = new ScatterSet();
  const old: Placement = { x: -50, y: 0, z: 40, yaw: 1, scale: 1, tint: 0.5 };
  initial.add(old);
  const resource = ScatterResource.ready("trees.scatter", initial);
  const start = contents(initial);

  const seen: number[] = [];
  resource.onChange((c) => seen.push(c.added.length - c.removed.length));
  const drag = paintDrag(resource, -60, 60);
  assert(drag.changed);
  // The renderer saw it as it happened, before any revision was recorded.
  assert(seen.length > 5);
  assertEquals(resource.revision, 0);
  const revision = drag.finish()!;
  assertEquals(revision, 1);
  const painted = contents(initial);
  assert(painted.length > start.length + 50);
  assert(painted.includes(start[0]), "the old instance is still there");

  assert(resource.seek(0));
  assertEquals(contents(initial), start);
  assert(resource.seek(1));
  assertEquals(contents(initial), painted);

  // Erase part of it as a second drag.
  const erase = new ScatterStroke(resource);
  erase.remove(planErase(initial, 0, 0, 25, flat, 3));
  const erased = erase.finish()!;
  assertEquals(erased, 2);
  const after = contents(initial);
  assert(after.length < painted.length);
  resource.seek(0);
  assertEquals(contents(initial), start);
  resource.seek(2);
  assertEquals(contents(initial), after);
  resource.seek(1);
  assertEquals(contents(initial), painted);
});

Deno.test("erasing what the same drag added cancels out; revert restores", () => {
  const set = new ScatterSet();
  const resource = ScatterResource.ready("trees.scatter", set);
  const stroke = paintDrag(resource, 0, 30);
  assert(set.count > 0);
  stroke.remove(planErase(set, 0, 0, 1000, flat, 1));
  assertEquals(set.count, 0);
  assert(!stroke.changed, "added and removed in one drag is no change");
  assertEquals(stroke.finish(), null);
  assertEquals(resource.revision, 0);

  const again = paintDrag(resource, 0, 30);
  assert(set.count > 0);
  again.revert();
  assertEquals(set.count, 0);
  assertEquals(again.finish(), null);
});

Deno.test("the saved file keeps every instance and the revision", () => {
  const set = new ScatterSet();
  const resource = ScatterResource.ready("trees.scatter", set);
  paintDrag(resource, -40, 40).finish();
  const copy = ScatterSet.parse(set.serialize());
  assertEquals(copy.count, set.count);
  assertEquals(copy.revision, 1);
});

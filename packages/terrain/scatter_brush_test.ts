import { assert, assertEquals } from "@std/assert";
import { ScatterSet } from "@ink/geometry";
import {
  MAX_CANDIDATES,
  planAdd,
  planErase,
  type ScatterBrush,
  scatterCandidates,
} from "./scatter_brush.ts";
import type { Falloff } from "./sculpt.ts";

const flat: Falloff = { shape: "constant", hardness: 0 };
const brush: ScatterBrush = {
  seed: 42,
  density: 0.05,
  minSpacing: 2,
  scale: [0.8, 1.4],
  tint: [0.2, 0.9],
};

Deno.test("the same place offers the same instances, whoever asks", () => {
  const a = scatterCandidates(brush, 100, -40, 30, flat);
  const b = scatterCandidates(brush, 100, -40, 30, flat);
  assertEquals(a, b);
  // A dab centred elsewhere sees the same instance at the same spot.
  const c = scatterCandidates(brush, 110, -40, 30, flat);
  const shared = a.filter((p) => Math.hypot(p.x - 110, p.z + 40) < 30);
  const seen = c.filter((p) => Math.hypot(p.x - 100, p.z + 40) < 30);
  assertEquals(shared, seen);
  assert(shared.length > 20);
  // Another seed grows another forest.
  const other = scatterCandidates({ ...brush, seed: 43 }, 100, -40, 30, flat);
  assert(JSON.stringify(other) !== JSON.stringify(a));
});

Deno.test("density, ranges and the circle are respected", () => {
  const list = scatterCandidates(brush, 0, 0, 100, flat);
  const area = Math.PI * 100 * 100;
  assert(
    Math.abs(list.length - area * brush.density) < area * brush.density * 0.12,
    `${list.length} of ${area * brush.density}`,
  );
  for (const p of list) {
    assert(Math.hypot(p.x, p.z) < 100);
    assert(p.scale >= 0.8 && p.scale <= 1.4);
    assert(p.tint >= 0.2 && p.tint <= 0.9);
    assert(p.yaw >= 0 && p.yaw < Math.PI * 2);
    assertEquals(p.y, 0);
  }
  // The yaws are not all the same.
  assert(new Set(list.map((p) => Math.round(p.yaw * 10))).size > 20);
  // The falloff thins the rim.
  const soft = scatterCandidates(
    brush,
    0,
    0,
    100,
    { shape: "linear", hardness: 0 },
  );
  assert(soft.length < list.length * 0.5);
  const inner = soft.filter((p) => Math.hypot(p.x, p.z) < 30).length;
  const rim = soft.filter((p) => Math.hypot(p.x, p.z) > 70).length;
  assert(inner / (Math.PI * 900) > rim / (Math.PI * (1e4 - 4900)) * 2);
  assertEquals(scatterCandidates({ ...brush, density: 0 }, 0, 0, 10, flat), []);
  assert(
    scatterCandidates({ ...brush, density: 100 }, 0, 0, 500, flat).length <=
      MAX_CANDIDATES,
  );
});

Deno.test("adding keeps the spacing and repeating a dab adds nothing", () => {
  const set = new ScatterSet();
  const first = planAdd(
    set,
    scatterCandidates(brush, 0, 0, 40, flat),
    brush.minSpacing,
  );
  assert(first.length > 50);
  for (const p of first) set.add(p);
  for (let i = 0; i < first.length; i++) {
    for (let j = i + 1; j < first.length; j++) {
      assert(
        Math.hypot(first[i].x - first[j].x, first[i].z - first[j].z) >= 2,
        "two instances closer than the spacing",
      );
    }
  }
  // The same dab again, and with zero spacing, adds no duplicates.
  assertEquals(
    planAdd(set, scatterCandidates(brush, 0, 0, 40, flat), brush.minSpacing),
    [],
  );
  // Even with no spacing at all, an instance never lands on another.
  const packed = new ScatterSet();
  const dab = scatterCandidates(brush, 0, 0, 40, flat);
  for (const p of planAdd(packed, dab, 0)) packed.add(p);
  assertEquals(packed.count, dab.length);
  assertEquals(planAdd(packed, dab, 0), []);
  // An overlapping dab adds only what is new, still spaced from the old.
  const more = planAdd(
    set,
    scatterCandidates(brush, 30, 0, 40, flat),
    brush.minSpacing,
  );
  assert(more.length > 0 && more.length < first.length);
  for (const m of more) {
    for (const p of first) {
      assert(Math.hypot(m.x - p.x, m.z - p.z) >= 2);
    }
  }
});

Deno.test("the terrain callback sets heights or turns instances down", () => {
  const set = new ScatterSet();
  const out = planAdd(
    set,
    scatterCandidates(brush, 0, 0, 50, flat),
    1,
    (p) => (p.x < 0 ? null : { ...p, y: p.x * 0.5 }),
  );
  assert(out.length > 30);
  for (const p of out) {
    assert(p.x >= 0);
    assertEquals(p.y, p.x * 0.5);
  }
});

Deno.test("erasing removes what lies inside the circle, deterministically", () => {
  const set = new ScatterSet();
  for (const p of planAdd(set, scatterCandidates(brush, 0, 0, 80, flat), 2)) {
    set.add(p);
  }
  const total = set.count;
  const gone = planErase(set, 0, 0, 30, flat, 1);
  assert(gone.length > 20);
  assert(gone.every((p) => Math.hypot(p.x, p.z) < 30));
  assertEquals(gone, planErase(set, 0, 0, 30, flat, 1));
  const removed = set.filter(
    (p) => !gone.some((g) => g.x === p.x && g.z === p.z),
  );
  assertEquals(removed.length, gone.length);
  assertEquals(set.count, total - gone.length);
  // Every instance inside the circle went; none outside did.
  for (let i = 0; i < set.count; i++) {
    const p = set.get(i);
    assert(Math.hypot(p.x, p.z) >= 30);
  }
  // A soft brush leaves some inside.
  const bigger = new ScatterSet();
  for (
    const p of planAdd(bigger, scatterCandidates(brush, 0, 0, 80, flat), 2)
  ) {
    bigger.add(p);
  }
  const thinned = planErase(
    bigger,
    0,
    0,
    60,
    { shape: "linear", hardness: 0 },
    1,
  );
  const all = planErase(bigger, 0, 0, 60, flat, 1);
  assert(thinned.length < all.length);
  assert(thinned.length > 0);
});

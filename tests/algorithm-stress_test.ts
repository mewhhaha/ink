import { instantiateGuest } from "@mewhhaha/blot";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(
  new URL("./algorithm-stress.blot", import.meta.url),
);
const { guest } = fixture;
function floats(name: string, values: number[]) {
  return Array.from(guest.call(name, new Float32Array(values)) as Float32Array);
}
function words(name: string, values: number[]) {
  return Array.from(guest.call(name, new Uint32Array(values)) as Uint32Array);
}
function unpack(values: number[]) {
  const out: number[][] = [];
  for (let i = 0; i < values.length;) {
    const length = values[i++];
    out.push(values.slice(i, i + length));
    i += length;
    assert(i <= values.length);
  }
  return out;
}
function random(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

Deno.test("[stress] stable sort boundaries, ties and exact U32 keys; copies remain independent", () => {
  const next = random(0xffffffff);
  for (const n of [0, 1, 2, 15, 16, 17, 31, 257, 4096]) {
    const cases = [
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => n - i),
      Array.from({ length: n }, () => 7),
      Array.from({ length: n }, () => next() % 13),
      Array.from({ length: n }, () => next()),
    ];
    for (const keys of cases) {
      const expected = keys.map((_, i) => i).sort((a, b) => keys[a] - keys[b]);
      assertEquals(words("order_u32", keys), expected);
      const f32 = keys.map(Math.fround);
      assertEquals(
        Array.from(guest.call("order", new Float32Array(keys)) as Uint32Array),
        f32.map((_, i) => i).sort((a, b) => f32[a] - f32[b]),
      );
    }
  }
  const values = [0, 1, 16777217, 0x80000000, 0xfffffffe, 0xffffffff];
  assertEquals(words("copied_u32", values), [
    ...values,
    ...values.map((v) => (v ^ 0xffffffff) >>> 0),
  ]);
  for (const values of [[], [-8, 0, 2.5, 100]]) {
    assertEquals(floats("copied", values), [
      ...values,
      ...values.map((v) => v + 1),
    ]);
  }
});

type Bounds = [number, number, number, number, number, number];
function intersects(a: Bounds, b: Bounds) {
  return [0, 1, 2].every((i) => a[i] <= b[i + 3] && a[i + 3] >= b[i]);
}
Deno.test("[stress] spatial dense/flat/empty indices and crossing refits match exhaustive bounds", () => {
  const next = random(813);
  for (const n of [0, 1, 7, 16, 127, 512]) {
    for (const mode of [0, 1, 2]) {
      const items: Bounds[] = Array.from({ length: n }, (_, i) => {
        let x = 0, y = 0, z = 0;
        if (mode === 1) x = i - n / 2;
        if (mode === 2) {
          x = next() % 100 - 50;
          y = next() % 100 - 50;
          z = next() % 100 - 50;
        }
        return [x, y, z, x + 1, y + 1, z + 1];
      });
      const dirty = items.map((_, i) => i).filter((i) => i % 3 === 0);
      const final = items.map((b) => b.slice() as Bounds);
      for (const i of dirty) final[i] = [80, 0, 0, 81, 1, 1];
      for (
        const query of [
          [-1, -1, -1, 1, 1, 1],
          [80, 1, 1, 80, 1, 1],
          [-100, -100, -100, 100, 100, 100],
        ] as Bounds[]
      ) {
        const result = unpack(Array.from(
          guest.call(
            "spatial_probe",
            new Float32Array([
              n,
              dirty.length,
              ...query,
              ...items.flat(),
              ...dirty.flatMap((i) => [i, ...final[i]]),
            ]),
          ) as Uint32Array,
        ));
        const before = items.map((_, i) => i).filter((i) =>
          intersects(items[i], query)
        );
        const after = final.map((_, i) => i).filter((i) =>
          intersects(final[i], query)
        );
        assertEquals(result, [before, after, after, before]);
      }
    }
  }
});
Deno.test("[stress] dense scene overlaps retain full-width source ids and old snapshots", () => {
  for (const n of [0, 1, 16, 127, 512]) {
    const ids = Array.from({ length: n }, (_, i) => 0xffffffff - i);
    const after = ids.filter((_, i) => i % 2 !== 0);
    const result = unpack(words("scene_dense", ids));
    assertEquals(result, [ids, after, after, ids]);
  }
});

// An independent reverse Dijkstra oracle. Entering a cell incurs its cost.
function distances(width: number, costs: number[], goal: number) {
  const distance = costs.map(() => Infinity);
  const visited = costs.map(() => false);
  distance[goal] = 0;
  for (let step = 0; step < costs.length; step++) {
    let cell = -1;
    for (let i = 0; i < costs.length; i++) {
      if (!visited[i] && (cell < 0 || distance[i] < distance[cell])) cell = i;
    }
    if (cell < 0 || !Number.isFinite(distance[cell])) break;
    visited[cell] = true;
    const adjacent = [];
    if (cell % width > 0) adjacent.push(cell - 1);
    if (cell % width + 1 < width) adjacent.push(cell + 1);
    if (cell >= width) adjacent.push(cell - width);
    if (cell + width < costs.length) adjacent.push(cell + width);
    for (const other of adjacent) {
      if (costs[other] > 0) {
        distance[other] = Math.min(
          distance[other],
          distance[cell] + costs[cell],
        );
      }
    }
  }
  return distance;
}
Deno.test("[stress] weighted bottlenecks and disconnected grids respect shortest costs and expansion budgets", () => {
  for (const size of [8, 16, 32]) {
    for (const mode of [0, 1, 2]) {
      const costs = Array.from({ length: size * size }, (_, i) => {
        const x = i % size, y = Math.floor(i / size);
        if (mode === 1 && x === size / 2 && y !== size - 1) return 0;
        if (mode === 2 && y === size / 2) return 0;
        return (i % 5 + 1) * 0.25;
      });
      const goal = costs.length - 1;
      const expected = distances(size, costs, goal);
      const field = floats("flow", [size, size, goal, ...costs]);
      assertEquals(field.length, costs.length * 2);
      for (let i = 0; i < costs.length; i++) {
        if (!Number.isFinite(expected[i])) {
          assert(field[i] >= 2.9e38);
          assertEquals(field[costs.length + i], costs.length);
        } else {
          assertAlmostEquals(field[i], expected[i], 1e-5);
          if (i !== goal) {
            const next = field[costs.length + i];
            assert(costs[next] > 0);
            assert(field[next] < field[i]);
            assertAlmostEquals(field[i], field[next] + costs[next], 1e-5);
          }
        }
      }
      for (const limit of [0, 1, costs.length]) {
        const path = floats("path", [size, size, 0, goal, limit, ...costs]);
        if (limit < 2 || !Number.isFinite(expected[0])) {
          assertEquals(path, [-1]);
        } else {
          assertAlmostEquals(path[0], expected[0], 1e-5);
          assert(path[1] <= limit);
          const cells = path.slice(2);
          assertEquals(cells[0], 0);
          assertEquals(cells.at(-1), goal);
          let total = 0;
          for (let i = 1; i < cells.length; i++) {
            assertEquals(
              Math.abs(cells[i] % size - cells[i - 1] % size) +
                Math.abs(
                  Math.floor(cells[i] / size) - Math.floor(cells[i - 1] / size),
                ),
              1,
            );
            assert(costs[cells[i]] > 0);
            total += costs[cells[i]];
          }
          assertAlmostEquals(total, expected[0], 1e-5);
        }
      }
    }
  }
});
Deno.test("[stress] placement joins negative chunks exactly and maintains authored spacing", () => {
  for (const seed of [0, 16777217, 0xffffffff]) {
    for (const spacing of [0, 0.7, 2.5]) {
      const place = (z: number, depth: number) =>
        floats("placed", [
          seed & 0xffff,
          seed >>> 16,
          0.5,
          spacing,
          -12,
          z,
          24,
          depth,
        ]);
      const whole = place(-10, 20);
      assertEquals(whole, [...place(-10, 10), ...place(0, 10)]);
      assertEquals(place(-10, 20), whole);
      for (let i = 0; i < whole.length; i += 2) {
        assert(whole[i] >= -6 && whole[i] < 6);
        assert(whole[i + 1] >= -5 && whole[i + 1] < 5);
        for (let j = 0; j < i; j += 2) {
          assert(
            Math.hypot(whole[i] - whole[j], whole[i + 1] - whole[j + 1]) >=
              spacing - 1e-6,
          );
        }
      }
      if (spacing === 0) assertEquals(whole.length, 24 * 20 * 2);
    }
  }
});
Deno.test("[stress] terrain borders and short grids remain finite; long tile walks stay supported", () => {
  for (const cells of [0, 1, 4, 32]) {
    const n = (cells + 1) ** 2;
    const grid = Array.from({ length: n }, (_, i) => (i % (cells + 1)) * 0.25);
    for (const heights of [[], grid.slice(0, 2), grid]) {
      for (const [x, z] of [[3, -5], [-100, -100], [100, 100]]) {
        const out = floats("terrain_probe", [cells, x, z, ...heights]);
        assert(out.every(Number.isFinite));
        assert(out[0] >= out[4] && out[0] <= out[5]);
        assertAlmostEquals(Math.hypot(...out.slice(1, 4)), 1, 1e-5);
        if (heights.length === 0) assertEquals(out[0], 2);
        if (heights.length === n && cells > 0) {
          const column = Math.max(0, Math.min(cells, (x + 1) / 8 * cells));
          assertAlmostEquals(out[0], 2 + column * 0.25, 1e-5);
        }
      }
    }
  }
  for (const ticks of [1, 256, 4096]) {
    const out = Array.from(guest.call("tile_walk", ticks) as Float32Array);
    assertAlmostEquals(out[0], 1 + ticks * 0.25 / 60, 0.001);
    assertAlmostEquals(out[1], 1.4, 1e-6);
    assertEquals(out[2], 1);
  }
});
Deno.test("[stress] degenerate segments and sphere contact reversals preserve geometric witnesses", () => {
  for (const scale of [0.001, 1, 1000]) {
    assertEquals(
      floats("segment", [0, 0, 0, 0, 0, 0, scale, 0, 0, scale, 0, 0]),
      [0, 0, 0, Math.fround(scale), 0, 0],
    );
    const crossed = floats("segment", [
      -scale,
      0,
      0,
      scale,
      0,
      0,
      0,
      -scale,
      0,
      0,
      scale,
      0,
    ]);
    for (const v of crossed) assertAlmostEquals(v, 0, 1e-4);
    for (const distance of [0, scale, 2 * scale, 3 * scale]) {
      const forward = floats("spheres", [
        scale,
        scale,
        0,
        0,
        0,
        distance,
        0,
        0,
      ]);
      const reverse = floats("spheres", [
        scale,
        scale,
        distance,
        0,
        0,
        0,
        0,
        0,
      ]);
      assert(forward.every(Number.isFinite));
      assertEquals(forward[0], reverse[0]);
      if (distance > 2 * scale + 0.02) assertEquals(forward[0], 0);
      else {
        assertEquals(forward[0], 1);
        assertAlmostEquals(
          forward[7],
          distance - scale * 2,
          Math.max(1e-6, scale * 1e-6),
        );
        assertAlmostEquals(Math.hypot(...forward.slice(4, 7)), 1, 1e-6);
        if (distance > 0) {
          for (let i = 4; i < 7; i++) {
            assertAlmostEquals(forward[i], -reverse[i], 1e-6);
          }
        }
      }
    }
  }
});
Deno.test("[stress] 600 host-carried rigid, joint and character ticks stay finite and deterministic", () => {
  for (const mode of [0, 1]) {
    let initial = new Float32Array([
      mode,
      0,
      2,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    if (mode === 1) {
      initial = new Float32Array([mode, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    }
    let state: Float32Array = initial;
    let replay: Float32Array = initial.slice();
    for (let tick = 0; tick < 600; tick++) {
      state = guest.call("body_tick", state) as Float32Array;
      replay = guest.call("body_tick", replay) as Float32Array;
      assertEquals(state, replay);
      assert(state.every(Number.isFinite));
      assert(state.length <= 54);
      assertAlmostEquals(Math.hypot(...state.slice(4, 8)), 1, 1e-4);
      if (mode === 1) {
        assertAlmostEquals(Math.hypot(...state.slice(1, 4)), 1, 0.03);
      }
    }
    if (mode === 0) {
      assertAlmostEquals(state[2], 0.5, 0.02);
      assert(Math.abs(state[9]) < 0.05);
      assert(state.length > 14);
    }
  }
  let walker: Float32Array = new Float32Array([0, 0.01, 0, 0]);
  for (let tick = 0; tick < 600; tick++) {
    walker = guest.call("walk_tick", walker) as Float32Array;
    assert(walker.every(Number.isFinite));
    assert(walker[0] <= 2.102);
    assertAlmostEquals(walker[1], 0.002, 0.012);
  }
  assertAlmostEquals(walker[0], 2.098, 0.01);
  assertEquals(walker[3], 1);
});
Deno.test("[stress] debug packing handles collapsed capsules and segment-count scaling", () => {
  for (const segments of [0, 1, 2, 3, 32, 512]) {
    const out = Array.from(
      guest.call("debug_capsule", segments) as Float32Array,
    );
    let lines = 4;
    if (segments >= 3) lines += 6 * segments;
    assertEquals(out.length, lines * 14);
    for (let i = 0; i < out.length; i += 7) {
      assertEquals(out.slice(i, i + 7), [0, 0, 0, 0.25, 0.5, 0.75, 1]);
    }
  }
});
Deno.test("[stress] redundant convex planes and long terrain segments retain analytic surfaces", () => {
  for (const copies of [1, 2, 4, 8]) {
    const out = Array.from(
      guest.call("redundant_hull", copies) as Float32Array,
    );
    assertEquals(out.slice(0, 10), [8, -1, -1, -1, 1, 1, 1, 1, 1, 1]);
    assertAlmostEquals(out[10], -0.1, 1e-6);
  }
  for (const cells of [1, 8, 32, 128]) {
    for (const halfLength of [0, 2, 64]) {
      const out = floats("terrain_segment", [cells, halfLength]);
      assertAlmostEquals(out[0], 2, 1e-5);
      assertAlmostEquals(out[1], 0, 1e-5);
      assertAlmostEquals(out[2], 1, 1e-5);
      assertAlmostEquals(out[3], 0, 1e-5);
    }
  }
});
Deno.test("[stress] dense physics cache canonical pairs preserve all bits without merging contacts", () => {
  for (const count of [0, 1, 8, 32, 64]) {
    const out = Array.from(guest.call("physics_dense", count) as Uint32Array);
    const expected = [count];
    for (let i = count - 1; i >= 0; i--) {
      expected.push(16777217, 0xffffffff - i);
    }
    assertEquals(out, expected);
  }
});
Deno.test("[stress] broad phase matches exhaustive mixed active/resting/layer-filtered pairs", () => {
  const next = random(0xabcdef01);
  for (const count of [0, 1, 16, 64, 128]) {
    const sources = Array.from({ length: count }, (_, i) => {
      const kind = i % 3;
      let active = 0;
      if (kind > 0 && i % 5 !== 0) active = 1;
      let x = next() % 8 * 0.25;
      if (i % 7 === 0) x += 100;
      return [
        x,
        next() % 8 * 0.25,
        next() % 8 * 0.25,
        0.5,
        kind,
        active,
        1 << i % 3,
        i % 7 + 1,
        Number(i % 11 === 0),
      ];
    });
    const expected: number[] = [];
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const a = sources[i], b = sources[j];
        if (a[8] || b[8] || !a[5] && !b[5]) continue;
        if (a[4] !== 2 && b[4] !== 2) continue;
        if (!(a[6] & b[7]) || !(b[6] & a[7])) continue;
        let reach = a[3] + b[3];
        if (a[5]) reach += 0.04;
        if (b[5]) reach += 0.04;
        if ([0, 1, 2].every((axis) => Math.abs(a[axis] - b[axis]) <= reach)) {
          expected.push(i, j);
        }
      }
    }
    const actual = Array.from(
      guest.call(
        "broad_pairs",
        new Float32Array(sources.flat()),
      ) as Uint32Array,
    );
    assertEquals(actual, expected);
  }
});
Deno.test("[stress] fully dense body state and canonical contact output use bounded committed memory", async () => {
  const compiled = await fixture.compiler.build();
  assert(compiled.success);
  const guest = await instantiateGuest(compiled.bytes);
  try {
    for (const count of [16, 32, 64]) {
      const state = guest.call("dense_bodies", count) as Float32Array;
      assertEquals(state[0], count);
      assertEquals(state[1], count * (count - 1) / 2);
      assertEquals(state, guest.call("dense_bodies", count));
      assert(state.every(Number.isFinite));
      const expected: number[] = [];
      for (let i = 1; i <= count; i++) {
        for (let j = i + 1; j <= count; j++) expected.push(i, j);
        const o = 2 + (i - 1) * 13;
        assert(state[o + 1] >= 10 - 9.81 / 3600 - 1e-5);
        assert(state[o + 1] <= 10 - 9.81 / 7200 + 1e-5);
        assertAlmostEquals(Math.hypot(...state.slice(o + 3, o + 7)), 1, 1e-5);
      }
      assertEquals(Array.from(state.slice(2 + count * 13)), expected);
    }
    // The pinned guest previously committed 94MiB for only 64 dense bodies:
    // early exits in pair collection copied its growing list on every append.
    assert(
      guest.memoryBytes() <= 40 * 1024 * 1024,
      `${guest.memoryBytes()} committed guest bytes`,
    );
  } finally {
    guest.dispose();
  }
});
Deno.test("[stress] fully dirty dense spatial/scene snapshots stay ordered within isolated memory bounds", async () => {
  const compiled = await fixture.compiler.build();
  assert(compiled.success);
  const count = 512;
  const indices = Array.from({ length: count }, (_, i) => i);
  const ids = indices.map((i) => 0xffffffff - i);
  const cases = [
    {
      entry: "spatial_dense_refit",
      input: count,
      before: indices,
      limit: 4 * 1024 * 1024,
    },
    {
      entry: "scene_dense",
      input: new Uint32Array(ids),
      before: ids,
      limit: 12 * 1024 * 1024,
    },
  ];
  for (const { entry, input, before, limit } of cases) {
    const guest = await instantiateGuest(compiled.bytes);
    try {
      const after = before.filter((_, i) => i % 2 !== 0);
      const expected = [before, after, after, before];
      for (let replay = 0; replay < 3; replay++) {
        const output = Array.from(guest.call(entry, input) as Uint32Array);
        assertEquals(unpack(output), expected);
        assert(
          guest.memoryBytes() <= limit,
          `${entry}: ${guest.memoryBytes()} committed bytes`,
        );
      }
    } finally {
      guest.dispose();
    }
  }
});
Deno.test.afterAll(() => fixture.dispose());

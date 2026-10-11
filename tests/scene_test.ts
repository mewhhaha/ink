import { assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";

const fixture = await compile(new URL("./scene.blot", import.meta.url));
const { guest } = fixture;
type V3 = [number, number, number];
interface Source {
  id: number;
  shape: number;
  position: V3;
  rotation?: [number, number, number, number];
  scale?: V3;
  size?: V3;
  radius?: number;
  height?: number;
  layer?: number;
  trigger?: boolean;
  body?: number;
}
interface Query {
  mode: number;
  a: V3;
  b?: V3;
  radius?: number;
  delta?: V3;
  mask?: number;
  skip?: number;
  triggers?: boolean;
  walkers?: boolean;
  dynamics?: boolean;
}

function sourceLanes(source: Source) {
  let trigger = 0;
  if (source.trigger) trigger = 1;
  return [
    source.id,
    source.shape,
    ...source.position,
    ...source.rotation ?? [0, 0, 0, 1],
    ...source.scale ?? [1, 1, 1],
    ...source.size ?? [1, 1, 1],
    source.radius ?? 0.5,
    source.height ?? 2,
    source.layer ?? 1,
    trigger,
    source.body ?? 0,
  ];
}

function queryLanes(query: Query) {
  let triggers = 0;
  let walkers = 1;
  let dynamics = 1;
  if (query.triggers) triggers = 1;
  if (query.walkers === false) walkers = 0;
  if (query.dynamics === false) dynamics = 0;
  return [
    query.mode,
    query.mask ?? 7,
    query.skip ?? 0,
    triggers,
    walkers,
    dynamics,
    ...query.a,
    ...query.b ?? query.a,
    query.radius ?? 0,
    ...query.delta ?? [0, 0, 0],
  ];
}

function call(name: string, lanes: number[]) {
  const values = guest.call(name, new Float32Array(lanes)) as Float32Array;
  const results: number[][] = [];
  let index = 0;
  while (index < values.length) {
    const length = values[index++];
    results.push(Array.from(values.subarray(index, index + length)));
    index += length;
  }
  assertEquals(index, values.length);
  return results;
}

function near(actual: number[], expected: number[]) {
  assertEquals(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    assertAlmostEquals(actual[index], expected[index], 2e-5);
  }
}

function probe(sources: Source[], query: Query) {
  const [actual, expected] = call("probe", [
    sources.length,
    ...queryLanes(query),
    ...sources.flatMap(sourceLanes),
  ]);
  near(actual, expected);
  return actual;
}

function update(
  before: Source[],
  after: Source[],
  dirty: number[],
  query: Query,
) {
  const [oldBefore, changed, rebuilt, exhaustiveNew, oldAfter, exhaustiveOld] =
    call("update", [
      before.length,
      after.length,
      dirty.length,
      ...queryLanes(query),
      ...before.flatMap(sourceLanes),
      ...after.flatMap(sourceLanes),
      ...dirty,
    ]);
  near(changed, rebuilt);
  near(changed, exhaustiveNew);
  near(oldBefore, oldAfter);
  near(oldAfter, exhaustiveOld);
  return { old: oldBefore, changed };
}

function random(seed: number) {
  let state = seed;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 4294967296;
  };
}

function distributed(seed: number, count: number) {
  const unit = random(seed);
  const sources: Source[] = [];
  for (let index = 0; index < count; index++) {
    const angle = (unit() - 0.5) * Math.PI;
    const source: Source = {
      id: count * 3 - index * 2,
      shape: index % 3 + 1,
      position: [(unit() - 0.5) * 40, (unit() - 0.5) * 12, (unit() - 0.5) * 40],
      rotation: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
      scale: [0.5 + unit(), 0.5 + unit(), 0.5 + unit()],
      size: [0.5 + unit() * 3, 0.5 + unit() * 3, 0.5 + unit() * 3],
      radius: 0.25 + unit(),
      height: 1 + unit() * 3,
      layer: 1 << index % 3,
      trigger: index % 5 === 0,
      body: index % 4,
    };
    sources.push(source);
  }
  return sources;
}

Deno.test("indexed queries match exhaustive geometry across seeded distributed scenes", () => {
  for (const seed of [7, 19283, 0x12345678]) {
    const sources = distributed(seed, 54);
    const unit = random(seed + 1);
    for (let index = 0; index < 36; index++) {
      const target = sources[index].position;
      const a: V3 = [target[0] - 5 - unit() * 5, target[1] + unit(), target[2]];
      const delta: V3 = [12 + unit() * 5, -unit() * 2, unit() - 0.5];
      const mask = index % 7 + 1;
      probe(sources, {
        mode: 0,
        a,
        delta,
        mask,
        skip: sources[(index + 7) % sources.length].id,
      });
      probe(sources, {
        mode: 1,
        a,
        b: [a[0], a[1] + 1.5, a[2]],
        radius: 0.3,
        delta,
        mask,
        triggers: index % 2 === 0,
        walkers: index % 3 !== 0,
        dynamics: index % 4 !== 0,
      });
      probe(sources, { mode: 2, a: target, radius: 0.75 + unit() * 2, mask });
      probe(sources, {
        mode: 3,
        a: target,
        b: [target[0] + 2, target[1] + 3, target[2] - 1],
        radius: 0.4,
        mask,
      });
      probe(sources, { mode: 4, a: target, mask });
    }
  }
});

Deno.test("degenerate index axes and coincident shapes preserve source ordering and ray ties", () => {
  const coincident: Source[] = [
    { id: 800, shape: 0, position: [0, 0, 0] },
    { id: 90, shape: 2, position: [0, 0, 0], radius: 1 },
    { id: 10, shape: 2, position: [0, 0, 0], radius: 1 },
    { id: 30, shape: 2, position: [0, 0, 0], radius: 1, trigger: true },
  ];
  assertEquals(probe(coincident, { mode: 2, a: [0, 0, 0], radius: 0.1 }), [
    90,
    10,
    30,
  ]);
  assertEquals(
    probe(coincident, { mode: 3, a: [0, 0, 0], b: [0, 2, 0], radius: 0.1 }),
    [90, 10, 30],
  );
  const ray = probe(coincident, { mode: 0, a: [-3, 0, 0], delta: [6, 0, 0] });
  assertEquals(ray.slice(0, 3), [1, 90, 0]);
  assertEquals(
    probe(coincident, {
      mode: 0,
      a: [-3, 0, 0],
      delta: [6, 0, 0],
      skip: 90,
    })[1],
    10,
  );
  for (let axis = 0; axis < 3; axis++) {
    const line: Source[] = [];
    for (let index = 0; index < 40; index++) {
      const position: V3 = [0, 0, 0];
      position[axis] = (index - 20) * 2;
      line.push({ id: 100 - index, shape: 2, position, radius: 0.5 });
    }
    const a: V3 = [0, 0, 0];
    const delta: V3 = [0, 0, 0];
    a[axis] = -50;
    delta[axis] = 100;
    probe(line, { mode: 0, a, delta });
    probe(line, { mode: 1, a, b: a, radius: 0.4, delta });
    probe(line, { mode: 2, a: [0, 0, 0], radius: 4 });
    probe(line, { mode: 3, a: [-1, -1, -1], b: [1, 1, 1], radius: 1 });
    probe(line, { mode: 4, a: [0, 0, 0] });
  }
});

Deno.test("empty scenes, zero motion and filtering keep exhaustive query semantics", () => {
  for (let mode = 0; mode < 5; mode++) {
    probe([], { mode, a: [0, 0, 0], radius: 1 });
  }
  const sources: Source[] = [
    { id: 1, shape: 2, position: [0, 0, 0], trigger: true, layer: 1 },
    { id: 2, shape: 3, position: [2, 0, 0], body: 3, layer: 2 },
    { id: 3, shape: 1, position: [4, 0, 0], body: 1, layer: 4 },
  ];
  assertEquals(probe(sources, { mode: 4, a: [0, 0, 0] }), [0]);
  assertEquals(probe(sources, { mode: 2, a: [0, 0, 0], radius: 0.1 }), [1]);
  assertEquals(
    probe(sources, { mode: 1, a: [0, 0, 0], radius: 0.1, triggers: true })[1],
    1,
  );
  assertEquals(probe(sources, { mode: 1, a: [0, 0, 0], radius: 0.1 }), [0]);
  assertEquals(
    probe(sources, {
      mode: 1,
      a: [-2, 0, 0],
      delta: [8, 0, 0],
      walkers: false,
      dynamics: false,
    }),
    [0],
  );
  assertEquals(
    probe(sources, { mode: 0, a: [-2, 0, 0], delta: [8, 0, 0], mask: 0 }),
    [0],
  );
  assertEquals(probe(sources, { mode: 0, a: [4, 0, 0] })[1], 3);
});

Deno.test("scene updates refresh translated and rotated movers without changing old snapshots", () => {
  const before: Source[] = [
    { id: 4, shape: 1, position: [0, 0, 0], size: [6, 0.5, 0.5], body: 2 },
    { id: 8, shape: 2, position: [20, 0, 0], radius: 1, body: 1 },
  ];
  const half = Math.SQRT1_2;
  const after: Source[] = [
    { ...before[0], position: [10, 0, 0], rotation: [0, 0, half, half] },
    { ...before[1], position: [10, 4, 0], scale: [2, 1, 1] },
  ];
  assertEquals(update(before, after, [0, 1], { mode: 4, a: [10, 2, 0] }), {
    old: [0],
    changed: [1],
  });
  assertEquals(
    update(before, after, [0, 1], { mode: 2, a: [0, 0, 0], radius: 0.1 }),
    { old: [4], changed: [] },
  );
  for (let mode = 0; mode < 5; mode++) {
    update(before, after, [0, 1], {
      mode,
      a: [6, 2, 0],
      b: [6, 3, 0],
      delta: [10, 0, 0],
      radius: 0.3,
    });
  }
});

Deno.test("dirty collider changes refresh layers, triggers, dimensions and shape kinds", () => {
  const before: Source[] = [
    { id: 7, shape: 1, position: [0, 0, 0], size: [1, 1, 1], layer: 1 },
    {
      id: 2,
      shape: 2,
      position: [4, 0, 0],
      radius: 0.5,
      layer: 1,
      trigger: true,
    },
  ];
  const after: Source[] = [
    { ...before[0], shape: 3, radius: 1, height: 6, layer: 2, trigger: true },
    { ...before[1], radius: 2, layer: 4, trigger: false },
  ];
  assertEquals(
    update(before, after, [0, 1], {
      mode: 2,
      a: [0, 2, 0],
      radius: 0.1,
      mask: 2,
    }).changed,
    [7],
  );
  assertEquals(
    update(before, after, [0, 1], { mode: 4, a: [0, 0, 0], mask: 7 }),
    { old: [1], changed: [0] },
  );
  assertEquals(
    update(before, after, [0, 1], { mode: 4, a: [4, 0, 0], mask: 4 }),
    { old: [0], changed: [1] },
  );
  for (let mode = 0; mode < 5; mode++) {
    update(before, after, [0, 1], {
      mode,
      a: [-4, 0, 0],
      b: [-4, 2, 0],
      delta: [12, 0, 0],
      radius: 1,
      mask: 7,
      triggers: true,
    });
  }
});

Deno.test("shape insertion and removal rebuild proxy slots while preserving source order", () => {
  const before: Source[] = [
    { id: 90, shape: 2, position: [0, 0, 0], radius: 1 },
    { id: 20, shape: 0, position: [0, 0, 0] },
    { id: 10, shape: 2, position: [0, 0, 0], radius: 1 },
  ];
  const after: Source[] = [{ ...before[0], shape: 0 }, {
    ...before[1],
    shape: 1,
  }, before[2]];
  assertEquals(
    update(before, after, [0, 1], { mode: 2, a: [0, 0, 0], radius: 0.1 }),
    { old: [90, 10], changed: [20, 10] },
  );
  for (let mode = 0; mode < 5; mode++) {
    update(before, after, [0, 1], {
      mode,
      a: [-3, 0, 0],
      b: [-3, 1, 0],
      delta: [6, 0, 0],
      radius: 0.2,
    });
  }
});

Deno.test("source count changes rebuild automatically and explicit reorder keeps tie order", () => {
  const before: Source[] = [
    { id: 90, shape: 2, position: [0, 0, 0], radius: 1 },
    { id: 10, shape: 2, position: [0, 0, 0], radius: 1 },
  ];
  const query: Query = { mode: 2, a: [0, 0, 0], radius: 0.1 };
  assertEquals(
    update(
      before,
      [...before, { id: 5, shape: 3, position: [0, 0, 0] }],
      [],
      query,
    ).changed,
    [90, 10, 5],
  );
  assertEquals(update(before, [before[1]], [], query).changed, [10]);
  assertEquals(update(before, [], [], query).changed, []);
  const reordered = [before[1], before[0]];
  assertEquals(update(before, reordered, [0, 1], query).changed, [10, 90]);
  const ray = update(before, reordered, [0, 1], {
    mode: 0,
    a: [-3, 0, 0],
    delta: [6, 0, 0],
  });
  assertEquals(ray.old[1], 90);
  assertEquals(ray.changed[1], 10);
});

Deno.test("no dirty slots reuse a scene while keeping both snapshots queryable", () => {
  const sources = distributed(19, 32);
  for (let mode = 0; mode < 5; mode++) {
    update(sources, sources, [], {
      mode,
      a: sources[0].position,
      b: [1, 2, 3],
      delta: [30, 0, 0],
      radius: 2,
    });
  }
});

Deno.test("dirty movers cross index partitions without stale bounds in shared snapshots", () => {
  const before = distributed(8173, 54);
  const after = before.slice();
  const dirty = [0, 3, 8, 14, 20, 27, 31, 38, 46, 53];
  for (const index of dirty) {
    after[index] = {
      ...before[index],
      position: [
        50 - before[index].position[0],
        before[index].position[1] + 12,
        -40 - before[index].position[2],
      ],
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
      size: [2, 6, 1],
      layer: 7,
      trigger: false,
    };
  }
  for (const index of dirty) {
    const p = after[index].position;
    for (let mode = 0; mode < 5; mode++) {
      update(before, after, dirty, {
        mode,
        a: p,
        b: [p[0], p[1] + 2, p[2]],
        delta: [8, 0, 0],
        radius: 0.2,
        triggers: true,
      });
    }
    const overlap = update(before, after, dirty, {
      mode: 2,
      a: p,
      radius: 0.2,
    });
    assertEquals(overlap.changed.includes(after[index].id), true);
    assertEquals(overlap.old, []);
  }
});

Deno.test.afterAll(() => fixture.dispose());

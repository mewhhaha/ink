/**
 * The physics library through the generated glue: the gate test (50 stacked
 * boxes for 10 s, identical across runs and standing), queries, the character
 * controller and determinism.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { decodeWorld, encodeWorld, idleInput } from "@ink/schema";
import {
  box,
  compileGame,
  entityOf,
  level,
  play,
  position,
  probeAt,
  probeGame,
  probeOut,
  run,
  schema,
  stack,
  stepOnly,
} from "./physics_fixture.ts";

const game = await compileGame(stepOnly);

Deno.test("50 stacked boxes stand for 10 s, identically every run", () => {
  const first = run(game, stack(50), 600);
  const second = run(game, stack(50), 600);
  assertEquals(first.length, second.length);
  assert(
    first.every((v, i) => Object.is(v, second[i])),
    "two runs end in byte-identical states",
  );
  const world = decodeWorld(schema, first);
  let worstSag = 0;
  let worstDrift = 0;
  for (let i = 0; i < 50; i++) {
    const [x, y, z] = position(world, i + 2);
    worstSag = Math.max(worstSag, Math.abs(y - (0.5 + i)));
    worstDrift = Math.max(worstDrift, Math.abs(x), Math.abs(z));
    assert(Number.isFinite(y), "no NaN");
  }
  // Soft contacts compress a 50 m tower a little (under 1%) and nothing
  // wanders sideways more than a few centimetres.
  assert(worstSag < 0.5, `sag ${worstSag}`);
  assert(worstDrift < 0.06, `drift ${worstDrift}`);
  const top = world.entities.find((e) => e.id === 51)!;
  assertEquals(top.components.body.sleeping, true, "the stack came to rest");
});

Deno.test("towers stand for 10 s with sleeping disabled: 50 boxes bounded, 60 not collapsing", () => {
  const awake = (count: number) => {
    const world = stack(count);
    for (const e of world.entities) {
      if (e.components.body) {
        (e.components.body as Record<string, unknown>).can_sleep = false;
      }
    }
    return world;
  };
  const tower = (count: number) => {
    const world = decodeWorld(schema, run(game, awake(count), 600));
    let sag = 0;
    let drift = 0;
    for (let i = 0; i < count; i++) {
      const [x, y, z] = position(world, i + 2);
      assert(Number.isFinite(y));
      sag = Math.max(sag, Math.abs(y - (0.5 + i)));
      drift = Math.max(drift, Math.abs(x), Math.abs(z));
    }
    const sleeping =
      world.entities.filter((e) =>
        (e.components.body as { sleeping?: boolean } | undefined)?.sleeping
      ).length;
    assertEquals(sleeping, 0, "nothing slept");
    return { sag, drift };
  };
  const fifty = tower(50);
  assert(fifty.sag < 0.45 && fifty.drift < 0.2, JSON.stringify(fifty));
  const sixty = tower(60);
  assert(sixty.sag < 0.55 && sixty.drift < 0.4, JSON.stringify(sixty));
});

// Queries -----------------------------------------------------------------------

const probes = await compileGame(probeGame);

const closeTo = (actual: number, expected: number, tolerance = 0.02) =>
  assertAlmostEquals(actual, expected, tolerance);

Deno.test("rays find the nearest solid, skip triggers and honour exclusions", () => {
  const world = (probe: Record<string, unknown>) =>
    level([
      box(1, [5, 0, 0], [2, 2, 2]),
      box(2, [10, 0, 0], [2, 2, 2]),
      // A trigger in the way is not hit by rays.
      box(3, [3, 0, 0], [1, 1, 1], {
        collider: { size: [1, 1, 1], trigger: true },
      }),
      probeAt([0, 0, 0], { dir: [1, 0, 0], reach: 20, ...probe }),
    ]);
  const hit = probeOut(play(probes, world({ mode: 1 }), 1));
  assertEquals(hit[0], 1);
  assertEquals(hit[1], 1, "the nearer box");
  closeTo(hit[2], 4);
  closeTo(hit[3], -1);
  closeTo(hit[6], 4);
  const behind = probeOut(play(probes, world({ mode: 6, other: 1 }), 1));
  assertEquals(behind[1], 2, "skipping the first box finds the second");
  closeTo(behind[2], 9);
  const short = probeOut(play(probes, world({ mode: 1, reach: 3 }), 1));
  assertEquals(short[0], 0, "nothing within reach");
});

Deno.test("rays and casts see spheres, capsules and brushes", () => {
  const wedge = {
    id: 5,
    components: {
      transform: { position: [0, 0, 0] },
      // A 45 degree ramp: solid below y = x, between x = 0 and x = 4.
      brush: {
        faces: [
          { plane: [0, -1, 0, 0] },
          { plane: [1, 0, 0, 4] },
          { plane: [0, 0, 1, 1] },
          { plane: [0, 0, -1, 1] },
          { plane: [-0.7071068, 0.7071068, 0, 0] },
        ],
      },
    },
  };
  const world = level([
    wedge,
    {
      id: 6,
      components: {
        transform: { position: [10, 1, 0] },
        collider: { shape: "sphere", radius: 1 },
      },
    },
    {
      id: 7,
      components: {
        transform: { position: [10, 1, 5] },
        collider: { shape: "capsule", radius: 0.5, height: 3 },
      },
    },
    probeAt([2, 5, 0], { mode: 1, dir: [0, -1, 0], reach: 10 }),
  ]);
  const down = probeOut(play(probes, world, 1));
  assertEquals(down[1], 5, "the wedge");
  closeTo(down[2], 3);
  closeTo(down[4], 0.7071, 0.01);
  closeTo(down[3], -0.7071, 0.01);
  const sphere = level([
    ...world.entities.slice(1, 3).map((e) => ({
      id: e.id,
      components: Object.fromEntries(
        Object.entries(e.components).filter(([k]) => k !== "probe"),
      ),
    })),
    probeAt([0, 1, 0], { mode: 1, dir: [1, 0, 0], reach: 20 }),
  ]);
  const hit = probeOut(play(probes, sphere, 1));
  assertEquals(hit[1], 6);
  closeTo(hit[2], 9);
  const swept = level([
    box(1, [8, 0, 0], [1, 4, 4]),
    probeAt([0, 0, 0], { mode: 2, dir: [1, 0, 0], reach: 20, radius: 0.5 }),
  ]);
  const cast = probeOut(play(probes, swept, 1));
  assertEquals(cast[1], 1);
  closeTo(cast[2], 7, 0.01);
  closeTo(cast[3], -1, 0.01);
});

Deno.test("overlaps include triggers; a point is solid inside colliders", () => {
  const entities = [
    box(1, [4, 0, 0], [2, 2, 2]),
    box(2, [2, 0, 0], [1, 1, 1], {
      collider: { size: [1, 1, 1], trigger: true },
    }),
  ];
  const near = probeOut(
    play(
      probes,
      level([...entities, probeAt([2.75, 0, 0], { mode: 4, radius: 0.4 })]),
      1,
    ),
  );
  assertEquals(near.slice(0, 3), [2, 1, 2]);
  const far = probeOut(
    play(
      probes,
      level([...entities, probeAt([2.75, 0, 0], { mode: 4, radius: 0.1 })]),
      1,
    ),
  );
  assertEquals(far[0], 0);
  const inside = probeOut(
    play(probes, level([...entities, probeAt([4, 0, 0], { mode: 5 })]), 1),
  );
  assertEquals(inside[0], 1);
  const outside = probeOut(
    play(probes, level([...entities, probeAt([2, 0, 0], { mode: 5 })]), 1),
  );
  assertEquals(outside[0], 0, "a trigger is not solid");
});

// Character controller ------------------------------------------------------------

const floor = box(1, [0, -0.5, 0], [100, 1, 100]);
const walker = (
  position: number[],
  character: Record<string, unknown> = {},
) => ({
  id: 100,
  components: {
    transform: { position },
    collider: {
      shape: "capsule",
      radius: 0.4,
      height: 1.8,
      offset: [0, 0.9, 0],
    },
    character,
  },
});
const walkerState = (world: ReturnType<typeof level>) => {
  const e = entityOf(world, 100);
  return {
    position: e.components.transform.position as number[],
    character: e.components.character as {
      velocity: number[];
      grounded: boolean;
      ground: number;
    },
  };
};

Deno.test("a character walks on the floor and rests on it", () => {
  const world = play(
    probes,
    level([
      floor,
      walker([0, 0.5, 0]),
      probeAt([0, 0, 0], { mode: 0, dir: [4, 0, 0] }),
    ]),
    60,
  );
  const { position, character } = walkerState(world);
  closeTo(position[0], 4, 0.1);
  assert(
    position[1] < 0.02 && position[1] >= 0,
    `rests on the floor: ${position[1]}`,
  );
  assert(character.grounded);
  assertEquals(character.ground, 1);
});

Deno.test("slopes: walkable up to the limit, a wall beyond it", () => {
  // Solid below the line y = x * tan(30 deg) from x = 4 to x = 12.
  const ramp = {
    id: 5,
    components: {
      transform: { position: [0, 0, 0] },
      brush: {
        faces: [
          { plane: [0, -1, 0, 0] },
          { plane: [1, 0, 0, 12] },
          { plane: [0, 0, 1, 3] },
          { plane: [0, 0, -1, 3] },
          { plane: [-0.5, 0.8660254, 0, -2] },
        ],
      },
    },
  };
  const run = (maxSlope: number) =>
    walkerState(
      play(
        probes,
        level([
          floor,
          ramp,
          walker([2, 0, 0], { max_slope: maxSlope }),
          probeAt([0, 0, 0], { mode: 0, dir: [3, 0, 0] }),
        ]),
        120,
      ),
    );
  const climbs = run(40);
  assert(climbs.position[0] > 8, `walked up the ramp: x=${climbs.position[0]}`);
  assert(climbs.position[1] > 1, `and is high up: y=${climbs.position[1]}`);
  assert(climbs.character.grounded);
  const blocked = run(25);
  assert(blocked.position[0] < 5, `too steep: x=${blocked.position[0]}`);
  assert(blocked.position[1] < 0.5);
});

Deno.test("steps up ledges within step height and is blocked by higher ones", () => {
  const run = (rise: number, stepHeight: number) =>
    walkerState(
      play(
        probes,
        level([
          floor,
          box(2, [5, rise / 2, 0], [2, rise, 6]),
          walker([2, 0, 0], { step_height: stepHeight }),
          probeAt([0, 0, 0], { mode: 0, dir: [3, 0, 0] }),
        ]),
        120,
      ),
    );
  const low = run(0.3, 0.4);
  assert(low.position[0] > 5.5, `stepped up and over: x=${low.position[0]}`);
  assert(low.character.grounded);
  const high = run(0.7, 0.4);
  assert(
    high.position[0] < 4.2,
    `blocked by the high ledge: x=${high.position[0]}`,
  );
});

Deno.test("a character slides along walls and stays on the ground going down a step", () => {
  const slide = walkerState(
    play(
      probes,
      level([
        floor,
        box(2, [5, 1, 0], [1, 2, 20]),
        walker([0, 0, 0]),
        probeAt([0, 0, 0], { mode: 0, dir: [3, 0, 3] }),
      ]),
      180,
    ),
  );
  assert(
    slide.position[0] < 4.7,
    `stopped by the wall: x=${slide.position[0]}`,
  );
  assert(slide.position[2] > 6, `slid along it: z=${slide.position[2]}`);
  // Walk off a 0.25 m ledge: snapping keeps the character on the ground.
  let airborne = 0;
  let world = level([
    box(1, [0, -0.5 - 0.25, 0], [100, 1, 100], {}),
    box(2, [-5, -0.5, 0], [10, 1, 20]),
    walker([-4, 0, 0], { snap_distance: 0.3 }),
    probeAt([0, 0, 0], { mode: 0, dir: [4, 0, 0] }),
  ]);
  let state = encodeWorld(schema, world);
  for (let t = 0; t < 120; t++) {
    state = probes.step(state, idleInput(schema, t)).state;
    if (!walkerState(decodeWorld(schema, state)).character.grounded) airborne++;
  }
  assertEquals(airborne, 0, "never left the ground");
  world = decodeWorld(schema, state);
  assert(walkerState(world).position[0] > 0, "walked off the ledge");
});

Deno.test("a character jumps to the height its speed gives and lands", () => {
  let state = encodeWorld(
    schema,
    level([floor, walker([0, 0, 0]), probeAt([0, 0, 0], { mode: 3 })]),
  );
  let apex = 0;
  let landedAfterApex = false;
  for (let t = 0; t < 90; t++) {
    state = probes.step(state, idleInput(schema, t)).state;
    const { position, character } = walkerState(decodeWorld(schema, state));
    if (position[1] > apex) apex = position[1];
    if (apex > 1 && character.grounded) landedAfterApex = true;
  }
  closeTo(apex, (7 * 7) / (2 * 20), 0.12);
  assert(landedAfterApex, "came back down");
});

Deno.test("a kinematic platform carries a character and pushes boxes", async () => {
  const platform = {
    id: 2,
    components: {
      transform: { position: [0, 0.5, 8] },
      collider: { size: [4, 0.2, 4] },
      body: { kind: "kinematic", linear_velocity: [2, 0, 0] },
    },
  };
  // The game moves kinematic bodies and says how fast: a system for the test.
  const moving = await compileGame(`
const move_platform = fn (input: s.Input) => fn (e: s.Entity) => do:
  let #Some b = e.body else:
    return e
  let #Some t = e.transform else:
    return e
  t.position := t.position + b.linear_velocity * input.dt
  e.transform := #Some t
  return e
const update = fn (input: s.Input) => fn (world: s.World) => do:
  world.entities := array.map (move_platform input) self
  return s.physics_step input.dt world
`);
  const carried = play(
    moving,
    level([floor, platform, walker([0, 0.6, 8])]),
    120,
  );
  const w = walkerState(carried);
  closeTo(
    w.position[0],
    (entityOf(carried, 2).components.transform.position as number[])[0],
    0.15,
  );
  assert(w.position[0] > 3.5, `carried along: x=${w.position[0]}`);
  assertEquals(w.character.ground, 2);
  const crate = {
    id: 3,
    components: {
      transform: { position: [3, 0.9, 8] },
      collider: {},
      body: {},
    },
  };
  const pushed = play(moving, level([floor, platform, crate]), 120);
  assert(
    (entityOf(pushed, 3).components.transform.position as number[])[0] > 3.5,
    "the kinematic platform shoves the crate it rides into",
  );
});

Deno.test("a character shoves dynamic bodies it walks into", () => {
  const world = play(
    probes,
    level([
      floor,
      walker([0, 0, 0]),
      {
        id: 3,
        components: {
          transform: { position: [2, 0.5, 0] },
          collider: {},
          body: { mass: 0.5 },
        },
      },
      probeAt([0, 0, 0], { mode: 0, dir: [3, 0, 0] }),
    ]),
    120,
  );
  assert(
    (entityOf(world, 3).components.transform.position as number[])[0] > 3.5,
  );
  assert(walkerState(world).position[0] > 3, "and keeps walking");
});

// Rigid bodies ---------------------------------------------------------------------

Deno.test("a ball bounces by its restitution and a thrown box comes to rest asleep", () => {
  let state = encodeWorld(
    schema,
    level([
      floor,
      {
        id: 2,
        components: {
          transform: { position: [0, 5, 0] },
          collider: { shape: "sphere", radius: 0.5, restitution: 0.8 },
          body: {},
        },
      },
      {
        id: 3,
        components: {
          transform: { position: [4, 3, 0], rotation: [0.2, 0.3, 0.1, 0.92] },
          collider: {},
          body: { linear_velocity: [3, 0, 1] },
        },
      },
    ]),
  );
  let rebound = 0;
  let landed = false;
  for (let t = 0; t < 360; t++) {
    state = probes.step(state, idleInput(schema, t)).state;
    const w = decodeWorld(schema, state);
    const e = entityOf(w, 2).components;
    const y = (e.transform.position as number[])[1];
    const vy = (e.body.linear_velocity as number[])[1];
    if (y < 0.7) landed = true;
    if (landed && vy > 0) rebound = Math.max(rebound, vy);
  }
  assert(rebound > 5, `bounced back up at ${rebound} m/s`);
  const w = decodeWorld(schema, state);
  const crate = entityOf(w, 3).components;
  assertEquals(crate.body.sleeping, true);
  const [x, y, z] = crate.transform.position as number[];
  closeTo(y, 0.5, 0.06);
  assert(x > 4 && Math.abs(z) < 6);
});

Deno.test("fast bodies do not tunnel through thin walls", () => {
  const world = play(
    probes,
    level([
      floor,
      box(2, [10, 2, 0], [0.1, 4, 8]),
      {
        id: 3,
        components: {
          transform: { position: [0, 1, 0] },
          collider: { shape: "sphere", radius: 0.2 },
          body: { gravity_scale: 0, linear_velocity: [150, 0, 0] },
        },
      },
    ]),
    30,
  );
  const x = (entityOf(world, 3).components.transform.position as number[])[0];
  assert(x < 10, `stopped by the wall: x=${x}`);
});

Deno.test("sleeping bodies wake when something hits them", () => {
  let state = encodeWorld(
    schema,
    level([
      floor,
      {
        id: 2,
        components: {
          transform: { position: [0, 0.5, 0] },
          collider: {},
          body: {},
        },
      },
    ]),
  );
  for (let t = 0; t < 120; t++) {
    state = probes.step(state, idleInput(schema, t)).state;
  }
  assertEquals(
    entityOf(decodeWorld(schema, state), 2).components.body.sleeping,
    true,
  );
  // Throw a ball at it.
  const w = decodeWorld(schema, state);
  w.entities.push(
    ...level([
      {
        id: 3,
        components: {
          transform: { position: [-4, 0.5, 0] },
          collider: { shape: "sphere", radius: 0.5 },
          body: { linear_velocity: [10, 0, 0] },
        },
      },
    ]).entities,
  );
  w.nextEntity = 4;
  state = encodeWorld(schema, w);
  for (let t = 120; t < 150; t++) {
    state = probes.step(state, idleInput(schema, t)).state;
  }
  const after = entityOf(decodeWorld(schema, state), 2).components;
  assert(
    (after.transform.position as number[])[0] > 0.3,
    "the crate was knocked",
  );
});

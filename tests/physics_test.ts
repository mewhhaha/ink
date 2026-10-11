import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { compile } from "./support.ts";
import { box, Fixture, rigid, stack, walker } from "./physics_fixture.ts";
import type { Source } from "./physics_fixture.ts";

const closeTo = (actual: number, expected: number, tolerance = 0.02) =>
  assertAlmostEquals(actual, expected, tolerance);
const floor = box(1, [0, -0.5, 0], [100, 1, 100]);

Deno.test("[stress] standalone physics library", async (t) => {
  const compiled = await compile(new URL("./physics.blot", import.meta.url));
  const guest = compiled.guest;
  const level = (sources: Source[]) => new Fixture(guest, sources);
  try {
    await t.step(
      "50 stacked boxes stand for 10 s, identically every run",
      () => {
        const first = level(stack(50)).advance(600);
        const second = level(stack(50)).advance(600);
        assertEquals(
          first.lanes,
          second.lanes,
          "identical poses, velocities and contact cache",
        );
        let sag = 0;
        let drift = 0;
        for (let i = 0; i < 50; i++) {
          const [x, y, z] = first.source(i + 2).position;
          assert(Number.isFinite(y));
          sag = Math.max(sag, Math.abs(y - (0.5 + i)));
          drift = Math.max(drift, Math.abs(x), Math.abs(z));
        }
        assert(sag < 0.5, `sag ${sag}`);
        assert(drift < 0.06, `drift ${drift}`);
        assert(first.source(51).sleeping, "stack came to rest");
      },
    );

    await t.step(
      "50 and 60 box towers remain bounded with sleeping disabled",
      () => {
        for (
          const [count, sagLimit, driftLimit] of [[50, 0.45, 0.2], [
            60,
            0.55,
            0.4,
          ]]
        ) {
          const tower = level(stack(count, false)).advance(600);
          let sag = 0;
          let drift = 0;
          for (let i = 0; i < count; i++) {
            const s = tower.source(i + 2);
            const [x, y, z] = s.position;
            assert(Number.isFinite(y));
            assert(!s.sleeping);
            sag = Math.max(sag, Math.abs(y - (0.5 + i)));
            drift = Math.max(drift, Math.abs(x), Math.abs(z));
          }
          assert(
            sag < sagLimit && drift < driftLimit,
            JSON.stringify({ count, sag, drift }),
          );
        }
      },
    );

    await t.step(
      "rays find nearest solids, exclude triggers, respect masks and skipped ids",
      () => {
        const sc = level([
          box(1, [5, 0, 0], [2, 2, 2]),
          box(2, [10, 0, 0], [2, 2, 2], { layer: 2 }),
          box(3, [3, 0, 0], [1, 1, 1], { trigger: true }),
        ]);
        const hit = sc.query(1, [0, 0, 0], [1, 0, 0]);
        assertEquals(hit.slice(0, 2), [1, 1]);
        closeTo(hit[2], 4);
        closeTo(hit[3], -1);
        closeTo(hit[6], 4);
        const skipped = sc.query(1, [0, 0, 0], [1, 0, 0], 20, 0.5, 1);
        assertEquals(skipped[1], 2);
        closeTo(skipped[2], 9);
        assertEquals(sc.query(1, [0, 0, 0], [1, 0, 0], 3), [0]);
        assertEquals(sc.query(1, [0, 0, 0], [1, 0, 0], 20, 0.5, 0, 2)[1], 2);
      },
    );

    await t.step(
      "rays and casts see spheres, capsules and convex brushes",
      () => {
        const sc = level([
          box(5, [0, 0, 0], [1, 1, 1], {
            shape: 3,
            planes: [
              [0, -1, 0, 0],
              [1, 0, 0, 4],
              [0, 0, 1, 1],
              [0, 0, -1, 1],
              [-0.7071068, 0.7071068, 0, 0],
            ],
          }),
          box(6, [10, 1, 0], [1, 1, 1], { shape: 1, radius: 1 }),
          box(7, [10, 1, 5], [1, 1, 1], { shape: 2, radius: 0.5, height: 3 }),
        ]);
        const wedge = sc.query(1, [2, 5, 0], [0, -1, 0]);
        assertEquals(wedge[1], 5);
        closeTo(wedge[2], 3);
        closeTo(wedge[3], -0.7071, 0.01);
        closeTo(wedge[4], 0.7071, 0.01);
        const sphere = sc.query(1, [6, 1, 0], [1, 0, 0]);
        assertEquals(sphere[1], 6);
        closeTo(sphere[2], 3);
        const capsule = sc.query(1, [0, 1, 5], [1, 0, 0]);
        assertEquals(capsule[1], 7);
        closeTo(capsule[2], 9.5);
        const wall = level([box(1, [8, 0, 0], [1, 4, 4])]);
        for (const mode of [2, 3]) {
          const cast = wall.query(mode, [0, 0, 0], [1, 0, 0]);
          assertEquals(cast[1], 1);
          closeTo(cast[2], 7, 0.01);
          closeTo(cast[3], -1, 0.01);
        }
      },
    );

    await t.step("overlaps include triggers, point-solid excludes them", () => {
      const sc = level([
        box(1, [4, 0, 0], [2, 2, 2]),
        box(2, [2, 0, 0], [1, 1, 1], { trigger: true }),
      ]);
      assertEquals(sc.query(4, [2.75, 0, 0], [0, 0, 0], 20, 0.4), [2, 1, 2]);
      assertEquals(sc.query(4, [2.75, 0, 0], [0, 0, 0], 20, 0.1), [0]);
      assertEquals(sc.query(5, [4, 0, 0]), [1]);
      assertEquals(sc.query(5, [2, 0, 0]), [0]);
    });

    await t.step("a character walks on the floor and rests on it", () => {
      const state = level([floor, walker([0, 0.5, 0])]).advance(60, [4, 0, 0])
        .source(100);
      closeTo(state.position[0], 4, 0.1);
      assert(
        state.position[1] < 0.02 && state.position[1] >= 0,
        `height ${state.position[1]}`,
      );
      assert(state.grounded);
      assertEquals(state.ground, 1);
    });

    await t.step("slopes are walkable up to the configured limit", () => {
      const ramp = box(5, [0, 0, 0], [1, 1, 1], {
        shape: 3,
        planes: [
          [0, -1, 0, 0],
          [1, 0, 0, 12],
          [0, 0, 1, 3],
          [0, 0, -1, 3],
          [-0.5, 0.8660254, 0, -2],
        ],
      });
      const climb = level([floor, ramp, walker([2, 0, 0], { slope: 40 })])
        .advance(120, [3, 0, 0]).source(100);
      assert(
        climb.position[0] > 8 && climb.position[1] > 1 && climb.grounded,
        JSON.stringify(climb),
      );
      const blocked = level([floor, ramp, walker([2, 0, 0], { slope: 25 })])
        .advance(120, [3, 0, 0]).source(100);
      assert(
        blocked.position[0] < 5 && blocked.position[1] < 0.5,
        JSON.stringify(blocked),
      );
    });

    await t.step("step height admits low ledges and blocks higher ones", () => {
      const run = (rise: number) =>
        level([
          floor,
          box(2, [5, rise / 2, 0], [2, rise, 6]),
          walker([2, 0, 0], { step: 0.4 }),
        ]).advance(120, [3, 0, 0]).source(100);
      const low = run(0.3);
      assert(low.position[0] > 5.5 && low.grounded, JSON.stringify(low));
      const high = run(0.7);
      assert(high.position[0] < 4.2, JSON.stringify(high));
    });

    await t.step("characters slide along walls and snap down steps", () => {
      const slid = level([
        floor,
        box(2, [5, 1, 0], [1, 2, 20]),
        walker([0, 0, 0]),
      ])
        .advance(180, [3, 0, 3]).source(100);
      assert(
        slid.position[0] < 4.7 && slid.position[2] > 6,
        JSON.stringify(slid),
      );
      const sc = level([
        box(1, [0, -0.75, 0], [100, 1, 100]),
        box(2, [-5, -0.5, 0], [10, 1, 20]),
        walker([-4, 0, 0], { snap: 0.3 }),
      ]);
      for (let tick = 0; tick < 120; tick++) {
        sc.advance(1, [4, 0, 0]);
        assert(sc.source(100).grounded, `airborne at tick ${tick}`);
      }
      assert(sc.source(100).position[0] > 0);
    });

    await t.step("jump speed determines apex and the character lands", () => {
      const sc = level([floor, walker([0, 0, 0])]);
      let apex = 0;
      let landed = false;
      for (let tick = 0; tick < 90; tick++) {
        const s = sc.advance(1, [0, 0, 0], true).source(100);
        apex = Math.max(apex, s.position[1]);
        if (apex > 1 && s.grounded) landed = true;
      }
      closeTo(apex, 49 / 40, 0.12);
      assert(landed);
    });

    await t.step("kinematic platforms carry characters and push crates", () => {
      const platform = box(2, [0, 0.5, 8], [4, 0.2, 4], {
        body: rigid({ kind: 2, velocity: [2, 0, 0] }),
      });
      const carried = level([floor, platform, walker([0, 0.6, 8])]).advance(
        120,
        [0, 0, 0],
        false,
        true,
      );
      closeTo(
        carried.source(100).position[0],
        carried.source(2).position[0],
        0.15,
      );
      assert(carried.source(100).position[0] > 3.5);
      assertEquals(carried.source(100).ground, 2);
      const pushed = level([
        floor,
        platform,
        box(3, [3, 0.9, 8], [1, 1, 1], { body: rigid() }),
      ])
        .advance(120, [0, 0, 0], false, true);
      assert(pushed.source(3).position[0] > 3.5);
    });

    await t.step("a character shoves dynamic bodies and keeps walking", () => {
      const sc = level([
        floor,
        walker([0, 0, 0]),
        box(3, [2, 0.5, 0], [1, 1, 1], { body: rigid({ mass: 0.5 }) }),
      ]).advance(120, [3, 0, 0]);
      assert(sc.source(3).position[0] > 3.5);
      assert(sc.source(100).position[0] > 3);
    });

    await t.step(
      "restitution bounces a ball and a thrown box comes to rest asleep",
      () => {
        const sc = level([
          floor,
          box(2, [0, 5, 0], [1, 1, 1], {
            shape: 1,
            radius: 0.5,
            restitution: 0.8,
            body: rigid(),
          }),
          box(3, [4, 3, 0], [1, 1, 1], {
            rotation: [0.2, 0.3, 0.1, 0.92],
            body: rigid({ velocity: [3, 0, 1] }),
          }),
        ]);
        let rebound = 0;
        let landed = false;
        for (let tick = 0; tick < 360; tick++) {
          const ball = sc.advance(1).source(2);
          if (ball.position[1] < 0.7) landed = true;
          if (landed) rebound = Math.max(rebound, ball.velocity[1]);
        }
        assert(rebound > 5, `rebound ${rebound}`);
        const crate = sc.source(3);
        assert(crate.sleeping);
        closeTo(crate.position[1], 0.5, 0.06);
        assert(crate.position[0] > 4 && Math.abs(crate.position[2]) < 6);
      },
    );

    await t.step("fast bodies do not tunnel through thin static walls", () => {
      const sc = level([
        floor,
        box(2, [10, 2, 0], [0.1, 4, 8]),
        box(3, [0, 1, 0], [1, 1, 1], {
          shape: 1,
          radius: 0.2,
          body: rigid({ gravity: 0, velocity: [150, 0, 0] }),
        }),
      ]).advance(30);
      assert(sc.source(3).position[0] < 10, JSON.stringify(sc.source(3)));
    });

    await t.step("sleepers wake when an active body hits them", () => {
      const settled = level([
        floor,
        box(2, [0, 0.5, 0], [1, 1, 1], { body: rigid() }),
      ]).advance(120);
      assert(settled.source(2).sleeping);
      const s = settled.source(2);
      const sc = level([
        floor,
        box(2, [s.position[0], s.position[1], s.position[2]], [1, 1, 1], {
          body: rigid({ sleeping: true }),
        }),
        box(3, [-4, 0.5, 0], [1, 1, 1], {
          shape: 1,
          body: rigid({ velocity: [10, 0, 0] }),
        }),
      ]).advance(30);
      assert(sc.source(2).position[0] > 0.3, "crate was knocked awake");
    });

    await t.step(
      "shape inertia, rigid inertia transform and character velocity clipping",
      () => {
        const out = Array.from(
          guest.call(
            "primitives",
            new Float32Array([1, 2, 3, 4, -5, 6]),
          ) as Float32Array,
        );
        assertEquals(out.slice(0, 6), [-1, -2, -3, 1, 2, 3]);
        closeTo(out[6], 13 / 3, 0.00001);
        closeTo(out[7], 10 / 3, 0.00001);
        closeTo(out[8], 5 / 3, 0.00001);
        assertEquals(out.slice(9), [0, 0, 0, 4, 0, 6]);
      },
    );
  } finally {
    await compiled.dispose();
  }
});

Deno.test("physics falls, rests and retains scene queries", async () => {
  const compiled = await compile(new URL("./physics.blot", import.meta.url));
  try {
    const world = new Fixture(compiled.guest, [
      floor,
      box(2, [0, 2, 0], [1, 1, 1], { body: rigid() }),
    ]);
    world.advance(15);
    assert(world.source(2).position[1] < 2);
    world.advance(120);
    closeTo(world.source(2).position[1], 0.5);
    const hit = world.query(1, [0, 3, 0], [0, -1, 0]);
    assertEquals(hit[1], 2);
    closeTo(hit[2], 2);
  } finally {
    await compiled.dispose();
  }
});

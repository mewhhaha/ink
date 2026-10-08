import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  button,
  decodeWorld,
  defineSchema,
  encodeWorld,
  u32,
} from "@ink/schema";
import { Session } from "./session.ts";
import { assertScenario, runScenario, type Scenario } from "./scenarios.ts";

const schema = defineSchema({
  resources: { score: { value: u32() } },
  actions: { jump: button("Space") },
});
function session() {
  const session = new Session({ schema, catalog: { assets: {} } });
  session.setGame({
    hasStart: false,
    start: (state) => ({ state, events: [] }),
    step(state, input) {
      const world = decodeWorld(schema, state);
      if ((input.actions.jump as { pressed: boolean }).pressed) {
        world.resources.score.value = Number(world.resources.score.value) + 1;
      }
      return { state: encodeWorld(schema, world), events: [] };
    },
    dispose() {},
  }, { revision: 1 });
  return session;
}

Deno.test("scenarios derive button edges, stop at a failure and retain replay and image evidence", async () => {
  const s = session();
  try {
    const scenario: Scenario = {
      ink: 1,
      name: "Jump",
      steps: [{ ticks: 2, keys: ["Space"] }, { ticks: 2 }, {
        ticks: 2,
        keys: ["Space"],
      }],
      checkpoints: [
        { tick: 2, assertions: [{ path: "resources.score.value", value: 1 }] },
        {
          tick: 5,
          assertions: [{ path: "resources.score.value", value: 3 }],
          image: { golden: "jump.png" },
        },
        { tick: 6 },
      ],
    };
    const result = await runScenario(
      s,
      scenario,
      () => Promise.resolve({ png: "actual", diff: "difference", error: 20 }),
    );
    assertEquals(result.passed, false);
    assertEquals(result.tick, 5);
    assertEquals(result.failures.length, 2);
    assertEquals(result.failures[0].png, "actual");
    assertEquals(s.timeline.marks[0].detail?.diff, "difference");
    assertEquals(s.timeline.input(2)?.actions.jump, {
      down: false,
      pressed: false,
      released: true,
    });
    assert(s.paused);
    const snapshot = s.state.slice();
    s.seek(0);
    s.seek(5);
    assertEquals(s.state, snapshot);
    assert(
      assertScenario(s.world, () => "", {
        entity: "missing",
        path: "id",
        value: undefined,
      }),
    );
  } finally {
    s.dispose();
  }
});

Deno.test("scenarios reject incomplete recordings and empty checkpoints", async () => {
  const s = session();
  try {
    await assertRejects(
      () => runScenario(s, { ink: 1, name: "Empty", checkpoints: [] }),
      Error,
      "checkpoint",
    );
    await assertRejects(
      () =>
        runScenario(s, {
          ink: 1,
          name: "Short",
          steps: [{ ticks: 1 }],
          checkpoints: [{ tick: 2 }],
        }),
      Error,
      "recording ends",
    );
  } finally {
    s.dispose();
  }
});

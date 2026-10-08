import { assertEquals } from "@std/assert";
import {
  button,
  defineSchema,
  type EventModel,
  idleInput,
  standard,
} from "@ink/schema";
import { buildHandoff, type Replay, replayHandoff } from "./handoff.ts";
import { type GameInstance, Session } from "./session.ts";
import { Timeline } from "./timeline.ts";

const schema = defineSchema({
  components: {},
  actions: { burst: button("Space") },
  events: standard.events,
});
const burst: EventModel = {
  name: "particles",
  value: { emitter: 1, count: 40, seed: 9, position: [1, 2, 3] },
};
const game: GameInstance = {
  hasStart: true,
  start(state) {
    return { state: state.slice(), events: [burst] };
  },
  step(state, input) {
    return {
      state: state.slice(),
      events: (input.actions.burst as { pressed: boolean }).pressed
        ? [burst]
        : [],
    };
  },
  dispose() {},
};
function session() {
  const session = new Session({
    schema,
    catalog: { assets: {} },
    scene: { ink: 1, entities: [] },
  });
  session.setGame(game, { revision: 1 });
  return session;
}
Deno.test("presentation follows seeks, replay keyframes, branching and rollback without redispatch", () => {
  const a = session(), b = session();
  let dispatched = 0;
  a.onEvents(() => dispatched++);
  try {
    a.play();
    for (let tick = 0; tick < 70; tick++) {
      const input = idleInput(schema, tick);
      input.actions.burst = {
        down: tick === 57,
        pressed: tick === 57,
        released: false,
      };
      a.stepFrame(input);
    }
    assertEquals(a.presentationEvents.map((f) => f.tick), [0, 58]);
    assertEquals(dispatched, 2);
    const packet = a.state.slice();
    const handoff = buildHandoff(a, { note: "burst replay", replaySeconds: 0 });
    const replay: Replay = JSON.parse(
      handoff.files.find((f) => f.name === "replay.json")!.text!,
    );
    assertEquals(replay.keyframe.tick, 60);
    replayHandoff(b, replay);
    assertEquals(b.state, packet);
    assertEquals(
      b.presentationEvents,
      a.presentationEvents,
      "bursts preceding a keyframe survive handoff",
    );
    a.seek(40);
    assertEquals(a.presentationEvents.map((f) => f.tick), [0]);
    a.seek(70);
    assertEquals(a.presentationEvents.map((f) => f.tick), [0, 58]);
    assertEquals(dispatched, 2, "seeking never replays audio");
    a.seek(40);
    a.stepFrame(idleInput(schema));
    assertEquals(a.timeline.events.between(0, 100).map((f) => f.tick), [0]);

    const driver = { label: "test", advance: () => false, dispose() {} };
    b.drivePlay(driver, packet);
    b.applyDrivenFrame(driver, idleInput(schema, 70), packet, {
      state: packet.slice(),
      events: [burst],
    });
    assertEquals(b.timeline.events.between(0, 100).map((f) => f.tick), [71]);
    b.applyDrivenFrame(driver, idleInput(schema, 70), packet, {
      state: packet.slice(),
      events: [],
    });
    assertEquals(
      b.timeline.events.between(0, 100),
      [],
      "corrected predictions erase cancelled bursts",
    );
    a.stop();
    assertEquals(a.presentationEvents, []);
  } finally {
    a.dispose();
    b.dispose();
  }
});

Deno.test("timeline trimming keeps bounded event context before its first keyframe", () => {
  const t = new Timeline(2, 4);
  const frame = (tick: number) => ({
    tick,
    state: new Float32Array(),
    schema,
    catalog: { assets: {} },
  });
  t.reset(frame(0));
  for (let i = 0; i < 20; i++) {
    t.record(i, () => frame(i), idleInput(schema, i));
    t.events.record(i + 1, [burst]);
  }
  const ticks = t.events.between(0, 100).map((f) => f.tick);
  assertEquals(ticks[0], t.first - t.capacity);
  assertEquals(ticks.at(-1), 20);
});

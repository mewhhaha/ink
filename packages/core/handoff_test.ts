import { assertEquals, assertThrows } from "@std/assert";
import { decodeWorld, defineSchema, encodeWorld, f32, u32 } from "@ink/schema";
import { buildHandoff, type Replay, replayHandoff } from "./handoff.ts";
import { Session } from "./session.ts";

Deno.test("handoff replay preserves post-start keyframes, time, bytes and scrubbing", () => {
  const schema = defineSchema({
    resources: { count: { starts: u32(), total: f32() } },
  });
  const session = new Session({
    schema,
    catalog: { assets: {} },
    scene: { ink: 1, entities: [] },
  });
  let starts = 0;
  session.setGame({
    hasStart: true,
    dispose() {},
    start(state) {
      starts++;
      const world = decodeWorld(schema, state);
      world.resources.count.starts = Number(world.resources.count.starts) + 1;
      return { state: encodeWorld(schema, world), events: [] };
    },
    step(state, input) {
      const world = decodeWorld(schema, state);
      world.tick++;
      world.resources.count.total = Number(world.resources.count.total) +
        input.time;
      return { state: encodeWorld(schema, world), events: [] };
    },
  }, { revision: 1 });
  session.play();
  for (let i = 0; i < 150; i++) session.stepFrame();
  const expected = session.state.slice();
  for (const seconds of [10, 0.5]) {
    const handoff = buildHandoff(session, {
      note: "Replay",
      replaySeconds: seconds,
    });
    const replay: Replay = JSON.parse(
      handoff.files.find((f) => f.name === "replay.json")!.text!,
    );
    replayHandoff(session, replay);
    assertEquals(session.state, expected);
    assertEquals(
      starts,
      1,
      "start must not run again, even for tick-zero keyframes",
    );
    session.seek(replay.keyframe.tick ?? 0);
    session.seek(150);
    assertEquals(session.state, expected);
    const broken = structuredClone(replay);
    broken.inputs[0].tick++;
    assertThrows(
      () => replayHandoff(session, broken),
      Error,
      "missing replay input",
    );
    assertEquals(
      session.state,
      expected,
      "invalid replay leaves the live world intact",
    );
  }
  session.dispose();
});

Deno.test("comment threads append against current state and preserve workflow metadata", () => {
  const session = new Session({
    schema: defineSchema({}),
    catalog: { assets: {} },
  });
  const comment = session.addComment({
    author: "tester",
    text: "Jump",
    assignee: "agent",
    anchor: {
      mode: "play",
      tick: 5,
      range: { from: 5, to: 9 },
      code: { file: "game/main.blot", line: 65 },
    },
  });
  const reply = {
    author: "agent",
    text: "Fixed",
    created: "2026-10-08T00:00:00Z",
  };
  session.replyToComment(comment.id, { ...reply, text: "Reproduced" });
  session.replyToComment(comment.id, {
    ...reply,
    captures: [{
      label: "after",
      path: ".ink/captures/check/view.png",
      tick: 9,
    }],
  });
  session.updateComment(comment.id, { status: "resolved" });
  assertEquals(session.comments[0].replies?.length, 2);
  assertEquals(session.comments[0].assignee, "agent");
  assertEquals(session.comments[0].anchor.range, { from: 5, to: 9 });
  assertThrows(
    () => session.replyToComment("missing", reply),
    Error,
    "no comment",
  );
});

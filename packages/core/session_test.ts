import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  axis2,
  button,
  type Catalog,
  defineSchema,
  f32,
  type SceneFile,
  standard,
  u32,
} from "@ink/schema";
import { createGameCompiler, formatDiagnostic } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import { buildHandoff, runHeadless, Session } from "./mod.ts";

const input = {
  components: {
    transform: standard.transform,
    mesh: standard.mesh,
    mover: { speed: f32({ default: 2 }) },
  },
  resources: { score: { value: u32() } },
  events: { ...standard.events },
  actions: {
    move: axis2({
      left: ["KeyA"],
      right: ["KeyD"],
      down: ["KeyS"],
      up: ["KeyW"],
    }),
    jump: button("Space"),
  },
  messages: { scored: "Score {0}" },
};
const schema = defineSchema(input);
const catalog: Catalog = {
  assets: { mesh: ["builtin:cube"], texture: [], sound: [] },
};

const game = `import * as array from "std/array"
import * as s from "./schema.gen"

const move = fn (input: s.Input) => fn (entity: s.Entity) => do:
  let #Some mover = entity.mover else:
    return entity
  let #Some transform = entity.transform else:
    return entity
  transform.position.x := self + input.actions.move.x * mover.speed * input.dt
  transform.position.z := self + 1.0
  entity.transform := #Some transform
  return entity

const update = fn (input: s.Input) => fn (world: s.World) => do:
  world.entities := array.map (move input) self
  if input.actions.jump.pressed:
    world.resources.score.value := self + 1
    use s.emit (#s.Log { message: s.message_scored, a: U32.to_f32 world.resources.score.value, b: 0.0 })
  return world

entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
`;

const scene: SceneFile = {
  ink: 1,
  entities: [
    {
      id: 1,
      name: "Player",
      components: { transform: {}, mover: {}, mesh: { shape: "builtin:cube" } },
    },
    {
      id: 2,
      name: "Light",
      components: { transform: { position: [0, 5, 0] } },
    },
  ],
};

async function withGame(
  test: (
    load: () => Promise<Awaited<ReturnType<typeof loadGame>>>,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir({ prefix: "ink-core-" });
  const entry = join(dir, "main.blot");
  await Deno.writeTextFile(entry, game);
  const compiler = await createGameCompiler({ entry, schema, catalog });
  try {
    const result = await compiler.build();
    if (!result.ok) {
      throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    }
    await test(() => loadGame(result.bytes, schema));
  } finally {
    await compiler.dispose();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("recorded inputs branch and replay without mutating their source", async () => {
  await withGame(async (load) => {
    const session = new Session({ schema, catalog, scene });
    session.setGame(await load(), { revision: 1 });
    session.play();
    const recorded = session.input.sample(900, 3, 70);
    recorded.actions.move = [1, 0];
    recorded.actions.jump = { down: true, pressed: true, released: false };
    const original = structuredClone(recorded);
    for (let i = 0; i < 30; i++) session.stepFrame(recorded);
    const state = session.state.slice();
    assertEquals(session.tick, 30);
    assertEquals(session.world.resources.score.value, 30);
    assertEquals(recorded, original);
    assertEquals(session.timeline.input(0)?.tick, 0);
    assertEquals(session.timeline.input(0)?.dt, 1 / 60);
    assertEquals(session.timeline.input(0)?.time, 0);
    session.seek(10);
    for (let i = 10; i < 30; i++) session.stepFrame(recorded);
    assertEquals(
      session.state,
      state,
      "branching preserves deterministic results",
    );
    assertAlmostEquals(session.timeline.input(10)!.time, 10 / 60, 1e-12);
    session.seek(0);
    session.seek(30);
    assertEquals(session.state, state, "seeking replays the supplied actions");
    session.dispose();
  });
});

Deno.test("session plays, edits while paused, undoes, rewinds and migrates", async () => {
  await withGame(async (load) => {
    const session = new Session({ schema, catalog, scene });
    session.setGame(await load(), { revision: 1 });
    assertEquals(session.mode, "edit");
    assertEquals(session.world.entities.length, 2);

    // Edit the document; undo restores it.
    session.edit("Move player", (world) => {
      world.entities[0].components.transform.position = [5, 0, 0];
    });
    assert(session.dirty);
    assertEquals(session.world.entities[0].components.transform.position, [
      5,
      0,
      0,
    ]);
    session.undo();
    assertEquals(session.world.entities[0].components.transform.position, [
      0,
      0,
      0,
    ]);
    session.redo();

    // Play: 30 steps moving right.
    session.play();
    session.input.keyDown("KeyD");
    for (let i = 0; i < 30; i++) session.advance(1 / 60);
    assertEquals(session.tick, 30);
    const x = session.world.entities[0].components.transform
      .position as number[];
    assertAlmostEquals(x[0], 5 + 2 * 30 / 60, 1e-4);
    assertEquals(x[2], 30);

    // Pause and edit the live world; the document is untouched.
    session.pause();
    session.edit("Teleport", (world) => {
      world.entities[0].components.transform.position = [100, 0, 0];
    });
    assertEquals(
      (session.world.entities[0].components.transform.position as number[])[0],
      100,
    );
    assertEquals(
      (session.documentWorld.entities[0].components.transform
        .position as number[])[0],
      5,
    );
    session.undo();
    assertAlmostEquals(
      (session.world.entities[0].components.transform.position as number[])[0],
      6,
      1e-4,
    );
    assertEquals(session.tick, 30);

    // Rewind by replaying recorded inputs.
    session.seek(10);
    assertEquals(session.tick, 10);
    assertEquals(
      (session.world.entities[0].components.transform.position as number[])[2],
      10,
    );
    session.seek(30);
    assertEquals(
      (session.world.entities[0].components.transform.position as number[])[2],
      30,
    );

    // Events become console lines.
    session.resume();
    session.input.keyDown("Space");
    session.advance(1 / 60);
    assertEquals(session.world.resources.score.value, 1);
    assertEquals(session.log.at(-1)?.text, "Score 1");

    // Schema change: a new field appears with its default; the game waits.
    const changed = defineSchema({
      ...input,
      components: {
        ...input.components,
        mover: { speed: f32({ default: 2 }), boost: f32({ default: 3 }) },
      },
    });
    session.setProject(changed, catalog);
    assertEquals(session.world.entities[0].components.mover.boost, 3);
    assertEquals(session.canStep, false);

    // The hand-off has the state, a replay and a readable index.
    const handoff = buildHandoff(session, {
      note: "Player drifts\nIt keeps moving on Z.",
      project: "examples/test",
    });
    assert(handoff.markdown.startsWith("# Player drifts"));
    const names = handoff.files.map((f) => f.name);
    assert(names.includes("state.scene.json"));
    assert(names.includes("replay.json"));

    session.stop();
    assertEquals(session.mode, "edit");
    assertEquals(
      (session.world.entities[0].components.transform.position as number[])[0],
      5,
    );
    assertEquals(session.world.entities[0].components.mover.boost, 3);
  });
});

Deno.test("headless runs are deterministic", async () => {
  await withGame(async (load) => {
    const loaded = await load();
    const session = new Session({ schema, catalog, scene });
    const a = runHeadless(loaded, schema, session.state, 20);
    const b = runHeadless(loaded, schema, session.state, 20);
    assertEquals(a.state, b.state);
    assertEquals(a.state[1], 20);
    loaded.dispose();
  });
});

Deno.test("transactions make one undo step and can cancel", () => {
  const session = new Session({ schema, catalog, scene });
  const drag = session.begin("Drag");
  for (let i = 1; i <= 5; i++) {
    drag.update((world) => {
      world.entities[0].components.transform.position = [i, 0, 0];
    });
  }
  drag.commit();
  assertEquals(session.history().undo, ["Drag"]);
  session.undo();
  assertEquals(session.world.entities[0].components.transform.position, [
    0,
    0,
    0,
  ]);

  const cancelled = session.begin("Drag");
  cancelled.update((world) => {
    world.entities[0].components.transform.position = [9, 9, 9];
  });
  cancelled.cancel();
  assertEquals(session.world.entities[0].components.transform.position, [
    0,
    0,
    0,
  ]);
});

Deno.test("entity edits keep the hierarchy consistent", () => {
  const session = new Session({ schema, catalog, scene });
  const child = session.createEntity({ name: "Child", parent: 1 });
  const grandchild = session.createEntity({
    name: "Grandchild",
    parent: child,
  });
  const copies = session.duplicateEntities([1]);
  assertEquals(copies.length, 1);
  const world = session.world;
  const copy = world.entities.find((e) => e.id === copies[0])!;
  const copiedChild = world.entities.find((e) => e.parent === copy.id)!;
  assert(world.entities.some((e) => e.parent === copiedChild.id));
  assertEquals(session.nameOf(copy.id), "Player copy");
  // Cycles are refused.
  session.reparent([1], grandchild);
  assertEquals(session.world.entities.find((e) => e.id === 1)!.parent, 0);
  session.deleteEntities([1]);
  assertEquals(session.world.entities.some((e) => e.id === grandchild), false);
});

Deno.test("the structure is one object until entities appear, move or are renamed", async () => {
  await withGame(async (load) => {
    const session = new Session({ schema, catalog, scene });
    session.setGame(await load(), { revision: 1 });
    const first = session.structure;
    assertEquals(first.rows.map((r) => r.id), [1, 2]);
    assertEquals(session.entity(2)?.id, 2);
    assertEquals(session.entity(99), undefined);
    session.play();
    for (let i = 0; i < 5; i++) session.stepFrame();
    // Components change every step; the structure does not.
    assert(session.structure === first);
    session.setComponent(1, "transform", { position: [5, 0, 0] });
    assert(session.structure === first);
    session.rename(2, "Lamp");
    const renamed = session.structure;
    assert(renamed !== first);
    assertEquals(session.nameOf(2), "Lamp");
    const id = session.createEntity({ name: "Extra" });
    assertEquals(session.structure.rows.map((r) => r.id), [1, 2, id]);
    assertEquals(session.entity(id)?.id, id);
    session.dispose();
  });
});

Deno.test("scrubbing forward continues a replay and agrees with a fresh one", async () => {
  await withGame(async (load) => {
    const session = new Session({ schema, catalog, scene });
    session.setGame(await load(), { revision: 1 });
    session.play();
    for (let i = 0; i < 100; i++) session.stepFrame();
    const end = session.state.slice();
    session.seek(70);
    const at70 = session.state.slice();
    session.seek(85);
    const at85 = session.state.slice();
    session.seek(70);
    assertEquals(session.state, at70);
    session.seek(100);
    assertEquals(session.state, end);
    session.seek(0);
    session.seek(85);
    assertEquals(session.state, at85);
    session.dispose();
  });
});

Deno.test("a scene file tuned on disk reaches the running world", async () => {
  await withGame(async (load) => {
    const session = new Session({ schema, catalog, scene });
    session.setGame(await load(), { revision: 1 });
    session.play();
    session.pause();
    for (let i = 0; i < 5; i++) session.stepFrame();
    const tick = session.tick;
    const player = () =>
      session.world.entities.find((e) => e.id === 1)!.components;
    const z = (player().transform as { position: number[] }).position[2];
    assertEquals(z, 5, "the game moves the player one metre per step");
    const tuned = structuredClone(scene);
    tuned.entities[0].components.mover = { speed: 9 };
    tuned.entities[1].components.transform = { position: [0, 8, 0] };
    assertEquals(session.sceneChangedOnDisk(tuned), true);
    assertEquals(session.tick, tick, "play carries on from where it was");
    assertEquals((player().mover as { speed: number }).speed, 9);
    assertEquals(
      (session.world.entities.find((e) => e.id === 2)!.components
        .transform as { position: number[] }).position[1],
      8,
    );
    assertEquals(
      (player().transform as { position: number[] }).position[2],
      z,
      "values the file did not change stay as the game left them",
    );
    assertEquals(session.sceneChangedOnDisk(tuned), false, "no change");
    session.dispose();
  });
});

Deno.test("a rebuild that changed nothing makes the build ready again", async () => {
  await withGame(async (load) => {
    const session = new Session({ schema, catalog, scene });
    session.setGame(await load(), { revision: 3, ms: 50 });
    session.setBuilding();
    assertEquals(session.status.kind, "building");
    session.setBuildUnchanged(41);
    assertEquals(session.status, { kind: "ready", revision: 3, ms: 41 });
    assertEquals(session.setProject(schema, catalog), false);
    session.dispose();
  });
});

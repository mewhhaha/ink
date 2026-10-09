import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  bool,
  type Catalog,
  color,
  decodeWorld,
  defineSchema,
  encodeWorld,
  enumOf,
  f32,
  idleInput,
  list,
  standard,
  struct,
  u32,
  vec3,
  type WorldModel,
} from "@ink/schema";
import { createGameCompiler, formatDiagnostic } from "@ink/blot/compiler";
import { loadGame } from "@ink/blot";
import { runHeadless } from "./headless.ts";

// Lists, a struct holding a list, absent components, empty components and a
// resource list exercise every path of the generated codec.
const schema = defineSchema({
  components: {
    transform: standard.transform,
    walker: {
      mood: enumOf(["calm", "eager"]),
      path: list(vec3()),
      tint: color(),
      stats: struct({
        trail: list(f32()),
        hp: u32({ default: 10 }),
        alive: bool({ default: true }),
      }),
    },
    tag: {},
    health: { value: f32({ default: 3 }) },
  },
  resources: { clock: { time: f32(), marks: list(u32()) } },
  events: { ...standard.events },
});
const catalog: Catalog = { assets: { mesh: [], texture: [], sound: [] } };

const identity = `import * as array from "std/array"
import * as s from "./schema.gen"

const idle = fn (input: s.Input) => fn (world: s.World) => world

entry const step = fn (lanes: Array F32) -> Array F32 => s.run idle lanes
`;

const changing = `import * as array from "std/array"
import * as s from "./schema.gen"

const grow = fn (input: s.Input) => fn (entity: s.Entity) => do:
  let #Some health = entity.health else:
    return entity
  health.value := self + 1.0
  entity.health := #Some health
  if let #Some walker = entity.walker:
    walker.stats.trail := array.push health.value self
    entity.walker := #Some walker
  return entity

const update = fn (input: s.Input) => fn (world: s.World) => do:
  world.entities := array.map (grow input) self
  world.resources.clock.time := self + input.dt
  world.resources.clock.marks := array.push world.tick self
  if world.tick == 2:
    let e = s.blank
    e.tag := #Some s.default_tag
    let (id, next) = s.spawn e world
    world := next
  return world

entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
`;

function initial(): WorldModel {
  return {
    tick: 0,
    nextEntity: 5,
    seed: 0x1234abcd,
    entities: [
      {
        id: 1,
        parent: 0,
        components: {
          transform: {
            position: [1, 2, 3],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          walker: {
            mood: "eager",
            path: [[1, 2, 3], [4, 5, 6]],
            tint: [1, 0.5, 0.25, 1],
            stats: { trail: [0.5], hp: 4, alive: false },
          },
          health: { value: 2 },
        },
      },
      { id: 2, parent: 1, nameId: 7, components: { tag: {} } },
      { id: 3, parent: 0, components: {} },
      {
        id: 4,
        parent: 0,
        components: {
          walker: {
            mood: "calm",
            path: [],
            tint: [0, 0, 0, 1],
            stats: { trail: [], hp: 1, alive: true },
          },
          health: { value: 9 },
        },
      },
    ],
    resources: { clock: { time: 0, marks: [] } },
  };
}

async function build(source: string) {
  const dir = await Deno.makeTempDir({ prefix: "ink-guest-" });
  const entry = join(dir, "main.blot");
  await Deno.writeTextFile(entry, source);
  const compiler = await createGameCompiler({ entry, schema, catalog });
  try {
    const result = await compiler.build();
    if (!result.ok) {
      throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    }
    return await loadGame(result.bytes, schema);
  } finally {
    await compiler.dispose();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("the guest writes back exactly the packet it was given", async () => {
  const game = await build(identity);
  try {
    const state = encodeWorld(schema, initial());
    const result = game.step(state, idleInput(schema));
    assertEquals(result.state, state);
    assertEquals(result.events, []);
  } finally {
    game.dispose();
  }
});

Deno.test("guest and host agree on a changed world, bit for bit", async () => {
  const game = await build(changing);
  try {
    const first = encodeWorld(schema, initial());
    const run = runHeadless(game, schema, first, 4);
    const world = decodeWorld(schema, run.state);
    assertEquals(world.tick, 4);
    assertEquals(world.resources.clock.marks, [0, 1, 2, 3]);
    assertEquals(world.entities.length, 5);
    assertEquals(world.entities[0].components.health.value, 6);
    assertEquals(world.entities[0].components.walker.stats, {
      trail: [0.5, 3, 4, 5, 6],
      hp: 4,
      alive: false,
    });
    assertEquals(
      (world.entities[0].components.walker.path as unknown[]).length,
      2,
    );
    // The host's encoding of what it decoded is the same packet.
    assertEquals(encodeWorld(schema, world), run.state);
    // The same run again is the same bytes.
    const again = runHeadless(game, schema, first, 4);
    assertEquals(again.state, run.state);
  } finally {
    game.dispose();
  }
});

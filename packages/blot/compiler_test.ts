import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  bool,
  button,
  type Catalog,
  decodeWorld,
  defineSchema,
  encodeWorld,
  enumOf,
  f32,
  idleInput,
  list,
  sceneToWorld,
  standard,
  textId,
  u32,
  vec3,
} from "@ink/schema";
import { createGameCompiler, formatDiagnostic } from "./compiler.ts";
import { loadGame } from "./mod.ts";

const schema = defineSchema({
  components: {
    ...standard.components,
    spinner: { speed: f32({ default: 1 }) },
    coin: {},
    walker: {
      mood: enumOf(["calm", "eager"]),
      path: list(vec3()),
      steps: u32(),
      awake: bool({ default: true }),
    },
  },
  resources: { score: { value: u32() } },
  events: { ...standard.events },
  actions: { jump: button("Space") },
  messages: { jumped: "Jumped {0} {1}" },
  names: { spinner: "Spinner", coin: "Coin" },
});

const catalog: Catalog = {
  assets: { mesh: ["builtin:cube", "models/coin.glb"], texture: [], sound: [] },
};

const game = `import * as array from "std/array"
import * as s from "./schema.gen"
import * as math from "ink/math"

const spin = fn (input: s.Input) => fn (entity: s.Entity) => do:
  if entity.name_id != s.name_spinner:
    return entity
  let #Some spinner = entity.spinner else:
    return entity
  let #Some transform = entity.transform else:
    return entity
  transform.rotation := self * math.axis_angle math.up (spinner.speed * input.dt)
  transform.position.x := self + 1.0
  entity.transform := #Some transform
  return entity

const walk = fn (entity: s.Entity) => do:
  let #Some walker = entity.walker else:
    return entity
  walker.steps := self + walker.path.length
  entity.walker := #Some walker
  return entity

const update = fn (input: s.Input) => fn (world: s.World) => do:
  world.entities := array.map (spin input) self
  world.entities := array.map walk self
  if input.actions.jump.pressed:
    use s.emit (#s.Log { message: s.message_jumped, a: 1.0, b: 2.0 })
  use roll <- s.random ()
  world.resources.score.value := self + 1
  return world

const begin = fn (input: s.Input) => fn (world: s.World) => do:
  let coin = s.blank
  coin.name_id := s.name_coin
  coin.coin := #Some #s.Coin
  coin.transform := #Some s.default_transform
  coin.mesh := #Some s.default_mesh
  let (id, spawned) = s.spawn coin world
  return spawned

entry const step = fn (lanes: Array F32) -> Array F32 => s.run update lanes
entry const start = fn (lanes: Array F32) -> Array F32 => s.run begin lanes
`;

Deno.test("generated schema module compiles and steps a world", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ink-blot-" });
  try {
    const entry = join(dir, "main.blot");
    await Deno.writeTextFile(entry, game);
    const compiler = await createGameCompiler({ entry, schema, catalog });
    try {
      const result = await compiler.build();
      if (!result.ok) {
        throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
      }
      const loaded = await loadGame(result.bytes, schema);
      const { world } = sceneToWorld(schema, {
        ink: 1,
        entities: [
          {
            id: 1,
            name: "Spinner",
            components: {
              transform: { position: [0, 1, 0] },
              spinner: { speed: 2 },
              mesh: { shape: "models/coin.glb" },
            },
          },
          {
            id: 2,
            parent: 1,
            components: {
              walker: { mood: "eager", path: [[1, 2, 3], [4, 5, 6]] },
            },
          },
        ],
      }, catalog);
      const state = encodeWorld(schema, world);
      assertEquals(decodeWorld(schema, state), world);

      const started = loaded.start(state, idleInput(schema));
      const afterStart = decodeWorld(schema, started.state);
      assertEquals(afterStart.entities.length, 3);
      assertEquals(afterStart.entities[2].id, 3);
      assert(afterStart.entities[2].components.coin);
      assertEquals(afterStart.entities[2].nameId, textId("Coin"));

      const input = idleInput(schema, 0, 0.5);
      input.actions.jump = { down: true, pressed: true, released: false };
      const stepped = loaded.step(started.state, input);
      const next = decodeWorld(schema, stepped.state);
      assertEquals(next.resources.score.value, 1);
      assertEquals(next.entities[0].components.transform.position, [1, 1, 0]);
      assertEquals(next.entities[1].components.walker.steps, 2);
      assertEquals(next.entities[1].components.walker.mood, "eager");
      assertEquals(next.entities[1].components.walker.path, [[1, 2, 3], [
        4,
        5,
        6,
      ]]);
      assert(next.seed !== world.seed, "random advanced the seed");
      assertEquals(stepped.events, [{
        name: "log",
        value: { message: 1, a: 1, b: 2 },
      }]);
      loaded.dispose();
    } finally {
      await compiler.dispose();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

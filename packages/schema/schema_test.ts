import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  bool,
  button,
  type Catalog,
  color,
  decodeEvents,
  decodeInput,
  decodeWorld,
  defineSchema,
  encodeEvents,
  encodeInput,
  encodeWorld,
  enumOf,
  type EventModel,
  f32,
  idleInput,
  list,
  migrateWorld,
  sceneToWorld,
  SchemaError,
  standard,
  struct,
  u32,
  vec3,
  worldToScene,
} from "./mod.ts";
import { f32Literal, generateBlot } from "./blot.ts";

const catalog: Catalog = {
  assets: {
    mesh: ["builtin:cube", "models/tree.glb"],
    texture: ["bricks.png"],
  },
};

const schema = defineSchema({
  components: {
    ...standard.components,
    walker: {
      mood: enumOf(["calm", "eager"]),
      path: list(vec3()),
      tint: color(),
      stats: struct({
        hp: u32({ default: 10 }),
        alive: bool({ default: true }),
      }),
    },
    tag: {},
  },
  resources: { clock: { time: f32() } },
  events: { ...standard.events, hit: { at: vec3(), by: u32() } },
  actions: { jump: button("Space") },
  messages: { hello: "Hello {0}" },
});

Deno.test("worlds round-trip through packets and scenes", () => {
  const { world, names, problems } = sceneToWorld(schema, {
    ink: 1,
    entities: [
      {
        id: 3,
        name: "Tree",
        components: {
          transform: { position: [1, 2, 3] },
          mesh: { shape: "models/tree.glb", texture: "bricks.png" },
        },
      },
      {
        id: 7,
        parent: 3,
        components: {
          walker: {
            mood: "eager",
            path: [[1, 1, 1], [2, 2, 2]],
            stats: { hp: 3 },
          },
          tag: {},
        },
      },
      {
        id: 8,
        components: {
          brush: { faces: [{ plane: [0, 1, 0, 1] }, { plane: [0, -1, 0, 1] }] },
        },
      },
    ],
    resources: { clock: { time: 2.5 } },
  }, catalog);
  assertEquals(problems, []);
  assertEquals(world.nextEntity, 9);
  assertEquals(world.entities[0].components.mesh.shape, 2);
  assertEquals(world.entities[0].components.mesh.texture, 1);
  const packed = encodeWorld(schema, world);
  const back = decodeWorld(schema, packed);
  assertEquals(back, world);
  const scene = worldToScene(schema, back, names, catalog);
  assertEquals(scene.entities[0].name, "Tree");
  assertEquals(
    (scene.entities[0].components.mesh as { shape: string }).shape,
    "models/tree.glb",
  );
  assertEquals(
    (scene.entities[1].components.walker as {
      stats: { hp: number; alive: boolean };
    }).stats,
    { hp: 3, alive: true },
  );
});

Deno.test("scene loading reports and repairs bad data", () => {
  const { world, problems } = sceneToWorld(schema, {
    ink: 1,
    entities: [
      {
        id: 1,
        components: {
          transform: { position: "up" },
          mesh: { shape: "missing.glb" },
          nope: {},
        },
      },
      { id: 1, components: {} },
      { id: 2, parent: 99, components: {} },
    ],
  }, catalog);
  assertEquals(world.entities.length, 2);
  assertEquals(world.entities[0].components.transform.position, [0, 0, 0]);
  assertEquals(world.entities[0].components.mesh.shape, 0);
  assertEquals(world.entities[1].parent, 0);
  assert(problems.some((p) => p.includes("nope")));
  assert(problems.some((p) => p.includes("missing.glb")));
  assert(problems.some((p) => p.includes("duplicate")));
});

Deno.test("migration matches fields by name", () => {
  const before = defineSchema({
    components: { mover: { speed: f32({ default: 1 }), old: f32() } },
  });
  const after = defineSchema({
    components: { mover: { boost: f32({ default: 5 }), speed: f32() } },
  });
  const world = sceneToWorld(before, {
    ink: 1,
    entities: [{ id: 1, components: { mover: { speed: 3, old: 9 } } }],
  }, catalog).world;
  const moved = migrateWorld({ schema: before, catalog }, {
    schema: after,
    catalog,
  }, world);
  assertEquals(moved.world.entities[0].components.mover, {
    boost: 5,
    speed: 3,
  });
  assert(before.hash !== after.hash);
});

Deno.test("input and events encode by name", () => {
  const input = idleInput(schema, 4, 0.5);
  input.actions.jump = { down: true, pressed: true, released: false };
  assertEquals(decodeInput(schema, encodeInput(schema, input)), input);
  const events: EventModel[] = [{
    name: "hit",
    value: { at: [1, 2, 3], by: 4 },
  }, { name: "log", value: { message: 1, a: 2, b: 0 } }];
  assertEquals(decodeEvents(schema, encodeEvents(schema, events)), events);
});

Deno.test("schemas reject names Blot cannot use or that collide", () => {
  assertThrows(() => defineSchema({ components: { type: {} } }), SchemaError);
  assertThrows(() => defineSchema({ components: { World: {} } }), SchemaError);
  assertThrows(
    () => defineSchema({ components: { world: {} } }),
    SchemaError,
    "reserved",
  );
  assertThrows(
    () =>
      defineSchema({
        components: {
          a: { kind: enumOf(["point"]) },
          b: { kind: enumOf(["point"]) },
        },
      }),
    SchemaError,
    "#Point",
  );
  assertThrows(
    () => defineSchema({ components: { a: { x: list(list(f32())) } } }),
    SchemaError,
    "fixed size",
  );
});

Deno.test("F32 literals are the shortest exact spelling", () => {
  assertEquals(f32Literal(0.6), "0.6");
  assertEquals(f32Literal(1), "1.0");
  assertEquals(f32Literal(-2.5), "(-2.5)");
  assertEquals(f32Literal(1e-7), "1e-7");
  assertEquals(f32Literal(3e20), "3e20");
});

Deno.test("the generated module names what games use", () => {
  const source = generateBlot(schema, catalog);
  for (
    const expected of [
      "type Walker is data = #Walker {",
      "type WalkerMood is data = #Calm | #Eager",
      "type Tag is data = #Tag",
      "const default_walker =",
      "const mesh_models_tree: U32 = 2",
      "const texture_bricks: U32 = 1",
      "const message_hello: U32 = 1",
      "| #Hit { at: Vec3, by: U32 }",
      "const run = fn update",
    ]
  ) assert(source.includes(expected), expected);
});

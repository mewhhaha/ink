import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  bool,
  cloneEntity,
  cloneWorld,
  color,
  componentNames,
  componentOf,
  decodeWorld,
  defineSchema,
  encodeWorld,
  enumOf,
  f32,
  hasComponent,
  LAZY_ENTITIES,
  list,
  PackedEntity,
  PacketError,
  plainEntity,
  standard,
  struct,
  u32,
  vec3,
  type WorldModel,
} from "./mod.ts";

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
});

function world(): WorldModel {
  return {
    tick: 7,
    nextEntity: 9,
    seed: 0xdeadbeef,
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
            stats: { trail: [0.5, 1.5, 2.5], hp: 4, alive: false },
          },
          health: { value: 2 },
        },
      },
      { id: 2, parent: 1, nameId: 5, components: { tag: {} } },
      {
        id: 8,
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
    resources: { clock: { time: 1.5, marks: [3, 4, 5] } },
  };
}

const lazy = (state: Float32Array) =>
  decodeWorld(schema, state, 0, { lazy: true });

const plain = (w: WorldModel) => ({
  ...w,
  entities: w.entities.map(plainEntity),
});

Deno.test("decoded worlds are lazy, equal to the original and re-encode verbatim", () => {
  const original = world();
  const state = encodeWorld(schema, original);
  const decoded = lazy(state);
  assert(decoded.entities.every((e) => e instanceof PackedEntity));
  assert(decoded.entities.every((e) => (e as PackedEntity).pristine));
  assertEquals(plain(decoded), original);
  assertEquals(
    JSON.parse(JSON.stringify(decoded.entities[0])),
    JSON.parse(JSON.stringify(original.entities[0])),
  );
  const again = lazy(state);
  assertEquals(encodeWorld(schema, again), state);
  // Untouched entities were copied, not decoded.
  assert(again.entities.every((e) => (e as PackedEntity).pristine));
});

Deno.test("packed entities answer presence and single components without decoding", () => {
  const state = encodeWorld(schema, world());
  const decoded = lazy(state);
  const [first, second, third] = decoded.entities;
  assert(hasComponent(first, "walker") && hasComponent(first, "health"));
  assert(!hasComponent(first, "tag"));
  assert(hasComponent(second, "tag") && !hasComponent(second, "health"));
  assertEquals(componentNames(third), ["walker", "health"]);
  assertEquals(componentOf(third, "health"), { value: 9 });
  assertEquals(componentOf(second, "health"), undefined);
  assertEquals(
    (componentOf(first, "walker") as { stats: unknown }).stats,
    { trail: [0.5, 1.5, 2.5], hp: 4, alive: false },
  );
  for (const e of decoded.entities) assert((e as PackedEntity).pristine);
});

Deno.test("changing a clone never changes the world it came from", () => {
  const state = encodeWorld(schema, world());
  const decoded = lazy(state);
  const copy = cloneWorld(decoded);
  copy.entities[0].components.health.value = 99;
  copy.entities[1].parent = 3;
  copy.entities.push({ id: 20, parent: 0, components: { tag: {} } });
  assertEquals(decoded.entities[0].components.health.value, 2);
  assertEquals(decoded.entities[1].parent, 1);
  const next = encodeWorld(schema, copy);
  assertNotEquals(next, state);
  const reread = decodeWorld(schema, next);
  assertEquals(reread.entities.length, 4);
  assertEquals(reread.entities[0].components.health.value, 99);
  assertEquals(reread.entities[1].parent, 3);
  // The untouched third entity still matches byte for byte.
  assertEquals(plainEntity(reread.entities[2]), world().entities[2]);
  assertEquals(
    lazy(state).entities[0].components.health.value,
    2,
  );
});

Deno.test("malformed packets fail with packet errors", () => {
  const state = encodeWorld(schema, world());
  assertThrows(() => decodeWorld(schema, state.subarray(0, 12)), PacketError);
  const wrong = state.slice();
  wrong[0] += 1;
  assertThrows(() => decodeWorld(schema, wrong), PacketError, "schema");
  const torn = state.slice();
  torn[7] = torn[8] + 1;
  assertThrows(() => decodeWorld(schema, torn), PacketError);
  const bad = world();
  bad.entities[0].components.health.value = 1;
  bad.entities[0].id = -1;
  assertThrows(() => encodeWorld(schema, bad), PacketError, "entity id");
  const unknown = world();
  unknown.entities[0].components.walker.mood = "angry";
  assertThrows(() => encodeWorld(schema, unknown), PacketError, "entity 1");
});

Deno.test("small worlds decode to plain objects and large ones to packed entities", () => {
  const state = encodeWorld(schema, world());
  const small = decodeWorld(schema, state);
  assert(small.entities.every((e) => !(e instanceof PackedEntity)));
  assertEquals(small, world());
  // Plain entities clone and spread as they always did.
  assertEquals(structuredClone(small.entities[0]), world().entities[0]);

  const big = world();
  for (let i = 0; i < LAZY_ENTITIES; i++) {
    big.entities.push({ id: 100 + i, parent: 0, components: { tag: {} } });
  }
  const packed = decodeWorld(schema, encodeWorld(schema, big));
  assert(packed.entities.every((e) => e instanceof PackedEntity));
  assertEquals(plain(packed), big);
});

Deno.test("a packed entity refuses structuredClone instead of dropping its components", () => {
  const entity = lazy(encodeWorld(schema, world())).entities[0];
  assertThrows(() => structuredClone(entity));
  assertEquals(cloneEntity(entity).components, entity.components);
  assertEquals(
    JSON.parse(JSON.stringify(entity)),
    JSON.parse(JSON.stringify(world().entities[0])),
  );
});

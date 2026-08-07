import { assertEquals, assertThrows } from "@std/assert";
import { create_test_sink } from "@ink/observability/sink.ts";
import {
  define_component,
  type SchemaCodec,
  type SnapshotValue,
} from "./schema.ts";
import { position, score, velocity } from "./test_schema.ts";
import { query, read, World, write } from "./world.ts";

Deno.test("dynamic entities recycle indices without exposing stale components", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: 3 },
    components: [position],
  });
  const first = spawned(world);
  const second = spawned(world);
  const third = spawned(world);
  assertEquals(world.spawn(), { type: "capacity_exhausted", capacity: 3 });
  assertEquals(world.insert(second, position, { x: 4, y: 8 }).type, "changed");
  assertEquals(world.despawn(second).type, "changed");
  assertEquals(world.get(second, position), {
    type: "stale",
    entity: second,
    actual_generation: 1,
    alive: false,
  });

  const recycled = spawned(world);
  assertEquals(
    {
      index: recycled.index,
      generation: recycled.generation,
      domain: recycled.domain,
    },
    { index: second.index, generation: 1, domain: "dynamic" },
  );
  assertEquals(world.get(recycled, position), { type: "missing" });
  assertEquals(world.lookup(second), {
    type: "stale",
    entity: second,
    actual_generation: 1,
    alive: true,
  });
  assertEquals([first.index, third.index], [0, 2]);
});

Deno.test("fixed worlds expose one permanent entity per index", () => {
  const world = new World({ domain: { type: "fixed", count: 2 } });
  const first = world.entity_at(0);
  assertEquals(first.type, "alive");
  if (first.type !== "alive") throw new Error("fixed entity 0 is unavailable");
  assertEquals(
    {
      index: first.entity.index,
      generation: first.entity.generation,
      domain: first.entity.domain,
    },
    { index: 0, generation: 0, domain: "fixed" },
  );
  assertEquals(world.entity_at(1).type, "alive");
  assertEquals(world.spawn(), { type: "fixed_domain" });
  const entity = world.entity_at(0);
  if (entity.type !== "alive") throw new Error("fixed entity 0 is unavailable");
  assertEquals(world.despawn(entity.entity), { type: "fixed_domain" });
});

Deno.test("sparse joins use the smallest store and return cloned values", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: 4 },
    components: [position, velocity],
  });
  const entities = [spawned(world), spawned(world), spawned(world)];
  for (const [index, entity] of entities.entries()) {
    world.insert(entity, position, { x: index, y: index + 10 });
  }
  world.insert(entities[2], velocity, { x: 3, y: 4 });
  world.insert(entities[0], velocity, { x: 1, y: 2 });

  const movement = query(write(position), read(velocity));
  const cursor = world.cursor(movement);
  assertEquals(cursor.span, 2);
  const rows = world.rows(movement);
  assertEquals(rows.map((row) => row.entity.index), [2, 0]);
  assertEquals(rows.map((row) => row.values), [
    [{ x: 2, y: 12 }, { x: 3, y: 4 }],
    [{ x: 0, y: 10 }, { x: 1, y: 2 }],
  ]);
  (rows[0].values[0] as { x: number }).x = 99;
  const unchanged = world.get(entities[2], position);
  assertEquals(unchanged.type, "present");
  if (unchanged.type !== "present") throw new Error("position is unavailable");
  assertEquals(unchanged.value, { x: 2, y: 12 });
});

Deno.test("component and resource mutations retain deterministic change ticks", () => {
  let now = 0;
  const sink = create_test_sink();
  const world = new World({
    domain: { type: "dynamic", capacity: 2 },
    components: [position],
    resources: [score],
    observations: {
      sink,
      clock: { now_seconds: () => now++ },
      instance: "test-world",
    },
  });
  const entity = spawned(world);
  const before_component = world.tick;
  world.insert(entity, position, { x: 1, y: 2 });
  world.set(entity, position, { x: 5, y: 8 });
  world.set_resource(score, 13);
  assertEquals(world.get_resource(score), {
    type: "present",
    value: 13,
    changed_at: world.tick,
  });
  assertEquals(
    world.changes_since(before_component).map((change) => change.type),
    [
      "inserted",
      "updated",
    ],
  );
  assertEquals(
    sink.observations().filter((observation) => observation.type === "event")
      .map((observation) => observation.name),
    [
      "world.created",
      "entity.spawned",
      "component.inserted",
      "component.updated",
      "resource.updated",
      "changes.extracted",
    ],
  );
});

Deno.test("world construction rejects duplicate schema identities", () => {
  const duplicate = define_component({
    id: position.id,
    version: 1,
    codec: position.codec,
  });
  assertThrows(
    () =>
      new World({
        domain: { type: "dynamic", capacity: 1 },
        components: [position, duplicate],
      }),
    Error,
    "ECS schema contains duplicate component:test.position",
  );
});

Deno.test("failed component encoding leaves the world tick unchanged", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [position],
  });
  const entity = spawned(world);
  const before_tick = world.tick;

  assertThrows(
    () => world.insert(entity, position, { x: Number.NaN, y: 0 }),
    Error,
    'component "test.position" encoding.x number NaN must be finite',
  );
  assertEquals(world.tick, before_tick);
  assertEquals(world.get(entity, position), { type: "missing" });
});

Deno.test("defined schemas retain their codec functions", () => {
  const codec: SchemaCodec<number> = {
    encode: (value) => value,
    decode: (encoded: SnapshotValue) =>
      typeof encoded === "number"
        ? { type: "decoded", value: encoded }
        : { type: "invalid", reason: "expected number" },
  };
  const stable = define_component({ id: "test.stable", version: 1, codec });
  codec.encode = () => Number.NaN;
  const world = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [stable],
  });
  const entity = spawned(world);

  assertEquals(world.insert(entity, stable, 4).type, "changed");
  assertEquals(world.get(entity, stable), {
    type: "present",
    value: 4,
    changed_at: world.tick,
  });
});

Deno.test("malformed custom decoder results fail with schema evidence", () => {
  const malformed = define_component<number>({
    id: "test.malformed",
    version: 1,
    codec: {
      encode: (value) => value,
      decode: () => undefined as never,
    },
  });
  const world = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [malformed],
  });
  const entity = spawned(world);

  assertThrows(
    () => world.insert(entity, malformed, 1),
    Error,
    'component "test.malformed" codec rejected its own encoding: component "test.malformed" decoder returned undefined',
  );
});

function spawned(world: World) {
  const result = world.spawn();
  if (result.type !== "spawned") {
    throw new Error(`spawn returned ${result.type}`);
  }
  return result.entity;
}

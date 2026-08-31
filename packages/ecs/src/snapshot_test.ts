import { assertEquals } from "@std/assert";
import { define_component } from "./experimental/schema.ts";
import { position, score, velocity } from "./experimental/test_schema.ts";
import { type EcsSnapshot, query, read, World } from "./experimental/world.ts";

Deno.test("snapshots restore allocator generations, components, resources, and changes", () => {
  const original = new World({
    domain: { type: "dynamic", capacity: 3 },
    components: [position],
    resources: [score],
  });
  const first = spawn(original);
  const recycled_index = spawn(original);
  original.insert(first, position, { x: 2, y: 3 });
  original.insert(recycled_index, position, { x: 5, y: 8 });
  original.set_resource(score, 21);
  original.despawn(recycled_index);
  const snapshot = original.snapshot();

  const restored = new World({
    domain: { type: "dynamic", capacity: 3 },
    components: [position],
    resources: [score],
  });
  assertEquals(restored.restore(snapshot), {
    type: "restored",
    tick: snapshot.tick,
  });
  assertEquals(restored.snapshot(), snapshot);
  assertEquals(restored.get(first, position).type === "present", true);
  assertEquals(restored.get_resource(score), original.get_resource(score));
  assertEquals(restored.changes_since(0), original.changes_since(0));
  const next = spawn(restored);
  assertEquals(
    { index: next.index, generation: next.generation },
    { index: recycled_index.index, generation: 1 },
  );
});

Deno.test("restore accepts additive schemas and leaves new stores empty", () => {
  const old_world = new World({
    domain: { type: "fixed", count: 1 },
    components: [position],
  });
  const entity = alive(old_world, 0);
  old_world.insert(entity, position, { x: 1, y: 4 });

  const new_world = new World({
    domain: { type: "fixed", count: 1 },
    components: [position, velocity],
  });
  assertEquals(new_world.restore(old_world.snapshot()).type, "restored");
  assertEquals(new_world.rows(query(read(position))).length, 1);
  assertEquals(new_world.rows(query(read(velocity))).length, 0);
});

Deno.test("incompatible component versions return evidence without changing the world", () => {
  const source = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [position],
  });
  source.insert(spawn(source), position, { x: 3, y: 7 });
  const version_two = define_component({
    id: position.id,
    version: 2,
    codec: position.codec,
  });
  const target = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [version_two],
  });
  const before = target.snapshot();
  assertEquals(target.restore(source.snapshot()), {
    type: "incompatible",
    reason: "snapshot component schema is unavailable",
    evidence: {
      component: "test.position",
      snapshot_version: 1,
      world_version: 2,
    },
  });
  assertEquals(target.snapshot(), before);
});

Deno.test("snapshots order schemas and component rows canonically", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: 3 },
    components: [velocity, position],
  });
  const first = spawn(world);
  const second = spawn(world);
  world.insert(second, position, { x: 2, y: 2 });
  world.insert(first, position, { x: 1, y: 1 });
  const snapshot = world.snapshot();
  assertEquals(snapshot.schema.components.map((entry) => entry.id), [
    "test.position",
    "test.velocity",
  ]);
  assertEquals(snapshot.components.map((component) => component.id), [
    "test.position",
    "test.velocity",
  ]);
  assertEquals(snapshot.components[0].values.map((value) => value.entity), [
    0,
    1,
  ]);
});

Deno.test("invalid allocator snapshots leave the current world untouched", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [position],
  });
  world.insert(spawn(world), position, { x: 1, y: 2 });
  const before = world.snapshot();
  const malformed: EcsSnapshot = { ...before, free_indices: [0] };
  assertEquals(world.restore(malformed), {
    type: "incompatible",
    reason: "snapshot allocator free index is invalid",
    evidence: { free_index: 0, next_index: 1 },
  });
  assertEquals(world.snapshot(), before);
});

Deno.test("snapshot restore rejects missing stores and unknown change kinds", () => {
  const source = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [position],
  });
  source.insert(spawn(source), position, { x: 1, y: 2 });
  const snapshot = source.snapshot();
  const target = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [position],
  });
  const before = target.snapshot();

  assertEquals(target.restore({ ...snapshot, components: [] }), {
    type: "incompatible",
    reason: "snapshot component values are missing",
    evidence: { component: "test.position" },
  });
  const malformed_change: EcsSnapshot = {
    ...snapshot,
    changes: [{ ...snapshot.changes[0], type: "corrupted" as never }],
  };
  assertEquals(target.restore(malformed_change).type, "incompatible");
  assertEquals(target.snapshot(), before);
});

function spawn(world: World) {
  const result = world.spawn();
  if (result.type !== "spawned") {
    throw new Error(`spawn returned ${result.type}`);
  }
  return result.entity;
}

function alive(world: World, index: number) {
  const result = world.entity_at(index);
  if (result.type !== "alive") throw new Error(`entity ${index} is not alive`);
  return result.entity;
}

import { safe_integer } from "./codec.ts";
import { define_component } from "./schema.ts";
import { query, read, World } from "./world.ts";

const benchmark_capacity = 1_000;
const value = define_component({
  id: "benchmark.value",
  version: 1,
  codec: safe_integer,
});
const marker = define_component({
  id: "benchmark.marker",
  version: 1,
  codec: safe_integer,
});

Deno.bench("ECS allocates 1,000 entities", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: benchmark_capacity },
  });
  for (let index = 0; index < benchmark_capacity; index += 1) world.spawn();
});

const iteration_world = populated_world();
const values = query(read(value));
Deno.bench("ECS iterates 1,000 components", () => {
  let total = 0;
  for (const row of iteration_world.rows(values)) total += row.values[0];
  if (total !== 499_500) throw new Error(`unexpected benchmark total ${total}`);
});

const join_world = populated_world();
for (let index = 0; index < benchmark_capacity; index += 2) {
  const entity = join_world.entity_at(index);
  if (entity.type !== "alive") {
    throw new Error(`benchmark entity ${index} is unavailable`);
  }
  join_world.insert(entity.entity, marker, index);
}
const joined = query(read(value), read(marker));
Deno.bench("ECS joins 500 of 1,000 entities", () => {
  const rows = join_world.rows(joined);
  if (rows.length !== 500) {
    throw new Error(`unexpected benchmark join ${rows.length}`);
  }
});

const churn_world = populated_world();
const churn_entities = Array.from(
  { length: benchmark_capacity },
  (_, index) => {
    const entity = churn_world.entity_at(index);
    if (entity.type !== "alive") {
      throw new Error(
        `benchmark entity ${index} is unavailable`,
      );
    }
    return entity.entity;
  },
);
let churn_cursor = 0;
Deno.bench("ECS recycles 100 entities", () => {
  for (let count = 0; count < 100; count += 1) {
    const slot = churn_cursor % benchmark_capacity;
    churn_world.despawn(churn_entities[slot]);
    const replacement = churn_world.spawn();
    if (replacement.type !== "spawned") {
      throw new Error(`benchmark spawn returned ${replacement.type}`);
    }
    const inserted = churn_world.insert(replacement.entity, value, slot);
    if (inserted.type !== "changed") {
      throw new Error(`benchmark insert returned ${inserted.type}`);
    }
    churn_entities[slot] = replacement.entity;
    churn_cursor += 1;
  }
});

const snapshot_world = populated_world();
Deno.bench("ECS snapshots 1,000 components", () => {
  const snapshot = snapshot_world.snapshot();
  const values = snapshot.components.find((component) =>
    component.id === value.id
  );
  if (values?.values.length !== benchmark_capacity) {
    throw new Error("benchmark snapshot omitted components");
  }
});

const change_world = populated_world();
const changed_after_population = change_world.tick;
for (let index = 0; index < 100; index += 1) {
  const entity = change_world.entity_at(index);
  if (entity.type !== "alive") {
    throw new Error(`benchmark entity ${index} is unavailable`);
  }
  change_world.set(entity.entity, value, index + 1);
}
Deno.bench("ECS extracts 100 changes", () => {
  const changes = change_world.changes_since(changed_after_population);
  if (changes.length !== 100) {
    throw new Error("benchmark change extraction is incomplete");
  }
});

function populated_world(): World {
  const world = new World({
    domain: { type: "dynamic", capacity: benchmark_capacity },
    components: [value, marker],
  });
  for (let index = 0; index < benchmark_capacity; index += 1) {
    const spawned = world.spawn();
    if (spawned.type !== "spawned") {
      throw new Error(`benchmark spawn returned ${spawned.type}`);
    }
    world.insert(spawned.entity, value, index);
  }
  return world;
}

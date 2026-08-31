import { assertEquals, assertThrows } from "@std/assert";
import {
  component_value,
  create_schedule,
  define_system,
  read_resource,
  write_resource,
} from "./experimental/schedule.ts";
import { position, score, velocity } from "./experimental/test_schema.ts";
import { query, read, World, write } from "./experimental/world.ts";

Deno.test("schedule stages separate conflicting access in declaration order", () => {
  const execution: string[] = [];
  const movement = query(write(position));
  const integrate = define_system({
    id: "integrate",
    accesses: [write(position)],
    run(context) {
      execution.push("integrate");
      for (const row of context.rows(movement)) {
        const [current] = row.values;
        context.set(row.entity, position, { x: current.x + 1, y: current.y });
      }
    },
  });
  const observe = define_system({
    id: "observe",
    accesses: [read(position)],
    run() {
      execution.push("observe");
    },
  });
  const independent = define_system({
    id: "independent",
    accesses: [read(velocity)],
    run() {
      execution.push("independent");
    },
  });
  const schedule = create_schedule([integrate, observe, independent]);
  assertEquals(
    schedule.stages.map((stage) => stage.systems.map((system) => system.id)),
    [
      ["integrate", "independent"],
      ["observe"],
    ],
  );

  const world = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [position, velocity],
  });
  const entity = spawn(world);
  world.insert(entity, position, { x: 4, y: 9 });
  assertEquals(schedule.run(world), {
    type: "completed",
    barriers: 2,
    spawned: [],
  });
  assertEquals(execution, ["integrate", "independent", "observe"]);
  const updated = world.get(entity, position);
  assertEquals(updated.type === "present" && updated.value, { x: 5, y: 9 });
});

Deno.test("structural commands apply at a barrier and direct changes stay locked", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: 2 },
    components: [position],
  });
  const existing = spawn(world);
  let direct_result = "";
  const system = define_system({
    id: "spawn-at-barrier",
    accesses: [],
    run(context) {
      direct_result = world.insert(existing, position, { x: 1, y: 1 }).type;
      context.commands.spawn([
        component_value(position, { x: 8, y: 13 }),
      ]);
    },
  });

  const result = create_schedule([system]).run(world);
  assertEquals(direct_result, "structural_changes_locked");
  assertEquals(result.type, "completed");
  if (result.type !== "completed") throw new Error(result.reason);
  assertEquals(result.spawned.length, 1);
  assertEquals(world.get(result.spawned[0], position).type === "present", true);
});

Deno.test("a failing structural barrier restores every preceding command", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: 3 },
    components: [position],
  });
  const existing = spawn(world);
  const before = world.snapshot();
  const failing = define_system({
    id: "invalid-remove",
    accesses: [],
    run(context) {
      context.commands.spawn([
        component_value(position, { x: 1, y: 2 }),
      ]);
      context.commands.remove(existing, position);
    },
  });

  const result = create_schedule([failing]).run(world);
  assertEquals(result.type, "failed");
  assertEquals(world.snapshot(), before);
});

Deno.test("system contexts reject undeclared writes with system evidence", () => {
  const world = new World({
    domain: { type: "dynamic", capacity: 1 },
    components: [position],
    resources: [score],
  });
  world.set_resource(score, 1);
  const invalid = define_system({
    id: "reads-but-writes",
    accesses: [read_resource(score)],
    run(context) {
      context.set_resource(score, 2);
    },
  });
  const result = create_schedule([invalid]).run(world);
  assertEquals(result, {
    type: "failed",
    stage: 0,
    system: "reads-but-writes",
    reason:
      'ECS system "reads-but-writes" requires write access to resource "test.score" but declared read',
  });

  const valid = define_system({
    id: "writes-score",
    accesses: [write_resource(score)],
    run(context) {
      context.set_resource(score, 3);
    },
  });
  assertEquals(create_schedule([valid]).run(world).type, "completed");
});

function spawn(world: World) {
  const result = world.spawn();
  if (result.type !== "spawned") {
    throw new Error(`spawn returned ${result.type}`);
  }
  return result.entity;
}

Deno.test("system definitions reject malformed public fields", () => {
  assertThrows(
    () => define_system({ id: 42, accesses: [], run() {} } as never),
    Error,
    "ECS system id 42 must be a string",
  );
  assertThrows(
    () => define_system({ id: "broken", accesses: null, run() {} } as never),
    Error,
    'ECS system "broken" accesses must be an array',
  );
});

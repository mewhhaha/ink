import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import {
  connect_platformer_logic,
  move_platformer_record,
  place_platformer_record,
  remove_platformer_connection,
  remove_platformer_record,
} from "./commands.ts";
import {
  platformer_connection_id,
  platformer_layer_id,
  platformer_level_id,
  platformer_record_id,
} from "./identity.ts";
import type { PlatformerLogicConnection } from "./model.ts";
import { create_platformer_starter } from "./starter.ts";

const level_id = platformer_level_id("first-steps");
const gameplay_layer_id = platformer_layer_id("gameplay");

Deno.test("place, move, and remove commands return new projects without changing their input", () => {
  const initial = create_platformer_starter();
  const collectible_id = platformer_record_id("first-coin");
  const placed = place_platformer_record(
    initial,
    { level_id, layer_id: gameplay_layer_id },
    {
      id: collectible_id,
      name: "First coin",
      kind: "collectible",
      position: { x: 6, y: 4 },
      collectible_key: "coin",
      quantity: 1,
    },
  );
  assertNotStrictEquals(placed, initial);
  assertEquals(
    all_records(initial).some(({ id }) => id === collectible_id),
    false,
  );
  assertEquals(
    all_records(placed).some(({ id }) => id === collectible_id),
    true,
  );

  const moved = move_platformer_record(placed, level_id, collectible_id, {
    x: 2,
    y: -1,
  });
  const moved_record = all_records(moved).find(({ id }) =>
    id === collectible_id
  );
  assertEquals(moved_record?.kind, "collectible");
  if (moved_record?.kind === "collectible") {
    assertEquals(moved_record.position, { x: 8, y: 3 });
  }
  const removed = remove_platformer_record(moved, level_id, collectible_id);
  assertEquals(
    all_records(removed).some(({ id }) => id === collectible_id),
    false,
  );
  assertEquals(
    all_records(moved).some(({ id }) => id === collectible_id),
    true,
  );
});

Deno.test("moving a checkpoint translates both its activation area and respawn position", () => {
  const checkpoint_id = platformer_record_id("midpoint");
  const placed = place_platformer_record(
    create_platformer_starter(),
    { level_id, layer_id: gameplay_layer_id },
    {
      id: checkpoint_id,
      name: "Midpoint",
      kind: "checkpoint",
      bounds: { minimum: { x: 10, y: 2 }, maximum: { x: 12, y: 5 } },
      respawn_position: { x: 11, y: 3 },
    },
  );
  const moved = move_platformer_record(placed, level_id, checkpoint_id, {
    x: 3,
    y: 2,
  });
  const checkpoint = all_records(moved).find(({ id }) => id === checkpoint_id);
  if (checkpoint?.kind !== "checkpoint") {
    throw new Error("checkpoint missing after move");
  }
  assertEquals(checkpoint.bounds.minimum, { x: 13, y: 4 });
  assertEquals(checkpoint.respawn_position, { x: 14, y: 5 });
});

Deno.test("logic commands add and remove explicit trigger-condition-action connections", () => {
  const trigger_id = platformer_record_id("finish-trigger");
  const with_trigger = place_platformer_record(
    create_platformer_starter(),
    { level_id, layer_id: gameplay_layer_id },
    {
      id: trigger_id,
      name: "Finish trigger",
      kind: "trigger_zone",
      bounds: { minimum: { x: 26, y: 2 }, maximum: { x: 28, y: 6 } },
      activation: "once",
    },
  );
  const connection: PlatformerLogicConnection = {
    id: platformer_connection_id("finish-level"),
    trigger: { record_id: trigger_id, event: "entered" },
    condition: { type: "always" },
    action: { type: "complete_level" },
  };
  const connected = connect_platformer_logic(
    with_trigger,
    level_id,
    connection,
  );
  assertEquals(with_trigger.levels[0].connections, []);
  assertEquals(connected.levels[0].connections, [connection]);
  const disconnected = remove_platformer_connection(
    connected,
    level_id,
    connection.id,
  );
  assertEquals(disconnected.levels[0].connections, []);
});

Deno.test("commands reject missing locations and duplicate record identities with evidence", () => {
  const project = create_platformer_starter();
  assertThrows(
    () =>
      move_platformer_record(
        project,
        level_id,
        platformer_record_id("missing"),
        { x: 1, y: 1 },
      ),
    Error,
    "does not contain record missing",
  );
  const ground = all_records(project).find(({ id }) => id === "ground");
  if (ground === undefined) throw new Error("starter ground missing");
  assertThrows(
    () =>
      place_platformer_record(
        project,
        { level_id, layer_id: gameplay_layer_id },
        ground,
      ),
    Error,
    "already contains record ground",
  );
});

function all_records(project: ReturnType<typeof create_platformer_starter>) {
  return project.levels.flatMap(({ layers }) =>
    layers.flatMap(({ records }) => records)
  );
}

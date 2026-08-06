import { assertEquals } from "@std/assert";
import { serialize_platformer_project } from "./serialization.ts";
import { create_platformer_starter } from "./starter.ts";

Deno.test("project serialization is stable and recursively orders keys", () => {
  const first = create_platformer_starter("classic-adventure");
  const second = { ...first, movement: { ...first.movement } };
  const serialized = serialize_platformer_project(first);
  assertEquals(serialize_platformer_project(second), serialized);
  assertEquals(serialized.endsWith("\n"), true);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  const keys = Object.keys(parsed);
  assertEquals(
    keys,
    [...keys].sort((left, right) => left.localeCompare(right)),
  );
});

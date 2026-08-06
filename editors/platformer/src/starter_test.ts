import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import { create_platformer_starter } from "./starter.ts";
import { validate_platformer_project } from "./validation.ts";

Deno.test("starter project is playable, valid, and deeply immutable", () => {
  const project = create_platformer_starter();
  const level = project.levels[0];
  const records = level.layers.flatMap(({ records }) => records);
  assertEquals(records.filter(({ kind }) => kind === "spawn").length, 1);
  assertEquals(records.filter(({ kind }) => kind === "exit").length, 1);
  assertEquals(records.some(({ kind }) => kind === "platform"), true);
  assertEquals(validate_platformer_project(project), []);
  assertEquals(Object.isFrozen(project), true);
  assertEquals(Object.isFrozen(level.layers[0].records[0]), true);
  assertThrows(() => {
    (level.bounds.minimum as { x: number }).x = 99;
  }, TypeError);
});

Deno.test("starter creation returns independent immutable projects", () => {
  const first = create_platformer_starter("precision");
  const second = create_platformer_starter("precision");
  assertNotStrictEquals(first, second);
  assertNotStrictEquals(first.levels, second.levels);
  assertEquals(first, second);
});

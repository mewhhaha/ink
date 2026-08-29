import { assertEquals, assertThrows } from "@std/assert";
import {
  parse_platformer_project,
  serialize_platformer_project,
} from "./serialization.ts";
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

Deno.test("project parsing round trips every editor-owned field", () => {
  const project = create_platformer_starter("classic-adventure");
  assertEquals(
    parse_platformer_project(serialize_platformer_project(project)),
    project,
  );
});

Deno.test("project parsing rejects unknown fields at the JSON boundary", () => {
  const source = JSON.parse(
    serialize_platformer_project(create_platformer_starter()),
  );
  source.legacy_level = true;
  assertThrows(
    () => parse_platformer_project(JSON.stringify(source)),
    Error,
    "fields are",
  );
});

Deno.test("project parsing rejects missing exit references with diagnostics", () => {
  const source = JSON.parse(
    serialize_platformer_project(create_platformer_starter()),
  );
  source.levels[0].layers[1].records = source.levels[0].layers[1].records
    .filter((record: { readonly kind: string }) => record.kind !== "exit");
  assertThrows(
    () => parse_platformer_project(JSON.stringify(source)),
    Error,
    "exactly one is required",
  );
});

import { assertEquals, assertThrows } from "@std/assert";
import { core_blocks, resolve_block_order } from "./block.ts";

Deno.test("engine blocks resolve after all of their dependencies", () => {
  const ordered = resolve_block_order(core_blocks).map((block) => block.id);

  assertEquals(ordered.indexOf("game") > ordered.indexOf("input"), true);
  assertEquals(ordered.indexOf("semantic") > ordered.indexOf("game"), true);
  assertEquals(ordered.indexOf("render") > ordered.indexOf("assets"), true);
  assertEquals(ordered.indexOf("replay") > ordered.indexOf("save"), true);
});

Deno.test("a missing block dependency identifies both blocks", () => {
  assertThrows(
    () =>
      resolve_block_order([{
        id: "game",
        depends_on: ["clock"],
        requirement: "required",
      }]),
    Error,
    "engine block game requires missing block clock",
  );
});

Deno.test("a block cycle reports the dependency path", () => {
  assertThrows(
    () =>
      resolve_block_order([
        { id: "left", depends_on: ["right"], requirement: "required" },
        { id: "right", depends_on: ["left"], requirement: "required" },
      ]),
    Error,
    "left -> right -> left",
  );
});

Deno.test("duplicate block identities are rejected", () => {
  assertThrows(
    () =>
      resolve_block_order([
        { id: "clock", depends_on: [], requirement: "required" },
        { id: "clock", depends_on: [], requirement: "degradable" },
      ]),
    Error,
    'engine block id "clock" is duplicated',
  );
});

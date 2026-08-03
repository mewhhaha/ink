import { assertEquals, assertThrows } from "@std/assert";
import { parse_indexed_seed } from "./src/ecs_seed.ts";

Deno.test("indexed ECS seeds parse one row per entity", () => {
  assertEquals(parse_indexed_seed("1, -2; 3, 4;", 2, 3), [
    [1n, -2n],
    [3n, 4n],
  ]);
});

Deno.test("indexed ECS seeds reject rows that do not match the component", () => {
  assertThrows(
    () => parse_indexed_seed("1,2;3;", 2, 2),
    Error,
    "ECS seed entity 1 has 1 fields; component requires 2",
  );
});

Deno.test("indexed ECS seeds parse a full sized map without exhausting the stack", () => {
  const source = Array.from(
    { length: 1_024 },
    (_, entity) => `${entity},0,-1,-1`,
  ).join(";");
  const seed = parse_indexed_seed(source, 4, 1_025);

  assertEquals(seed.length, 1_024);
  assertEquals(seed[1_023], [1_023n, 0n, -1n, -1n]);
});

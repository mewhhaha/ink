import { assertEquals, assertThrows } from "@std/assert";
import {
  decode_blot_entity,
  encode_blot_entity,
  parse_blot_component_schema,
  parse_blot_indexed_seed,
} from "./blot.ts";

Deno.test("Blot entity encoding preserves index and generation", () => {
  const encoded = encode_blot_entity({ index: 2, generation: 7 }, 4);
  assertEquals(encoded, 30);
  assertEquals(decode_blot_entity(encoded, 4), {
    type: "decoded",
    entity: { index: 2, generation: 7 },
  });
});

Deno.test("Blot component schemas preserve declared integer field order", () => {
  assertEquals(parse_blot_component_schema(1, "Velocity", "x:Int;y:Int"), {
    id: 1,
    name: "Velocity",
    fields: ["x", "y"],
  });
  assertThrows(
    () => parse_blot_component_schema(1, "Velocity", "x:Int;x:Int"),
    Error,
    'Blot ECS component "Velocity" contains duplicate fields',
  );
});

Deno.test("Blot indexed seeds match the guest boundary contract", () => {
  assertEquals(parse_blot_indexed_seed("1,-2;3,4;", 2, 4), [
    [1n, -2n],
    [3n, 4n],
  ]);
  assertThrows(
    () => parse_blot_indexed_seed("1,2;3;", 2, 4),
    Error,
    "ECS seed entity 1 has 1 fields; component requires 2",
  );
});

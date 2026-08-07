import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import { parse_blot_integer_data_asset } from "./data_asset.ts";

Deno.test("integer data assets parse ordered numeric fields", () => {
  assertEquals(
    parse_blot_integer_data_asset(
      3,
      JSON.stringify({
        format: "blot-integer-data",
        version: 1,
        fields: [[24], [14], [-1, 0, 42]],
      }),
    ),
    { id: 3, fields: [[24], [14], [-1, 0, 42]] },
  );
});

Deno.test("integer data assets reject malformed field values", () => {
  assertThrows(
    () =>
      parse_blot_integer_data_asset(
        2,
        JSON.stringify({
          format: "blot-integer-data",
          version: 1,
          fields: [[1, 1.5]],
        }),
      ),
    Error,
    "data asset 2 field 0 value 1 1.5",
  );
});

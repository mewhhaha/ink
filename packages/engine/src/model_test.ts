import { assertEquals, assertThrows } from "@std/assert";
import { parse_obj_model } from "./model.ts";

Deno.test("OBJ quads become triangles with position and normal vertices", () => {
  const source =
    "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//1 4//1";
  const model = parse_obj_model(source);

  assertEquals(model.vertex_count, 6);
  assertEquals(model.vertices.length, 6 * 6);
  assertEquals([...model.vertices.slice(0, 6)], [0, 0, 0, 0, 0, 1]);
});

Deno.test("an OBJ face reports an out-of-range position with its line", () => {
  assertThrows(
    () => parse_obj_model("v 0 0 0\nf 1 2 3"),
    Error,
    'OBJ line 2 position index "2" is outside 1..1',
  );
});

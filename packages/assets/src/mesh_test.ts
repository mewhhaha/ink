import { assertEquals, assertThrows } from "@std/assert";
import { parse_obj_model } from "./mesh.ts";

Deno.test("packed OBJ meshes triangulate faces into position-normal vertices", () => {
  const mesh = parse_obj_model(
    "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4",
    "quad.obj",
  );
  assertEquals(mesh.vertex_count, 6);
  assertEquals([...mesh.vertices.slice(0, 6)], [0, 0, 0, 0, 0, 1]);
});

Deno.test("packed OBJ meshes reject faces without area", () => {
  assertThrows(
    () => parse_obj_model("v 0 0 0\nv 1 0 0\nv 2 0 0\nf 1 2 3", "line.obj"),
    Error,
    "zero-length normal",
  );
});

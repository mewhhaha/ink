import { assertEquals } from "@std/assert";
import { parse_obj } from "./obj.ts";

Deno.test("OBJ parsing preserves material references and triangulates polygons", () => {
  const result = parse_obj(
    `
mtllib scene.mtl
o floor
usemtl stone
v 0 0 0
v 1 0 0
v 1 0 1
v 0 0 1
vn 0 1 0
f 1//1 2//1 3//1 4//1
`,
    "floor.obj",
  );

  if (result.type !== "ready") throw new Error(result.reason);
  assertEquals(result.document.material_libraries, ["scene.mtl"]);
  assertEquals(result.document.triangles, [
    {
      vertices: [
        { position: 0, normal: 0 },
        { position: 1, normal: 0 },
        { position: 2, normal: 0 },
      ],
      object: "floor",
      material: "stone",
    },
    {
      vertices: [
        { position: 0, normal: 0 },
        { position: 2, normal: 0 },
        { position: 3, normal: 0 },
      ],
      object: "floor",
      material: "stone",
    },
  ]);
});

Deno.test("OBJ parsing reports an out-of-range negative index with its line", () => {
  const result = parse_obj("v 0 0 0\nf -2 -1 -1", "broken.obj");
  assertEquals(result, {
    type: "invalid_obj",
    source: "broken.obj",
    line: 2,
    reason: 'position index "-2" is outside the available 1 values',
  });
});

Deno.test("OBJ parsing applies homogeneous positions and rejects non-integer index syntax", () => {
  const homogeneous = parse_obj("v 2 4 6 2", "point.obj");
  if (homogeneous.type !== "ready") throw new Error(homogeneous.reason);
  assertEquals(homogeneous.document.positions, [[1, 2, 3]]);

  assertEquals(parse_obj("v 0 0 0\nf 1.0 1 1", "broken.obj"), {
    type: "invalid_obj",
    source: "broken.obj",
    line: 2,
    reason: 'position index "1.0" must be an integer',
  });
});

import { mesh_bounds } from "@ink/geometry/mesh.ts";
import { vec3 } from "@ink/math/vector.ts";
import { assert, assertThrows } from "@std/assert";
import { polygonize_distance_field } from "./experimental/marching.ts";
import { sphere_distance_field } from "./experimental/sdf.ts";

Deno.test("marching tetrahedra polygonizes a signed-distance sphere", () => {
  const mesh = polygonize_distance_field({
    field: sphere_distance_field(vec3(0, 0, 0), 0.8),
    minimum: vec3(-1.25, -1.25, -1.25),
    maximum: vec3(1.25, 1.25, 1.25),
    cells_x: 8,
    cells_y: 8,
    cells_z: 8,
  });
  assert(mesh.triangle_count > 100);
  const bounds = mesh_bounds(mesh);
  assert(bounds.minimum.x < -0.7 && bounds.maximum.x > 0.7);
  assert(bounds.minimum.y < -0.7 && bounds.maximum.y > 0.7);
  assert(bounds.minimum.z < -0.7 && bounds.maximum.z > 0.7);
});

Deno.test("distance meshing rejects fields without an iso-surface", () => {
  assertThrows(
    () =>
      polygonize_distance_field({
        field: { sample: () => 1 },
        minimum: vec3(-1, -1, -1),
        maximum: vec3(1, 1, 1),
        cells_x: 2,
        cells_y: 2,
        cells_z: 2,
      }),
    Error,
    "does not cross",
  );
});

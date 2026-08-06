import { vec3 } from "@ink/math/vector.ts";
import { bake_heightfield } from "./heightfield.ts";
import { polygonize_distance_field } from "./marching.ts";
import { sphere_distance_field } from "./sdf.ts";

Deno.bench("bake a 256 by 256 analytical heightfield", () => {
  bake_heightfield({
    width: 256,
    depth: 256,
    spacing: 1,
    field: { sample: (x, z) => Math.sin(x * 0.02) * Math.cos(z * 0.02) },
  });
});

Deno.bench("polygonize a 24 cubed signed-distance field", () => {
  polygonize_distance_field({
    field: sphere_distance_field(vec3(0, 0, 0), 0.8),
    minimum: vec3(-1, -1, -1),
    maximum: vec3(1, 1, 1),
    cells_x: 24,
    cells_y: 24,
    cells_z: 24,
  });
});

import { mat4_transform_affine_point } from "./matrix.ts";
import { quat_from_axis_angle } from "./quaternion.ts";
import { transform, transform_to_mat4 } from "./transform.ts";
import { vec3 } from "./vector.ts";

const benchmark_matrix = transform_to_mat4(transform(
  vec3(10, 20, 30),
  quat_from_axis_angle(vec3(1, 2, 3), 0.7),
  vec3(2, 3, 4),
));
const benchmark_points = Array.from(
  { length: 10_000 },
  (_, index) => vec3(index, index / 2, -index),
);

Deno.bench("transform 10,000 affine points", () => {
  let checksum = 0;
  for (const point of benchmark_points) {
    checksum += mat4_transform_affine_point(benchmark_matrix, point).x;
  }
  if (!Number.isFinite(checksum)) {
    throw new Error(`bulk transform checksum is ${String(checksum)}`);
  }
});

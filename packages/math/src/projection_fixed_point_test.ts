import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  decode_fixed_point,
  decode_fixed_vec3,
  encode_fixed_point,
  encode_fixed_vec3,
} from "./fixed_point.ts";
import { mat4_multiply, mat4_transform_point } from "./matrix.ts";
import {
  jitter_projection,
  look_at_view,
  orthographic_projection,
  perspective_projection,
  project_to_viewport,
  reversed_orthographic_projection,
  reversed_perspective_projection,
  unproject_from_viewport,
} from "./projection.ts";
import { vec2, vec3 } from "./vector.ts";

function projected_depth(
  projection: ReturnType<typeof perspective_projection>,
  distance: number,
): number {
  const projected = mat4_transform_point(projection, vec3(0, 0, -distance));
  if (!projected.ok) throw new Error(`projection failed with w ${projected.w}`);
  return projected.value.z;
}

Deno.test("perspective projections use WebGPU zero-to-one depth", () => {
  const parameters = {
    vertical_fov_radians: Math.PI / 2,
    aspect_ratio: 2,
    near_plane: 1,
    far_plane: 101,
  };
  const projection = perspective_projection(parameters);
  assertAlmostEquals(projected_depth(projection, 1), 0);
  assertAlmostEquals(projected_depth(projection, 101), 1);
  const reversed = reversed_perspective_projection(parameters);
  assertAlmostEquals(projected_depth(reversed, 1), 1);
  assertAlmostEquals(projected_depth(reversed, 101), 0);
});

Deno.test("orthographic projections use WebGPU zero-to-one depth", () => {
  const parameters = {
    left: -2,
    right: 2,
    bottom: -1,
    top: 1,
    near_plane: 1,
    far_plane: 11,
  };
  const standard = orthographic_projection(parameters);
  const reversed = reversed_orthographic_projection(parameters);
  assertAlmostEquals(projected_depth(standard, 1), 0);
  assertAlmostEquals(projected_depth(standard, 11), 1);
  assertAlmostEquals(projected_depth(reversed, 1), 1);
  assertAlmostEquals(projected_depth(reversed, 11), 0);
});

Deno.test("jitter offsets normalized device coordinates", () => {
  const projection = perspective_projection({
    vertical_fov_radians: Math.PI / 2,
    aspect_ratio: 1,
    near_plane: 1,
    far_plane: 10,
  });
  const jittered = jitter_projection(projection, vec2(0.25, -0.125));
  const projected = mat4_transform_point(jittered, vec3(0, 0, -2));
  if (!projected.ok) throw new Error(`projection failed with w ${projected.w}`);
  assertAlmostEquals(projected.value.x, 0.25);
  assertAlmostEquals(projected.value.y, -0.125);
});

Deno.test("look-at views follow negative Z and viewport projection round-trips", () => {
  const view = look_at_view(vec3(0, 0, 5), vec3(0, 0, 0), vec3(0, 1, 0));
  const projection = perspective_projection({
    vertical_fov_radians: Math.PI / 2,
    aspect_ratio: 1,
    near_plane: 1,
    far_plane: 20,
  });
  const view_projection = mat4_multiply(projection, view);
  const viewport = { x: 10, y: 20, width: 800, height: 800 };
  const screen = project_to_viewport(vec3(0, 0, 0), view_projection, viewport);
  if (!screen.ok) throw new Error(`screen projection failed: ${screen.reason}`);
  assertEquals(screen.value.x, 410);
  assertEquals(screen.value.y, 420);
  const world = unproject_from_viewport(
    screen.value,
    view_projection,
    viewport,
  );
  if (!world.ok) throw new Error(`screen unprojection failed: ${world.reason}`);
  assertAlmostEquals(world.value.x, 0);
  assertAlmostEquals(world.value.y, 0);
  assertAlmostEquals(world.value.z, 0);
});

Deno.test("projection builders reject invalid camera parameters with evidence", () => {
  assertThrows(
    () =>
      perspective_projection({
        vertical_fov_radians: Math.PI,
        aspect_ratio: 1,
        near_plane: 1,
        far_plane: 10,
      }),
    Error,
    `vertical field of view must be between 0 and pi, received ${Math.PI}`,
  );
  assertThrows(
    () =>
      orthographic_projection({
        left: 1,
        right: 1,
        bottom: -1,
        top: 1,
        near_plane: 1,
        far_plane: 10,
      }),
    Error,
    "orthographic left and right are both 1",
  );
});

Deno.test("guest fixed-point codecs round-trip scalar and vector values", () => {
  assertEquals(encode_fixed_point(1.25), 1_250_000);
  assertEquals(decode_fixed_point(-1_250_000), -1.25);
  const source = vec3(1.25, -2.5, 0.000001);
  assertEquals(decode_fixed_vec3(encode_fixed_vec3(source)), source);
});

Deno.test("guest fixed-point codecs reject overflow and non-finite host values", () => {
  assertThrows(
    () => encode_fixed_point(Infinity),
    Error,
    "host fixed-point value must be finite, received Infinity",
  );
  assertThrows(
    () => encode_fixed_point(3_000),
    Error,
    "host fixed-point value 3000 encodes as 3000000000, outside [-2147483648, 2147483647]",
  );
  assertThrows(
    () => decode_fixed_point(2_147_483_648),
    Error,
    "guest fixed-point value 2147483648 is outside [-2147483648, 2147483647]",
  );
});

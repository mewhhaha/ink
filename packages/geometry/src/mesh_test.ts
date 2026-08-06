import { assertEquals, assertThrows } from "@std/assert";
import { vec2, vec3 } from "@ink/math/vector.ts";
import {
  generate_triangle_adjacency,
  generate_vertex_normals,
  generate_vertex_tangents,
  mesh_bounds,
  mesh_topology,
  reverse_mesh_winding,
} from "./mesh.ts";

const quad_positions = [
  vec3(0, 0, 0),
  vec3(1, 0, 0),
  vec3(1, 1, 0),
  vec3(0, 1, 0),
];
const quad_texture_coordinates = [
  vec2(0, 0),
  vec2(1, 0),
  vec2(1, 1),
  vec2(0, 1),
];

Deno.test("mesh topology generates bounds, area-weighted normals, and tangents", () => {
  const topology = mesh_topology(
    quad_positions,
    [0, 1, 2, 0, 2, 3],
    quad_texture_coordinates,
  );
  assertEquals(mesh_bounds(topology).minimum, vec3(0, 0, 0));
  assertEquals(mesh_bounds(topology).maximum, vec3(1, 1, 0));
  const normals = generate_vertex_normals(topology);
  assertEquals(normals, [
    vec3(0, 0, 1),
    vec3(0, 0, 1),
    vec3(0, 0, 1),
    vec3(0, 0, 1),
  ]);
  const tangents = generate_vertex_tangents(topology, normals);
  assertEquals(tangents.map((value) => [value.x, value.y, value.z, value.w]), [
    [1, 0, 0, 1],
    [1, 0, 0, 1],
    [1, 0, 0, 1],
    [1, 0, 0, 1],
  ]);
});

Deno.test("winding conversion reverses generated surface normals", () => {
  const topology = mesh_topology(quad_positions, [0, 1, 2, 0, 2, 3]);
  const reversed = reverse_mesh_winding(topology);
  assertEquals(reversed.indices, [0, 2, 1, 0, 3, 2]);
  assertEquals(generate_vertex_normals(reversed), [
    vec3(0, 0, -1),
    vec3(0, 0, -1),
    vec3(0, 0, -1),
    vec3(0, 0, -1),
  ]);
});

Deno.test("triangle adjacency identifies shared and boundary edges", () => {
  const adjacency = generate_triangle_adjacency(
    mesh_topology(quad_positions, [0, 1, 2, 0, 2, 3]),
  );
  assertEquals(adjacency, [
    { triangle: 0, neighbors: [null, null, 1] },
    { triangle: 1, neighbors: [0, null, null] },
  ]);
});

Deno.test("mesh construction rejects zero-area and out-of-range triangles", () => {
  assertThrows(
    () =>
      mesh_topology([vec3(0, 0, 0), vec3(1, 0, 0), vec3(2, 0, 0)], [0, 1, 2]),
    Error,
    "mesh triangle 0 has zero area",
  );
  assertThrows(
    () => mesh_topology(quad_positions, [0, 1, 8]),
    Error,
    "mesh corner 2 references position 8 outside 0..3",
  );
});

Deno.test("tangent generation rejects degenerate UV parameterization", () => {
  const topology = mesh_topology(
    quad_positions.slice(0, 3),
    [0, 1, 2],
    [vec2(0, 0), vec2(1, 0), vec2(2, 0)],
  );
  assertThrows(
    () => generate_vertex_tangents(topology, generate_vertex_normals(topology)),
    Error,
    "mesh triangle 0 has degenerate texture coordinates",
  );
});

Deno.test("adjacency rejects a third triangle on one edge", () => {
  const topology = mesh_topology(
    [
      vec3(0, 0, 0),
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, -1, 0),
      vec3(0, 0, 1),
    ],
    [0, 1, 2, 1, 0, 3, 0, 1, 4],
  );
  assertThrows(
    () => generate_triangle_adjacency(topology),
    Error,
    "mesh edge 0:1 is non-manifold at triangle 2",
  );
});

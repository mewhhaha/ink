import { mesh_topology } from "@ink/geometry/mesh.ts";
import { ray } from "@ink/geometry/shapes.ts";
import {
  canonical_material_record,
  create_material_definition,
  default_pbr_parameters,
} from "@ink/materials/canonical.ts";
import { material_definition_id } from "@ink/materials/identity.ts";
import { mat4_identity } from "@ink/math/matrix.ts";
import { vec3 } from "@ink/math/vector.ts";
import {
  ray_tracing_geometry_id,
  ray_tracing_instance_id,
  ray_tracing_scene_revision,
} from "../identity.ts";
import { ray_tracing_material_identity } from "../model.ts";
import { build_ray_tracing_scene } from "../scene.ts";
import { trace_ray } from "../trace.ts";

const triangle_count = 256;
const positions = Array.from({ length: triangle_count }, (_, index) => {
  const x = (index % 16) * 2;
  const y = Math.floor(index / 16) * 2;
  return [
    vec3(x, y, 0),
    vec3(x + 1, y, 0),
    vec3(x, y + 1, 0),
  ];
}).flat();
const topology = mesh_topology(
  positions,
  Array.from(
    { length: triangle_count },
    (_, index) => [index * 3, index * 3 + 1, index * 3 + 2],
  ).flat(),
);
const material = canonical_material_record(create_material_definition({
  id: material_definition_id("benchmark.surface"),
  revision: 0,
  parameters: default_pbr_parameters(),
  alpha: { type: "opaque" },
  sidedness: "front",
}));
const geometry = {
  id: ray_tracing_geometry_id("benchmark.grid"),
  revision: 0,
  topology,
  vertex_normals: null,
  material: ray_tracing_material_identity(material),
};
const scene = {
  revision: ray_tracing_scene_revision(0),
  geometries: [geometry],
  instances: [{
    id: ray_tracing_instance_id("benchmark.grid-instance"),
    revision: 0,
    geometry: geometry.id,
    transform: mat4_identity(),
  }],
  materials: [material],
  lights: [],
};
const packed = build_ray_tracing_scene(scene);
const cast = ray(vec3(30.5, 30.5, 10), vec3(0, 0, -1));

Deno.bench("pack 256 triangles into BLAS and TLAS arrays", () => {
  build_ray_tracing_scene(scene);
});

Deno.bench("trace a nearest hit through 256 packed triangles", () => {
  const hit = trace_ray(packed, cast);
  if (hit === null) throw new Error("benchmark ray did not hit the grid");
});

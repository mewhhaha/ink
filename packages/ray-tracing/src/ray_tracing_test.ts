import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { mesh_topology, type MeshTopology } from "@ink/geometry/mesh.ts";
import { ray_triangle_intersection } from "@ink/geometry/queries.ts";
import { ray, triangle } from "@ink/geometry/shapes.ts";
import { light_id } from "@ink/lighting/identity.ts";
import type { LightDefinition } from "@ink/lighting/light.ts";
import {
  canonical_material_record,
  create_material_definition,
  default_pbr_parameters,
} from "@ink/materials/canonical.ts";
import { linear_rgb } from "@ink/materials/color.ts";
import {
  material_definition_id,
  material_instance_id,
} from "@ink/materials/identity.ts";
import type {
  CanonicalMaterialRecord,
  MaterialInstance,
} from "@ink/materials/canonical.ts";
import { mat4 } from "@ink/math/matrix.ts";
import { quat_identity } from "@ink/math/quaternion.ts";
import { transform, transform_to_mat4 } from "@ink/math/transform.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import { brdf_wgsl, pbr_wgsl } from "@ink/shaders/pbr.ts";
import { compose_wgsl_modules } from "@ink/shaders/compose.ts";
import { next_path_tracing_accumulation } from "./accumulation.ts";
import {
  ray_tracing_geometry_id,
  ray_tracing_instance_id,
  ray_tracing_sample_sequence,
  ray_tracing_scene_revision,
} from "./identity.ts";
import type {
  IndexedRayTracingGeometry,
  PathTracingAccumulationResetReason,
  PathTracingPresentationState,
  RayTracingBuildLimits,
  RayTracingSceneInput,
} from "./model.ts";
import { ray_tracing_material_identity } from "./model.ts";
import {
  build_ray_tracing_scene,
  default_ray_tracing_build_limits,
  plan_ray_tracing_acceleration_update,
  update_ray_tracing_scene,
} from "./scene.ts";
import { trace_ray } from "./trace.ts";
import { ray_tracing_wgsl_modules } from "./wgsl.ts";

Deno.test("ray tracing identities parse their domain and reject unstable values", () => {
  assertEquals(ray_tracing_geometry_id(" room/wall "), "room/wall");
  assertEquals(ray_tracing_instance_id("room:wall-1"), "room:wall-1");
  assertEquals(ray_tracing_scene_revision(3), 3);
  assertEquals(ray_tracing_sample_sequence(8), 8);
  assertThrows(
    () => ray_tracing_geometry_id("wall with spaces"),
    Error,
    'ray tracing geometry identity "wall with spaces" must be a nonempty stable identity',
  );
  assertThrows(
    () => ray_tracing_scene_revision(-1),
    Error,
    "ray tracing scene revision -1 must be a nonnegative safe integer",
  );
  assertThrows(
    () => ray_tracing_sample_sequence(0.5),
    Error,
    "ray tracing sample sequence 0.5 must be a nonnegative safe integer",
  );
});

Deno.test("scene packing is independent of registry order", () => {
  const stone = material("stone");
  const brass = material("brass");
  const floor = geometry("floor", 0, stone);
  const ceiling = geometry("ceiling", 2, brass);
  const first = build_ray_tracing_scene({
    revision: ray_tracing_scene_revision(7),
    geometries: [floor, ceiling],
    instances: [
      instance("floor-instance", floor.id, vec3(0, 0, 0)),
      instance("ceiling-instance", ceiling.id, vec3(0, 0, 0)),
    ],
    materials: [stone, brass],
    lights: [
      point_light("key", vec3(0, 2, 3)),
      point_light("fill", vec3(2, 1, 0)),
    ],
  });
  const second = build_ray_tracing_scene({
    revision: ray_tracing_scene_revision(7),
    geometries: [ceiling, floor],
    instances: [
      instance("ceiling-instance", ceiling.id, vec3(0, 0, 0)),
      instance("floor-instance", floor.id, vec3(0, 0, 0)),
    ],
    materials: [brass, stone],
    lights: [
      point_light("fill", vec3(2, 1, 0)),
      point_light("key", vec3(0, 2, 3)),
    ],
  });

  assertEquals(second, first);
  assertEquals(first.geometries.map(({ id }) => id), ["ceiling", "floor"]);
  assertEquals(first.instances.map(({ id }) => id), [
    "ceiling-instance",
    "floor-instance",
  ]);
  assertEquals(first.materials.map(({ identity }) => identity.id), [
    "brass",
    "stone",
  ]);
  assertEquals(first.lights.map(({ id }) => id), ["fill", "key"]);
  assertEquals(first.triangles.map(({ source_triangle }) => source_triangle), [
    0,
    0,
  ]);
  assertEquals(Object.isFrozen(first.blas), true);
  assertEquals(Object.isFrozen(first.tlas), true);
});

Deno.test("scene packing orders identities by locale-independent code units", () => {
  const uppercase = material("Z-surface");
  const lowercase = material("a-surface");
  const uppercase_geometry = geometry("Z-shape", 0, uppercase);
  const lowercase_geometry = geometry("a-shape", 0, lowercase, 3);
  const scene = build_ray_tracing_scene({
    revision: ray_tracing_scene_revision(0),
    geometries: [lowercase_geometry, uppercase_geometry],
    instances: [
      instance("a-instance", lowercase_geometry.id, vec3(0, 0, 0)),
      instance("Z-instance", uppercase_geometry.id, vec3(0, 0, 0)),
    ],
    materials: [lowercase, uppercase],
    lights: [
      point_light("a-light", vec3(0, 2, 3)),
      point_light("Z-light", vec3(2, 1, 0)),
    ],
  });

  assertEquals(scene.geometries.map(({ id }) => id), ["Z-shape", "a-shape"]);
  assertEquals(scene.instances.map(({ id }) => id), [
    "Z-instance",
    "a-instance",
  ]);
  assertEquals(scene.materials.map(({ identity }) => identity.id), [
    "Z-surface",
    "a-surface",
  ]);
  assertEquals(scene.lights.map(({ id }) => id), ["Z-light", "a-light"]);
});

Deno.test("nearest hit matches the geometry oracle through a transformed instance", () => {
  const surface = material("surface");
  const shape = geometry("triangle", 0, surface);
  const near_transform = transform_to_mat4(transform(
    vec3(3, 0, 4),
    quat_identity(),
    vec3(2, 1, 1),
  ));
  const far_transform = transform_to_mat4(transform(
    vec3(3, 0, 0),
    quat_identity(),
    vec3(2, 1, 1),
  ));
  const scene = build_ray_tracing_scene({
    revision: ray_tracing_scene_revision(1),
    geometries: [shape],
    instances: [
      {
        id: ray_tracing_instance_id("a-far"),
        revision: 0,
        geometry: shape.id,
        transform: far_transform,
      },
      {
        id: ray_tracing_instance_id("z-near"),
        revision: 0,
        geometry: shape.id,
        transform: near_transform,
      },
    ],
    materials: [surface],
    lights: [],
  });
  const cast = ray(vec3(4, 1, 10), vec3(0, 0, -1));
  const expected = ray_triangle_intersection(
    cast,
    triangle(vec3(3, 0, 4), vec3(7, 0, 4), vec3(3, 2, 4)),
  );
  const hit = trace_ray(scene, cast);

  assertEquals(expected?.distance, 6);
  assertAlmostEquals(hit?.distance ?? -1, expected?.distance ?? -2, 1e-12);
  assertEquals(hit?.position, vec3(4, 1, 4));
  assertEquals(hit?.normal, vec3(0, 0, 1));
  assertEquals(hit?.front_face, true);
  assertEquals(hit?.barycentrics, { a: 0.25, b: 0.25, c: 0.5 });
  assertEquals(hit?.texture_coordinate, vec2(0.25, 0.5));
  assertEquals(hit?.geometry, shape.id);
  assertEquals(hit?.instance, ray_tracing_instance_id("z-near"));
  assertEquals(hit?.material, ray_tracing_material_identity(surface));
  assertEquals(hit?.source_triangle, 0);
  assertEquals(trace_ray(scene, cast, 5), null);
});

Deno.test("stackless BLAS and TLAS traversal keeps geometry-local triangle identity", () => {
  const surface = material("surface");
  const prefix = geometry("a-prefix", 0, surface, 100);
  const layers: IndexedRayTracingGeometry = {
    id: ray_tracing_geometry_id("z-layers"),
    revision: 0,
    topology: layered_topology(6),
    vertex_normals: null,
    material: ray_tracing_material_identity(surface),
  };
  const scene = build_ray_tracing_scene({
    revision: ray_tracing_scene_revision(0),
    geometries: [layers, prefix],
    instances: [
      instance("prefix", prefix.id, vec3(0, 0, 0)),
      ...Array.from({ length: 6 }, (_, index) =>
        instance(
          `layer-instance-${index}`,
          layers.id,
          vec3(0, 0, index * -20),
        )),
    ],
    materials: [surface],
    lights: [],
  });
  const cast = ray(vec3(0.5, 0.5, 10), vec3(0, 0, -1));
  const expected = ray_triangle_intersection(
    cast,
    triangle(vec3(0, 0, 0), vec3(2, 0, 0), vec3(0, 2, 0)),
  );
  const hit = trace_ray(scene, cast);

  assertEquals(scene.blas.some(({ type }) => type === "branch"), true);
  assertEquals(scene.tlas.some(({ type }) => type === "branch"), true);
  assertEquals(hit?.distance, expected?.distance);
  assertEquals(hit?.geometry, layers.id);
  assertEquals(hit?.instance, ray_tracing_instance_id("layer-instance-0"));
  assertEquals(hit?.source_triangle, 5);
});

Deno.test("nearest hits interpolate normalized vertex normals", () => {
  const surface = material("smooth-surface");
  const shape: IndexedRayTracingGeometry = {
    ...geometry("smooth-shape", 0, surface),
    vertex_normals: [
      vec3(0, 0, 1),
      vec3(0, 0.6, 0.8),
      vec3(0.8, 0, 0.6),
    ],
  };
  const scene = build_ray_tracing_scene(scene_with(shape, surface, [
    instance("smooth-instance", shape.id, vec3(0, 0, 0)),
  ]));
  const hit = trace_ray(scene, ray(vec3(0.5, 1, 2), vec3(0, 0, -1)));
  const length = Math.hypot(0.4, 0.15, 0.75);

  assertAlmostEquals(hit?.normal.x ?? -1, 0.4 / length, 1e-12);
  assertAlmostEquals(hit?.normal.y ?? -1, 0.15 / length, 1e-12);
  assertAlmostEquals(hit?.normal.z ?? -1, 0.75 / length, 1e-12);
});

Deno.test("definition and instance materials with the same text keep distinct identities", () => {
  const definition_material = material("shared");
  const instance_material = material_instance("base", "shared");
  const definition_geometry = geometry("definition", 0, definition_material);
  const instance_geometry = geometry("instance", 0, instance_material, 3);
  const scene = build_ray_tracing_scene({
    revision: ray_tracing_scene_revision(0),
    geometries: [definition_geometry, instance_geometry],
    instances: [
      instance("definition", definition_geometry.id, vec3(0, 0, 0)),
      instance("instance", instance_geometry.id, vec3(0, 0, 0)),
    ],
    materials: [definition_material, instance_material],
    lights: [],
  });

  assertEquals(scene.materials.map(({ identity }) => identity), [
    { type: "definition", id: material_definition_id("shared") },
    { type: "instance", id: material_instance_id("shared") },
  ]);
  const hit = trace_ray(scene, ray(vec3(3.5, 0.5, 2), vec3(0, 0, -1)));
  assertEquals(hit?.material, {
    type: "instance",
    id: material_instance_id("shared"),
  });
});

Deno.test("malformed topology reports the geometry and offending index", () => {
  const surface = material("surface");
  const malformed = structuredClone(triangle_topology(0));
  Object.defineProperty(malformed, "indices", { value: [0, 1, 9] });
  const shape: IndexedRayTracingGeometry = {
    id: ray_tracing_geometry_id("broken"),
    revision: 0,
    topology: malformed,
    vertex_normals: null,
    material: ray_tracing_material_identity(surface),
  };
  assertThrows(
    () => build_ray_tracing_scene(scene_with(shape, surface)),
    Error,
    "ray tracing geometry broken topology is invalid: mesh corner 2 references position 9 outside 0..2",
  );
});

Deno.test("build limits report the overflowing resource and owner", () => {
  const surface = material("surface");
  const shape = geometry("shape", 0, surface);
  const source = scene_with(shape, surface, [
    instance("shape-instance", shape.id, vec3(0, 0, 0)),
  ], [point_light("lamp", vec3(0, 0, 2))]);
  const cases = [
    [
      { maximum_materials: 0 },
      "ray tracing material capacity 0 is exceeded by material definition surface; requested 1",
    ],
    [
      { maximum_triangles: 0 },
      "ray tracing triangle capacity 0 is exceeded by geometry shape; requested 1",
    ],
    [
      { maximum_instances: 0 },
      "ray tracing instance capacity 0 is exceeded by instance shape-instance; requested 1",
    ],
    [
      { maximum_lights: 0 },
      "ray tracing light capacity 0 is exceeded by light lamp; requested 1",
    ],
    [
      { maximum_blas_nodes: 0 },
      "ray tracing BLAS node capacity 0 is exceeded by geometry shape; requested 1",
    ],
    [
      { maximum_tlas_nodes: 0 },
      "ray tracing TLAS node capacity 0 is exceeded by 1 instances; requested 1",
    ],
  ] satisfies readonly [Partial<RayTracingBuildLimits>, string][];
  for (const [override, message] of cases) {
    assertThrows(
      () =>
        build_ray_tracing_scene(source, {
          ...default_ray_tracing_build_limits,
          ...override,
        }),
      Error,
      message,
    );
  }
});

Deno.test("invalid build limits retain the field and received value", () => {
  const surface = material("surface");
  const shape = geometry("shape", 0, surface);
  assertThrows(
    () =>
      build_ray_tracing_scene(scene_with(shape, surface), {
        ...default_ray_tracing_build_limits,
        maximum_tlas_nodes: 0.5,
      }),
    Error,
    "ray tracing build limit maximum_tlas_nodes 0.5 must be an unsigned 32-bit integer",
  );
});

Deno.test("scene packing rejects a non-affine instance with its identity and last row", () => {
  const surface = material("surface");
  const shape = geometry("shape", 0, surface);
  const placed = instance("broken-instance", shape.id, vec3(0, 0, 0));
  assertThrows(
    () =>
      build_ray_tracing_scene(scene_with(shape, surface, [{
        ...placed,
        transform: mat4([
          1,
          0,
          0,
          1,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
        ]),
      }])),
    Error,
    "ray tracing instance broken-instance transform last row [1, 0, 0, 1] is not affine",
  );
});

Deno.test("scene packing rejects a singular instance with its identity and pivot", () => {
  const surface = material("surface");
  const shape = geometry("shape", 0, surface);
  const placed = instance("broken-instance", shape.id, vec3(0, 0, 0));
  assertThrows(
    () =>
      build_ray_tracing_scene(scene_with(shape, surface, [{
        ...placed,
        transform: transform_to_mat4(transform(
          vec3(0, 0, 0),
          quat_identity(),
          vec3(1, 0, 1),
        )),
      }])),
    Error,
    "ray tracing instance broken-instance transform is singular at pivot 0",
  );
});

Deno.test("acceleration planning rebuilds only the level changed by its revision", () => {
  const first_material = material("surface");
  const next_material = material("surface-next");
  const shape = geometry("shape", 0, first_material);
  const placed = instance("shape-instance", shape.id, vec3(0, 0, 0));
  const initial: RayTracingSceneInput = {
    ...scene_with(shape, first_material, [placed]),
    materials: [first_material, next_material],
  };
  const material_only: RayTracingSceneInput = {
    ...initial,
    revision: ray_tracing_scene_revision(1),
    geometries: [{
      ...shape,
      material: ray_tracing_material_identity(next_material),
    }],
  };
  const transform_change: RayTracingSceneInput = {
    ...material_only,
    revision: ray_tracing_scene_revision(2),
    instances: [{ ...placed, revision: 1 }],
  };
  const geometry_change: RayTracingSceneInput = {
    ...transform_change,
    revision: ray_tracing_scene_revision(3),
    geometries: [{ ...material_only.geometries[0], revision: 1 }],
  };

  assertEquals(
    plan_ray_tracing_acceleration_update(initial, material_only),
    { type: "unchanged" },
  );
  assertEquals(
    plan_ray_tracing_acceleration_update(material_only, transform_change),
    { type: "rebuild_tlas" },
  );
  assertEquals(
    plan_ray_tracing_acceleration_update(transform_change, geometry_change),
    { type: "rebuild_blas_and_tlas", geometries: [shape.id] },
  );
});

Deno.test("scene updates reuse unchanged geometry BLAS and rebuild the changed BLAS and TLAS", () => {
  const surface = material("surface");
  const anchor = geometry("anchor", 0, surface);
  const changing = geometry("changing", 0, surface, 4);
  const initial_input: RayTracingSceneInput = {
    revision: ray_tracing_scene_revision(0),
    geometries: [changing, anchor],
    instances: [
      instance("anchor-instance", anchor.id, vec3(0, 0, 0)),
      instance("changing-instance", changing.id, vec3(0, 0, 0)),
    ],
    materials: [surface],
    lights: [],
  };
  const initial = build_ray_tracing_scene(initial_input);
  const next_input: RayTracingSceneInput = {
    ...initial_input,
    revision: ray_tracing_scene_revision(1),
    geometries: [
      anchor,
      {
        ...changing,
        revision: 1,
        topology: triangle_topology(-1, 4),
      },
    ],
  };

  const updated = update_ray_tracing_scene(initial_input, initial, next_input);

  assertStrictEquals(updated.geometries[0].blas, initial.geometries[0].blas);
  assertNotStrictEquals(updated.geometries[1].blas, initial.geometries[1].blas);
  assertNotStrictEquals(updated.blas, initial.blas);
  assertNotStrictEquals(updated.tlas, initial.tlas);
  assertEquals(
    trace_ray(updated, ray(vec3(0.5, 0.5, 2), vec3(0, 0, -1)))
      ?.geometry,
    anchor.id,
  );
  assertEquals(
    trace_ray(updated, ray(vec3(4.5, 0.5, 2), vec3(0, 0, -1)))
      ?.geometry,
    changing.id,
  );
});

Deno.test("scene updates rebuild only TLAS for transform changes", () => {
  const surface = material("surface");
  const shape = geometry("shape", 0, surface);
  const placed = instance("shape-instance", shape.id, vec3(0, 0, 0));
  const initial_input = scene_with(shape, surface, [placed]);
  const initial = build_ray_tracing_scene(initial_input);
  const next_input: RayTracingSceneInput = {
    ...initial_input,
    instances: [{
      ...placed,
      revision: 1,
      transform: transform_to_mat4(transform(
        vec3(3, 0, 0),
        quat_identity(),
        vec3(1, 1, 1),
      )),
    }],
  };

  const updated = update_ray_tracing_scene(initial_input, initial, next_input);

  assertStrictEquals(updated.geometries, initial.geometries);
  assertStrictEquals(updated.triangles, initial.triangles);
  assertStrictEquals(updated.blas, initial.blas);
  assertStrictEquals(updated.blas_indices, initial.blas_indices);
  assertNotStrictEquals(updated.instances, initial.instances);
  assertNotStrictEquals(updated.tlas, initial.tlas);
  assertEquals(
    trace_ray(updated, ray(vec3(3.5, 0.5, 2), vec3(0, 0, -1)))
      ?.instance,
    placed.id,
  );
});

Deno.test("material assignment updates preserve BLAS and TLAS", () => {
  const stone = material("stone");
  const brass = material("brass");
  const shape = geometry("shape", 0, stone);
  const initial_input: RayTracingSceneInput = {
    ...scene_with(shape, stone, [
      instance("shape-instance", shape.id, vec3(0, 0, 0)),
    ]),
    materials: [stone, brass],
  };
  const initial = build_ray_tracing_scene(initial_input);
  const next_input: RayTracingSceneInput = {
    ...initial_input,
    revision: ray_tracing_scene_revision(1),
    geometries: [{
      ...shape,
      material: ray_tracing_material_identity(brass),
    }],
  };

  const updated = update_ray_tracing_scene(initial_input, initial, next_input);

  assertStrictEquals(updated.geometries, initial.geometries);
  assertStrictEquals(updated.blas, initial.blas);
  assertStrictEquals(updated.blas_indices, initial.blas_indices);
  assertStrictEquals(updated.instances, initial.instances);
  assertStrictEquals(updated.tlas, initial.tlas);
  assertStrictEquals(updated.tlas_indices, initial.tlas_indices);
  assertNotStrictEquals(updated.triangles, initial.triangles);
  assertEquals(
    trace_ray(updated, ray(vec3(0.5, 0.5, 2), vec3(0, 0, -1)))
      ?.material,
    ray_tracing_material_identity(brass),
  );
});

Deno.test("accumulation continues with the next sample sequence when presentation is unchanged", () => {
  const presentation = path_tracing_presentation();
  const first = next_path_tracing_accumulation(undefined, presentation);
  const second = next_path_tracing_accumulation(first, presentation);
  const third = next_path_tracing_accumulation(second, presentation);

  assertEquals(first.type, "reset");
  if (first.type === "reset") assertEquals(first.reasons, ["initial"]);
  assertEquals(first.sample_sequence, ray_tracing_sample_sequence(0));
  assertEquals(first.accumulated_samples, 4);
  assertEquals(second.type, "continued");
  assertEquals(second.sample_sequence, ray_tracing_sample_sequence(4));
  assertEquals(second.accumulated_samples, 8);
  assertEquals(third.sample_sequence, ray_tracing_sample_sequence(8));
  assertEquals(third.accumulated_samples, 12);
});

Deno.test("every presentation change resets accumulation with its reason", () => {
  const presentation = path_tracing_presentation();
  const previous = next_path_tracing_accumulation(undefined, presentation);
  const cases = [
    ["scene", {
      ...presentation,
      scene_revision: ray_tracing_scene_revision(2),
    }],
    ["transforms", { ...presentation, transform_revision: 2 }],
    ["materials", { ...presentation, material_revision: 2 }],
    ["lights", { ...presentation, light_revision: 2 }],
    ["camera", { ...presentation, camera_revision: 2 }],
    ["viewport", { ...presentation, viewport: { width: 801, height: 600 } }],
    ["exposure", { ...presentation, exposure_revision: 2 }],
    ["fog", { ...presentation, fog_revision: 2 }],
    [
      "quality",
      {
        ...presentation,
        quality: { ...presentation.quality, maximum_bounces: 5 },
      },
    ],
  ] satisfies readonly [
    PathTracingAccumulationResetReason,
    PathTracingPresentationState,
  ][];

  for (const [reason, changed] of cases) {
    const frame = next_path_tracing_accumulation(previous, changed);
    assertEquals(frame.type, "reset", reason);
    if (frame.type === "reset") assertEquals(frame.reasons, [reason], reason);
    assertEquals(frame.sample_sequence, ray_tracing_sample_sequence(0), reason);
    assertEquals(frame.accumulated_samples, 4, reason);
  }
});

Deno.test("simultaneous presentation changes report reset reasons in fixed order", () => {
  const presentation = path_tracing_presentation();
  const previous = next_path_tracing_accumulation(undefined, presentation);
  const frame = next_path_tracing_accumulation(previous, {
    ...presentation,
    scene_revision: ray_tracing_scene_revision(2),
    material_revision: 2,
    camera_revision: 2,
    viewport: { width: 400, height: 300 },
    quality: { ...presentation.quality, samples_per_frame: 8 },
  });
  assertEquals(frame.type, "reset");
  if (frame.type === "reset") {
    assertEquals(frame.reasons, [
      "scene",
      "materials",
      "camera",
      "viewport",
      "quality",
    ]);
  }
  assertEquals(frame.accumulated_samples, 8);
});

Deno.test("ray tracing WGSL modules compose with shared PBR independently of root order", () => {
  const roots = [
    ...ray_tracing_wgsl_modules.map(({ id }) => id),
    pbr_wgsl.id,
  ];
  const available = [...ray_tracing_wgsl_modules, brdf_wgsl, pbr_wgsl];
  const first = compose_wgsl_modules(roots, available);
  const second = compose_wgsl_modules(
    [...roots].reverse(),
    [...available].reverse(),
  );

  assertEquals(second.source, first.source);
  const parallel_slab = first.source.indexOf("if (direction == 0.0)");
  const slab_reciprocal = first.source.indexOf("1.0 / direction");
  assert(
    parallel_slab >= 0 && slab_reciprocal > parallel_slab,
    "composed ray WGSL must handle parallel slabs before taking a reciprocal",
  );
  assertEquals(first.modules.length, 9);
  assertEquals(
    new Set(first.symbols.map(({ name }) => name)),
    new Set([
      "ink_distribution_ggx",
      "ink_fresnel_schlick",
      "ink_geometry_smith",
      "ink_evaluate_pbr",
      "InkRayTracingRay",
      "InkRayTracingTriangleHit",
      "ink_ray_bounds_distance",
      "ink_ray_triangle_intersection",
      "InkRayTracingBvhNode",
      "ink_ray_stackless_next",
      "ink_ray_ggx_distribution",
      "ink_ray_ggx_sample_half_vector",
      "InkRayTracingDirectLightSample",
      "ink_ray_sample_point_light",
      "ink_ray_sample_rectangular_light",
      "ink_ray_progressive_accumulation",
      "ink_ray_luminance_variance",
      "ink_ray_update_moments",
      "ink_ray_edge_aware_weight",
    ]),
  );
  assertEquals(first.bindings, []);
  assertEquals(first.entry_points, []);
});

function material(id: string): CanonicalMaterialRecord {
  return canonical_material_record(create_material_definition({
    id: material_definition_id(id),
    revision: 0,
    parameters: default_pbr_parameters(),
    alpha: { type: "opaque" },
    sidedness: "front",
  }));
}

function material_instance(
  definition_id: string,
  instance_id: string,
): CanonicalMaterialRecord {
  const definition = create_material_definition({
    id: material_definition_id(definition_id),
    revision: 0,
    parameters: default_pbr_parameters(),
    alpha: { type: "opaque" },
    sidedness: "front",
  });
  const instance: MaterialInstance = {
    id: material_instance_id(instance_id),
    definition: definition.id,
    definition_revision: definition.revision,
    revision: 0,
    overrides: {},
  };
  return canonical_material_record(definition, instance);
}

function triangle_topology(z: number, x = 0): MeshTopology {
  return mesh_topology(
    [
      vec3(x, 0, z),
      vec3(x + 2, 0, z),
      vec3(x, 2, z),
    ],
    [0, 1, 2],
    [vec2(0, 0), vec2(1, 0), vec2(0, 1)],
  );
}

function layered_topology(layer_count: number): MeshTopology {
  const positions = Array.from({ length: layer_count }, (_, index) => {
    const z = (index - layer_count + 1) * 2;
    return [vec3(0, 0, z), vec3(2, 0, z), vec3(0, 2, z)];
  }).flat();
  const indices = Array.from(
    { length: layer_count },
    (_, index) => [index * 3, index * 3 + 1, index * 3 + 2],
  ).flat();
  const texture_coordinates = Array.from(
    { length: layer_count },
    () => [vec2(0, 0), vec2(1, 0), vec2(0, 1)],
  ).flat();
  return mesh_topology(positions, indices, texture_coordinates);
}

function geometry(
  id: string,
  z: number,
  surface: CanonicalMaterialRecord,
  x = 0,
): IndexedRayTracingGeometry {
  return {
    id: ray_tracing_geometry_id(id),
    revision: 0,
    topology: triangle_topology(z, x),
    vertex_normals: null,
    material: ray_tracing_material_identity(surface),
  };
}

function instance(
  id: string,
  geometry_id: IndexedRayTracingGeometry["id"],
  position: ReturnType<typeof vec3>,
) {
  return {
    id: ray_tracing_instance_id(id),
    revision: 0,
    geometry: geometry_id,
    transform: transform_to_mat4(transform(
      position,
      quat_identity(),
      vec3(1, 1, 1),
    )),
  };
}

function point_light(
  id: string,
  position: ReturnType<typeof vec3>,
): LightDefinition {
  return {
    id: light_id(id),
    revision: 0,
    type: "point",
    color: linear_rgb(1, 1, 1),
    layers: 1,
    importance: 1,
    shadow: { type: "off" },
    position,
    intensity_candela: 100,
    range: 10,
    source_radius: 0.1,
  };
}

function scene_with(
  shape: IndexedRayTracingGeometry,
  surface: CanonicalMaterialRecord,
  instances: RayTracingSceneInput["instances"] = [],
  lights: RayTracingSceneInput["lights"] = [],
): RayTracingSceneInput {
  return {
    revision: ray_tracing_scene_revision(0),
    geometries: [shape],
    instances,
    materials: [surface],
    lights,
  };
}

function path_tracing_presentation(): PathTracingPresentationState {
  return {
    scene_revision: ray_tracing_scene_revision(1),
    transform_revision: 1,
    material_revision: 1,
    light_revision: 1,
    camera_revision: 1,
    viewport: { width: 800, height: 600 },
    exposure_revision: 1,
    fog_revision: 1,
    quality: {
      samples_per_frame: 4,
      maximum_bounces: 4,
      render_scale: 1,
      denoiser: "edge_aware",
    },
  };
}

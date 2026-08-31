import {
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { mesh_topology } from "@ink/geometry/mesh.ts";
import { light_id } from "@ink/lighting/identity.ts";
import { create_light } from "@ink/lighting/light.ts";
import {
  canonical_material_record,
  create_material_definition,
  default_pbr_parameters,
} from "@ink/materials/canonical.ts";
import { linear_rgb, linear_rgba } from "@ink/materials/color.ts";
import { material_definition_id } from "@ink/materials/identity.ts";
import type { CanonicalMaterialRecord } from "@ink/materials/canonical.ts";
import { mat4_identity } from "@ink/math/matrix.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import {
  ray_tracing_geometry_id,
  ray_tracing_instance_id,
  ray_tracing_scene_revision,
} from "@ink/ray-tracing/identity.ts";
import {
  ray_tracing_material_identity,
  type RayTracingSceneInput,
} from "@ink/ray-tracing/scene.ts";
import {
  pack_ray_tracing_gpu_scene,
  path_tracing_render_scene_snapshot,
  plan_path_tracing_frame,
} from "./path_tracing.ts";
import {
  perspective_render_camera,
  render_color,
  render_material,
  render_node_id,
  render_point_light,
  render_scene_hierarchy,
  render_scene_node,
  render_texture_id,
  type RenderScene,
} from "./renderer.ts";

Deno.test("path tracing initializes every GPU scene resource and continues accumulation", () => {
  const source = scene_source();
  const initial = plan_path_tracing_frame(undefined, {
    source,
    presentation: presentation(),
    camera_moving: false,
  });

  assertEquals(initial.type, "path_traced");
  if (initial.type !== "path_traced") return;
  assertEquals(initial.acceleration, { type: "initialize" });
  assertEquals(initial.accumulation.type, "reset");
  assertEquals(initial.uploads, {
    blas: true,
    geometry: true,
    instances: true,
    lights: true,
    materials: true,
    triangles: true,
    tlas: true,
  });

  const continued = plan_path_tracing_frame(initial.next_history, {
    source,
    presentation: presentation(),
    camera_moving: false,
  });
  assertEquals(continued.type, "path_traced");
  if (continued.type !== "path_traced") return;
  assertEquals(continued.acceleration, { type: "unchanged" });
  assertEquals(continued.accumulation.type, "continued");
  assertEquals(continued.accumulation.accumulated_samples, 4);
  assertStrictEquals(continued.packed_scene, initial.packed_scene);
  assertEquals(continued.uploads, {
    blas: false,
    geometry: false,
    instances: false,
    lights: false,
    materials: false,
    triangles: false,
    tlas: false,
  });
});

Deno.test("transform changes rebuild only TLAS resources and reset accumulation", () => {
  const source = scene_source();
  const initial = traced_history(source);
  const moved: RayTracingSceneInput = {
    ...source,
    instances: [{ ...source.instances[0], revision: 1 }],
  };

  const frame = plan_path_tracing_frame(initial, {
    source: moved,
    presentation: presentation({ transform_revision: 1 }),
    camera_moving: false,
  });

  assertEquals(frame.type, "path_traced");
  if (frame.type !== "path_traced") return;
  assertEquals(frame.acceleration, { type: "rebuild_tlas" });
  assertEquals(frame.accumulation, {
    ...frame.accumulation,
    type: "reset",
    reasons: ["transforms"],
  });
  assertEquals(frame.uploads, {
    blas: false,
    geometry: false,
    instances: true,
    lights: false,
    materials: false,
    triangles: false,
    tlas: true,
  });
  assertStrictEquals(
    frame.packed_scene.geometries,
    initial.packed_scene.geometries,
  );
  assertStrictEquals(
    frame.packed_scene.triangles,
    initial.packed_scene.triangles,
  );
  assertStrictEquals(frame.packed_scene.blas, initial.packed_scene.blas);
  assertStrictEquals(
    frame.packed_scene.blas_indices,
    initial.packed_scene.blas_indices,
  );
  assertNotStrictEquals(
    frame.packed_scene.instances,
    initial.packed_scene.instances,
  );
  assertNotStrictEquals(frame.packed_scene.tlas, initial.packed_scene.tlas);
});

Deno.test("geometry changes rebuild BLAS and TLAS resources", () => {
  const source = scene_source();
  const initial = traced_history(source);
  const changed: RayTracingSceneInput = {
    ...source,
    revision: ray_tracing_scene_revision(1),
    geometries: [{ ...source.geometries[0], revision: 1 }],
  };

  const frame = plan_path_tracing_frame(initial, {
    source: changed,
    presentation: presentation({ scene_revision: 1 }),
    camera_moving: false,
  });

  assertEquals(frame.type, "path_traced");
  if (frame.type !== "path_traced") return;
  assertEquals(frame.acceleration.type, "rebuild_blas_and_tlas");
  assertEquals(frame.uploads.blas, true);
  assertEquals(frame.uploads.geometry, true);
  assertEquals(frame.uploads.instances, true);
  assertEquals(frame.uploads.tlas, true);
  assertNotStrictEquals(frame.packed_scene.blas, initial.packed_scene.blas);
  assertNotStrictEquals(frame.packed_scene.tlas, initial.packed_scene.tlas);
});

Deno.test("material changes preserve acceleration and replace only material resources", () => {
  const source = scene_source();
  const initial = traced_history(source);
  const changed_material = material("surface", [0.2, 0.3, 0.4]);
  const changed: RayTracingSceneInput = {
    ...source,
    materials: [changed_material],
  };

  const frame = plan_path_tracing_frame(initial, {
    source: changed,
    presentation: presentation({ material_revision: 1 }),
    camera_moving: false,
  });

  assertEquals(frame.type, "path_traced");
  if (frame.type !== "path_traced") return;
  assertEquals(frame.acceleration, { type: "unchanged" });
  assertEquals(frame.accumulation.type, "reset");
  assertEquals(frame.uploads, {
    blas: false,
    geometry: false,
    instances: false,
    lights: false,
    materials: true,
    triangles: false,
    tlas: false,
  });
  assertStrictEquals(
    frame.packed_scene.geometries,
    initial.packed_scene.geometries,
  );
  assertStrictEquals(frame.packed_scene.blas, initial.packed_scene.blas);
  assertStrictEquals(frame.packed_scene.tlas, initial.packed_scene.tlas);
  assertStrictEquals(
    frame.packed_scene.instances,
    initial.packed_scene.instances,
  );
});

Deno.test("camera motion uses raster preview and restarts path accumulation when motion stops", () => {
  const source = scene_source();
  const initial = traced_history(source);
  const preview = plan_path_tracing_frame(initial, {
    source,
    presentation: presentation({ camera_revision: 1 }),
    camera_moving: true,
  });

  assertEquals(preview.type, "raster_preview");
  assertStrictEquals(preview.next_history?.source, source);
  assertStrictEquals(
    preview.next_history?.packed_scene,
    initial.packed_scene,
  );
  assertEquals(preview.next_history?.accumulation, undefined);
  const resumed = plan_path_tracing_frame(preview.next_history, {
    source,
    presentation: presentation({ camera_revision: 1 }),
    camera_moving: false,
  });
  assertEquals(resumed.type, "path_traced");
  if (resumed.type !== "path_traced") return;
  assertEquals(resumed.acceleration, { type: "unchanged" });
  assertEquals(resumed.accumulation.type, "reset");
  if (resumed.accumulation.type === "reset") {
    assertEquals(resumed.accumulation.reasons, ["initial"]);
  }
});

Deno.test("GPU scene packing has deterministic shader-aligned strides", () => {
  const planned = plan_path_tracing_frame(undefined, {
    source: scene_source(),
    presentation: presentation(),
    camera_moving: false,
  });
  if (planned.type !== "path_traced") return;

  const first = pack_ray_tracing_gpu_scene(planned.packed_scene);
  const second = pack_ray_tracing_gpu_scene(planned.packed_scene);
  assertEquals(second, first);
  assertEquals(first.triangles.byteLength, 128);
  assertEquals(first.geometries.byteLength, 16);
  assertEquals(first.instances.byteLength, 144);
  assertEquals(first.materials.byteLength, 80);
  assertEquals(first.blas.byteLength, 48);
  assertEquals(first.tlas.byteLength, 48);
  const triangle = new DataView(first.triangles.buffer);
  assertEquals(triangle.getFloat32(0, true), -1);
  assertEquals(triangle.getFloat32(16, true), 1);
  assertEquals(triangle.getUint32(12, true), 0);
  assertEquals(triangle.getUint32(44, true), 3);
  assertEquals(triangle.getFloat32(56, true), 1);
  assertEquals(triangle.getFloat32(88, true), 1);
});

Deno.test("GPU material packing retains base-color and normal texture layers", () => {
  const base_color = render_texture_id("fixture/base-color");
  const normal = render_texture_id("fixture/normal");
  const surface = render_material("fixture/textured", {
    albedo: [1, 1, 1],
    base_color_texture: base_color,
    emissive: [0, 0, 0],
    metallic: 0,
    normal_texture: normal,
    roughness: 0.5,
  });
  const planned = plan_path_tracing_frame(undefined, {
    source: scene_source(surface),
    presentation: presentation(),
    camera_moving: false,
  });
  if (planned.type !== "path_traced") return;

  const packed = pack_ray_tracing_gpu_scene(planned.packed_scene, {
    base_color: new Map([[
      base_color,
      { layer: 2, width_scale: 0.5, height_scale: 0.25 },
    ]]),
    normal: new Map([[
      normal,
      { layer: 3, width_scale: 0.75, height_scale: 0.5 },
    ]]),
  });
  const material = new DataView(packed.materials.buffer);
  assertEquals(material.getFloat32(48, true), 2);
  assertEquals(material.getFloat32(52, true), 3);
  assertEquals(material.getFloat32(56, true), 0.5);
  assertEquals(material.getFloat32(60, true), 0.25);
  assertEquals(material.getFloat32(64, true), 0.75);
  assertEquals(material.getFloat32(68, true), 0.5);
  assertEquals(material.getFloat32(72, true), 1);
});

Deno.test("GPU light packing preserves the shader's floating-point type tag", () => {
  const source = scene_source();
  const planned = plan_path_tracing_frame(undefined, {
    source: {
      ...source,
      lights: [render_point_light("fixture/lamp", {
        color: [1, 0.8, 0.6],
        position: [0, 2, 1],
        intensity_candela: 20,
        range: 8,
      })],
    },
    presentation: presentation(),
    camera_moving: false,
  });
  if (planned.type !== "path_traced") return;

  const packed = pack_ray_tracing_gpu_scene(planned.packed_scene);
  assertEquals(new DataView(packed.lights.buffer).getFloat32(28, true), 1);
});

Deno.test("render scene translation turns hierarchy motion into a TLAS-only update", () => {
  const surface = material("translated-surface", [0.7, 0.6, 0.5]);
  const node = render_scene_node(0, {
    position: [0, 0, 0],
    rotation: { type: "y_axis", radians: 0 },
    scale: [1, 1, 1],
  });
  const source = render_scene_fixture(surface, node, 0);
  const built_in_geometry = built_in_path_tracing_geometry();
  const technique = path_tracing_technique();
  const initial_snapshot = path_tracing_render_scene_snapshot(
    source,
    built_in_geometry,
    { width: 320, height: 180 },
    technique,
  );
  const initial = plan_path_tracing_frame(undefined, {
    ...initial_snapshot,
    camera_moving: false,
  });
  if (initial.type !== "path_traced") return;
  const moved_node = render_scene_node(0, {
    position: [2, 0, 0],
    rotation: { type: "y_axis", radians: 0 },
    scale: [1, 1, 1],
  });
  const moved_snapshot = path_tracing_render_scene_snapshot(
    render_scene_fixture(surface, moved_node, 1),
    built_in_geometry,
    { width: 320, height: 180 },
    technique,
  );
  const moved = plan_path_tracing_frame(initial.next_history, {
    ...moved_snapshot,
    camera_moving: false,
  });

  assertEquals(moved.type, "path_traced");
  if (moved.type !== "path_traced") return;
  assertEquals(moved.acceleration, { type: "rebuild_tlas" });
  assertEquals(moved.accumulation.type, "reset");
  if (moved.accumulation.type === "reset") {
    assertEquals(moved.accumulation.reasons, ["transforms"]);
  }
});

Deno.test("material assignment changes reset accumulation and upload only triangles", () => {
  const stone = material("assignment-stone", [0.7, 0.6, 0.5]);
  const brass = material("assignment-brass", [0.8, 0.5, 0.2]);
  const nodes = [0, 1, 2].map((index) =>
    render_scene_node(index, {
      position: [index * 2, 0, 0],
      rotation: { type: "y_axis", radians: 0 },
      scale: [1, 1, 1],
    })
  );
  const initial_scene: RenderScene = {
    ...render_scene_fixture(stone, nodes[0], 0),
    hierarchy: render_scene_hierarchy("material-assignments", 0, nodes),
    objects: [
      {
        id: "anchor",
        shape: "plane",
        node: render_node_id(0),
        material: stone,
      },
      {
        id: "second",
        shape: "plane",
        node: render_node_id(1),
        material: stone,
      },
      { id: "third", shape: "plane", node: render_node_id(2), material: brass },
    ],
  };
  const swapped_scene: RenderScene = {
    ...initial_scene,
    objects: [
      {
        id: "anchor",
        shape: "plane",
        node: render_node_id(0),
        material: stone,
      },
      {
        id: "second",
        shape: "plane",
        node: render_node_id(1),
        material: brass,
      },
      { id: "third", shape: "plane", node: render_node_id(2), material: stone },
    ],
  };
  const initial_snapshot = path_tracing_render_scene_snapshot(
    initial_scene,
    built_in_path_tracing_geometry(),
    { width: 320, height: 180 },
    path_tracing_technique(),
  );
  const swapped_snapshot = path_tracing_render_scene_snapshot(
    swapped_scene,
    built_in_path_tracing_geometry(),
    { width: 320, height: 180 },
    path_tracing_technique(),
  );
  const initial = plan_path_tracing_frame(undefined, {
    ...initial_snapshot,
    camera_moving: false,
  });
  if (initial.type !== "path_traced") return;
  const swapped = plan_path_tracing_frame(initial.next_history, {
    ...swapped_snapshot,
    camera_moving: false,
  });

  assertEquals(
    initial_snapshot.presentation.scene_revision,
    swapped_snapshot.presentation.scene_revision,
  );
  assertNotEquals(
    initial_snapshot.presentation.material_revision,
    swapped_snapshot.presentation.material_revision,
  );
  assertEquals(swapped.type, "path_traced");
  if (swapped.type !== "path_traced") return;
  assertEquals(swapped.acceleration, { type: "unchanged" });
  assertEquals(swapped.accumulation.type, "reset");
  if (swapped.accumulation.type === "reset") {
    assertEquals(swapped.accumulation.reasons, ["materials"]);
  }
  assertEquals(swapped.uploads, {
    blas: false,
    geometry: false,
    instances: false,
    lights: false,
    materials: false,
    triangles: true,
    tlas: false,
  });
});

Deno.test("ambient light changes reset accumulation without replacing scene buffers", () => {
  const surface = material("ambient-surface", [0.7, 0.6, 0.5]);
  const node = render_scene_node(0, {
    position: [0, 0, 0],
    rotation: { type: "y_axis", radians: 0 },
    scale: [1, 1, 1],
  });
  const initial_scene = render_scene_fixture(surface, node, 0);
  const changed_scene: RenderScene = {
    ...initial_scene,
    environment: {
      ...initial_scene.environment,
      ambient_light: render_color([0.3, 0.2, 0.1]),
    },
  };
  const initial_snapshot = path_tracing_render_scene_snapshot(
    initial_scene,
    built_in_path_tracing_geometry(),
    { width: 320, height: 180 },
    path_tracing_technique(),
  );
  const changed_snapshot = path_tracing_render_scene_snapshot(
    changed_scene,
    built_in_path_tracing_geometry(),
    { width: 320, height: 180 },
    path_tracing_technique(),
  );
  const initial = plan_path_tracing_frame(undefined, {
    ...initial_snapshot,
    camera_moving: false,
  });
  if (initial.type !== "path_traced") return;
  const changed = plan_path_tracing_frame(initial.next_history, {
    ...changed_snapshot,
    camera_moving: false,
  });

  assertEquals(changed.type, "path_traced");
  if (changed.type !== "path_traced") return;
  assertEquals(changed.acceleration, { type: "unchanged" });
  assertEquals(changed.accumulation.type, "reset");
  if (changed.accumulation.type === "reset") {
    assertEquals(changed.accumulation.reasons, ["lights"]);
  }
  assertEquals(changed.uploads, {
    blas: false,
    geometry: false,
    instances: false,
    lights: false,
    materials: false,
    triangles: false,
    tlas: false,
  });
});

Deno.test("rectangular light orientation changes replace lights and reset accumulation", () => {
  const surface = material("area-light-surface", [0.7, 0.6, 0.5]);
  const node = render_scene_node(0, {
    position: [0, 0, 0],
    rotation: { type: "y_axis", radians: 0 },
    scale: [1, 1, 1],
  });
  const area_light = create_light({
    id: light_id("fixture/area"),
    revision: 0,
    type: "rectangular",
    color: linear_rgb(1, 0.9, 0.8),
    layers: 0xffff_ffff,
    importance: 1,
    shadow: { type: "off" },
    position: vec3(0, 2, 0),
    normal: vec3(0, -1, 0),
    tangent: vec3(1, 0, 0),
    size: vec2(2, 1),
    luminance_nits: 20,
    range: 8,
    two_sided: false,
  });
  if (area_light.type !== "rectangular") {
    throw new Error("fixture area light unexpectedly changed type");
  }
  const initial_scene: RenderScene = {
    ...render_scene_fixture(surface, node, 0),
    lights: [area_light],
  };
  const changed_scene: RenderScene = {
    ...initial_scene,
    lights: [create_light({ ...area_light, tangent: vec3(0, 0, 1) })],
  };
  const initial_snapshot = path_tracing_render_scene_snapshot(
    initial_scene,
    built_in_path_tracing_geometry(),
    { width: 320, height: 180 },
    path_tracing_technique(),
  );
  const changed_snapshot = path_tracing_render_scene_snapshot(
    changed_scene,
    built_in_path_tracing_geometry(),
    { width: 320, height: 180 },
    path_tracing_technique(),
  );
  const initial = plan_path_tracing_frame(undefined, {
    ...initial_snapshot,
    camera_moving: false,
  });
  if (initial.type !== "path_traced") return;
  const changed = plan_path_tracing_frame(initial.next_history, {
    ...changed_snapshot,
    camera_moving: false,
  });

  assertEquals(changed.type, "path_traced");
  if (changed.type !== "path_traced") return;
  assertEquals(changed.acceleration, { type: "unchanged" });
  assertEquals(changed.accumulation.type, "reset");
  if (changed.accumulation.type === "reset") {
    assertEquals(changed.accumulation.reasons, ["lights"]);
  }
  assertEquals(changed.uploads, {
    blas: false,
    geometry: false,
    instances: false,
    lights: true,
    materials: false,
    triangles: false,
    tlas: false,
  });
});

function built_in_path_tracing_geometry() {
  return new Map([[
    "plane" as const,
    {
      first_vertex: 0,
      vertex_count: 3,
      vertices: new Float32Array([
        -1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        1,
        0,
        0,
        1,
        0,
        0,
        1,
        0,
        0.5,
        1,
      ]),
    },
  ]]);
}

function path_tracing_technique() {
  return {
    type: "path_traced" as const,
    samples_per_frame: 2,
    maximum_bounces: 4,
    render_scale: 1,
    denoiser: "edge_aware" as const,
  };
}

function traced_history(source: RayTracingSceneInput) {
  const frame = plan_path_tracing_frame(undefined, {
    source,
    presentation: presentation(),
    camera_moving: false,
  });
  if (frame.type !== "path_traced") {
    throw new Error("fixture path frame unexpectedly selected raster preview");
  }
  return frame.next_history;
}

function scene_source(
  surface: CanonicalMaterialRecord = material(
    "surface",
    [0.8, 0.7, 0.6],
  ),
): RayTracingSceneInput {
  const geometry = {
    id: ray_tracing_geometry_id("fixture/triangle"),
    revision: 0,
    topology: mesh_topology(
      [vec3(-1, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0)],
      [0, 1, 2],
      [vec2(0, 0), vec2(1, 0), vec2(0.5, 1)],
    ),
    vertex_normals: [vec3(0, 0, 1), vec3(0, 0, 1), vec3(0, 0, 1)],
    material: ray_tracing_material_identity(surface),
  };
  return {
    revision: ray_tracing_scene_revision(0),
    geometries: [geometry],
    instances: [{
      id: ray_tracing_instance_id("fixture/instance"),
      revision: 0,
      geometry: geometry.id,
      transform: mat4_identity(),
    }],
    materials: [surface],
    lights: [],
  };
}

function render_scene_fixture(
  surface: CanonicalMaterialRecord,
  node: ReturnType<typeof render_scene_node>,
  revision: number,
): RenderScene {
  return {
    camera: perspective_render_camera("fixture.camera", {
      position: [0, 2, 5],
      target: [0, 0, 0],
      vertical_fov_radians: 1,
      clear_color: [0, 0, 0],
    }),
    hierarchy: render_scene_hierarchy("translated", revision, [node]),
    lights: [],
    environment: {
      ambient_light: render_color([0.1, 0.1, 0.1]),
      fog_color: render_color([0, 0, 0]),
      fog_density: 0,
      exposure_ev100: 0,
      bloom_intensity: 0,
    },
    meshes: [],
    textures: [],
    objects: [{
      id: "translated-object",
      shape: "plane",
      node: render_node_id(0),
      material: surface,
    }],
  };
}

function material(
  id: string,
  color: readonly [number, number, number],
): CanonicalMaterialRecord {
  const defaults = default_pbr_parameters();
  return canonical_material_record(create_material_definition({
    id: material_definition_id(id),
    revision: 0,
    parameters: {
      ...defaults,
      base_color: linear_rgba(...color, 1),
      emissive: linear_rgb(0, 0, 0),
    },
    alpha: { type: "opaque" },
    sidedness: "double",
  }));
}

function presentation(
  overrides: Partial<{
    readonly camera_revision: number;
    readonly material_revision: number;
    readonly scene_revision: number;
    readonly transform_revision: number;
  }> = {},
) {
  return {
    scene_revision: ray_tracing_scene_revision(overrides.scene_revision ?? 0),
    transform_revision: overrides.transform_revision ?? 0,
    material_revision: overrides.material_revision ?? 0,
    light_revision: 0,
    camera_revision: overrides.camera_revision ?? 0,
    viewport: { width: 1280, height: 720 },
    exposure_revision: 0,
    fog_revision: 0,
    quality: {
      samples_per_frame: 2,
      maximum_bounces: 4,
      render_scale: 1,
      denoiser: "edge_aware" as const,
    },
  };
}

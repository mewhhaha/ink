import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  batch_scene_objects,
  create_preview_renderer,
  create_semantic_renderer,
  create_texture_mip_levels,
  preview_shader_source,
  project_model_origin,
  resolve_scene_objects,
  scene_nodes_equal,
  scene_objects_equal,
  semantic_model_view_projection,
  semantic_texture_size,
  viewport_model_view_projection,
} from "./webgpu.ts";

Deno.test("world surfaces project textures from all three world axes", () => {
  assertStringIncludes(
    preview_shader_source,
    "let x_uv = world_position.zy * texture_scale;",
  );
  assertStringIncludes(
    preview_shader_source,
    "let y_uv = world_position.xz * texture_scale;",
  );
  assertStringIncludes(
    preview_shader_source,
    "let z_uv = world_position.xy * texture_scale;",
  );
  assertStringIncludes(
    preview_shader_source,
    "texture_color = ink_sample_triplanar(",
  );
});

Deno.test("specialized surface modes retain their authored projections", () => {
  assertStringIncludes(
    preview_shader_source,
    "let world_uv = input.world_position.xy * input.texture_scale.xy;",
  );
  assertStringIncludes(preview_shader_source, "if (surface_mode == 1u)");
  assertStringIncludes(
    preview_shader_source,
    "ink_upright_decal_uv(input.local_position)",
  );
  assertStringIncludes(preview_shader_source, "if (surface_mode == 2u)");
});

const triangle_mesh = {
  vertices: new Float32Array(18),
  vertex_count: 3,
};

const base_scene_object = {
  type: "scene_object",
  id: 0,
  mesh: 0,
  parent: null,
  color: [0.36, 0.4, 0.5],
  emissive: 0,
  texture: null,
  secondary_texture: null,
  texture_scale: [1, 1],
  blend_edges: 0,
  variation_seed: 0,
  surface_mode: 0,
  path_connections: 0,
  rotation_radians: [0, 0, 0],
  position: [0, 0, 0],
  scale: [1_000_000, 1_000_000, 1_000_000],
  visible: true,
} as const;

Deno.test("texture mip levels preserve alpha-weighted colour", () => {
  const levels = create_texture_mip_levels({
    id: 0,
    width: 2,
    height: 2,
    pixels: new Uint8Array([
      200,
      100,
      50,
      255,
      0,
      0,
      0,
      0,
      100,
      50,
      25,
      255,
      0,
      0,
      0,
      0,
    ]),
  });

  assertEquals(levels.length, 2);
  assertEquals(levels[1], {
    width: 1,
    height: 1,
    pixels: new Uint8Array([150, 75, 38, 128]),
  });
});

Deno.test("perspective model projection matches the Blot semantic transform", () => {
  const [x, y] = project_model_origin(
    [-1_800_000, 0, 1_000_000],
    "perspective",
    1,
    960,
    540,
  );

  assertAlmostEquals(x, 328.8, 0.001);
  assertAlmostEquals(y, 270, 0.001);
});

Deno.test("orthographic model projection matches the Blot semantic transform", () => {
  const [x, y] = project_model_origin(
    [1_800_000, 0, 0],
    "orthographic",
    1,
    960,
    540,
  );

  assertAlmostEquals(x, 606, 0.001);
  assertAlmostEquals(y, 270, 0.001);
});

Deno.test("camera zoom scales an orthographic scene around its center", () => {
  const [x, y] = project_model_origin(
    [1_800_000, 0, 0],
    "orthographic",
    2,
    960,
    540,
  );

  assertAlmostEquals(x, 732, 0.001);
  assertAlmostEquals(y, 270, 0.001);
});

Deno.test("semantic rendering retains its degradation reason", () => {
  const renderer = create_semantic_renderer("no graphics adapter");

  assertEquals(renderer.mode, "semantic_only");
  assertEquals(renderer.adapter_description, null);
  assertEquals(renderer.unavailable_reason, "no graphics adapter");
  assertEquals(renderer.on_unavailable(() => {})(), undefined);
  assertEquals(renderer.dispose(), undefined);
});

Deno.test("preview mesh identities are unique", async () => {
  await assertRejects(
    () =>
      create_preview_renderer({} as HTMLCanvasElement, [
        { id: 4, model: triangle_mesh },
        { id: 4, model: triangle_mesh },
      ], []),
    Error,
    "preview contains duplicate mesh id 4",
  );
});

Deno.test("preview texture identities are unique", async () => {
  const texture = {
    id: 4,
    width: 1,
    height: 1,
    pixels: new Uint8Array([255, 255, 255, 255]),
  };

  await assertRejects(
    () =>
      create_preview_renderer({} as HTMLCanvasElement, [], [texture, texture]),
    Error,
    "preview contains duplicate texture id 4",
  );
});

Deno.test("semantic regions map from CSS pixels to the WebGPU texture", () => {
  const size = semantic_texture_size({
    width: 80,
    height: 32,
  }, 2);

  assertEquals(size, {
    width: 160,
    height: 64,
  });
});

Deno.test("semantic placement rotates around its attached scene object", () => {
  const placement = {
    type: "scene_object",
    object: 0,
    offset: [900_000, 0, 560_000],
    size: [1_200_000, 500_000],
  } as const;
  const before = semantic_model_view_projection(
    placement,
    base_scene_object,
    "perspective",
    1,
    960,
    540,
  );
  const after = semantic_model_view_projection(
    placement,
    { ...base_scene_object, rotation_radians: [0, Math.PI, 0] },
    "perspective",
    1,
    960,
    540,
  );
  const before_x = (before[12] / before[15] + 1) * 480;
  const after_x = (after[12] / after[15] + 1) * 480;

  assertEquals(before_x > 480, true);
  assertEquals(after_x < 480, true);
});

Deno.test("viewport placement stays inset from the upper-right corner", () => {
  const matrix = viewport_model_view_projection(
    {
      type: "viewport",
      anchor: "top_right",
      inset: [16, 16],
    },
    {
      width: 80,
      height: 32,
    },
    960,
    540,
  );

  assertAlmostEquals(matrix[12], 0.883333, 0.000001);
  assertAlmostEquals(matrix[13], 0.881481, 0.000001);
  assertAlmostEquals(matrix[0], 1 / 6, 0.000001);
  assertAlmostEquals(matrix[5], 32 / 270, 0.000001);
});

Deno.test("child scene objects inherit parent transforms and visibility", () => {
  const parent = {
    ...base_scene_object,
    position: [1_000_000, 0, 0],
    visible: false,
  } as const;
  const child = {
    ...base_scene_object,
    id: 1,
    parent: 0,
    position: [2_000_000, 0, 0],
  } as const;

  const resolved = resolve_scene_objects([parent, child]).get(1);

  assertAlmostEquals(resolved?.model[12] ?? 0, 3);
  assertEquals(resolved?.visible, false);
});

Deno.test("renderable objects inherit generic scene-node transforms", () => {
  const group = {
    type: "scene_node",
    id: 10,
    parent: null,
    rotation_radians: [0, 0, 0],
    position: [1_000_000, 0, 0],
    scale: [1_000_000, 1_000_000, 1_000_000],
    visible: false,
  } as const;
  const child = {
    ...base_scene_object,
    id: 11,
    parent: 10,
    position: [2_000_000, 0, 0],
  } as const;

  const resolved = resolve_scene_objects([child], [group]).get(11);

  assertAlmostEquals(resolved?.model[12] ?? 0, 3);
  assertEquals(resolved?.visible, false);
  assertEquals(scene_nodes_equal([group], [{ ...group }]), true);
  assertEquals(
    scene_nodes_equal([group], [{ ...group, visible: true }]),
    false,
  );
});

Deno.test("compatible visible scene objects share an instance batch", () => {
  const objects = [
    { ...base_scene_object, id: 0, texture: 4 },
    { ...base_scene_object, id: 1, texture: 4, surface_mode: 1 },
    { ...base_scene_object, id: 2, texture: 5 },
    { ...base_scene_object, id: 3, texture: 4, visible: false },
  ] as const;

  const batches = batch_scene_objects(objects, resolve_scene_objects(objects));

  assertEquals(
    batches.map((batch) =>
      batch.instances.map((instance) => instance.object.id)
    ),
    [[0, 1], [2]],
  );
});

Deno.test("scene object preparation changes only when render values change", () => {
  assertEquals(
    scene_objects_equal([base_scene_object], [{ ...base_scene_object }]),
    true,
  );
  assertEquals(
    scene_objects_equal([base_scene_object], [{
      ...base_scene_object,
      texture_scale: [0.5, 1],
    }]),
    false,
  );
});

Deno.test("a missing scene parent identifies both object ids", () => {
  assertThrows(
    () =>
      resolve_scene_objects([{
        ...base_scene_object,
        id: 4,
        parent: 9,
      }]),
    Error,
    "preview scene is invalid: scene node 4:0 has unknown parent 9:0",
  );
});

Deno.test("a scene parent cycle reports its path", () => {
  assertThrows(
    () =>
      resolve_scene_objects([
        { ...base_scene_object, id: 1, parent: 2 },
        { ...base_scene_object, id: 2, parent: 1 },
      ]),
    Error,
    "preview scene is invalid: scene hierarchy cycle is 1:0 -> 2:0 -> 1:0",
  );
});

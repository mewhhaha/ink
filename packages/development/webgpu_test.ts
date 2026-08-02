import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  create_preview_renderer,
  create_semantic_renderer,
  project_model_origin,
  resolve_scene_objects,
  semantic_model_view_projection,
  semantic_texture_size,
} from "./webgpu.ts";

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
  rotation_radians: [0, 0, 0],
  position: [0, 0, 0],
  scale: [1_000_000, 1_000_000, 1_000_000],
  visible: true,
} as const;

Deno.test("perspective model projection matches the Blot semantic transform", () => {
  const [x, y] = project_model_origin(
    [-1_800_000, 0, 1_000_000],
    "perspective",
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
    960,
    540,
  );

  assertAlmostEquals(x, 606, 0.001);
  assertAlmostEquals(y, 270, 0.001);
});

Deno.test("semantic rendering retains its degradation reason", () => {
  const renderer = create_semantic_renderer("no graphics adapter");

  assertEquals(renderer.mode, "semantic_only");
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
      ]),
    Error,
    "preview contains duplicate mesh id 4",
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
    960,
    540,
  );
  const after = semantic_model_view_projection(
    placement,
    { ...base_scene_object, rotation_radians: [0, Math.PI, 0] },
    "perspective",
    960,
    540,
  );
  const before_x = (before[12] / before[15] + 1) * 480;
  const after_x = (after[12] / after[15] + 1) * 480;

  assertEquals(before_x > 480, true);
  assertEquals(after_x < 480, true);
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

Deno.test("a missing scene parent identifies both object ids", () => {
  assertThrows(
    () =>
      resolve_scene_objects([{
        ...base_scene_object,
        id: 4,
        parent: 9,
      }]),
    Error,
    "scene object 4 has missing parent 9",
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
    "scene object parent cycle: 1 -> 2 -> 1",
  );
});

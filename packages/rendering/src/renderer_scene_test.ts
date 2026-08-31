import { assertEquals, assertThrows } from "@std/assert";
import { build_camera_frame } from "@ink/camera/view.ts";
import { visibility_id } from "@ink/visibility/model.ts";
import { path_tracing_render_scene_snapshot } from "./path_tracing.ts";
import {
  perspective_render_camera,
  pick_render_scene,
  render_color,
  render_material,
  render_mesh_id,
  render_node_id,
  render_scene_hierarchy,
  render_scene_node,
  render_texture_id,
  type RenderObject,
  type RenderScene,
  select_raster_scene,
  validate_render_scene,
} from "./renderer.ts";

const node = render_scene_node(0, {
  position: [0, 0, 0],
  rotation: { type: "y_axis", radians: 0 },
  scale: [1, 1, 1],
});
const material = render_material("fixture/plinth", {
  albedo: [0.5, 0.5, 0.5],
  emissive: [0, 0, 0],
  metallic: 0,
  roughness: 0.5,
});

Deno.test("render scenes reject duplicate object identities", () => {
  const object: RenderObject = {
    id: "plinth",
    shape: "cube",
    node: render_node_id(0),
    material,
  };
  const scene = fixture_scene([object, object]);

  assertThrows(
    () => validate_render_scene(scene),
    Error,
    'repeats object id "plinth"',
  );
});

Deno.test("render scenes reject objects that select a missing imported mesh", () => {
  const scene = fixture_scene([{
    id: "missing-statue",
    shape: "mesh",
    mesh: render_mesh_id("statue"),
    node: render_node_id(0),
    material,
  }]);

  assertThrows(
    () => validate_render_scene(scene),
    Error,
    'selects missing mesh "statue"',
  );
});

Deno.test("render materials own canonical texture bindings", () => {
  const base_color_texture = render_texture_id("fixture/base-color");
  const normal_texture = render_texture_id("fixture/normal");
  const textured = render_material("fixture/textured", {
    albedo: [1, 1, 1],
    base_color_texture,
    emissive: [0, 0, 0],
    metallic: 0,
    normal_texture,
    roughness: 0.5,
  });

  assertEquals(
    textured.textures.map(({ semantic, texture }) => ({ semantic, texture })),
    [
      { semantic: "base_color", texture: base_color_texture },
      { semantic: "normal", texture: normal_texture },
    ],
  );
});

Deno.test("render picking retains the nearest visible object identity", () => {
  const scene = fixture_scene([{
    id: "plinth",
    shape: "cube",
    node: render_node_id(0),
    material,
  }]);

  const hit = pick_render_scene(scene, {
    x: 50,
    y: 50,
    width: 100,
    height: 100,
  });
  assertEquals(hit.type, "hit");
  if (hit.type === "hit") assertEquals(hit.object_id, "plinth");
  assertEquals(
    pick_render_scene(scene, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    }),
    { type: "miss" },
  );
});

Deno.test("raster selection rejects off-camera and subpixel objects and selects the authored LOD", () => {
  const scene: RenderScene = {
    ...fixture_scene([]),
    hierarchy: render_scene_hierarchy("visibility", 2, [
      node,
      render_scene_node(1, {
        position: [100, 0, 0],
        rotation: { type: "y_axis", radians: 0 },
        scale: [1, 1, 1],
      }),
      render_scene_node(2, {
        position: [0, 0, -80],
        rotation: { type: "y_axis", radians: 0 },
        scale: [0.01, 0.01, 0.01],
      }),
      render_scene_node(3, {
        position: [0, 0, -25],
        rotation: { type: "y_axis", radians: 0 },
        scale: [1, 1, 1],
      }),
    ]),
    objects: [
      {
        id: "visible",
        shape: "cube",
        node: render_node_id(0),
        material,
      },
      {
        id: "off-camera",
        shape: "cube",
        node: render_node_id(1),
        material,
      },
      {
        id: "subpixel",
        shape: "sphere",
        node: render_node_id(2),
        material,
        raster_visibility: {
          id: visibility_id("fixture/subpixel"),
          minimum_projected_pixels: 2,
        },
      },
      {
        id: "lod-object",
        shape: "sphere",
        node: render_node_id(3),
        material,
        raster_visibility: {
          id: visibility_id("fixture/lod-object"),
          lods: [
            {
              id: "detailed",
              minimum_projected_pixels: 100,
              geometry: { shape: "sphere" },
            },
            {
              id: "distant",
              minimum_projected_pixels: 0,
              geometry: { shape: "cube" },
            },
          ],
        },
      },
    ],
  };

  assertEquals(select_raster_scene(scene, fixture_view(scene)), {
    submitted: [
      { object_id: "lod-object", lod: "distant" },
      { object_id: "visible", lod: "source" },
    ],
    rejected: [
      { object_id: "subpixel", reason: "projected_size" },
      { object_id: "off-camera", reason: "frustum" },
    ],
  });
});

Deno.test("path scene extraction retains geometry rejected by raster visibility", () => {
  const scene: RenderScene = {
    ...fixture_scene([]),
    hierarchy: render_scene_hierarchy("reflected", 0, [
      node,
      render_scene_node(1, {
        position: [100, 0, 0],
        rotation: { type: "y_axis", radians: 0 },
        scale: [1, 1, 1],
      }),
    ]),
    objects: [
      {
        id: "camera-visible",
        shape: "plane",
        node: render_node_id(0),
        material,
      },
      {
        id: "reflection-only",
        shape: "plane",
        node: render_node_id(1),
        material,
      },
    ],
  };
  const raster = select_raster_scene(scene, fixture_view(scene));
  const path = path_tracing_render_scene_snapshot(
    scene,
    new Map([["plane", {
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
        0,
        1,
        0,
        1,
        0,
        0.5,
        1,
      ]),
    }]]),
    { width: 100, height: 100 },
    {
      type: "path_traced",
      samples_per_frame: 1,
      maximum_bounces: 2,
      render_scale: 1,
      denoiser: "edge_aware",
    },
  );

  assertEquals(raster.rejected, [{
    object_id: "reflection-only",
    reason: "frustum",
  }]);
  assertEquals(
    path.instance_objects.map(({ object_id }) => object_id),
    ["camera-visible", "reflection-only"],
  );
});

function fixture_scene(objects: readonly RenderObject[]): RenderScene {
  return {
    camera: perspective_render_camera("fixture.camera", {
      position: [0, 2, 5],
      target: [0, 0, 0],
      vertical_fov_radians: 1,
      clear_color: [0, 0, 0],
    }),
    hierarchy: render_scene_hierarchy("fixture", 0, [node]),
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
    objects,
  };
}

function fixture_view(scene: RenderScene) {
  const result = build_camera_frame({
    camera: scene.camera,
    surface: { width: 100, height: 100 },
    frame_index: 0,
    jitter_scale_pixels: 0,
  });
  if (result.type !== "ready") throw new Error(result.reason);
  return result.frame.view;
}

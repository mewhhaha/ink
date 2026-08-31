import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import type { RenderSnapshot } from "@ink/blot/protocol.ts";
import { validate_render_scene } from "@ink/rendering/renderer.ts";
import { visual_novel_scene } from "./stage.tsx";

const snapshot: RenderSnapshot = {
  camera: {
    type: "perspective",
    position: [1.2, 4.5, 9.1],
    target: [0.2, 1.1, -0.4],
    clear_color: [0.02, 0.03, 0.04],
    vertical_fov_radians: 0.81,
  },
  directional_light: {
    type: "directional_light",
    color: [0.42, 0.55, 1],
    direction: [-0.35, -1, -0.22],
    intensity: 1.35,
  },
  environment: {
    ambient_light: [0.13, 0.17, 0.22],
    fog_color: [0.04, 0.05, 0.08],
    fog_density: 0.027,
    exposure_ev100: 0.55,
    bloom_intensity: 0.41,
  },
  nodes: [],
  resources: [],
  objects: [{
    type: "scene_object",
    id: 4,
    mesh: 1,
    parent: null,
    color: [0.2, 1, 0.4],
    emissive: 7,
    texture: null,
    texture_offset: [0, 0],
    secondary_texture: null,
    texture_scale: [1, 1],
    blend_edges: 0,
    variation_seed: 0,
    surface_mode: 0,
    path_connections: 0,
    rotation_radians: [0, 0, 0],
    position: [5_500_000, 2_800_000, -1_000_000],
    scale: [250_000, 250_000, 250_000],
    visible: true,
  }],
};

Deno.test("visual novel scenes follow Blot camera, light, and object output", () => {
  const scene = visual_novel_scene(snapshot, 3);
  validate_render_scene(scene);

  assertEquals(scene.camera.projection.type, "perspective");
  if (scene.camera.projection.type === "perspective") {
    assertAlmostEquals(scene.camera.projection.vertical_fov_radians, 0.81);
  }
  assertEquals(
    [
      scene.camera.pose.position.x,
      scene.camera.pose.position.y,
      scene.camera.pose.position.z,
    ],
    [1.2, 4.5, 9.1],
  );
  assertEquals(scene.camera.clear, {
    type: "color",
    color: [0.02, 0.03, 0.04, 1],
  });
  assertEquals(scene.environment.fog_density, 0.027);
  assertEquals(scene.environment.exposure_ev100, 0.55);
  assertEquals(scene.environment.bloom_intensity, 0.41);
  assertEquals(scene.hierarchy.revision, 3);
  assertEquals(scene.lights[0]?.type, "directional");
  assertEquals(scene.objects[0]?.shape, "sphere");
  const emissive = emissive_channels(scene, "visual-novel-object-4");
  assertEquals(emissive?.length, 3);
  assertAlmostEquals(emissive?.[0] ?? -1, 1.4);
  assertAlmostEquals(emissive?.[1] ?? -1, 7);
  assertAlmostEquals(emissive?.[2] ?? -1, 2.8);
});

Deno.test("visual novel scenes reject undeclared built-in mesh ids", () => {
  assertThrows(
    () =>
      visual_novel_scene({
        ...snapshot,
        objects: [{ ...snapshot.objects[0], mesh: 9 }],
      }, 0),
    Error,
    "visual novel object 4 selects unsupported built-in mesh 9",
  );
});

function emissive_channels(
  scene: ReturnType<typeof visual_novel_scene>,
  object_id: string,
): readonly number[] | undefined {
  const emissive = scene.objects.find(({ id }) => id === object_id)?.material
    .parameters.emissive;
  return emissive === undefined
    ? undefined
    : [emissive.r, emissive.g, emissive.b];
}

import { assertEquals } from "@std/assert";
import { parse_static_glb_scene } from "@ink/assets/gltf_model.ts";
import { validate_simple3d_scene } from "@ink/rendering/simple3d.ts";
import { lighting_scene } from "./scene.ts";

Deno.test("lighting lab renders the Bevy model through every light and material path", async () => {
  const model = parse_static_glb_scene(
    await Deno.readFile(
      new URL("../assets/bevy/VolumetricFogExample.glb", import.meta.url),
    ),
    "VolumetricFogExample.glb",
  );
  const scene = lighting_scene(0, model);
  validate_simple3d_scene(scene);

  assertEquals(scene.meshes.length, 1);
  assertEquals(model.texture_reference_count, 1);
  assertEquals(scene.point_lights.length, 4);
  assertEquals(scene.spot_lights.length, 2);
  assertEquals(
    scene.objects.some(({ material }) => material.metallic === 1),
    true,
  );
  assertEquals(
    scene.objects.some(({ material }) =>
      material.emissive.some((channel) => channel > 1)
    ),
    true,
  );
});

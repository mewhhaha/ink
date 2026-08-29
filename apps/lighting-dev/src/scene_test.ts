import { assertEquals } from "@std/assert";
import { validate_simple3d_scene } from "@ink/rendering/simple3d.ts";
import { lighting_scene } from "./scene.ts";

Deno.test("lighting lab exercises every supported light and material path", () => {
  const scene = lighting_scene(0);
  validate_simple3d_scene(scene);

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

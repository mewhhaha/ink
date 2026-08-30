import { assertEquals } from "@std/assert";
import { parse_static_glb_scene } from "@ink/assets/gltf_model.ts";
import { validate_simple3d_scene } from "@ink/rendering/simple3d.ts";
import {
  lighting_scene,
  prepare_lighting_reference,
  reference_presentations,
  reference_texture_id,
} from "./scene.ts";

Deno.test("lighting lab renders the Bevy model through every light and material path", async () => {
  const model = parse_static_glb_scene(
    await Deno.readFile(
      new URL("../assets/bevy/VolumetricFogExample.glb", import.meta.url),
    ),
    "VolumetricFogExample.glb",
  );
  const source = await createImageBitmap(
    new Blob([model.textures[0].bytes.slice().buffer], {
      type: model.textures[0].mime_type,
    }),
  );
  try {
    const reference = prepare_lighting_reference(model, "fog-room", [{
      color_space: "linear",
      id: reference_texture_id(model.textures[0].id, "normal"),
      source,
    }]);
    const presentation = reference_presentations["fog-room"];
    const scene = lighting_scene(
      0,
      reference,
      presentation.camera,
      presentation.settings,
    );
    validate_simple3d_scene(scene);

    assertEquals(scene.meshes.length, 1);
    assertEquals(model.texture_reference_count, 1);
    assertEquals(scene.meshes[0].normal_texture, reference.textures[0].id);
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
  } finally {
    source.close();
  }
});

Deno.test("Bistro lighting ignores imported emissive materials and retains its sun", async () => {
  const parsed = parse_static_glb_scene(
    await Deno.readFile(
      new URL("../assets/bevy/VolumetricFogExample.glb", import.meta.url),
    ),
    "VolumetricFogExample.glb",
  );
  const mesh = parsed.meshes[0];
  const reference = prepare_lighting_reference(
    {
      meshes: [{
        id: mesh.id,
        indices: mesh.indices,
        material: {
          albedo: [0.8, 0.7, 0.6],
          emissive: [4, 3, 2],
          metallic: 0,
          roughness: 0.7,
        },
        vertices: mesh.vertices,
      }],
      source: "emissive-bistro.glb",
      textures: [],
      texture_reference_count: 0,
    },
    "bistro",
    [],
  );
  const presentation = reference_presentations.bistro;
  const scene = lighting_scene(
    0,
    reference,
    presentation.camera,
    presentation.settings,
  );

  assertEquals(scene.objects[0].material.emissive, [0, 0, 0]);
  assertEquals(scene.directional_light.intensity > 0, true);
});

import { assertEquals } from "@std/assert";
import type { ArtifactReader } from "@ink/assets/load.ts";
import {
  pick_render_scene,
  validate_render_scene,
} from "@ink/rendering/renderer.ts";
import { LightingReferenceAssets } from "./reference_assets.ts";
import {
  lighting_scene,
  prepare_lighting_reference,
  reference_presentations,
  reference_texture_id,
} from "./scene.ts";
import path_tracing_regions from "./browser/path_tracing_regions.json" with {
  type: "json",
};

const generated_public_root = new URL("../generated/public/", import.meta.url);
const generated_reference_reader: ArtifactReader = {
  async read(location): Promise<Uint8Array> {
    const relative_location = location.startsWith("/")
      ? location.slice(1)
      : location;
    return await Deno.readFile(
      new URL(relative_location, generated_public_root),
    );
  },
};

Deno.test("lighting lab renders the Bevy model through every light and material path", async () => {
  const references = await LightingReferenceAssets.create(
    generated_reference_reader,
  );
  const { scene: model } = await references.load("fog-room");
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
      "authored",
      "authored",
    );
    validate_render_scene(scene);

    assertEquals(scene.meshes.length, 1);
    assertEquals(reference.triangle_count, 360);
    assertEquals(model.texture_reference_count, 1);
    assertEquals(
      scene.objects[0].material.textures.find(({ semantic }) =>
        semantic === "normal"
      )?.texture,
      reference.textures[0].id,
    );
    assertEquals(
      scene.lights.filter(({ type }) => type === "point").length,
      4,
    );
    assertEquals(
      scene.lights.filter(({ type }) => type === "spot").length,
      2,
    );
    assertEquals(
      scene.lights.filter(({ type }) => type === "rectangular").length,
      1,
    );
    assertEquals(
      [
        presentation.camera.pose.position.x,
        presentation.camera.pose.position.y,
        presentation.camera.pose.position.z,
      ],
      [0.25, 1.45, 5.5],
    );
    assertEquals(presentation.camera_target, [0.25, 0.59, 2.25]);
    assertEquals(
      scene.objects.slice(-5).map(({ id }) => id),
      [
        "material-stage",
        "rough-stone",
        "glazed-ceramic",
        "polished-brass",
        "emissive-lamp",
      ],
    );
    for (
      const [x, y, expected_object] of [
        [480, 180, "emissive-lamp"],
        [180, 360, "rough-stone"],
        [480, 360, "glazed-ceramic"],
        [750, 360, "polished-brass"],
        [480, 500, "material-stage"],
        [30, 60, "fog-room-surface-0"],
      ] as const
    ) {
      const pick = pick_render_scene(scene, {
        x,
        y,
        width: 960,
        height: 720,
      });
      if (pick.type !== "hit") {
        throw new Error(
          `Fog proof pick ${x},${y} missed ${expected_object}`,
        );
      }
      assertEquals(pick.object_id, expected_object);
    }
    const normal_region = path_tracing_regions.fog.normal_detail;
    const minimum_x = Math.floor(normal_region.x * 960);
    const minimum_y = Math.floor(normal_region.y * 720);
    const maximum_x = Math.ceil(
      (normal_region.x + normal_region.width) * 960,
    );
    const maximum_y = Math.ceil(
      (normal_region.y + normal_region.height) * 720,
    );
    const sampled_x = new Set([minimum_x, maximum_x - 1]);
    const sampled_y = new Set([minimum_y, maximum_y - 1]);
    for (let x = minimum_x; x < maximum_x; x += 4) sampled_x.add(x);
    for (let y = minimum_y; y < maximum_y; y += 4) sampled_y.add(y);
    const normal_region_composition = new Map<string, number>();
    for (const y of sampled_y) {
      for (const x of sampled_x) {
        const pick = pick_render_scene(scene, {
          x,
          y,
          width: 960,
          height: 720,
        });
        const object_id = pick.type === "hit" ? pick.object_id : "miss";
        normal_region_composition.set(
          object_id,
          (normal_region_composition.get(object_id) ?? 0) + 1,
        );
      }
    }
    assertEquals(
      Object.fromEntries(normal_region_composition),
      { "fog-room-surface-0": sampled_x.size * sampled_y.size },
      "Fog normal-detail proof grid must stay entirely on the loaded mesh",
    );
    assertEquals(
      scene.objects.some(({ material }) => material.parameters.metallic === 1),
      true,
    );
    const diffuse_control = lighting_scene(
      0,
      reference,
      presentation.camera,
      presentation.settings,
      "diffuse_control",
      "authored",
    );
    for (const object_id of ["glazed-ceramic", "polished-brass"]) {
      const authored = scene.objects.find(({ id }) => id === object_id);
      const diffuse = diffuse_control.objects.find(({ id }) =>
        id === object_id
      );
      assertEquals(
        authored?.material.parameters.base_color,
        diffuse?.material.parameters.base_color,
      );
      assertEquals(diffuse?.material.parameters.metallic, 0);
      assertEquals(diffuse?.material.parameters.perceptual_roughness, 1);
    }
    const flat_normal_control = lighting_scene(
      0,
      reference,
      presentation.camera,
      presentation.settings,
      "authored",
      "flat_control",
    );
    assertEquals(
      flat_normal_control.objects[0].material.parameters,
      scene.objects[0].material.parameters,
    );
    assertEquals(
      flat_normal_control.objects[0].material.textures,
      scene.objects[0].material.textures.filter(({ semantic }) =>
        semantic !== "normal"
      ),
    );
    assertEquals(
      scene.objects.some(({ material }) =>
        Object.values(material.parameters.emissive).some((channel) =>
          channel > 1
        )
      ),
      true,
    );
  } finally {
    source.close();
  }
});

Deno.test("Bistro lighting ignores imported emissive materials and retains its sun", async () => {
  const references = await LightingReferenceAssets.create(
    generated_reference_reader,
  );
  const { scene: parsed } = await references.load("fog-room");
  const mesh = parsed.meshes[0];
  const reference = prepare_lighting_reference(
    {
      meshes: [{
        id: mesh.id,
        indices: mesh.indices,
        material: {
          albedo: [0.8, 0.7, 0.6],
          emissive: [4, 3, 2],
          metallic: 1,
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
    "authored",
    "authored",
  );

  const emissive = scene.objects[0].material.parameters.emissive;
  assertEquals([emissive.r, emissive.g, emissive.b], [0, 0, 0]);
  assertEquals(scene.objects[0].material.parameters.metallic, 0);
  assertEquals(
    scene.lights.some((light) =>
      light.type === "directional" && light.illuminance_lux > 0
    ),
    true,
  );
});

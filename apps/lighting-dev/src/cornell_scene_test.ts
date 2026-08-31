import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  pick_render_scene,
  validate_render_scene,
} from "@ink/rendering/renderer.ts";
import {
  cornell_camera,
  cornell_dimensions,
  cornell_emitter_bounds,
  cornell_scene,
} from "./cornell_scene.ts";
import path_tracing_regions from "./browser/path_tracing_regions.json" with {
  type: "json",
};

const proof_viewport = { width: 960, height: 720 };

Deno.test("Cornell room uses the published meter-scale box, camera, walls, and emitter", () => {
  const scene = cornell_scene();
  validate_render_scene(scene);

  assertEquals(cornell_dimensions, {
    width: 0.5528,
    height: 0.5488,
    depth: 0.5592,
  });
  assertEquals(
    [
      cornell_camera.pose.position.x,
      cornell_camera.pose.position.y,
      cornell_camera.pose.position.z,
    ],
    [0.278, 0.273, -0.8],
  );
  assertEquals(cornell_emitter_bounds, {
    minimum_x: 0.213,
    maximum_x: 0.343,
    y: 0.5488,
    minimum_z: 0.227,
    maximum_z: 0.332,
  });
  const emitter = scene.meshes.find(({ id }) => id === "cornell/emitter");
  assert(emitter !== undefined);
  const expected_vertices = [
    [0.213, 0.5488, 0.227],
    [0.343, 0.5488, 0.227],
    [0.343, 0.5488, 0.332],
    [0.213, 0.5488, 0.332],
  ];
  for (const [index, expected] of expected_vertices.entries()) {
    for (const [component, value] of expected.entries()) {
      assertAlmostEquals(emitter.vertices[index * 8 + component], value);
    }
  }
  const light = scene.lights.find(({ type }) => type === "rectangular");
  assert(light?.type === "rectangular");
  assertAlmostEquals(light.size.x, 0.13);
  assertAlmostEquals(light.size.y, 0.105);
  assertEquals(
    [light.normal.x, light.normal.y, light.normal.z],
    [0, -1, 0],
  );

  const green_wall = scene.objects.find(({ id }) =>
    id === "cornell.wall.green-right"
  );
  const red_wall = scene.objects.find(({ id }) =>
    id === "cornell.wall.red-left"
  );
  assert(green_wall !== undefined);
  assert(red_wall !== undefined);
  assertEquals(
    scene.hierarchy.nodes[green_wall.node.index].local_transform.position.x,
    0,
  );
  assertEquals(
    scene.hierarchy.nodes[red_wall.node.index].local_transform.position.x,
    cornell_dimensions.width,
  );
});

Deno.test("Cornell room retains mirror-only geometry outside the camera-facing box", () => {
  const scene = cornell_scene();
  const mirror = scene.objects.find(({ id }) => id === "cornell.mirror");
  const hidden = scene.objects.find(({ id }) =>
    id === "cornell.mirror-only-object"
  );
  assert(mirror !== undefined);
  assert(hidden !== undefined);
  assertEquals(mirror.material.parameters.metallic, 1);
  assertEquals(mirror.material.parameters.perceptual_roughness, 0);
  const hidden_node = scene.hierarchy.nodes.find(({ id }) =>
    id.index === hidden.node.index && id.generation === hidden.node.generation
  );
  assert(hidden_node !== undefined);
  assert(
    hidden_node.local_transform.position.z < cornell_camera.pose.position.z,
  );

  const first_pick = pick_render_scene(scene, {
    x: 480,
    y: 360,
    width: 960,
    height: 720,
  });
  const second_pick = pick_render_scene(scene, {
    x: 480,
    y: 360,
    width: 960,
    height: 720,
  });
  assertEquals(first_pick, second_pick);
  assertEquals(first_pick.type, "hit");
  if (first_pick.type === "hit") {
    assertEquals(first_pick.object_id, "cornell.mirror");
  }
});

Deno.test("Cornell proof pick grids stay on neutral color-bleed and penumbra receivers", () => {
  const scene = cornell_scene();
  const expected_receivers = {
    indirect_shadow: "cornell.wall.floor",
    lit_floor: "cornell.wall.floor",
    neutral_green_back: "cornell.wall.back",
    neutral_green_floor: "cornell.wall.floor",
    neutral_red_back: "cornell.wall.back",
    neutral_red_floor: "cornell.wall.floor",
    penumbra_core: "cornell.wall.floor",
    penumbra_edge: "cornell.wall.floor",
  } as const;

  for (
    const name of Object.keys(
      expected_receivers,
    ) as readonly (keyof typeof expected_receivers)[]
  ) {
    const expected_receiver = expected_receivers[name];
    const region = path_tracing_regions.cornell[name];
    const minimum_x = Math.floor(region.x * proof_viewport.width);
    const minimum_y = Math.floor(region.y * proof_viewport.height);
    const maximum_x = Math.ceil(
      (region.x + region.width) * proof_viewport.width,
    );
    const maximum_y = Math.ceil(
      (region.y + region.height) * proof_viewport.height,
    );
    const sampled_x = new Set([minimum_x, maximum_x - 1]);
    const sampled_y = new Set([minimum_y, maximum_y - 1]);
    for (let x = minimum_x; x < maximum_x; x += 3) sampled_x.add(x);
    for (let y = minimum_y; y < maximum_y; y += 3) sampled_y.add(y);
    const composition = new Map<string, number>();
    for (const y of sampled_y) {
      for (const x of sampled_x) {
        const pick = pick_render_scene(scene, { ...proof_viewport, x, y });
        const object_id = pick.type === "hit" ? pick.object_id : "miss";
        composition.set(object_id, (composition.get(object_id) ?? 0) + 1);
      }
    }
    assertEquals(
      Object.fromEntries(composition),
      {
        [expected_receiver]: sampled_x.size * sampled_y.size,
      },
      `${name} must sample only ${expected_receiver}`,
    );
  }

  for (const object_id of ["cornell.wall.floor", "cornell.wall.back"]) {
    const receiver = scene.objects.find(({ id }) => id === object_id);
    assert(receiver !== undefined);
    const base_color = receiver.material.parameters.base_color;
    assertEquals(
      [base_color.r, base_color.g, base_color.b, base_color.a],
      [0.725, 0.71, 0.68, 1],
    );
    assertEquals(receiver.material.parameters.metallic, 0);
  }
});

import { assertEquals } from "@std/assert";
import { load_isometric_city } from "../src/wasm_game.ts";

async function load_city() {
  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(
      new URL("../generated/isometric_city.wasm", import.meta.url),
    ),
    Deno.readTextFile(
      new URL("../generated/isometric_city.wasm.json", import.meta.url),
    ),
  ]);
  return await load_isometric_city(wasm_bytes, manifest_source);
}

Deno.test("the city map exposes large textured districts", async () => {
  const session = await load_city();

  const initial = session.describe();
  const districts = initial.regions.filter((region) =>
    region.id.startsWith("city-district-")
  );
  assertEquals(initial.projection, "orthographic");
  assertEquals(initial.regions.length, 18);
  assertEquals(districts.length, 16);
  assertEquals(districts.every((region) => region.role === "text"), true);
  assertEquals(
    districts.map((region) => region.order),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assertEquals(districts[0].label, "District 1,1");
  assertEquals(districts[15].label, "District 4,4");
  assertEquals(
    initial.regions.find((region) => region.id === "city-immigration-entrance")
      ?.label,
    "Immigration entrance",
  );
  assertEquals(initial.actions, [
    {
      id: "city-tool-path",
      label: "Path",
      action: { type: "custom", kind: 10, target: 1, value: 1 },
    },
    {
      id: "city-tool-plot",
      label: "Housing plot",
      action: { type: "custom", kind: 10, target: 2, value: 0 },
    },
    {
      id: "city-tool-well",
      label: "Well",
      action: { type: "custom", kind: 10, target: 4, value: 0 },
    },
    {
      id: "city-tool-marshal",
      label: "Fire marshal post",
      action: { type: "custom", kind: 10, target: 6, value: 0 },
    },
    {
      id: "city-paint-tile",
      label: "Place the selected building on a map tile",
      action: { type: "custom", kind: 11, target: 0, value: 0 },
    },
  ]);
  assertEquals(initial.status, {
    done: false,
    label: "Map",
    value: "Population 0; active fires 0",
  });

  const snapshot = session.render();
  const ground = snapshot.objects.filter((object) => object.mesh === 0);
  assertEquals(
    ground.map((object) => object.id),
    Array.from({ length: 1_024 }, (_, index) => index),
  );
  assertEquals(ground.filter((object) => object.texture === 0).length, 717);
  assertEquals(ground.filter((object) => object.texture === 1).length, 307);
  assertEquals(ground.filter((object) => object.blend_edges !== 0).length, 131);
  assertEquals(
    ground.every((object) =>
      object.color[0] === 1 && object.color[1] === 1 &&
      object.color[2] === 1 && object.secondary_texture === 1 &&
      object.texture_scale[0] === 0.35 && object.texture_scale[1] === 0.35 &&
      object.surface_mode === 0 && object.path_connections === 0
    ),
    true,
  );
  assertEquals(ground[0].position, [0, -11_160_000, 0]);
  assertEquals(ground[1_023].position, [0, 11_160_000, 0]);

  const roads = snapshot.objects.filter((object) =>
    object.mesh === 1 && object.id < 4000
  );
  assertEquals(roads.length, 46);
  assertEquals(
    roads.every((object) =>
      object.texture === 2 && object.surface_mode === 1 &&
      object.path_connections >= 0 && object.path_connections <= 15
    ),
    true,
  );

  const terrain_details = snapshot.objects.filter((object) =>
    object.mesh === 2 && object.id < 5000
  );
  assertEquals(terrain_details.length, 53);
  assertEquals(
    [3, 4, 5, 6, 7].map((texture) =>
      terrain_details.filter((object) => object.texture === texture).length
    ),
    [14, 10, 11, 9, 9],
  );
  assertEquals(
    terrain_details.every((object) =>
      object.surface_mode === 2 && object.path_connections === 0
    ),
    true,
  );

  assertEquals(snapshot.resources, [
    { type: "mesh", id: 0, url: "/assets/terrain.obj" },
    { type: "mesh", id: 1, url: "/assets/path-tile.obj" },
    { type: "mesh", id: 2, url: "/assets/terrain-detail.obj" },
    { type: "texture", id: 0, url: "/assets/terrain-grass.webp" },
    { type: "texture", id: 1, url: "/assets/terrain-sand.webp" },
    { type: "texture", id: 2, url: "/assets/terrain-road.webp" },
    { type: "texture", id: 3, url: "/assets/terrain-detail-bushes.png" },
    { type: "texture", id: 4, url: "/assets/terrain-detail-rocks.png" },
    {
      type: "texture",
      id: 5,
      url: "/assets/terrain-detail-meadow-v2.png",
    },
    {
      type: "texture",
      id: 6,
      url: "/assets/terrain-detail-shrub-v2.png",
    },
    {
      type: "texture",
      id: 7,
      url: "/assets/terrain-detail-grove-v2.png",
    },
    { type: "texture", id: 8, url: "/assets/tent-placeholder.png" },
  ]);
  assertEquals(snapshot.directional_light, {
    type: "directional_light",
    color: [1, 0.95, 0.78],
    direction: [-0.3, -0.5, -1],
    intensity: 0.9,
  });
  assertEquals(snapshot.camera_zoom, 0.25);

  await session.step({ type: "custom", kind: 11, target: 1_024, value: 0 });
  assertEquals(
    session.render().objects.filter((object) =>
      object.id >= 4_000 && object.id < 5_024 && object.visible
    ).map((object) => object.id),
    [4_512],
  );

  await session.step({ type: "custom", kind: 10, target: 2, value: 0 });
  await session.step({ type: "custom", kind: 11, target: 514, value: 0 });
  for (let tick = 0; tick < 5; tick += 1) {
    await session.step({ type: "frame" }, 500_000);
  }
  assertEquals(session.describe().status.value, "Population 1; active fires 0");
  assertEquals(
    session.render().objects.filter((object) =>
      object.id >= 6_048 && object.id < 7_072 && object.visible
    ).map((object) => object.id),
    [6_562],
  );

  await session.step({ type: "custom", kind: 10, target: 4, value: 0 });
  await session.step({ type: "custom", kind: 11, target: 515, value: 0 });
  await session.step({ type: "frame" }, 500_000);
  const supplied_residence = session.render();
  assertEquals(
    supplied_residence.objects.filter((object) =>
      object.id >= 7_072 && object.id < 8_096 && object.visible
    ).map((object) => object.id),
    [7_587],
  );
  assertEquals(
    supplied_residence.objects.filter((object) =>
      object.id >= 8_096 && object.id < 9_120 && object.visible
    ).map((object) => object.id),
    [8_610],
  );

  for (let tick = 0; tick < 7; tick += 1) {
    await session.step({ type: "frame" }, 500_000);
  }
  assertEquals(session.describe().status.value, "Population 1; active fires 1");
  assertEquals(
    session.render().objects.filter((object) =>
      object.id >= 10_144 && object.id < 11_168 && object.visible
    ).map((object) => object.id),
    [10_658],
  );

  await session.step({ type: "custom", kind: 10, target: 6, value: 0 });
  await session.step({ type: "custom", kind: 11, target: 513, value: 0 });
  for (let tick = 0; tick < 3; tick += 1) {
    await session.step({ type: "frame" }, 500_000);
  }
  assertEquals(session.describe().status.value, "Population 1; active fires 0");
  assertEquals(
    session.render().objects.filter((object) =>
      object.id >= 12_192 && object.visible
    ).map((object) => object.id),
    [12_192],
  );

  await session.step({ type: "custom", kind: 10, target: 1, value: 0 });
  await session.step({ type: "custom", kind: 11, target: 496, value: 0 });
  await session.step({ type: "custom", kind: 11, target: 497, value: 0 });

  const built = session.render();
  const placed_paths = built.objects.filter((object) =>
    object.id >= 4000 && object.id < 5024 && object.visible
  );
  assertEquals(
    placed_paths.map((object) => [object.id, object.path_connections]),
    [[4496, 1], [4497, 2], [4512, 0]],
  );

  for (let target = 498; target <= 505; target += 1) {
    await session.step({ type: "custom", kind: 11, target, value: 0 });
  }
  const expanded_paths = session.render().objects.filter((object) =>
    object.id >= 4000 && object.id < 5024 && object.visible
  );
  assertEquals(expanded_paths.length, 11);
  assertEquals(
    expanded_paths.map((object) => object.id),
    [...Array.from({ length: 10 }, (_, index) => 4496 + index), 4512],
  );

  const saved = await session.save();
  await session.reset();
  assertEquals(
    session.render().objects.filter((object) =>
      object.id >= 4000 && object.id < 5024 && object.visible
    ).map((object) => object.id),
    [4_512],
  );
  await session.load(saved);
  assertEquals(
    session.render().objects.filter((object) =>
      object.id >= 4000 && object.id < 5024 && object.visible
    ).length,
    11,
  );

  await session.step({ type: "zoom", direction: "in" });
  assertEquals(session.render().camera_zoom, 0.275);

  await session.step({ type: "custom", kind: 10, target: 99, value: 0 });
  assertEquals(session.describe().status.value, "Population 1; active fires 0");
  session.close();
});

Deno.test("units interpolate toward objectives and prefer nearby paths", async () => {
  const session = await load_city();

  await session.step({ type: "custom", kind: 10, target: 2, value: 0 });
  await session.step({ type: "custom", kind: 11, target: 514, value: 0 });
  await session.step({ type: "custom", kind: 10, target: 1, value: 0 });
  await session.step({ type: "custom", kind: 11, target: 480, value: 0 });

  await session.step({ type: "frame" }, 500_000);
  await session.step({ type: "frame" }, 500_000);
  const halfway_to_path = session.render().objects.find((object) =>
    object.id === 11_168
  );
  assertEquals(halfway_to_path?.visible, true);
  assertEquals(halfway_to_path?.position, [-11_160_000, -5_580_000, 180_000]);

  await session.step({ type: "frame" }, 500_000);
  const reached_path = session.render().objects.find((object) =>
    object.id === 11_168
  );
  assertEquals(reached_path?.position, [-10_800_000, -5_760_000, 180_000]);

  for (let tick = 0; tick < 4; tick += 1) {
    await session.step({ type: "frame" }, 500_000);
  }
  assertEquals(session.describe().status.value, "Population 1; active fires 0");
  session.close();
});

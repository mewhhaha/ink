import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { GameGuest } from "./game_guest.ts";
import { create_headless_session } from "./headless_session.ts";

const semantic_region = {
  id: "tile-0",
  label: "Tile 0",
  description: "Empty tile",
  role: "button",
  target: 0,
  pressed: false,
  selected: false,
  element_size: { width: 80, height: 32 },
  placement: {
    type: "scene_object",
    object: 0,
    offset: [0, 0, 0],
    size: [1_000_000, 500_000],
  },
  style: {
    background_color: "transparent",
    border_color: "white",
    border_radius: 0,
    border_width: 1,
    color: "white",
    font_size: 12,
    font_weight: 400,
  },
  order: 0,
  actions: [],
} as const;

const scene_object = {
  type: "scene_object",
  id: 0,
  mesh: 0,
  parent: null,
  color: [1, 1, 1],
  emissive: 0,
  texture: null,
  texture_offset: [0, 0],
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

const directional_light = {
  type: "directional_light",
  color: [1, 1, 1],
  direction: [0, 0, -1],
  intensity: 1,
} as const;

const guest: GameGuest = {
  state_schema: "",
  start: () => ({ scalar: 0n, cells: [] }),
  step: (state) => state,
  describe: () => ({
    actions: [],
    regions: [semantic_region],
    status: { label: "City", value: "Ready", done: false },
  }),
  render: () => ({
    projection: "orthographic",
    camera_zoom: 1,
    directional_light,
    nodes: [],
    objects: [scene_object],
    resources: [],
  }),
};

Deno.test("headless descriptions reject duplicate semantic identities", async () => {
  const session = await create_headless_session({
    ...guest,
    describe: () => ({
      actions: [],
      regions: [semantic_region, semantic_region],
      status: { label: "City", value: "Ready", done: false },
    }),
  }, {
    game_id: "test",
    artifact_digest: "artifact",
    schema_digest: "schema",
  });

  assertThrows(
    () => session.describe(),
    Error,
    'game emitted duplicate semantic region id "tile-0"',
  );
});

Deno.test("headless rendering rejects duplicate scene identities", async () => {
  const session = await create_headless_session({
    ...guest,
    render: () => ({
      projection: "orthographic",
      camera_zoom: 1,
      directional_light,
      nodes: [],
      objects: [scene_object, scene_object],
      resources: [],
    }),
  }, {
    game_id: "test",
    artifact_digest: "artifact",
    schema_digest: "schema",
  });

  assertThrows(
    () => session.render(),
    Error,
    "game emitted duplicate scene object id 0",
  );
});

Deno.test("headless rendering reuses the current game snapshot", async () => {
  let render_count = 0;
  const session = await create_headless_session({
    ...guest,
    render: (...arguments_) => {
      render_count += 1;
      return guest.render(...arguments_);
    },
  }, {
    game_id: "test",
    artifact_digest: "artifact",
    schema_digest: "schema",
  });

  session.describe();
  session.render();
  assertEquals(render_count, 1);

  await session.step({ type: "frame" });
  session.render();
  assertEquals(render_count, 2);
});

Deno.test("camera zoom stays within the inspection range", async () => {
  const session = await create_headless_session(guest, {
    game_id: "test",
    artifact_digest: "artifact",
    schema_digest: "schema",
  });

  for (let step = 0; step < 100; step += 1) {
    await session.step({ type: "zoom", direction: "in" });
  }
  assertEquals(session.render().camera_zoom, 8);

  for (let step = 0; step < 100; step += 1) {
    await session.step({ type: "zoom", direction: "out" });
  }
  assertEquals(session.render().camera_zoom, 0.2);
  session.close();
});

Deno.test("headless sessions reject invalid viewport and direct action timing", async () => {
  await assertRejects(
    () =>
      create_headless_session(guest, {
        game_id: "test",
        artifact_digest: "artifact",
        schema_digest: "schema",
      }, { width: 0, height: 10 }),
    Error,
    "must use positive integers",
  );
  const session = await create_headless_session(guest, {
    game_id: "test",
    artifact_digest: "artifact",
    schema_digest: "schema",
  });
  await assertRejects(
    () => session.step({ type: "frame" }, -1),
    Error,
    "delta_us -1 must be nonnegative",
  );
});

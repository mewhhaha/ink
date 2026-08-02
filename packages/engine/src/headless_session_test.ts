import { assertThrows } from "@std/assert";
import type { GameGuest } from "./guest.ts";
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
  rotation_radians: [0, 0, 0],
  position: [0, 0, 0],
  scale: [1_000_000, 1_000_000, 1_000_000],
  visible: true,
} as const;

const guest: GameGuest = {
  start: () => 0n,
  step: (state) => state,
  describe: () => ({
    actions: [],
    regions: [semantic_region],
    status: { label: "City", value: "Ready", done: false },
  }),
  render: () => ({ projection: "orthographic", objects: [scene_object] }),
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
      objects: [scene_object, scene_object],
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

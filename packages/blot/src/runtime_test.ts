import { Observer } from "@ink/observability/observer.ts";
import { no_observations } from "@ink/observability/sink.ts";
import { parse_game_artifact } from "@ink/runtime/artifact.ts";
import { create_runtime_session, microseconds } from "@ink/runtime/session.ts";
import { assertEquals, assertRejects } from "@std/assert";
import type { GameGuest } from "./game_guest.ts";
import {
  blot_runtime_codec,
  type BlotRuntimeSession,
  create_blot_runtime_guest,
} from "./runtime.ts";

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

const wasm_guest: GameGuest = {
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

async function create_test_session(
  guest: GameGuest = wasm_guest,
): Promise<BlotRuntimeSession> {
  const runtime_guest = create_blot_runtime_guest({
    artifact: parse_game_artifact({
      guest_id: "test",
      artifact_digest: "artifact",
      schema_digest: "schema",
      wasm: new Uint8Array([1]),
      capabilities: [],
    }),
    wasm_guest: guest,
  });
  return await create_runtime_session({
    guest: runtime_guest,
    codec: blot_runtime_codec,
    observer: new Observer({
      source: { subsystem: "blot-test" },
      sink: no_observations,
      clock: { now_seconds: () => 1 },
    }),
  });
}

Deno.test("Blot observations reject duplicate semantic identities", async () => {
  const session = await create_test_session({
    ...wasm_guest,
    describe: () => ({
      actions: [],
      regions: [semantic_region, semantic_region],
      status: { label: "City", value: "Ready", done: false },
    }),
  });
  try {
    await assertRejects(
      () => session.observe({ width: 960, height: 540 }),
      Error,
      'game emitted duplicate semantic region id "tile-0"',
    );
  } finally {
    await session.close();
  }
});

Deno.test("Blot observations reject duplicate scene identities", async () => {
  const session = await create_test_session({
    ...wasm_guest,
    render: () => ({
      projection: "orthographic",
      camera_zoom: 1,
      directional_light,
      nodes: [],
      objects: [scene_object, scene_object],
      resources: [],
    }),
  });
  try {
    await assertRejects(
      () => session.observe({ width: 960, height: 540 }),
      Error,
      "game emitted duplicate scene object id 0",
    );
  } finally {
    await session.close();
  }
});

Deno.test("one Blot batch applies inputs before one elapsed frame step", async () => {
  const received_deltas: number[] = [];
  const received_kinds: number[] = [];
  const session = await create_test_session({
    ...wasm_guest,
    step: (state, kind, _target, value, delta_us) => {
      received_kinds.push(kind);
      received_deltas.push(delta_us);
      return { ...state, scalar: state.scalar + BigInt(value) };
    },
  });
  try {
    await session.advance({
      elapsed_us: microseconds(20_000),
      inputs: [
        { type: "custom", kind: 10, target: 0, value: 1 },
        { type: "custom", kind: 10, target: 0, value: 2 },
        { type: "custom", kind: 10, target: 0, value: 3 },
      ],
    });
    assertEquals(received_kinds, [10, 10, 10, 0]);
    assertEquals(received_deltas, [0, 0, 0, 20_000]);
  } finally {
    await session.close();
  }
});

Deno.test("Blot camera zoom remains within the inspection range", async () => {
  const session = await create_test_session();
  try {
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: Array.from(
        { length: 100 },
        () => ({ type: "zoom", direction: "in" } as const),
      ),
    });
    assertEquals(
      (await session.observe({ width: 960, height: 540 })).snapshot.camera_zoom,
      8,
    );
    await session.advance({
      elapsed_us: microseconds(0),
      inputs: Array.from(
        { length: 100 },
        () => ({ type: "zoom", direction: "out" } as const),
      ),
    });
    assertEquals(
      (await session.observe({ width: 960, height: 540 })).snapshot.camera_zoom,
      0.2,
    );
  } finally {
    await session.close();
  }
});

Deno.test("Blot viewport parsing rejects nonpositive dimensions", async () => {
  const session = await create_test_session();
  try {
    await assertRejects(
      () => session.observe({ width: 0, height: 10 }),
      Error,
      "Blot viewport width must be positive",
    );
  } finally {
    await session.close();
  }
});

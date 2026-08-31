import { asset_id } from "@ink/assets/identity.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import { Observer } from "@ink/observability/observer.ts";
import { no_observations } from "@ink/observability/sink.ts";
import { parse_game_artifact } from "@ink/runtime/artifact.ts";
import { create_runtime_session, microseconds } from "@ink/runtime/session.ts";
import { scene_node_id } from "@ink/scene/identity.ts";
import { literal_text, ui_id, type UiSnapshot } from "@ink/ui/semantic.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { blot_abi_registry } from "./abi.ts";
import type { GameGuest } from "./game_guest.ts";
import {
  blot_runtime_codec,
  type BlotRuntimeSession,
  create_blot_runtime_guest,
} from "./runtime.ts";

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

const camera = {
  type: "orthographic",
  position: [0, 2, 8],
  target: [0, 1, 0],
  clear_color: [0.01, 0.02, 0.03],
  vertical_size: 6,
} as const;

const environment = {
  ambient_light: [0.1, 0.1, 0.1],
  fog_color: [0.01, 0.02, 0.03],
  fog_density: 0.01,
  exposure_ev100: 0,
  bloom_intensity: 0.2,
} as const;

function test_ui(revision: number, scene_object_id = 0): UiSnapshot {
  return {
    revision,
    direction: "auto",
    root: {
      id: ui_id("blot.game"),
      role: "region",
      label: literal_text("City"),
      description: literal_text("Ready"),
      layout: { type: "absolute" },
      children: [{
        id: ui_id("tile-0"),
        role: "button",
        label: literal_text("Tile 0"),
        description: literal_text("Empty tile"),
        size: { width: 80, height: 32 },
        placement: {
          type: "scene",
          node: scene_node_id(scene_object_id, 0),
          offset: vec3(0, 0, 0),
          size: vec2(1_000_000, 500_000),
        },
        reading_order: 0,
        focus_order: 0,
        actions: [],
      }],
    },
    announcements: [],
  };
}

const wasm_guest: GameGuest = {
  state_schema: "",
  start: () => ({ scalar: 0n, cells: [] }),
  step: (state) => ({ state, effects: [] }),
  describe: (_state, _viewport, revision) => ({
    actions: [],
    ui: test_ui(revision),
    status: { label: "City", value: "Ready", done: false },
  }),
  render: () => ({
    camera,
    directional_light,
    environment,
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

Deno.test("Blot observations reject UI attached to a missing scene object", async () => {
  const session = await create_test_session({
    ...wasm_guest,
    describe: (_state, _viewport, revision) => ({
      actions: [],
      ui: test_ui(revision, 7),
      status: { label: "City", value: "Ready", done: false },
    }),
  });
  try {
    await assertRejects(
      () => session.observe({ width: 960, height: 540 }),
      Error,
      'UI node "tile-0" attaches to missing scene object 7',
    );
  } finally {
    await session.close();
  }
});

Deno.test("Blot observations reject duplicate scene identities", async () => {
  const session = await create_test_session({
    ...wasm_guest,
    render: () => ({
      camera,
      directional_light,
      environment,
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

Deno.test("one Blot batch applies inputs before one elapsed update", async () => {
  const received_deltas: number[] = [];
  const received_kinds: number[] = [];
  const session = await create_test_session({
    ...wasm_guest,
    step: (state, kind, _target, value, delta_us) => {
      received_kinds.push(kind);
      received_deltas.push(delta_us);
      return {
        state: { ...state, scalar: state.scalar + BigInt(value) },
        effects: kind === 10
          ? [{
            type: "play_audio",
            id: `input-${value}`,
            cue: asset_id<"audio">(`input-${value}.wav`),
          }]
          : [],
      };
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
    assertEquals(received_kinds, [
      10,
      10,
      10,
      blot_abi_registry.protocol.events.elapsed,
    ]);
    assertEquals(received_deltas, [0, 0, 0, 20_000]);
    assertEquals(
      (await session.observe({ width: 960, height: 540 })).effects,
      [
        {
          type: "play_audio",
          id: "input-1",
          cue: asset_id<"audio">("input-1.wav"),
        },
        {
          type: "play_audio",
          id: "input-2",
          cue: asset_id<"audio">("input-2.wav"),
        },
        {
          type: "play_audio",
          id: "input-3",
          cue: asset_id<"audio">("input-3.wav"),
        },
      ],
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

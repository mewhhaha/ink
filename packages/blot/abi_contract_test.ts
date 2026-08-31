import { asset_id } from "@ink/assets/identity.ts";
import { vec2, vec3 } from "@ink/math/vector.ts";
import { Observer } from "@ink/observability/observer.ts";
import { no_observations } from "@ink/observability/sink.ts";
import { create_runtime_session, microseconds } from "@ink/runtime/session.ts";
import { scene_node_id } from "@ink/scene/identity.ts";
import { literal_text, ui_id } from "@ink/ui/semantic.ts";
import { assert, assertEquals } from "@std/assert";
import { blot } from "./src/adapter.ts";
import type { ActionDescription } from "./src/protocol.ts";
import { blot_runtime_codec } from "./src/runtime.ts";

const decoder = new TextDecoder();
const blot_cli = new URL("../../../blot/src/cli.ts", import.meta.url);
const fixture = new URL("./testdata/abi_contract.blot", import.meta.url);
const wasm_artifact = new URL("./testdata/abi_contract.wasm", import.meta.url);
const manifest_artifact = new URL(
  "./testdata/abi_contract.wasm.json",
  import.meta.url,
);

const focus_action: ActionDescription = {
  id: "focus:contract-button",
  label: literal_text("Focus contract-button"),
  trigger: { type: "focus", target: ui_id("contract-button") },
  action: { type: "focus", target: 909 },
};

const activate_action: ActionDescription = {
  id: "activate:contract-button",
  label: literal_text("Activate contract-button"),
  trigger: { type: "activate", target: ui_id("contract-button") },
  action: { type: "activate", target: 909 },
};

const command_action: ActionDescription = {
  id: "contract-action",
  label: literal_text("Contract action"),
  trigger: { type: "command" },
  action: { type: "custom", kind: 41, target: 42, value: 43 },
};

Deno.test("Blot adapter decodes scene and semantic host values", async () => {
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      blot_cli.pathname,
      "build",
      fixture.pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!build.success) {
    throw new Error(
      `Blot ABI fixture exited with code ${build.code}: ${
        decoder.decode(build.stderr).trim()
      }`,
    );
  }

  const [wasm_bytes, manifest_source] = await Promise.all([
    Deno.readFile(wasm_artifact),
    Deno.readTextFile(manifest_artifact),
  ]);
  await Promise.all([
    Deno.remove(wasm_artifact),
    Deno.remove(manifest_artifact),
  ]);

  const guest = await blot({ game_id: "abi_contract" }).create_guest(
    wasm_bytes,
    manifest_source,
  );
  assertEquals(guest.artifact.guest_id, "abi_contract");
  assert(guest.artifact.artifact_digest.length > 0);
  assert(guest.artifact.schema_digest.length > 0);
  const viewport = { width: 1280, height: 720 };
  const session = await create_runtime_session({
    guest,
    codec: blot_runtime_codec,
    observer: new Observer({
      source: { subsystem: "blot-abi" },
      sink: no_observations,
      clock: { now_seconds: () => 1 },
    }),
  });
  const presentation = await session.observe(viewport);
  assertEquals(presentation.observation, {
    sequence: 0,
    outcome: "won",
    actions: [focus_action, activate_action, command_action],
    ui: {
      revision: 0,
      direction: "auto",
      root: {
        id: ui_id("blot.game"),
        role: "region",
        label: literal_text("Contract status"),
        description: literal_text("Complete"),
        placement: {
          type: "absolute",
          x: 0,
          y: 0,
          width: 1280,
          height: 720,
        },
        layout: { type: "absolute" },
        actions: [command_action],
        children: [
          {
            id: ui_id("contract-text"),
            label: literal_text("Contract text"),
            description: literal_text("Text description"),
            size: { width: 16, height: 15 },
            placement: {
              type: "viewport",
              anchor: "top_right",
              inset: vec2(606, 707),
              size: vec2(16, 15),
            },
            reading_order: 10,
            focus_order: 10,
            role: "text",
          },
          {
            id: ui_id("contract-progress"),
            label: literal_text("Contract progress"),
            description: literal_text("Progress description"),
            size: { width: 22, height: 21 },
            placement: {
              type: "scene",
              node: scene_node_id(7, 0),
              offset: vec3(1111, 1212, 1313),
              size: vec2(1515, 1414),
            },
            reading_order: 20,
            focus_order: 20,
            role: "progress",
            minimum: 0,
            maximum: 99,
            value: 37,
          },
          {
            id: ui_id("contract-button"),
            label: literal_text("Contract button"),
            description: literal_text("Button description"),
            size: { width: 1280, height: 720 },
            placement: {
              type: "scene",
              node: scene_node_id(7, 0),
              offset: vec3(101, 202, 303),
              size: vec2(505, 404),
            },
            reading_order: 30,
            focus_order: 30,
            role: "button",
            pressed: true,
            selected: false,
            actions: [focus_action, activate_action],
          },
        ],
      },
      announcements: [],
    },
    status: {
      done: true,
      label: "Contract status",
      value: "Complete",
    },
  });
  assertEquals(presentation.snapshot, {
    camera: {
      type: "orthographic",
      position: [1, 2, 3],
      target: [4, 5, 6],
      clear_color: [0.1, 0.2, 0.3],
      vertical_size: 10,
    },
    directional_light: {
      type: "directional_light",
      color: [0.8, 0.7, 0.6],
      direction: [-0.1, -0.2, -0.3],
      intensity: 0.9,
    },
    environment: {
      ambient_light: [0.01, 0.02, 0.03],
      fog_color: [0.06, 0.07, 0.08],
      fog_density: 0.009,
      exposure_ev100: -0.5,
      bloom_intensity: 0.4,
    },
    nodes: [],
    resources: [
      { type: "mesh", id: 18, asset: asset_id<"mesh">("contract.obj") },
      {
        type: "texture",
        id: 19,
        asset: asset_id<"texture">("contract.png"),
      },
      {
        type: "texture",
        id: 20,
        asset: asset_id<"texture">("contract-secondary.png"),
      },
    ],
    objects: [{
      type: "scene_object",
      id: 7,
      mesh: 6,
      parent: 73,
      color: [0.25, 0.5, 0.75],
      emissive: 0.125,
      texture: 19,
      texture_offset: [0.15, 0.16],
      secondary_texture: 20,
      texture_scale: [0.17, 0.18],
      blend_edges: 5,
      variation_seed: 123,
      surface_mode: 2,
      path_connections: 9,
      rotation_radians: [-0.25, 0.5, -0.75],
      position: [1280, 720, -3000000],
      scale: [1000000, 2000000, 3000000],
      visible: false,
    }],
  });
  assertEquals(presentation.effects, []);
  await session.advance({
    elapsed_us: microseconds(4),
    inputs: [{ type: "custom", kind: 1, target: 2, value: 3 }],
  });
  assertEquals((await session.observe(viewport)).effects, [{
    type: "play_audio",
    id: "contract-effect",
    cue: asset_id<"audio">("contract.audio"),
  }]);
  const restored: unknown = JSON.parse(
    new TextDecoder().decode(await guest.snapshot()),
  );
  if (typeof restored !== "object" || restored === null) {
    throw new Error("Blot ABI runtime snapshot must be an object");
  }
  const guest_state = Reflect.get(restored, "guest_state");
  if (typeof guest_state !== "object" || guest_state === null) {
    throw new Error("Blot ABI runtime snapshot guest state must be an object");
  }
  assertEquals(Reflect.get(guest_state, "scalar"), "27");
  await session.close();
});
